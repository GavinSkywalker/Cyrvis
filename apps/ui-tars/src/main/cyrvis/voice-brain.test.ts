/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CodingAgentService, CodingTaskSnapshot } from './coding-agent';
import { CyrvisController } from './controller';
import type { ControllerEvent, GUIAdapter, GUIAdapterCallbacks } from './types';
import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceToolCallWithId,
} from './voice/provider';
import { VoiceBrain, type VoiceBrainCallbacks } from './voice-brain';
import { parseGazeSuggestion } from './gaze/suggestions';
import type { GazeActionContext } from './gaze/actions';

class FakeGUIAdapter implements GUIAdapter {
  callbacks: GUIAdapterCallbacks | null = null;
  instruction = '';
  private resolveStart: (() => void) | null = null;

  start(instruction: string, callbacks: GUIAdapterCallbacks): Promise<void> {
    this.instruction = instruction;
    this.callbacks = callbacks;
    callbacks.onStarted();
    return new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }

  async cancel(): Promise<void> {
    this.callbacks?.onCancelled();
  }

  async pause(): Promise<void> {
    this.callbacks?.onPaused();
  }

  async resume(): Promise<void> {
    this.callbacks?.onResumed();
  }

  finish(summary = '任务完成'): void {
    this.callbacks?.onDone(summary);
    this.resolveStart?.();
  }
}

class FakeProvider implements VoiceProvider {
  readonly toolResults: Array<{ callId: string; output: string }> = [];
  readonly spoken: string[] = [];
  readonly submitted: string[] = [];
  readonly audio: Int16Array[] = [];
  canceled = 0;
  connected = false;

  constructor(readonly callbacks: VoiceProviderCallbacks) {}

  async connect(): Promise<void> {
    this.connected = true;
    this.callbacks.onReady?.();
  }

  sendAudio(pcm16: Int16Array): void {
    this.audio.push(pcm16);
  }

  sendToolResult(callId: string, output: string): void {
    this.toolResults.push({ callId, output });
    this.callbacks.onResponseStarted?.();
    this.callbacks.onResponseDone?.();
  }

  cancelResponse(): void {
    this.canceled += 1;
  }

  speak(text: string): void {
    this.spoken.push(text);
    this.callbacks.onResponseStarted?.();
    this.callbacks.onResponseDone?.();
  }
  submitText(text: string): boolean {
    this.submitted.push(text);
    return true;
  }

  close(): void {
    this.connected = false;
  }

  emitTranscript(text: string, final = true): boolean | void {
    return this.callbacks.onTranscript?.(text, final);
  }

  emitToolCall(call: VoiceToolCallWithId): void {
    this.callbacks.onToolCall?.(call);
  }

  emitAudio(pcm: Int16Array): void {
    this.callbacks.onAudio?.(pcm);
  }
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const setup = (options?: {
  getGazeActionContext?: (text: string) => GazeActionContext | null;
  inspectGaze?: (question: string) => Promise<string>;
  requireWakeWord?: boolean;
  awakeTimeoutMs?: number;
  rememberFact?: (text: string) => Promise<string | null>;
  codingAgent?: CodingAgentService;
}) => {
  const adapter = new FakeGUIAdapter();
  const controller = new CyrvisController(adapter, {
    stallTimeoutMs: 0,
    idFactory: () => 'task-1',
  });
  const events: ControllerEvent[] = [];
  controller.onEvent((event) => events.push(event));

  let provider!: FakeProvider;
  const wakeEvents: string[] = [];
  const audioOut: Int16Array[] = [];
  const callbacks: VoiceBrainCallbacks = {
    onWake: () => wakeEvents.push('wake'),
    onSleep: () => wakeEvents.push('sleep'),
    onAudio: (pcm) => audioOut.push(pcm),
  };

  const brain = new VoiceBrain(
    controller,
    callbacks,
    (providerCallbacks) => {
      provider = new FakeProvider(providerCallbacks);
      return provider;
    },
    {
      requireWakeWord: options?.requireWakeWord ?? true,
      awakeTimeoutMs: options?.awakeTimeoutMs ?? 0,
      rememberFact: options?.rememberFact,
      inspectGaze: options?.inspectGaze,
      getGazeActionContext: options?.getGazeActionContext,
      codingAgent: options?.codingAgent,
    },
  );

  return { adapter, controller, events, brain, provider, wakeEvents, audioOut };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceBrain', () => {
  it('supersedes an early read-only gaze tool when ASR confirms the user asked for a GUI action', async () => {
    let finish!: (value: string) => void;
    const gaze = {
      x: 0.5,
      y: 0.5,
      at: Date.now(),
      displayId: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      target: {
        id: 'cover',
        scene: 'music',
        label: '歌单',
        role: 'AXImage',
        source: 'accessibility' as const,
        bounds: { x: 500, y: 300, width: 180, height: 180 },
      },
    };
    const { brain, provider, adapter } = setup({
      requireWakeWord: false,
      getGazeActionContext: () => ({ gaze, observedAt: Date.now() }),
      inspectGaze: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await brain.start();
    provider.callbacks.onSpeechStarted?.();
    provider.emitToolCall({
      name: 'inspect_gaze_target',
      args: { question: '看看这个歌单' },
      callId: 'early',
    });
    await flush();
    provider.emitTranscript('帮我点一下这个歌单然后播放');
    await flush();
    expect(adapter.instruction).toContain('[已绑定注视对象]');
    finish('只读模型不能点击');
    await flush();
    expect(provider.spoken.join('')).not.toContain('只读模型不能点击');
    brain.dispose();
  });
  it.each(['play', 'open'] as const)(
    'routes the selected %s option to the frozen object even when gaze has moved',
    async (action) => {
      const gaze = {
        x: 0.5,
        y: 0.5,
        at: Date.now(),
        displayId: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        target: {
          id: 'cover',
          scene: 'music',
          label: '歌单',
          role: 'AXImage',
          source: 'accessibility' as const,
          bounds: { x: 500, y: 300, width: 180, height: 180 },
        },
      };
      const { brain, provider, adapter } = setup({
        requireWakeWord: false,
        getGazeActionContext: () => ({
          gaze: {
            ...gaze,
            target: { ...gaze.target, id: 'other', label: '其他对象' },
          },
          observedAt: Date.now(),
        }),
      });
      await brain.start();
      const suggestion = {
        ...parseGazeSuggestion(
          JSON.stringify({
            kind: action === 'play' ? 'music' : 'image',
            target: '',
            description: '无名称的封面',
            visible: true,
            identified: false,
            confidence: 'high',
          }),
          Date.now(),
        )!,
        gaze,
      };
      brain.offerGazeSuggestion(suggestion);
      expect(adapter.instruction).toBe('');
      provider.emitTranscript('第一个');
      await flush();
      expect(adapter.instruction).toContain('[已绑定注视对象]');
      expect(adapter.instruction).toContain('歌单');
      expect(adapter.instruction).not.toContain('其他对象');
      expect(provider.submitted).toEqual([]);
      expect(brain.gazeSuggestionBlockReason()).toContain('桌面任务');
      adapter.finish();
      await flush();
      expect(brain.canOfferGazeSuggestion()).toBe(true);
      brain.dispose();
    },
  );
  it('routes an explicit click-and-play request to the GUI executor even when the cover has no name', async () => {
    const context: GazeActionContext = {
      gaze: {
        x: 0.4,
        y: 0.5,
        at: Date.now(),
        displayId: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        target: {
          id: 'playlist',
          scene: 'music',
          label: '图像区域（名称待确认）',
          role: 'image-region',
          source: 'vision',
          bounds: { x: 480, y: 320, width: 180, height: 180 },
        },
      },
      observedAt: Date.now(),
    };
    const { brain, provider, adapter, controller, events } = setup({
      getGazeActionContext: () => context,
    });
    await brain.start();
    expect(
      provider.emitTranscript('呃你帮我点一下，然后播放这个歌单就行。'),
    ).toBe(true);
    await flush();
    expect(controller.getStatus().status).toBe('executing');
    expect(adapter.instruction).toContain('[已绑定注视对象]');
    expect(adapter.instruction).toContain('不要求先从封面认出作品名');
    expect(adapter.instruction).toContain('确认播放器');
    expect(provider.submitted).toEqual([]);
    expect(provider.spoken.join('')).not.toContain('播放成功');
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: '重复播放' },
      callId: 'late',
    });
    await flush();
    expect(
      events.filter((event) => event.type === 'task_started'),
    ).toHaveLength(1);
    expect(provider.toolResults.at(-1)?.output).toContain('ALREADY_ROUTED');
    brain.dispose();
  });
  it('asks for an explicit gaze target instead of guessing or claiming GUI capability is absent', async () => {
    const { brain, provider, adapter } = setup({
      requireWakeWord: false,
      getGazeActionContext: () => null,
    });
    await brain.start();
    provider.emitTranscript('播放这个歌单');
    await flush();
    expect(adapter.instruction).toBe('');
    expect(provider.spoken.at(-1)).toContain('绿框锁定');
    brain.dispose();
  });
  it('only submits a suggested music action after a clear user choice and preserves its target', async () => {
    const { brain, provider, adapter } = setup({ requireWakeWord: false });
    await brain.start();
    const suggestion = parseGazeSuggestion(
      '{"kind":"music","target":"Day One","description":"你在看一个音乐封面","identified":true,"confidence":"high"}',
      Date.now(),
    )!;
    brain.offerGazeSuggestion(suggestion);
    expect(provider.submitted).toEqual([]);
    expect(adapter.instruction).toBe('');
    provider.emitTranscript('好');
    await flush();
    expect(provider.submitted).toEqual([]);
    expect(provider.spoken.at(-1)).toContain('选择哪一项');
    provider.emitTranscript('播放它');
    await flush();
    expect(provider.submitted).toHaveLength(1);
    expect(provider.submitted[0]).toContain('Day One');
    expect(provider.submitted[0]).toContain('确认播放器状态');
    brain.dispose();
  });
  it('expires and dismisses proactive suggestions without executing anything', async () => {
    vi.useFakeTimers();
    const { brain, provider } = setup({ requireWakeWord: false });
    await brain.start();
    const suggestion = parseGazeSuggestion(
      '{"kind":"music","target":"Day One","description":"音乐封面","identified":true,"confidence":"high"}',
      Date.now(),
    )!;
    brain.offerGazeSuggestion(suggestion);
    provider.emitTranscript('不用了');
    expect(provider.submitted).toEqual([]);
    expect(brain.followGazeSuggestion(suggestion.id, 'play').ok).toBe(false);
    brain.offerGazeSuggestion(suggestion);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(brain.followGazeSuggestion(suggestion.id, 'play').ok).toBe(false);
    brain.dispose();
  });
  it('wakes for an explicitly requested screen reply and delivers its audio', async () => {
    const { brain, provider, audioOut } = setup();
    await brain.start();
    expect(brain.getState().awake).toBe(false);
    brain.speakRequestedReply('这片区域是一个歌单。');
    provider.emitAudio(new Int16Array([10, 20]));
    expect(brain.getState().awake).toBe(true);
    expect(provider.spoken).toEqual(['这片区域是一个歌单。']);
    expect(audioOut).toHaveLength(1);
    brain.dispose();
  });

  it('does not manufacture a muted fallback reply for background speech while asleep', async () => {
    vi.useFakeTimers();
    const { brain, provider, audioOut } = setup();
    await brain.start();
    provider.callbacks.onResponseStarted?.();
    provider.callbacks.onAssistantText?.('不应显示的后台回答', true);
    provider.callbacks.onResponseDone?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.spoken).toEqual([]);
    expect(audioOut).toEqual([]);
    brain.dispose();
  });
  it('does not invalidate a pending gaze answer for a noise-only speech segment', async () => {
    let resolve!: (value: string) => void;
    const { brain, provider } = setup({
      requireWakeWord: false,
      inspectGaze: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await brain.start();
    provider.emitTranscript('我在看什么');
    provider.callbacks.onSpeechStarted?.();
    provider.callbacks.onSpeechStopped?.();
    provider.emitTranscript('');
    resolve('注视区域里的歌单');
    await flush();
    expect(provider.spoken).toEqual(['注视区域里的歌单']);
    brain.dispose();
  });
  it('ignores blank ASR while a valid answer is being delivered', async () => {
    const { brain, provider, audioOut } = setup({ requireWakeWord: false });
    await brain.start();
    provider.callbacks.onResponseStarted?.();
    provider.callbacks.onAssistantText?.('这片区域里', false);
    expect(provider.emitTranscript('   ')).toBe(true);
    provider.callbacks.onAssistantText?.('这片区域里有一个歌单。', true);
    provider.emitAudio(new Int16Array([1, 2]));
    expect(provider.canceled).toBe(0);
    expect(brain.shouldSuppressReply()).toBe(false);
    expect(audioOut).toHaveLength(1);
    brain.dispose();
  });

  it.each(['播放我正在看着的这个歌单。', '我在看什么？'])(
    'keeps an early gaze tool result for its later ASR turn: %s',
    async (text) => {
      vi.useFakeTimers();
      let resolve!: (value: string) => void;
      const inspectGaze = vi.fn(
        () =>
          new Promise<string>((done) => {
            resolve = done;
          }),
      );
      const { brain, provider } = setup({
        requireWakeWord: false,
        awakeTimeoutMs: 1000,
        inspectGaze,
      });
      await brain.start();
      provider.callbacks.onSpeechStarted?.();
      provider.callbacks.onSpeechStopped?.();
      provider.emitToolCall({
        name: 'inspect_gaze_target',
        callId: 'early-gaze',
        args: { question: '正在看什么歌单？' },
      });
      provider.emitTranscript(text);
      provider.emitTranscript('');
      await vi.advanceTimersByTimeAsync(25_000);
      expect(brain.getState().awake).toBe(true);
      expect(provider.spoken).toEqual([]);
      expect(inspectGaze).toHaveBeenCalledOnce();
      resolve('当前区域是滑板时听的歌1');
      await flush();
      expect(provider.toolResults).toHaveLength(1);
      expect(provider.toolResults[0].output).toContain('滑板时听的歌1');
      expect(provider.canceled).toBe(0);
      brain.dispose();
    },
  );

  it('still discards a gaze result after an explicit new stop turn', async () => {
    let resolve!: (value: string) => void;
    const { brain, provider } = setup({
      requireWakeWord: false,
      inspectGaze: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await brain.start();
    provider.callbacks.onSpeechStarted?.();
    provider.callbacks.onSpeechStopped?.();
    provider.emitToolCall({
      name: 'inspect_gaze_target',
      callId: 'old-gaze',
      args: {},
    });
    provider.emitTranscript('我在看什么');
    provider.callbacks.onSpeechStarted?.();
    provider.callbacks.onSpeechStopped?.();
    provider.emitTranscript('停止');
    resolve('不应该继续播报的旧画面');
    await flush();
    expect(provider.toolResults).toEqual([]);
    expect(provider.spoken).toEqual([]);
    expect(provider.canceled).toBeGreaterThan(0);
    brain.dispose();
  });
  it('keeps gaze inspection available after a spoken stop task command', async () => {
    const inspectGaze = vi.fn(async () => '仍能识别注视区域');
    const { brain, provider, controller } = setup({
      requireWakeWord: false,
      inspectGaze,
    });
    await brain.start();
    provider.emitTranscript('打开网易云音乐');
    provider.emitToolCall({
      name: 'start_gui_task',
      callId: 'start',
      args: { instruction: '打开网易云音乐' },
    });
    await flush();
    provider.emitTranscript('停止任务');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getStatus().status).toBe('cancelled');
    expect(brain.getState().awake).toBe(true);
    provider.emitTranscript('我在看什么');
    await flush();
    expect(inspectGaze).toHaveBeenCalledWith('我在看什么');
    expect(provider.spoken).toContain('仍能识别注视区域');
    brain.dispose();
  });
  it('joins a model tool call to an in-flight deterministic gaze request without duplicate speech or capture', async () => {
    let resolve!: (answer: string) => void;
    const inspectGaze = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const { brain, provider } = setup({ requireWakeWord: false, inspectGaze });
    await brain.start();
    provider.emitTranscript('我在看什么');
    provider.emitToolCall({
      name: 'inspect_gaze_target',
      callId: 'joined',
      args: {},
    });
    resolve('截图中的测试文字');
    await flush();
    expect(inspectGaze).toHaveBeenCalledOnce();
    expect(provider.spoken).toEqual([]);
    expect(provider.toolResults).toHaveLength(1);
    expect(provider.toolResults[0].output).toContain('截图中的测试文字');
    brain.dispose();
  });
  it('routes an explicit gaze question to the visual inspector and speaks its result without starting a GUI task', async () => {
    const inspectGaze = vi.fn(async () => '这片区域里有一个音乐播放器');
    const { brain, provider, adapter } = setup({
      requireWakeWord: false,
      inspectGaze,
    });
    await brain.start();
    expect(provider.emitTranscript('我在看什么？')).toBe(true);
    await flush();
    expect(inspectGaze).toHaveBeenCalledWith('我在看什么？');
    expect(provider.spoken).toContain('这片区域里有一个音乐播放器');
    expect(adapter.instruction).toBe('');
    brain.dispose();
  });

  it('returns visual inspection tool output for other gaze questions', async () => {
    const inspectGaze = vi.fn(async () => '画面中有三个按钮');
    const { brain, provider, adapter } = setup({
      requireWakeWord: false,
      inspectGaze,
    });
    await brain.start();
    provider.emitTranscript('解释一下我注视的区域');
    provider.emitToolCall({
      name: 'inspect_gaze_target',
      callId: 'gaze-1',
      args: { question: '解释我注视的区域' },
    });
    await flush();
    expect(provider.toolResults[0].output).toContain('画面中有三个按钮');
    expect(adapter.instruction).toBe('');
    brain.dispose();
  });

  it('does not speak a delayed inspection after sleep', async () => {
    let resolve!: (answer: string) => void;
    const { brain, provider } = setup({
      requireWakeWord: false,
      inspectGaze: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await brain.start();
    provider.emitTranscript('我在看什么');
    brain.sleep();
    resolve('不应播出的旧画面');
    await flush();
    expect(provider.spoken).toEqual([]);
    brain.dispose();
  });

  it('speaks an actionable capture error instead of inventing screen content', async () => {
    const { brain, provider } = setup({
      requireWakeWord: false,
      inspectGaze: async () => {
        throw new Error('请启用屏幕录制权限');
      },
    });
    await brain.start();
    provider.emitTranscript('这个是什么');
    await flush();
    expect(provider.spoken).toEqual(['请启用屏幕录制权限']);
    brain.dispose();
  });
  it('wakes on an explicit greeting', async () => {
    const { brain, provider } = setup();
    await brain.start();

    provider.emitTranscript('你好', true);

    expect(brain.getState().awake).toBe(true);
  });

  it('routes explicit remember requests through long-term memory', async () => {
    const remembered: string[] = [];
    const { brain, provider } = setup({
      requireWakeWord: false,
      rememberFact: async (text) => {
        remembered.push(text);
        return text;
      },
    });
    await brain.start();

    provider.emitToolCall({
      callId: 'memory-1',
      name: 'remember_fact',
      args: { text: '用户喜欢简洁回答' },
    });
    await flush();

    expect(remembered).toEqual(['用户喜欢简洁回答']);
    expect(provider.toolResults.at(-1)?.output).toContain('用户喜欢简洁回答');
  });

  it('does not wake on unrelated background speech', async () => {
    const { brain, provider } = setup();
    await brain.start();

    provider.emitTranscript('今天天气不错', true);

    expect(brain.getState().awake).toBe(false);
    expect(provider.canceled).toBe(1);
  });

  it('wakes on "Hello CYRVIS" ASR variants', async () => {
    const { brain, provider, wakeEvents } = setup();
    await brain.start();

    provider.emitTranscript('Hello, service.', true);
    expect(brain.getState().awake).toBe(true);

    const second = setup();
    await second.brain.start();
    second.provider.emitTranscript('Hello, Cyrus.', true);
    expect(second.brain.getState().awake).toBe(true);
    expect(wakeEvents).toContain('wake');
  });

  it('auto-wakes on a clear task command without the wake word', async () => {
    const { brain, provider } = setup();
    await brain.start();

    provider.emitTranscript('打开记事本输入 Hello', true);

    expect(brain.getState().awake).toBe(true);
    expect(brain.getState().lastUserText).toContain('记事本');
  });

  it('auto-wakes on a clear search need without the wake word', async () => {
    const { brain, provider } = setup();
    await brain.start();

    provider.emitTranscript('我要去巴黎的机票', true);

    expect(brain.getState().awake).toBe(true);
    expect(brain.getState().lastUserText).toContain('巴黎');
  });

  it('drops audio while asleep and plays it after waking', async () => {
    const { brain, provider, audioOut } = setup();
    await brain.start();

    provider.emitAudio(new Int16Array([1, 2, 3]));
    expect(audioOut).toHaveLength(0);

    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitAudio(new Int16Array([4, 5, 6]));
    expect(audioOut).toHaveLength(1);
  });

  it('rejects a GUI tool call for chit-chat', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: '你好' },
      callId: 'call-chat',
    });
    await flush();

    expect(adapter.instruction).toBe('');
    expect(provider.toolResults[0].output).toContain('REJECTED');
  });

  it('redirects a pure search request from start_gui_task to search_web', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('我要去巴黎的机票', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: '打开浏览器搜索去巴黎的机票' },
      callId: 'call-search-redirect',
    });
    await flush();

    expect(adapter.instruction).toBe('');
    expect(provider.toolResults[0].output).toContain('USE_SEARCH_WEB');
    expect(provider.toolResults[0].output).toContain('去巴黎的机票');
  });

  it('rejects a web search for a stable knowledge question', async () => {
    const { brain, provider } = setup();
    await brain.start();
    provider.emitTranscript('给我介绍下邓小平', true);

    provider.emitToolCall({
      name: 'search_web',
      args: { query: '邓小平 简介' },
      callId: 'call-knowledge',
    });
    await flush();

    expect(provider.toolResults[0].output).toContain('ANSWER_FROM_KNOWLEDGE');
  });

  it('redirects site navigation from search_web to open_site', async () => {
    const { brain, provider } = setup();
    await brain.start();
    provider.emitTranscript('打开B站', true);

    provider.emitToolCall({
      name: 'search_web',
      args: { query: 'B站' },
      callId: 'call-nav-search',
    });
    await flush();

    expect(provider.toolResults[0].output).toContain('USE_OPEN_SITE');
    expect(provider.toolResults[0].output).toContain('bilibili');
  });

  it('redirects site navigation from start_gui_task to open_site', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('打开B站', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: '打开B站首页' },
      callId: 'call-nav-gui',
    });
    await flush();

    expect(adapter.instruction).toBe('');
    expect(provider.toolResults[0].output).toContain('USE_OPEN_SITE');
  });

  it('dispatches a real GUI task and returns a task id', async () => {
    const { brain, provider, adapter, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-task',
    });
    await flush();

    expect(adapter.instruction).toBe('Open Notepad and type hello');
    expect(controller.getStatus().status).toBe('executing');
    expect(provider.toolResults[0].output).toContain('"ok":true');
    expect(provider.toolResults[0].output).toContain('task-1');
  });

  it('answers task progress queries without waiting for the model', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-status-task',
    });
    await flush();
    provider.emitTranscript('你进行哪一步了');
    expect(provider.spoken.at(-1)).toContain('任务正在执行');
    adapter.callbacks?.onStep({
      index: 2,
      summary: '打开记事本窗口',
      actionType: 'click',
    });

    provider.emitTranscript('任务进度怎么样了', true);

    expect(provider.spoken.at(-1)).toContain('当前节点');
    expect(provider.spoken.at(-1)).toContain('打开记事本窗口');
  });

  it('allows a short continuation after an earlier task request', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('我想去巴黎，最便宜的机票嘛。', true);

    provider.emitToolCall({
      name: 'start_gui_task',
      args: {
        instruction:
          '打开携程，点击机票搜索，查看从当前城市到巴黎的最便宜机票。',
      },
      callId: 'call-paris',
    });
    await flush();

    expect(adapter.instruction).toContain('巴黎');
  });

  it('starts a task when the model paraphrase lacks known verbs', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript(
      '在桌面给我创建一个 TXT 文件，把《沁园春·雪》写在里面。',
      true,
    );

    provider.emitToolCall({
      name: 'start_gui_task',
      args: {
        instruction: '桌面准备一个文本文件，内容为《沁园春·雪》',
      },
      callId: 'call-create',
    });
    await flush();

    expect(adapter.instruction).toContain('桌面');
    expect(provider.toolResults[0].output).toContain('"ok":true');
  });

  it('handles stop as a control tool', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitToolCall({
      name: 'cancel_gui_task',
      args: {},
      callId: 'call-stop',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();

    expect(controller.getStatus().status).toBe('cancelled');
    expect(provider.toolResults.at(-1)?.output).toContain('cancelled');
    // The tool-result response is the single acknowledgment; no proactive
    // "已停止" line should race it.
    expect(
      provider.spoken.filter((text) => text.includes('已停止')),
    ).toHaveLength(0);
  });

  it('blocks a premature completion claim while the GUI task is running', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.callbacks.onResponseStarted?.();
    provider.callbacks.onAssistantText?.("I've opened Notepad", true);
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(provider.canceled).toBeGreaterThan(0);
    expect(provider.spoken.some((text) => text.includes('正在执行'))).toBe(
      true,
    );
    expect(adapter.instruction).toBe('Open Notepad and type hello');
  });

  it('cancels deterministically on "停" even without a tool call', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitTranscript('算了，取消这个任务', true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getStatus().status).toBe('cancelled');
    expect(
      provider.spoken.filter((text) => text.includes('已停止')),
    ).toHaveLength(0);
  });

  it('cancels deterministically on "停一下" while a task is running', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitTranscript('停一下', true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getStatus().status).toBe('cancelled');
  });

  it('treats urgent stop phrasings as a hard stop', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitTranscript('马上停', true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getStatus().status).toBe('cancelled');
    expect(provider.spoken.some((text) => text.includes('任务已取消'))).toBe(
      false,
    );
  });

  it('blocks a queued tool call after a stop barge', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    await flush();

    brain.markUserStop();
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-after-stop',
    });
    await flush();

    expect(adapter.instruction).toBe('');
    expect(provider.toolResults.at(-1)?.output).toContain('STOPPED');
  });

  it('treats 等一下 as a pause prefix and ignores trailing TTS echo', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitTranscript(
      '等一下，给我打开b站，然后搜索这个刘德华，并且点击第一条视频',
      true,
    );
    await flush();

    expect(controller.getStatus().status).toBe('paused');
  });

  it('treats a leading stop plus trailing echo as a pure stop', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitTranscript(
      '停一下，现在这样，打开B站搜索周杰伦，然后点击第一个视频',
      true,
    );
    await flush();

    expect(controller.getStatus().status).toBe('cancelled');
  });

  it('cancels a running task on any confirmed barge', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    brain.handleBargeStop();
    expect(controller.getStatus().status).toBe('cancelled');
  });

  it('suspends gaze menus and rejects gaze operations while a coding task is active', async () => {
    const codingAgent = { isBusy: () => true } as unknown as CodingAgentService;
    const { brain, provider, adapter } = setup({
      requireWakeWord: false,
      codingAgent,
    });
    await brain.start();
    expect(brain.canOfferGazeSuggestion()).toBe(false);
    expect(brain.gazeSuggestionBlockReason()).toContain('编码任务');
    const gaze = {
      x: 0.5,
      y: 0.5,
      at: Date.now(),
      displayId: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      target: {
        id: 'cover',
        scene: 'music',
        label: '歌单',
        role: 'AXImage',
        source: 'accessibility' as const,
        bounds: { x: 500, y: 300, width: 180, height: 180 },
      },
    };
    const suggestion = {
      ...parseGazeSuggestion(
        JSON.stringify({
          kind: 'music',
          description: '封面',
          confidence: 'high',
        }),
        Date.now(),
      )!,
      gaze,
    };
    brain.offerGazeSuggestion(suggestion);
    expect(brain.followGazeSuggestion(suggestion.id, 'play').ok).toBe(false);
    expect(adapter.instruction).toBe('');
    expect(provider.spoken.at(-1)).toContain('编码任务');
    brain.dispose();
  });

  it('cancels a running coding task on "停一下"', async () => {
    const cancel = vi.fn().mockResolvedValue({ status: 'cancelled' });
    const codingAgent = {
      isBusy: () => true,
      cancel,
    } as unknown as CodingAgentService;
    const { brain, provider } = setup({ codingAgent });
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    await flush();

    provider.emitTranscript('停一下', true);
    await flush();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('speaks only key coding nodes and reports command output', async () => {
    const { brain, provider } = setup({ requireWakeWord: false });
    await brain.start();
    const base: CodingTaskSnapshot = {
      taskId: 'coding-1',
      status: 'running',
      instruction: '写一个脚本',
      workspace: 'D:/demo',
      startedAt: 1,
      endedAt: null,
      lastMessage: '正在读取文件',
      lastEvent: {
        tool: 'read_file',
        message: '正在读取文件：hello.py',
        ok: true,
      },
      result: '',
      diff: '',
      changedFiles: [],
      error: null,
    };

    brain.notifyCodingStatus(base);
    expect(provider.spoken).toHaveLength(0);

    brain.notifyCodingStatus({
      ...base,
      lastMessage: '命令完成：sorted',
      lastEvent: {
        tool: 'run_shell_command',
        message: '命令完成：sorted',
        ok: true,
        output: 'sorted',
      },
    });
    expect(provider.spoken.at(-1)).toContain('运行结果：sorted');
  });

  it('pauses deterministically and acknowledges "暂停"', async () => {
    const { brain, provider, controller } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    provider.emitTranscript('暂停这个任务', true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getStatus().status).toBe('paused');
    expect(
      provider.spoken.filter((text) => text.includes('已暂停')),
    ).toHaveLength(1);
  });

  it('ignores a short self-echo transcript while the assistant is speaking', async () => {
    const { brain, provider } = setup({ requireWakeWord: false });
    await brain.start();
    provider.callbacks.onResponseStarted?.();
    provider.emitAudio(new Int16Array(320));
    provider.callbacks.onAssistantText?.('我在呢，随时待命。', true);
    provider.emitTranscript('我在', true);
    await flush();

    expect(provider.canceled).toBeGreaterThan(0);
  });

  it('ignores an empty transcript when no local user speech happened', async () => {
    const { brain, provider } = setup({ requireWakeWord: false });
    await brain.start();
    provider.callbacks.onResponseStarted?.();
    provider.emitAudio(new Int16Array(320));
    provider.emitTranscript('', true);
    await flush();

    expect(provider.canceled).toBe(0);
  });

  it('ignores an empty transcript even after a local utterance', async () => {
    const { brain, provider } = setup({ requireWakeWord: false });
    await brain.start();
    provider.callbacks.onResponseStarted?.();
    provider.emitAudio(new Int16Array(320));
    provider.callbacks.onSpeechStarted?.();
    await new Promise((resolve) => setTimeout(resolve, 250));
    provider.callbacks.onSpeechStopped?.();
    provider.emitTranscript('', true);
    await flush();

    expect(provider.canceled).toBe(0);
  });

  it('suppresses the model reply after a bare stop', async () => {
    const { brain, provider, audioOut } = setup({ requireWakeWord: false });
    await brain.start();

    provider.callbacks.onResponseStarted?.();
    provider.emitAudio(new Int16Array(320));
    provider.emitTranscript('停一下', true);
    await flush();

    expect(provider.canceled).toBeGreaterThan(0);
    expect(brain.shouldSuppressReply()).toBe(true);

    const audioBefore = audioOut.length;
    provider.callbacks.onResponseStarted?.();
    provider.emitAudio(new Int16Array(320));
    provider.callbacks.onAssistantText?.('好的，已暂停当前任务。', true);
    await flush();

    expect(audioOut.length).toBe(audioBefore);
  });

  it('sleeps after the awake timeout', async () => {
    vi.useFakeTimers();
    const { brain, provider, wakeEvents } = setup({ awakeTimeoutMs: 1000 });
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);

    expect(brain.getState().awake).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(brain.getState().awake).toBe(false);
    expect(wakeEvents).toContain('sleep');
  });

  it('stays awake when wake word is disabled', async () => {
    vi.useFakeTimers();
    const { brain } = setup({
      requireWakeWord: false,
      awakeTimeoutMs: 0,
    });
    await brain.start();

    expect(brain.getState().awake).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(brain.getState().awake).toBe(true);
  });

  it('speaks proactive task completion', async () => {
    const { brain, provider, adapter } = setup();
    await brain.start();
    provider.emitTranscript('Hello CYRVIS', true);
    provider.emitTranscript('Open Notepad and type hello', true);
    provider.emitToolCall({
      name: 'start_gui_task',
      args: { instruction: 'Open Notepad and type hello' },
      callId: 'call-start',
    });
    await flush();

    adapter.finish('任务完成');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();

    expect(provider.spoken.some((text) => text.includes('完成'))).toBe(true);
  });

  it('starts awake when wake word is disabled', async () => {
    const { brain, provider, audioOut } = setup({ requireWakeWord: false });
    await brain.start();

    provider.emitAudio(new Int16Array([7, 8]));
    expect(brain.getState().awake).toBe(true);
    expect(audioOut).toHaveLength(1);
  });
});
