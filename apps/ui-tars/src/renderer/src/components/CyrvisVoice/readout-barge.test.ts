// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useVoiceAudio } from './useVoiceAudio';

vi.mock('@renderer/hooks/useSetting', () => ({
  useSetting: () => ({ settings: { voiceEngine: 'omni' } }),
}));
const playback = vi.hoisted(() => ({
  stop: vi.fn(),
  play: vi.fn(),
  reference: undefined as
    | undefined
    | ((pcm: Int16Array, startedAt: number) => void),
}));
vi.mock('./webaudio-player', () => ({
  WebAudioStreamPlayer: class {
    constructor(
      _idle: unknown,
      _error: unknown,
      reference: typeof playback.reference,
    ) {
      playback.reference = reference;
    }
    play = playback.play;
    stop = playback.stop;
  },
}));

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  playback.reference = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

async function setupVoice(outputLabel?: string) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const events = new Map<string, (...args: any[]) => void>();
  const methods: Record<string, any> = {
    isTestMode: true,
    getPtt: vi.fn(async () => ({ active: false, mode: false })),
    getAudioMode: vi.fn(async () => ({ mode: 'headset' })),
    start: vi.fn(async () => ({ ok: true })),
  };
  const voice = new Proxy(methods, {
    get(target, key: string) {
      if (!(key in target)) {
        target[key] = key.startsWith('on')
          ? (callback: (...args: any[]) => void) => {
              events.set(key, callback);
              return () => events.delete(key);
            }
          : vi.fn();
      }
      return target[key];
    },
  });
  (window as any).electron = { voice };
  const track = {
    label: 'Built-in microphone',
    getSettings: () => ({}),
    stop: vi.fn(),
    addEventListener: vi.fn(),
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      })),
      enumerateDevices: vi.fn(async () =>
        outputLabel
          ? [{ kind: 'audiooutput', deviceId: 'default', label: outputLabel }]
          : [],
      ),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  const processors: any[] = [];
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 48_000;
      destination = {};
      resume = async () => {};
      close = async () => {};
      createMediaStreamSource = node;
      createGain = () => ({ ...node(), gain: { value: 0 } });
      createScriptProcessor() {
        const processor = { ...node(), onaudioprocess: null };
        processors.push(processor);
        return processor;
      }
    },
  );
  let audio!: ReturnType<typeof useVoiceAudio>;
  function Harness() {
    audio = useVoiceAudio();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(React.createElement(Harness)));
  await act(async () => audio.start());
  expect(audio.micReady).toBe(true);
  return { audio: () => audio, voice, events, processors };
}

it('keeps gaze readout playing through mic energy while feeding stop-word audio and retaining explicit stop', async () => {
  const { audio: getAudio, voice, events, processors } = await setupVoice();
  const audio = getAudio();
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(1, {
    audio: expect.objectContaining({ echoCancellation: true }),
  });
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(2, {
    audio: expect.objectContaining({ echoCancellation: false }),
  });
  await act(async () => {
    events.get('onState')!({
      awake: true,
      readoutGuardUntil: Date.now() + 45_000,
    });
    events.get('onAudio')!(new Int16Array([10, 20]));
  });
  playback.stop.mockClear();
  const loudMic = {
    inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.2) },
  };
  await act(async () => {
    for (let i = 0; i < 5; i++) processors[0].onaudioprocess(loudMic);
    processors[1].onaudioprocess(loudMic); // Dedicated KWS capture stays live.
  });
  expect(voice.cancelSpeechOnly).not.toHaveBeenCalled();
  expect(playback.stop).not.toHaveBeenCalled();
  expect(voice.sendKeywordAudio).toHaveBeenCalled();
  await act(async () => audio.interrupt());
  expect(voice.bargeIn).toHaveBeenCalledOnce();
  expect(playback.stop).toHaveBeenCalledOnce();
  await act(async () => {
    events.get('onState')!({ awake: true, readoutGuardUntil: 0 });
    events.get('onAudio')!(new Int16Array([10, 20]));
    for (let i = 0; i < 5; i++) processors[0].onaudioprocess(loudMic);
  });
  expect(voice.cancelSpeechOnly).toHaveBeenCalledOnce();
});

// Match the actual reference resampling, then upsample to the capture rate.
function makeReference(seed: number) {
  let state = seed;
  return Int16Array.from({ length: 96_000 }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return Math.round((state / 0xffffffff - 0.5) * 24_000);
  });
}
function micFrame(reference: Int16Array, elapsedMs: number, nearEnd: boolean) {
  const end = Math.floor(elapsedMs * 16);
  return Float32Array.from({ length: 4095 }, (_, index) => {
    const position = (end - 1365 + Math.floor(index / 3)) * 1.5;
    const left = Math.floor(position);
    const fraction = position - left;
    const echo =
      (reference[left] * (1 - fraction) + reference[left + 1] * fraction) /
      32768;
    const user = nearEnd ? Math.sin(Math.floor(index / 3) * 0.217) * 0.3 : 0;
    return echo * 0.6 + user;
  });
}

it('protects speaker playback from loud echo, then accepts sustained independent speech even during readout', async () => {
  vi.useFakeTimers();
  const base = 100_000;
  vi.setSystemTime(base);
  const { audio, voice, events, processors } = await setupVoice();
  await act(async () => audio().selectAudioMode('speaker'));
  await act(async () => {
    events.get('onState')!({ awake: true, readoutGuardUntil: base + 45_000 });
    events.get('onAudio')!(new Int16Array([10, 20]));
  });
  const reference = makeReference(27);
  playback.reference!(reference, base);
  playback.stop.mockClear();
  await act(async () => {
    for (let ms = 1000; ms <= 1400; ms += 100) {
      vi.setSystemTime(base + ms);
      processors[0].onaudioprocess({
        inputBuffer: { getChannelData: () => micFrame(reference, ms, false) },
      });
    }
  });
  expect(voice.cancelSpeechOnly).not.toHaveBeenCalled();
  expect(playback.stop).not.toHaveBeenCalled();
  await act(async () => {
    for (let ms = 1500; ms <= 1700; ms += 100) {
      vi.setSystemTime(base + ms);
      processors[0].onaudioprocess({
        inputBuffer: { getChannelData: () => micFrame(reference, ms, true) },
      });
    }
  });
  expect(voice.cancelSpeechOnly).toHaveBeenCalledExactlyOnceWith({
    speakerVerified: true,
  });
  expect(playback.stop).toHaveBeenCalledOnce();
  expect(voice.beginUtterance).toHaveBeenCalled();
});

it('keeps speaker playback protected when reference audio has not arrived; explicit stop remains available', async () => {
  const { audio, voice, events, processors } = await setupVoice();
  await act(async () => audio().selectAudioMode('speaker'));
  await act(async () => {
    events.get('onAudio')!(new Int16Array([10, 20]));
    for (let i = 0; i < 10; i++)
      processors[0].onaudioprocess({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) },
      });
  });
  expect(voice.cancelSpeechOnly).not.toHaveBeenCalled();
  await act(async () => audio().interrupt());
  expect(voice.bargeIn).toHaveBeenCalledOnce();
});

it('protects actual built-in speakers even if the saved UI mode says headset', async () => {
  const { events, voice, processors } = await setupVoice(
    'Default - MacBook Pro Speakers',
  );
  await act(async () => {
    events.get('onAudio')!(new Int16Array([10, 20]));
    for (let i = 0; i < 8; i++)
      processors[0].onaudioprocess({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) },
      });
  });
  expect(voice.setOutput).toHaveBeenCalledWith(
    'Default - MacBook Pro Speakers',
  );
  expect(voice.cancelSpeechOnly).not.toHaveBeenCalled();
});
