import { useCallback, useEffect, useRef, useState } from 'react';

import {
  isActiveTaskStatus,
  type CyrvisActivityEvent,
  type CyrvisMemorySnapshot,
  type CyrvisVoiceState,
} from '@shared/cyrvis';

export type FloatingEntryKind = 'user' | 'assistant' | 'activity' | 'error';

export interface FloatingEntry {
  id: string;
  kind: FloatingEntryKind;
  text: string;
  timestamp: number;
}

type AudioMode = 'headset' | 'speaker';
type PttState = { active: boolean; mode: boolean };

const MAX_ENTRIES = 200;
let entrySequence = 0;

const createEntry = (
  kind: FloatingEntryKind,
  text: string,
  id = `voice-entry-${Date.now()}-${entrySequence++}`,
  timestamp = Date.now(),
): FloatingEntry => ({
  id,
  kind,
  text: text.trim(),
  timestamp,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function useFloatingVoice() {
  const [state, setState] = useState<CyrvisVoiceState | null>(null);
  const [entries, setEntries] = useState<FloatingEntry[]>([]);
  const [transcript, setTranscript] = useState('');
  const [transcriptFinal, setTranscriptFinal] = useState(false);
  const [assistantText, setAssistantText] = useState('');
  const [assistantFinal, setAssistantFinal] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [playbackActive, setPlaybackActive] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [audioMode, setAudioModeState] = useState<AudioMode>('headset');
  const [ptt, setPtt] = useState<PttState>({ active: false, mode: false });
  const [error, setError] = useState<string | null>(null);

  const lastEntryRef = useRef<{ key: string; at: number } | null>(null);
  const assistantTextStartedRef = useRef(false);

  const appendEntry = useCallback(
    (
      kind: FloatingEntryKind,
      text: string,
      id?: string,
      timestamp?: number,
    ) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const now = timestamp ?? Date.now();
      const key = `${kind}:${trimmed}`;
      if (
        !id &&
        lastEntryRef.current?.key === key &&
        now - lastEntryRef.current.at < 1000
      ) {
        return;
      }

      lastEntryRef.current = { key, at: now };
      setEntries((current) =>
        [
          ...current.filter((entry) => !id || entry.id !== id),
          createEntry(kind, trimmed, id, now),
        ]
          .sort((left, right) => left.timestamp - right.timestamp)
          .slice(-MAX_ENTRIES),
      );
    },
    [],
  );

  const clearEntries = useCallback(() => {
    setEntries([]);
    lastEntryRef.current = null;
  }, []);

  const appendActivity = useCallback(
    (event: CyrvisActivityEvent) => {
      appendEntry(
        event.kind === 'error' ? 'error' : 'activity',
        event.text,
        event.id,
        event.createdAt,
      );
    },
    [appendEntry],
  );

  useEffect(() => {
    let disposed = false;
    const loadInitialState = async () => {
      const [voiceState, mode, pttState, capture, memory] = await Promise.all([
        window.electron.voice.getState() as Promise<CyrvisVoiceState | null>,
        window.electron.voice.getAudioMode(),
        window.electron.voice.getPtt(),
        window.electron.voice.getCaptureReady(),
        window.electron.voice.getMemory() as Promise<CyrvisMemorySnapshot>,
      ]);
      if (disposed) {
        return;
      }
      setState((current) => current ?? voiceState);
      setAudioModeState(mode.mode);
      setPtt(pttState);
      setMicReady((current) => current || capture.ready);
      const memoryEntries: FloatingEntry[] = [
        ...memory.turns.map((turn) =>
          createEntry(turn.role, turn.text, turn.id, turn.createdAt),
        ),
        ...memory.activities.map((event) =>
          createEntry(
            event.kind === 'error' ? 'error' : 'activity',
            event.text,
            event.id,
            event.createdAt,
          ),
        ),
      ]
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-MAX_ENTRIES);
      setEntries((current) =>
        [
          ...current,
          ...memoryEntries.filter(
            (entry) => !current.some((existing) => existing.id === entry.id),
          ),
        ]
          .sort((left, right) => left.timestamp - right.timestamp)
          .slice(-MAX_ENTRIES),
      );
    };

    void loadInitialState().catch((loadError) => {
      if (!disposed) {
        setError(errorMessage(loadError));
      }
    });

    const cleanups = [
      window.electron.voice.onState((next) => {
        setState(next);
      }),
      window.electron.voice.onActivity((event) => {
        appendActivity(event);
      }),
      window.electron.voice.onTranscript(({ text, final }) => {
        setTranscript(text);
        setTranscriptFinal(final);
        if (final) {
          setThinking(false);
          if (text.trim() && !assistantTextStartedRef.current) {
            setAssistantText('');
          }
          if (text.trim()) {
            appendEntry('user', text);
          }
        }
      }),
      window.electron.voice.onAssistantText(({ text, final }) => {
        setThinking(false);
        setAssistantText((current) => {
          if (!assistantTextStartedRef.current) {
            assistantTextStartedRef.current = true;
            return text;
          }
          return final ? text : current + text;
        });
        setAssistantFinal(final);
        if (final) {
          appendEntry('assistant', text);
        }
      }),
      window.electron.voice.onSpeechStarted(() => {
        setTranscript('');
        setTranscriptFinal(false);
        assistantTextStartedRef.current = false;
        setAssistantFinal(false);
        setThinking(false);
        setError(null);
      }),
      window.electron.voice.onError(({ message }) => {
        setThinking(false);
        setPlaybackActive(false);
        setError(message);
        appendEntry('error', message);
      }),
      window.electron.voice.onThinking(() => {
        setThinking(true);
      }),
      window.electron.voice.onResponseStarted(() => {
        assistantTextStartedRef.current = false;
        setThinking(false);
        setPlaybackActive(true);
      }),
      window.electron.voice.onResponseStopped(() => {
        setPlaybackActive(false);
      }),
      window.electron.voice.onResponseDone(() => {
        setThinking(false);
        setPlaybackActive(false);
      }),
      window.electron.voice.onWake(() => {
        setTranscript('');
        setTranscriptFinal(false);
        setAssistantText('');
        assistantTextStartedRef.current = false;
        setAssistantFinal(false);
        setError(null);
      }),
      window.electron.voice.onSleep(() => {
        setThinking(false);
        setPlaybackActive(false);
      }),
      window.electron.voice.onCaptureReady(() => {
        setMicReady(true);
        setError(null);
      }),
      window.electron.voice.onCaptureError(({ message }) => {
        setMicReady(false);
        setError(message);
        appendEntry('error', message);
      }),
      window.electron.voice.onAudioMode(({ mode: nextMode }) => {
        setAudioModeState(nextMode);
      }),
      window.electron.voice.onPttState((next) => {
        setPtt(next);
      }),
    ];

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [appendActivity, appendEntry]);

  const runVoiceAction = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      const result = (await action()) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (result?.ok === false) {
        setError(result.error || '语音服务暂不可用');
      }
      return result;
    } catch (actionError) {
      const message = errorMessage(actionError);
      setError(message);
      return null;
    }
  }, []);

  const start = useCallback(
    () => runVoiceAction(() => window.electron.voice.start()),
    [runVoiceAction],
  );

  const sleep = useCallback(() => {
    window.electron.voice.sleep();
  }, []);

  const wake = useCallback(() => {
    window.electron.voice.forceAwake();
  }, []);

  const interrupt = useCallback(() => {
    window.electron.voice.bargeIn();
  }, []);

  const togglePtt = useCallback(
    () => runVoiceAction(() => window.electron.voice.togglePtt()),
    [runVoiceAction],
  );

  const toggleAudioMode = useCallback(async () => {
    const nextMode: AudioMode = audioMode === 'speaker' ? 'headset' : 'speaker';
    setAudioModeState(nextMode);
    await runVoiceAction(() => window.electron.voice.setAudioMode(nextMode));
  }, [audioMode, runVoiceAction]);

  const cancelTask = useCallback(
    () => runVoiceAction(() => window.electron.voice.cancelTask()),
    [runVoiceAction],
  );

  const pauseTask = useCallback(
    () => runVoiceAction(() => window.electron.voice.pauseTask()),
    [runVoiceAction],
  );

  const resumeTask = useCallback(
    () => runVoiceAction(() => window.electron.voice.resumeTask()),
    [runVoiceAction],
  );

  return {
    state,
    entries,
    transcript,
    transcriptFinal,
    assistantText,
    assistantFinal,
    thinking,
    playbackActive,
    micReady,
    audioMode,
    ptt,
    error,
    taskActive: state ? isActiveTaskStatus(state.task.status) : false,
    clearEntries,
    start,
    sleep,
    wake,
    interrupt,
    togglePtt,
    toggleAudioMode,
    cancelTask,
    pauseTask,
    resumeTask,
  };
}
