import { afterEach, describe, expect, it, vi } from 'vitest';

import { QwenTtsStreamingPlayer } from './qwenTtsStream';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Renderer Qwen TTS player', () => {
  it('streams text through main IPC and schedules returned PCM', async () => {
    const events: {
      handler:
        | ((event: {
            type: 'completed' | 'audio';
            sessionId: string;
            delta?: string;
            sampleRate?: number;
          }) => void)
        | null;
    } = { handler: null };
    const start = vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      voice: 'voice',
      sampleRate: 24_000,
      format: 'pcm',
      protocol: 'qwen3-realtime',
    });
    const append = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn().mockImplementation(async () => {
      events.handler?.({ type: 'completed', sessionId: 'session-1' });
    });
    const cancel = vi.fn().mockResolvedValue(undefined);

    class MockAudioContext {
      state = 'running';
      destination = {};
      private readonly startedAt = Date.now();
      get currentTime() {
        return (Date.now() - this.startedAt) / 1000;
      }
      async resume() {}
      async close() {}
      createBuffer() {
        return { duration: 0.1, copyToChannel: vi.fn() };
      }
      createBufferSource() {
        return {
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null,
        };
      }
    }
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('window', {
      setTimeout,
      electron: {
        voice: {
          startQwenTtsSession: start,
          appendQwenTtsText: append,
          finishQwenTtsSession: finish,
          cancelQwenTtsSession: cancel,
          onQwenTtsEvent: (handler: typeof events.handler) => {
            events.handler = handler;
            return () => {
              events.handler = null;
            };
          },
        },
      },
    });

    const onFirstAudio = vi.fn();
    const onPlaybackReference = vi.fn();
    const player = new QwenTtsStreamingPlayer({
      requestId: 'request-1',
      onFirstAudio,
      onPlaybackReference,
    });
    await player.start();
    player.appendText('这是一个测试分句，');
    await vi.waitFor(() => {
      expect(append).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          commit: true,
        }),
      );
    });
    events.handler?.({
      type: 'audio',
      sessionId: 'session-1',
      delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
      sampleRate: 24_000,
    });
    await vi.waitFor(() => expect(onFirstAudio).toHaveBeenCalledOnce());
    expect(onPlaybackReference).toHaveBeenCalledWith(
      new Int16Array([1, 2]),
      expect.any(Number),
      24_000,
    );
    await player.finish();
    expect(finish).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });
});
