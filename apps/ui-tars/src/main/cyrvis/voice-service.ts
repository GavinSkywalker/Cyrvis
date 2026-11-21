import { isSpeakerOutputLabel } from '@shared/audioOutput';
import { gazeChat } from './gaze/chat';
import { DesktopGazeCursor } from './gaze/cursor';
import { gazeInspector } from './gaze/desktop-inspector';
import { getDesktopGaze, setDesktopGaze } from './gaze/context';
import { ProactiveGaze } from './gaze/proactive';
import type { GazeAction } from './gaze/suggestions';
import {
  selectGazeActionContext,
  type GazeActionContext,
} from './gaze/actions';
import { GazeObjectTracker } from './gaze/object-tracker';
import { NativeGazeObjects } from './gaze/native-objects';
import { showCompanion } from '@main/window';
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';

import * as env from '@main/env';
import { logger } from '@main/logger';
import { getCompanionStore } from '@main/store/companion';
import { resolveCompanionSkin } from '@shared/companion-skins';
import { SettingStore } from '@main/store/setting';
import { breezeTtsService } from '@main/services/breezeTts';
import { qwenTtsRealtimeService } from '@main/services/qwenTtsRealtime';
import { localTtsService } from './voice/local-tts';
import {
  describeControllerEvent,
  describeVoiceToolCall,
  type CyrvisActivityEvent,
  type CyrvisMemoryTurnRole,
  type VoiceToolName,
} from '@shared/cyrvis';

import { startCaptureService, type CaptureService } from './capture-service';
import { CodingAgentService } from './coding-agent';
import { CyrvisController } from './controller';
import { openApp } from './desktop-actions';
import { ElectronGUIAdapter } from './gui-adapter';
import { KeywordGate } from './keyword-gate';
import { voiceMemoryService } from './memory';
import { SpeakerEchoDetector, type SpeakerEchoAnalysis } from './speaker-barge';
import { isLikelySpeakerEcho } from './speaker-echo';
import { composeContextSections, type DynamicContextStore } from './context';
import { LocalDesktopHost } from './tools/desktop-host';
import { createFastToolMatrix } from './tools';
import { SystemStateStore } from './system/system-state';
import { CascadeVoiceProvider } from './voice/cascade-provider';
import { QwenOmniProvider } from './voice/qwen-omni';
import type { InteractiveVoiceProvider } from './voice/provider';
import { createPendingIntentClassifier } from './voice/pending-intent-classifier';
import { buildVoiceToolSurface } from './voice/tool-surface';
import { VoiceBrain, type VoiceBrainState } from './voice-brain';
import type { ControllerEvent } from './types';

interface VoiceService {
  brain: VoiceBrain;
  provider: InteractiveVoiceProvider;
  controller: CyrvisController;
  systemState: SystemStateStore;
  dynamicContext?: DynamicContextStore;
}

let service: VoiceService | null = null;
let lastGazeVoiceActivityAt = 0;
let activeVoiceReadoutId: string | undefined;
let replayedGazeId: string | undefined;
gazeChat.subscribe((turn) => {
  if (turn.phase === 'capturing') replayedGazeId = undefined;
  broadcast('cyrvis:gaze:chat-turn', turn);
});
const speakGazeAnswer = (answer: string) => {
  const id = gazeInspector.getStatus().id;
  if (!service) {
    if (id) gazeChat.speech(id, 'failed', '请先开启语音助手，再点击重新播报。');
    return;
  }
  if (id) service.brain.speakRequestedReply(answer, id);
  else service.brain.speakRequestedReply(answer);
};
const proactiveGaze = new ProactiveGaze({
  onEvent: (event, detail) =>
    logger.info('[cyrvis gaze proactive]', { event, detail }),
  inspect: (gaze) => gazeInspector.suggest(gaze),
  cancel: () => gazeInspector.cancelProactive(),
  canInspect: () => !proactiveGazeBlockReason(),
  blockedReason: () => proactiveGazeBlockReason() || '',
  onSuggestion: (suggestion) => {
    if (!service?.brain.offerGazeSuggestion(suggestion)) return false;
    emitActivity('speech', suggestion.speech);
    return true;
  },
});
function proactiveGazeBlockReason(): string | undefined {
  if (!service || !captureReady) return '请先开启语音助手和麦克风。';
  if (!gazeInspector.getStatus().enabled) return '请先开启 AI 看屏。';
  if (service.provider.isReady?.() === false)
    return '语音正在连接，连好后恢复提醒。';
  const reason = service.brain.gazeSuggestionBlockReason();
  if (reason) return reason;
  if (['capturing', 'thinking'].includes(gazeInspector.getStatus().phase))
    return '正在处理上一张截图，完成后恢复提醒。';
  if (Date.now() - lastGazeVoiceActivityAt < 3000)
    return '对话刚结束，稍后恢复注视计时。';
  return undefined;
}
const providerContextMaxChars = (() => {
  const value = Number(process.env.CYRVIS_CONTEXT_MAX_CHARS);
  return Number.isFinite(value) && value >= 2_000 ? value : 12_000;
})();
let selectedVoiceEngine: 'cascade' | 'omni' = env.voiceEngine;
// Hybrid mode: the main Renderer owns the microphone (and its AEC reference),
// so the hidden capture window must not feed a second copy of the same audio
// into the omni provider.
const rendererCapture =
  selectedVoiceEngine === 'omni'
    ? process.env.CYRVIS_RENDERER_CAPTURE !== '0'
    : process.env.CYRVIS_RENDERER_CAPTURE === '1';
let captureService: CaptureService | null = null;
let captureReady = false;
let captureGeneration = 0;
let captureRetryTimer: ReturnType<typeof setTimeout> | null = null;
let captureRetryAttempts = 0;
let assistantPlaybackActive = false;
let capturePreroll: Int16Array[] = [];
let lastCaptureLogAt = 0;
// Two selectable audio modes:
// - headset: capture without AEC + full voice barge-in (verified)
// - speaker: reference-aware echo gating plus an interrupt probe, so the
//   assistant can still be interrupted while its own audio is playing.
let audioMode: 'headset' | 'speaker' = 'headset';
let speakerOutputMode = false;
// The output device is independent of the voice mode. If playback is routed
// to Realtek/NVIDIA while the UI still says "headset", the low-energy headset
// barge must not run: the mic hears the assistant's own speaker output.
let externalOutput = false;
let speakerGuardUntil = 0;
let lastAssistantText = '';
let lastAssistantAt = 0;
let ipcRegistered = false;
let testAudioActive = false;
let pttActive = false;
// Hands-free by default. PTT remains available as a fallback mode.
const pttMode = false;

/** Speak a proactive reminder through the active realtime voice session. */
export const speakProactiveText = (text: string): boolean => {
  if (!service || !text.trim() || service.provider.isConnected?.() !== true) {
    return false;
  }
  service.provider.speak(text);
  return true;
};

/** Historical greetings must yield to the current object/question/readout. */
export const shouldDeferFollowUpSpeech = (): boolean =>
  !!service &&
  (assistantPlaybackActive ||
    service.brain.isReadoutSpeechActive() ||
    !!service.brain.gazeSuggestionBlockReason() ||
    ['inspecting', 'waiting'].includes(proactiveGaze.getStatus().phase));

/** Show locally spoken proactive text in the voice conversation as well. */
export const publishProactiveText = (text: string): void => {
  const normalized = text.trim();
  if (!normalized) return;
  broadcast('cyrvis:voice:assistant', { text: normalized, final: true });
  void voiceMemoryService.appendTurn('assistant', normalized).catch((error) => {
    logger.warn('[cyrvis follow-up] message persist failed', error);
  });
};

const CAPTURE_BARGE_THRESHOLD = 1500;
const CAPTURE_BARGE_SUSTAIN_MS = 180;
const SPEAKER_REVERB_GUARD_MS = 1400;
// A bare "停" is often only 200-300ms. The old 220ms decay + 140ms confirm
// discarded the whole word, so every short stop failed the probe.
const SPEAKER_PROBE_DECAY_MS = 220;
const SPEAKER_PROBE_CONFIRM_MS = 140;
const HEADSET_PROBE_DECAY_MS = 80;
const HEADSET_PROBE_CONFIRM_MS = 100;
const SPEAKER_PROBE_TIMEOUT_MS = 700;
const SPEAKER_PROBE_THRESHOLD = 1100;
const SPEAKER_RESUME_SUPPRESS_MS = 550;
const SPEAKER_DIRECT_PREROLL_CHUNKS = 24;
const HEADSET_REVERB_GUARD_MS = 900;
// Fast fallback when KWS misses a very short bare "停": require 300ms of
// near-end energy, then verify the same 1s window with the local speaker
// embedding before interrupting. This replaces the old 13s-late direct path.
const VOICE_FALLBACK_SUSTAIN_MS = 200;
const VOICE_FALLBACK_THRESHOLD = 1200;
const VOICE_FALLBACK_COOLDOWN_MS = 700;
const VOICE_FALLBACK_VOICEPRINT = 0.22;
const BARGE_MIC_TAIL_MS = {
  cascade: 150,
  omni: 800,
} as const;
const BARGE_SAMPLE_DIR = path.resolve(process.cwd(), '../../doc/kws-lab');
const BARGE_SAMPLE_MAX_CHUNKS = 150; // 3s at 20ms
const BARGE_SAMPLE_DUMP_INTERVAL_MS = 3000;

const AUDIO_SCRIPT_CANDIDATES = () => [
  path.resolve(
    app.getAppPath(),
    '../../scripts/cyrvis/audio/set-default-output.ps1',
  ),
  path.resolve(process.cwd(), 'scripts/cyrvis/audio/set-default-output.ps1'),
  path.resolve(
    process.cwd(),
    '../../scripts/cyrvis/audio/set-default-output.ps1',
  ),
];

const findAudioScript = (): string | null =>
  AUDIO_SCRIPT_CANDIDATES().find((candidate) => fs.existsSync(candidate)) ??
  null;

/**
 * Windows sometimes keeps the Electron audio session on the Bluetooth headset
 * even when <audio>.setSinkId() names the Realtek endpoint. Switching the
 * Windows default endpoint per voice mode makes both paths agree.
 */
const switchWindowsDefaultOutput = async (
  kind: 'headset' | 'speaker',
): Promise<void> => {
  if (process.platform !== 'win32') return;
  const script = findAudioScript();
  if (!script) {
    logger.warn('[cyrvis voice] audio endpoint script not found');
    return;
  }
  await new Promise<void>((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Kind',
        kind,
      ],
      { timeout: 15_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          logger.error('[cyrvis voice] switch default output failed', {
            kind,
            error: error.message,
            stderr: stderr?.trim(),
          });
        } else {
          logger.info('[cyrvis voice] default output switched', {
            kind,
            result: stdout.trim(),
          });
        }
        resolve();
      },
    );
  });
};

interface SpeakerProbeState {
  startedAt: number;
  speechMs: number;
  chunks: Int16Array[];
}

const speakerEchoDetector = new SpeakerEchoDetector();
let speakerProbe: SpeakerProbeState | null = null;
let speakerCandidateMs = 0;
// Headset mode has no meaningful speaker echo; use direct energy barge so a
// short "停" is never lost to a 700ms probe confirmation window.
let headsetBargeMs = 0;
let speakerResumeSuppressUntil = 0;
let lastSpeakerDiagnosticAt = 0;
let voiceprintPending = false;
let lastVoiceprintAt = 0;
let voiceprintResidual: Int16Array[] = [];
const VOICEPRINT_COOLDOWN_MS = 600;
let speakerBargeStopPending = false;
let speakerBargeStopTimer: ReturnType<typeof setTimeout> | null = null;
interface BargeTrace {
  responseStartedAt: number;
  speechOnsetAt: number | null;
  detectedAt: number | null;
  verifiedAt: number | null;
  bargeAt: number | null;
  keyword?: string;
  score?: number | null;
  accepted?: boolean;
}
let bargeTrace: BargeTrace | null = null;
let voiceOnsetAt = 0;
let bargeSampleBuffer: Int16Array[] = [];
// Continuous ~1s buffer that is NOT cleared at response start. The normal
// capturePreroll is cleared so a new response starts clean, which left the
// first 0.5s with no voiceprint window and produced score=null near-misses.
const keywordPreroll: Int16Array[] = [];
// Aligned playback reference for relative user-vs-TTS verification.
let referencePreroll: Float32Array[] = [];
let lastBargeDumpAt = 0;
let keywordGate: KeywordGate | null = null;
let keywordRejectUntil = 0;
// Runtime A/B switch (Ctrl+Alt+E): pure 1500/180ms energy barge, including
// external output. Off = KWS + voiceprint. Started from
// CYRVIS_EXTERNAL_ENERGY_BARGE for reproducing the 11:00 behavior.
let energyOnlyBarge =
  selectedVoiceEngine === 'cascade' ||
  process.env.CYRVIS_EXTERNAL_ENERGY_BARGE === '1';
let voiceFallbackMs = 0;
let lastVoiceFallbackAt = 0;
let lastDeviceChangeRetryAt = 0;

const pushCapturePreroll = (pcm16: Int16Array): void => {
  capturePreroll.push(pcm16.slice());
  // Keep ~1s so the voiceprint verifier has enough audio for a stable
  // embedding (ERes2Net works best with >=0.6s).
  if (capturePreroll.length > 50) {
    capturePreroll.shift();
  }
};

const averageAbsoluteInt16 = (samples: Int16Array): number => {
  if (!samples.length) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    total += Math.abs(samples[index]);
  }
  return total / samples.length / 0x8000;
};

const writePcm16Wav = (file: string, chunks: Int16Array[]): void => {
  const dataLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  const data = Buffer.alloc(dataLength);
  let offset = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      data.writeInt16LE(chunk[index], offset);
      offset += 2;
    }
  }
  fs.writeFileSync(file, Buffer.concat([header, data]));
};

const dumpBargeFailure = (
  reason: string,
  keyword?: string,
  score?: number | null,
): void => {
  if (process.env.CYRVIS_KWS_DUMP_FAILURES !== '1') {
    return;
  }
  const now = Date.now();
  if (now - lastBargeDumpAt < BARGE_SAMPLE_DUMP_INTERVAL_MS) {
    return;
  }
  lastBargeDumpAt = now;
  const chunks = bargeSampleBuffer.slice(-BARGE_SAMPLE_MAX_CHUNKS);
  if (!chunks.length) {
    return;
  }
  try {
    fs.mkdirSync(BARGE_SAMPLE_DIR, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const file = path.join(BARGE_SAMPLE_DIR, `failed-${stamp}-${reason}.wav`);
    writePcm16Wav(file, chunks);
    logger.info('[cyrvis kws] dumped failure sample', {
      file,
      reason,
      keyword: keyword ?? null,
      score: score ?? null,
    });
  } catch (error) {
    logger.warn('[cyrvis kws] failure sample dump failed', error);
  }
};

const recentForVerification = (): Int16Array[] => {
  const total = capturePreroll.reduce((sum, chunk) => sum + chunk.length, 0);
  return total >= 8000 ? capturePreroll : keywordPreroll;
};

const recentKeywordForVerification = (): Int16Array[] => {
  const total = keywordPreroll.reduce((sum, chunk) => sum + chunk.length, 0);
  return total >= 8000 ? keywordPreroll : [];
};

const feedHybridKeywordAudio = (pcm16: Int16Array): void => {
  if (!keywordGate?.available) {
    return;
  }
  keywordPreroll.push(pcm16.slice());
  if (keywordPreroll.length > 50) {
    keywordPreroll.shift();
  }
  const speakerPath = (speakerOutputMode || externalOutput) && !energyOnlyBarge;
  const ttsContainsStop = /停|暂停|停止/.test(lastAssistantText);
  const result = keywordGate.feed(pcm16, keywordPreroll.slice(), speakerPath, {
    ttsContainsStop,
    // The hybrid renderer owns TTS playback, so the main process has no
    // aligned playback reference. Direct stop words do not need it; when
    // the assistant is saying a stop word, the absolute voiceprint gate
    // still applies.
    reference: null,
  });
  if (result === 'rejected') {
    keywordRejectUntil = Date.now() + 600;
    speakerCandidateMs = 0;
  }
};

const recentReference = (): Float32Array | null => {
  const total = referencePreroll.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total < 8000) {
    return null;
  }
  const output = new Float32Array(total);
  let offset = 0;
  for (const chunk of referencePreroll) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
};

const resetSpeakerDetection = (): void => {
  speakerEchoDetector.reset();
  speakerProbe = null;
  speakerCandidateMs = 0;
  headsetBargeMs = 0;
  voiceFallbackMs = 0;
  referencePreroll = [];
  speakerResumeSuppressUntil = 0;
  voiceprintResidual = [];
};

const expectSpeakerBargeStop = (): void => {
  speakerBargeStopPending = true;
  if (speakerBargeStopTimer) {
    clearTimeout(speakerBargeStopTimer);
  }
  speakerBargeStopTimer = setTimeout(() => {
    speakerBargeStopTimer = null;
    speakerBargeStopPending = false;
  }, 1500);
};

const finishSpeakerBargeIn = (_buffered: Int16Array[]): void => {
  if (!service) {
    return;
  }

  speakerProbe = null;
  speakerCandidateMs = 0;
  expectSpeakerBargeStop();
  assistantPlaybackActive = false;
  speakerGuardUntil = 0;
  speakerEchoDetector.reset();
  capturePreroll = [];
  service.provider.bargeIn({ forceCommit: false });
  service.provider.muteMicFor(BARGE_MIC_TAIL_MS[selectedVoiceEngine]);
  service.brain.forceAwake();
  service.brain.handleBargeStop();
  broadcast('cyrvis:voice:response-stopped');
  emitActivity('speech', '已通过外放麦克风打断助手');
};

const resumeSpeakerPlayback = (): void => {
  speakerProbe = null;
  speakerCandidateMs = 0;
  speakerResumeSuppressUntil = Date.now() + SPEAKER_RESUME_SUPPRESS_MS;
  // Keep the playback references collected before the probe. Resetting them
  // here made the next analysis run with corr=0 and triggered a second probe
  // for the same sentence.
  speakerEchoDetector.setReferenceEnabled(true);
  broadcast('cyrvis:voice:playback-resume');
};

const startSpeakerProbe = (now: number): void => {
  speakerProbe = {
    startedAt: now,
    speechMs: 0,
    chunks: [],
  };
  speakerCandidateMs = 0;
  speakerEchoDetector.setReferenceEnabled(false);
  broadcast('cyrvis:voice:playback-pause');
  logger.info('[cyrvis speaker] playback paused for interrupt probe');
};

const handleSpeakerProbePcm = (
  pcm16: Int16Array,
  average: number,
  now: number,
): void => {
  const probe = speakerProbe;
  if (!probe) {
    return;
  }

  probe.chunks.push(pcm16.slice());
  if (probe.chunks.length > 100) {
    probe.chunks.shift();
  }
  // Speaker mode needs a longer decay: its own reverb tail was being counted
  // as user speech and confirmed false interruptions. Headset mode has almost
  // no echo, so it can accept a short 200ms "停".
  const decayMs = speakerOutputMode
    ? SPEAKER_PROBE_DECAY_MS
    : HEADSET_PROBE_DECAY_MS;
  const confirmMs = speakerOutputMode
    ? SPEAKER_PROBE_CONFIRM_MS
    : HEADSET_PROBE_CONFIRM_MS;
  const elapsed = now - probe.startedAt;
  if (elapsed < decayMs) {
    return;
  }

  const chunkMs = (pcm16.length / 16000) * 1000;
  if (average > SPEAKER_PROBE_THRESHOLD) {
    probe.speechMs += chunkMs;
  } else {
    probe.speechMs = Math.max(0, probe.speechMs - chunkMs);
  }

  if (probe.speechMs >= confirmMs) {
    logger.info('[cyrvis speaker] interrupt confirmed', {
      avg: Math.round(average),
      elapsed,
    });
    const dropSamples = Math.floor((decayMs * 16000) / 1000);
    const buffered: Int16Array[] = [];
    let remainingDrop = dropSamples;
    for (const chunk of probe.chunks) {
      if (remainingDrop >= chunk.length) {
        remainingDrop -= chunk.length;
        continue;
      }
      buffered.push(
        remainingDrop > 0 ? chunk.slice(remainingDrop) : chunk.slice(),
      );
      remainingDrop = 0;
    }
    finishSpeakerBargeIn(buffered);
    return;
  }

  if (elapsed >= SPEAKER_PROBE_TIMEOUT_MS) {
    logger.info('[cyrvis speaker] interrupt probe rejected', {
      elapsed,
      speechMs: Math.round(probe.speechMs),
    });
    resumeSpeakerPlayback();
  }
};

const voiceprintUrl = (): string | null => {
  const value = process.env.CYRVIS_VOICEPRINT_URL?.trim();
  return value ? value.replace(/\/$/, '') : null;
};

/**
 * Ask the local speaker-verification sidecar whether the last ~1s of mic audio
 * belongs to the enrolled user. Returns null when the service is unavailable
 * or not enrolled, so callers can fall back to the old barge policy.
 */
const verifyVoiceprint = async (): Promise<boolean | null> => {
  const base = voiceprintUrl();
  if (!base) {
    return null;
  }
  const source =
    voiceprintResidual.length > 0 ? voiceprintResidual : capturePreroll;
  const chunks = source.slice(-50);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total < 9600) {
    return null;
  }
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const response = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    });
    if (!response.ok) {
      logger.warn('[cyrvis voiceprint] verify failed', {
        status: response.status,
      });
      return null;
    }
    const result = (await response.json()) as {
      score?: number;
      match?: boolean;
      threshold?: number;
    };
    logger.info('[cyrvis voiceprint] verify', result);
    return typeof result.match === 'boolean' ? result.match : null;
  } catch (error) {
    logger.warn('[cyrvis voiceprint] unavailable', error);
    return null;
  } finally {
    voiceprintPending = false;
  }
};

const handleSpeakerPlaybackPcm = (
  pcm16: Int16Array,
  average: number,
  now: number,
  analysisOverride: SpeakerEchoAnalysis | null = null,
): void => {
  if (speakerProbe) {
    handleSpeakerProbePcm(pcm16, average, now);
    return;
  }

  const analysis = analysisOverride ?? speakerEchoDetector.analyze(pcm16, now);
  const residualAverage = averageAbsoluteInt16(analysis.residual);
  if (assistantPlaybackActive) {
    // Echo residual is a much better user-onset proxy than raw energy: the
    // assistant's own TTS subtracts out, while user speech remains.
    const nearEnd = residualAverage > 0.015 && average > 1200;
    if (nearEnd) {
      if (voiceOnsetAt === 0) {
        voiceOnsetAt = now;
      }
      if (bargeTrace && bargeTrace.speechOnsetAt === null) {
        bargeTrace.speechOnsetAt = voiceOnsetAt;
      }
    } else if (residualAverage < 0.004) {
      voiceOnsetAt = 0;
    }
  }
  voiceprintResidual.push(analysis.residual);
  if (voiceprintResidual.length > 50) {
    voiceprintResidual.shift();
  }
  if (now - lastSpeakerDiagnosticAt >= 1000) {
    lastSpeakerDiagnosticAt = now;
    logger.info('[cyrvis speaker] echo analysis', {
      avg: Math.round(average),
      ref: Math.round(analysis.referenceAverage * 0x8000),
      corr: Number(analysis.correlation.toFixed(3)),
      residual: Number(residualAverage.toFixed(4)),
      echo: analysis.likelyEcho,
      ambiguous: analysis.ambiguous,
    });
  }

  // The local KWS + voiceprint gate in handleCapturePcm owns all barge
  // decisions while it is available. The legacy energy/correlation path below
  // was measured taking up to 13 seconds to fire on the same utterance; keep
  // it only as a fallback when the KWS model could not be loaded.
  if (keywordGate?.available) {
    speakerCandidateMs = 0;
    return;
  }

  if (now < speakerResumeSuppressUntil) {
    speakerCandidateMs = 0;
    return;
  }

  const chunkMs = (pcm16.length / 16000) * 1000;
  if (average <= CAPTURE_BARGE_THRESHOLD || analysis.likelyEcho) {
    speakerCandidateMs = Math.max(0, speakerCandidateMs - chunkMs);
    return;
  }

  speakerCandidateMs += chunkMs;
  if (speakerCandidateMs < CAPTURE_BARGE_SUSTAIN_MS) {
    return;
  }

  // Speaker-verification gate: only an enrolled user's voice may interrupt.
  // This is what lets us ignore the assistant's own speaker output even when
  // its energy is higher than the user's voice.
  // The local KWS gate already performs speaker verification. Do not also
  // call the optional Python sidecar; when it is not running those requests
  // just fail noisily on every loud echo frame.
  if (
    voiceprintUrl() &&
    !keywordGate?.available &&
    !voiceprintPending &&
    now - lastVoiceprintAt >= VOICEPRINT_COOLDOWN_MS
  ) {
    lastVoiceprintAt = now;
    speakerCandidateMs = 0;
    voiceprintPending = true;
    const fallbackDirect = !analysis.ambiguous && analysis.referenceActive;
    void verifyVoiceprint().then((match) => {
      if (!assistantPlaybackActive) {
        return;
      }
      if (match === true) {
        logger.info('[cyrvis voiceprint] enrolled user; interrupt');
        finishSpeakerBargeIn(
          capturePreroll.slice(-SPEAKER_DIRECT_PREROLL_CHUNKS),
        );
      } else if (match === false) {
        logger.info('[cyrvis voiceprint] not the user; keep playing');
      } else if (fallbackDirect) {
        logger.info('[cyrvis voiceprint] fallback direct interrupt');
        finishSpeakerBargeIn(
          capturePreroll.slice(-SPEAKER_DIRECT_PREROLL_CHUNKS),
        );
      }
    });
    return;
  }

  // Missing references happen between WAV segments and during device
  // latency. In that window a loud speaker tail is indistinguishable from a
  // user, so fail closed and wait for the next valid playback reference.
  if (!analysis.referenceActive) {
    speakerCandidateMs = 0;
    return;
  }

  if (analysis.ambiguous) {
    // By default, do not pause playback to "probe" an ambiguous echo. On this
    // hardware the probe itself sounded like a brief stop and then resumed.
    // CYRVIS_SPEAKER_PROBE=1 restores the old pause-and-confirm behavior.
    if (process.env.CYRVIS_SPEAKER_PROBE === '1') {
      startSpeakerProbe(now);
    } else {
      speakerCandidateMs = 0;
    }
    return;
  }

  logger.info('[cyrvis speaker] direct interrupt detected', {
    avg: Math.round(average),
    corr: Number(analysis.correlation.toFixed(3)),
  });
  finishSpeakerBargeIn(capturePreroll.slice(-SPEAKER_DIRECT_PREROLL_CHUNKS));
};

/**
 * Microphone audio comes from a hidden renderer that never plays audio.
 * Playback lives in the main window; separating the two audio sessions is
 * what keeps the mic alive while the assistant speaks.
 */
const handleCapturePcm = (pcm16: Int16Array): void => {
  if (!service || !captureReady || !pcm16.length) {
    return;
  }

  let sum = 0;
  for (let i = 0; i < pcm16.length; i += 1) {
    sum += Math.abs(pcm16[i]);
  }
  const average = sum / pcm16.length;

  const now = Date.now();
  if (now - lastCaptureLogAt >= 1000) {
    lastCaptureLogAt = now;
    logger.info('[cyrvis capture] level', {
      avg: Math.round(average),
      playing: assistantPlaybackActive,
      mode: audioMode,
      externalOutput,
    });
  }

  pushCapturePreroll(pcm16);
  keywordPreroll.push(pcm16.slice());
  if (keywordPreroll.length > 50) {
    keywordPreroll.shift();
  }
  if (assistantPlaybackActive) {
    bargeSampleBuffer.push(pcm16.slice());
    if (bargeSampleBuffer.length > BARGE_SAMPLE_MAX_CHUNKS) {
      bargeSampleBuffer.shift();
    }
  }

  // Stop words are detected on the raw microphone signal, not on AEC output.
  // In the real double-talk sample, AEC3 removed the near-end "停一下" while
  // the raw signal kept it; a speaker-embedding gate then rejects the
  // assistant's own TTS saying "暂停". See doc/speaker-barge-solution.md.
  // Comparison switch: when on, both headset and external output use the
  // 11:00 1500/180ms energy path. When off, speaker output uses KWS +
  // voiceprint and headset output keeps its own energy path.
  const externalEnergyBarge = energyOnlyBarge;
  const speakerPath =
    (speakerOutputMode || externalOutput) && !externalEnergyBarge;
  // Headset/energy-only paths use raw energy for onset trace. Speaker mode
  // uses the echo-residual onset below, otherwise the assistant's own TTS
  // start looks like the user's speech onset and inflates the trace.
  if (assistantPlaybackActive && !speakerPath) {
    if (average > 1800) {
      if (voiceOnsetAt === 0) {
        voiceOnsetAt = now;
      }
      if (bargeTrace && bargeTrace.speechOnsetAt === null) {
        bargeTrace.speechOnsetAt = voiceOnsetAt;
      }
    } else if (average < 600) {
      voiceOnsetAt = 0;
    }
  }
  let speakerAnalysis: SpeakerEchoAnalysis | null = null;
  if (assistantPlaybackActive && speakerPath) {
    speakerAnalysis = speakerEchoDetector.analyze(pcm16, now);
    if (speakerAnalysis.reference) {
      referencePreroll.push(speakerAnalysis.reference);
      if (referencePreroll.length > 50) {
        referencePreroll.shift();
      }
    }
  }
  const ttsContainsStop = /停|暂停|停止/.test(lastAssistantText);
  if (assistantPlaybackActive && keywordGate && !externalEnergyBarge) {
    const keywordResult = keywordGate.feed(
      pcm16,
      recentForVerification(),
      speakerPath,
      {
        ttsContainsStop,
        reference: speakerAnalysis?.referenceActive ? recentReference() : null,
      },
    );
    if (keywordResult === 'triggered') {
      return;
    }
    if (keywordResult === 'rejected') {
      // This hit was the assistant's own voice (or not the enrolled user).
      // Do not let the legacy energy path turn the same echo into a barge.
      keywordRejectUntil = now + 600;
      speakerCandidateMs = 0;
      return;
    }
  }
  if (
    assistantPlaybackActive &&
    !externalEnergyBarge &&
    now < keywordRejectUntil
  ) {
    return;
  }

  // Fast fallback for a bare "停" that KWS misses: 300ms of near-end energy,
  // then the same local speaker embedding over the last 1s. This is much
  // faster than the legacy correlation path and never fires on the assistant's
  // own TTS (its embedding score is ~0.1).
  if (assistantPlaybackActive && speakerPath && keywordGate?.available) {
    const chunkMs = (pcm16.length / 16000) * 1000;
    if (average > VOICE_FALLBACK_THRESHOLD) {
      voiceFallbackMs += chunkMs;
    } else {
      voiceFallbackMs = 0;
    }
    if (
      voiceFallbackMs >= VOICE_FALLBACK_SUSTAIN_MS &&
      now - lastVoiceFallbackAt >= VOICE_FALLBACK_COOLDOWN_MS
    ) {
      lastVoiceFallbackAt = now;
      voiceFallbackMs = 0;
      const recent = recentForVerification();
      const reference = speakerAnalysis?.referenceActive
        ? recentReference()
        : null;
      const score = keywordGate.verify(recent);
      const relative = keywordGate.verifyRelative(recent, reference);
      const relativeAccepted =
        relative !== null &&
        relative.margin > 0.05 &&
        relative.userScore > 0.04;
      const relativeAvailable = reference !== null && relative !== null;
      const fallbackThreshold = ttsContainsStop
        ? VOICE_FALLBACK_VOICEPRINT
        : 0.085;
      // Any-speech barge only uses the relative decision. Absolute scores
      // overlap with TTS echo and produced false interruptions (margin -0.33
      // but score 0.09). Wait for the ~1s reference before allowing this path.
      const accepted = relativeAvailable && relativeAccepted;
      logger.info('[cyrvis kws] energy fallback check', {
        score: score === null ? null : Number(score.toFixed(4)),
        relativeUser:
          relative === null ? null : Number(relative.userScore.toFixed(4)),
        relativeTts:
          relative === null ? null : Number(relative.referenceScore.toFixed(4)),
        relativeMargin:
          relative === null ? null : Number(relative.margin.toFixed(4)),
        relativeAvailable,
        accepted,
        avg: Math.round(average),
        ttsContainsStop,
        threshold: fallbackThreshold,
      });
      if (accepted) {
        logger.info('[cyrvis kws] energy+voiceprint barge', {
          relative: relativeAccepted,
        });
        triggerBargeIn();
        return;
      }
      dumpBargeFailure('fallback-rejected', undefined, score);
    }
  }

  if (assistantPlaybackActive && !speakerPath) {
    // Headset-routed playback, or the explicit 11:00 comparison mode where
    // external output is also allowed to use the fast energy path.
    const chunkMs = (pcm16.length / 16000) * 1000;
    const bargeThreshold =
      selectedVoiceEngine === 'cascade' ? 1800 : CAPTURE_BARGE_THRESHOLD;
    const bargeSustainMs =
      selectedVoiceEngine === 'cascade' ? 150 : CAPTURE_BARGE_SUSTAIN_MS;
    if (average > bargeThreshold) {
      headsetBargeMs += chunkMs;
    } else {
      headsetBargeMs = Math.max(0, headsetBargeMs - chunkMs);
    }
    if (headsetBargeMs >= bargeSustainMs) {
      logger.info('[cyrvis capture] barge-in', {
        avg: Math.round(average),
        mode: externalEnergyBarge ? 'energy-only' : 'headset',
      });
      headsetBargeMs = 0;
      assistantPlaybackActive = false;
      capturePreroll = [];
      service.provider.bargeIn({ forceCommit: false });
      service.provider.muteMicFor(BARGE_MIC_TAIL_MS[selectedVoiceEngine]);
      service.brain.forceAwake();
      service.brain.handleBargeStop();
      broadcast('cyrvis:voice:response-stopped');
    }
    return;
  }

  if (assistantPlaybackActive) {
    // External output (even if the UI still reports "headset"): use the
    // reference-aware path so the assistant does not interrupt itself.
    handleSpeakerPlaybackPcm(pcm16, average, now, speakerAnalysis);
    return;
  }

  const analysis = speakerEchoDetector.analyze(pcm16, now);
  if (analysis.likelyEcho) {
    return;
  }
  const clearUserSpeech =
    average > CAPTURE_BARGE_THRESHOLD && !analysis.ambiguous;
  if (now < speakerGuardUntil && !clearUserSpeech) {
    return;
  }

  service.provider.sendAudio(pcm16);
};

const clearCaptureRetry = () => {
  if (captureRetryTimer) {
    clearTimeout(captureRetryTimer);
    captureRetryTimer = null;
  }
};

const scheduleCaptureRetry = (message: string) => {
  // Bluetooth headsets sleep and temporarily disappear from Chromium's device
  // list. Keep trying long enough for the user to power the headset back on
  // instead of requiring an app restart.
  if (captureRetryTimer || captureRetryAttempts >= 1000) {
    return;
  }
  if (!/No physical microphone|Microphone disconnected/i.test(message)) {
    return;
  }
  captureRetryAttempts += 1;
  const delay = Math.min(5000, 1000 + captureRetryAttempts * 400);
  logger.warn('[cyrvis capture] retrying', {
    attempt: captureRetryAttempts,
    delay,
    message,
  });
  captureRetryTimer = setTimeout(() => {
    captureRetryTimer = null;
    void startCapture().catch((error) => {
      logger.error('[cyrvis capture] retry failed', error);
    });
  }, delay);
};

const startCapture = async (resetRetries = false): Promise<void> => {
  if (rendererCapture) {
    return;
  }
  if (resetRetries) {
    captureRetryAttempts = 0;
    clearCaptureRetry();
  }
  const generation = ++captureGeneration;
  captureService?.close();
  captureService = null;
  captureReady = false;
  try {
    captureService = await startCaptureService(
      {
        onPcm: (pcm16) => {
          if (generation === captureGeneration) {
            handleCapturePcm(pcm16);
          }
        },
        onReady: (label) => {
          if (generation !== captureGeneration) {
            return;
          }
          captureReady = true;
          captureRetryAttempts = 0;
          clearCaptureRetry();
          logger.info('[cyrvis capture] ready', {
            label,
            mode: audioMode,
          });
          broadcast('cyrvis:voice:capture-ready', { label });
          emitActivity('session', `麦克风已连接：${label}`);
        },
        onError: (message) => {
          if (generation !== captureGeneration) {
            return;
          }
          captureReady = false;
          logger.error('[cyrvis capture] error', { message });
          broadcast('cyrvis:voice:capture-error', { message });
          emitActivity('error', `麦克风连接失败：${message}`);
          scheduleCaptureRetry(message);
        },
        onDeviceChange: () => {
          if (generation !== captureGeneration || captureReady) {
            return;
          }
          const now = Date.now();
          if (now - lastDeviceChangeRetryAt < 3000) {
            return;
          }
          lastDeviceChangeRetryAt = now;
          // A Bluetooth headset just came back. Reset the retry budget so a
          // device that was powered off for a while still reconnects.
          captureRetryAttempts = 0;
          clearCaptureRetry();
          scheduleCaptureRetry('Microphone disconnected');
        },
      },
      // Cascade follows UI-tars and uses browser AEC. The omni fallback keeps
      // Cyrvis's previous reference-aware capture behavior.
      { echoCancellation: selectedVoiceEngine === 'cascade' },
    );
  } catch (error) {
    if (generation === captureGeneration) {
      captureReady = false;
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[cyrvis capture] start failed', { message });
      broadcast('cyrvis:voice:capture-error', { message });
      emitActivity('error', `麦克风连接失败：${message}`);
      scheduleCaptureRetry(message);
    }
    throw error;
  }
};

const broadcast = (channel: string, payload?: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

const emitActivity = (
  kind: CyrvisActivityEvent['kind'],
  text: string,
): void => {
  const event: CyrvisActivityEvent = {
    id: randomUUID(),
    kind,
    text,
    createdAt: Date.now(),
  };
  broadcast('cyrvis:voice:activity', event);
  void voiceMemoryService.appendActivity(event).catch((error) => {
    logger.warn('[cyrvis memory] activity persist failed', error);
  });
};

const syncProviderMemoryContext = async (): Promise<void> => {
  if (!service) {
    return;
  }
  service.provider.setContext?.(
    composeContextSections(
      [
        service.dynamicContext?.getContext(),
        await voiceMemoryService.getContext(),
        service.systemState.getContext(40),
      ],
      providerContextMaxChars,
    ),
  );
};

const recordTurn = (role: CyrvisMemoryTurnRole, text: string): void => {
  void voiceMemoryService
    .appendTurn(role, text)
    .then(() => syncProviderMemoryContext())
    .catch((error) => {
      logger.warn('[cyrvis memory] turn persist failed', error);
    });
};

const broadcastPtt = () => {
  broadcast('cyrvis:voice:ptt', { active: pttActive, mode: pttMode });
};

const triggerBargeIn = (hardStop = false) => {
  if (!service) {
    return;
  }
  logger.info('[cyrvis voice] barge-in');
  if (bargeTrace) {
    bargeTrace.bargeAt = Date.now();
  }
  const wasPlaying = assistantPlaybackActive;
  expectSpeakerBargeStop();
  assistantPlaybackActive = false;
  capturePreroll = [];
  keywordRejectUntil = 0;
  keywordGate?.reset();
  resetSpeakerDetection();
  service.provider.bargeIn({ forceCommit: false });
  if (wasPlaying) {
    service.provider.muteMicFor(BARGE_MIC_TAIL_MS[selectedVoiceEngine]);
  }
  service.brain.forceAwake();
  service.brain.handleBargeStop(hardStop);
  broadcast('cyrvis:voice:response-stopped');
  emitActivity('speech', hardStop ? '已停止任务' : '已打断助手回答');
};

const setPttActive = (active: boolean) => {
  if (!service) {
    return;
  }
  pttActive = active;
  if (pttActive) {
    service.brain.forceAwake();
    service.provider.clearAudioBuffer();
  } else {
    service.provider.endPtt();
  }
  logger.info('[cyrvis voice] PTT', { active: pttActive });
  broadcastPtt();
};

const registerVoiceIpc = () => {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  const desktopCursor = new DesktopGazeCursor();
  const nativeObjects = new NativeGazeObjects((capture) =>
    desktopCursor.withHiddenOverlay(capture),
  );
  const objectTracker = new GazeObjectTracker({
    scan: (gaze) => nativeObjects.scan(gaze),
    render: (state) => desktopCursor.updateTarget(state),
    onGaze: (gaze) => {
      const value = gazeInspector.getStatus().enabled ? gaze : null;
      setDesktopGaze(value);
      proactiveGaze.update(value);
    },
  });
  const rawGaze = (
    sample: { x: number; y: number; timestamp: number } | null,
  ) => {
    if (
      !sample ||
      !Number.isFinite(sample.x) ||
      !Number.isFinite(sample.y) ||
      !Number.isFinite(sample.timestamp) ||
      sample.x < 0 ||
      sample.x > 1 ||
      sample.y < 0 ||
      sample.y > 1 ||
      Math.abs(Date.now() - sample.timestamp) > 800
    )
      return null;
    const display = screen.getPrimaryDisplay();
    return {
      x: sample.x,
      y: sample.y,
      at: sample.timestamp,
      displayId: display.id,
      bounds: { ...display.bounds },
    };
  };
  ipcMain.handle('cyrvis:gaze:object-status', () => objectTracker.getStatus());
  ipcMain.handle('cyrvis:gaze:object-configure', (_event, enabled) =>
    objectTracker.configure(enabled !== false),
  );
  ipcMain.handle('cyrvis:gaze:inspect-enabled', (_event, enabled) => {
    if (enabled !== true) {
      proactiveGaze.configure(false);
      service?.brain.clearGazeSuggestion();
    }
    return gazeInspector.setEnabled(enabled === true);
  });
  ipcMain.handle('cyrvis:gaze:proactive-status', () =>
    proactiveGaze.getStatus(),
  );
  ipcMain.handle('cyrvis:gaze:proactive-configure', (_event, config) => {
    const enabled =
      config?.enabled === true && gazeInspector.getStatus().enabled;
    if (!enabled) service?.brain.clearGazeSuggestion();
    return proactiveGaze.configure(enabled, Number(config?.dwellMs) || 4500);
  });
  ipcMain.handle('cyrvis:gaze:proactive-action', (_event, id, action) => {
    if (
      !['play', 'explain', 'story', 'open', 'summarize', 'dismiss'].includes(
        action,
      )
    )
      return { ok: false, message: '无效操作' };
    if (!service) return { ok: false, message: '请先开启语音助手' };
    broadcast('cyrvis:voice:response-stopped');
    return service.brain.followGazeSuggestion(
      String(id),
      action as GazeAction | 'dismiss',
    );
  });
  ipcMain.handle('cyrvis:gaze:chat-turns', () => gazeChat.recent());
  ipcMain.handle('cyrvis:voice:submit-text', (_event, text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 6000)
      return { ok: false, error: '消息为空或过长。' };
    broadcast('cyrvis:voice:response-stopped');
    return (
      service?.brain.submitChatText(text) || {
        ok: false,
        error: '请先开启语音助手。',
      }
    );
  });
  ipcMain.handle('cyrvis:gaze:replay', (_event, id) => {
    const turn = typeof id === 'string' ? gazeChat.get(id) : undefined;
    if (!turn?.answer || !service)
      return { ok: false, error: '没有可重播的识别结果，或语音助手尚未开启。' };
    if (service.provider.isReady?.() === false)
      return { ok: false, error: '语音正在连接，请稍后重播。' };
    service.provider.cancelResponse();
    broadcast('cyrvis:voice:response-stopped');
    replayedGazeId = turn.id;
    service.brain.speakRequestedReply(turn.answer, turn.id);
    return { ok: true };
  });
  ipcMain.on('cyrvis:gaze:playback', (_event, id, phase, error) => {
    if (
      typeof id === 'string' &&
      ['playing', 'spoken', 'failed', 'cancelled'].includes(String(phase))
    )
      gazeChat.speech(
        id,
        phase as 'playing' | 'spoken' | 'failed' | 'cancelled',
        typeof error === 'string' ? error.slice(0, 300) : undefined,
      );
  });
  ipcMain.handle('cyrvis:gaze:inspection-status', () =>
    gazeInspector.getStatus(),
  );
  ipcMain.handle('cyrvis:gaze:inspect', async () => {
    proactiveGaze.snooze();
    service?.brain.clearGazeSuggestion();
    try {
      const answer = await gazeInspector.inspect();
      speakGazeAnswer(answer);
    } catch {
      /* Error is displayed in the inspection panel. */
    }
    return gazeInspector.getStatus();
  });
  globalShortcut.register('CommandOrControl+Alt+I', () => {
    proactiveGaze.snooze();
    service?.brain.clearGazeSuggestion();
    void gazeInspector
      .inspect()
      .then((answer) => {
        speakGazeAnswer(answer);
      })
      .catch((error) => {
        service?.brain.speakRequestedReply(
          error instanceof Error ? error.message : '看屏识别失败',
        );
      });
  });
  ipcMain.handle('cyrvis:gaze:cursor', (_event, sample) => {
    if (objectTracker.getStatus().enabled)
      objectTracker.update(rawGaze(sample));
    else desktopCursor.update(sample);
  });
  ipcMain.handle('cyrvis:gaze:cursor-enabled', (_event, enabled) =>
    desktopCursor.setEnabled(enabled === true),
  );
  ipcMain.handle('cyrvis:gaze:cursor-preview', async () => {
    desktopCursor.setEnabled(true);
    desktopCursor.update({ x: 0.5, y: 0.5, timestamp: Date.now() }, 5000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { visible: desktopCursor.isVisible() };
  });
  globalShortcut.register('CommandOrControl+Alt+G', () =>
    desktopCursor.toggle(),
  );
  screen.on('display-metrics-changed', () => {
    objectTracker.clear();
    proactiveGaze.resetObservation();
    desktopCursor.hide();
    setDesktopGaze(null);
  });
  screen.on('display-removed', () => {
    objectTracker.clear();
    proactiveGaze.resetObservation();
    desktopCursor.hide();
    setDesktopGaze(null);
  });
  ipcMain.handle('cyrvis:gaze:calibrate-screen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    objectTracker.clear();
    desktopCursor.hide();
    // Transparent/vibrant windows can become blank in macOS simple fullscreen.
    // Cover the primary screen with a normal opaque window instead.
    if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false);
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setVibrancy(null);
    win.setBackgroundColor('#ffffff');
    const bounds = screen.getPrimaryDisplay().bounds;
    win.setBounds(bounds);
    win.show();
    win.focus();
    win.webContents.invalidate();
  });
  ipcMain.handle('cyrvis:gaze:hide', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.hide();
    showCompanion();
  });
  ipcMain.handle('cyrvis:gaze:update', (_event, sample) => {
    if (objectTracker.getStatus().enabled) {
      objectTracker.update(rawGaze(sample));
      return;
    }
    if (!sample) {
      setDesktopGaze(null);
      proactiveGaze.update(null);
      return;
    }
    if (
      !Number.isFinite(sample.x) ||
      !Number.isFinite(sample.y) ||
      sample.x < 0 ||
      sample.x > 1 ||
      sample.y < 0 ||
      sample.y > 1 ||
      Math.abs(Date.now() - sample.timestamp) > 3000
    )
      return;
    setDesktopGaze({ x: sample.x, y: sample.y });
    proactiveGaze.update(getDesktopGaze());
    // Read the current sample at tool invocation. Repeated session.update calls
    // can overwrite the voice provider's in-flight speech instructions.
  });

  ipcMain.handle('cyrvis:voice:toggle-ptt', () => {
    setPttActive(!pttActive);
    return { active: pttActive, mode: pttMode };
  });

  ipcMain.handle('cyrvis:voice:get-ptt', () => ({
    active: pttActive,
    mode: pttMode,
  }));

  ipcMain.handle('cyrvis:voice:start', async () => {
    if (!service) {
      return {
        ok: false,
        error:
          '未配置语音模型：请在 apps/ui-tars/.env 填写 QWEN_API_KEY，保存后完全退出并重新启动 CYRVIS。',
      };
    }
    try {
      await service.brain.start();
      return { ok: true, state: service.brain.getState() };
    } catch (error) {
      logger.error('[cyrvis voice] start failed', error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('cyrvis:voice:stop', () => {
    clearCaptureRetry();
    captureGeneration += 1;
    service?.provider.bargeIn();
    service?.brain.sleep();
    captureReady = false;
    captureService?.close();
    captureService = null;
    assistantPlaybackActive = false;
    resetSpeakerDetection();
    keywordGate?.reset();
    broadcast('cyrvis:voice:response-stopped');
  });

  ipcMain.handle('cyrvis:voice:get-state', () => {
    return service?.brain.getState() ?? null;
  });

  ipcMain.handle('cyrvis:voice:get-memory', () => {
    return voiceMemoryService.getSnapshot();
  });

  ipcMain.handle('cyrvis:voice:get-context', () => {
    return service?.dynamicContext?.getPublicSnapshot() ?? null;
  });

  ipcMain.handle('cyrvis:voice:clear-context', () => {
    service?.dynamicContext?.clearUserContext();
    return service?.dynamicContext?.getPublicSnapshot() ?? null;
  });

  ipcMain.handle('cyrvis:voice:get-capture-ready', () => ({
    ready: captureReady,
  }));

  ipcMain.handle('cyrvis:voice:cancel-task', async () => {
    if (!service) {
      return null;
    }
    return service.controller.cancelTask();
  });

  ipcMain.handle('cyrvis:voice:pause-task', async () => {
    if (!service) {
      return null;
    }
    return service.controller.pauseTask();
  });

  ipcMain.handle('cyrvis:voice:resume-task', async () => {
    if (!service) {
      return null;
    }
    return service.controller.resumeTask();
  });

  ipcMain.on('cyrvis:voice:audio', (_event, buffer: ArrayBuffer) => {
    if (!service || testAudioActive || !(buffer instanceof ArrayBuffer)) {
      return;
    }
    if (pttMode && !pttActive) {
      return;
    }
    service.provider.sendAudio(new Int16Array(buffer));
  });

  ipcMain.on('cyrvis:voice:keyword-audio', (_event, buffer: ArrayBuffer) => {
    if (!keywordGate?.available || !(buffer instanceof ArrayBuffer)) {
      return;
    }
    feedHybridKeywordAudio(new Int16Array(buffer));
  });

  ipcMain.on('cyrvis:voice:begin-utterance', () => {
    service?.provider.beginUtterance?.();
  });

  ipcMain.on('cyrvis:voice:finish-utterance', () => {
    service?.provider.finishUtterance?.();
  });

  ipcMain.on('cyrvis:voice:cancel-utterance', () => {
    service?.provider.cancelUtterance?.();
  });

  ipcMain.on('cyrvis:voice:renderer-capture-ready', (_event, label: string) => {
    captureReady = true;
    logger.info('[cyrvis voice] renderer capture ready', {
      label: label || 'renderer microphone',
    });
    broadcast('cyrvis:voice:capture-ready', {
      label: label || 'renderer microphone',
    });
  });

  ipcMain.on(
    'cyrvis:voice:renderer-capture-error',
    (_event, message: string) => {
      captureReady = false;
      logger.warn('[cyrvis voice] renderer capture error', {
        message: message || 'renderer microphone error',
      });
      broadcast('cyrvis:voice:capture-error', {
        message: message || 'renderer microphone error',
      });
    },
  );

  const ttsService =
    process.env.CYRVIS_TTS_LOCAL === '1'
      ? (localTtsService as unknown as typeof qwenTtsRealtimeService)
      : qwenTtsRealtimeService;
  ipcMain.handle('qwen-tts:start', (_event, input) => ttsService.start(input));
  ipcMain.handle('qwen-tts:append', (_event, input) =>
    ttsService.append(input),
  );
  ipcMain.handle('qwen-tts:finish', (_event, input) =>
    ttsService.finish(input.sessionId),
  );
  ipcMain.handle('qwen-tts:cancel', (_event, input) =>
    ttsService.cancel(input.sessionId),
  );
  ipcMain.handle('qwen-tts:prepare-voice', (_event, input) =>
    qwenTtsRealtimeService.ensureVoice(input),
  );
  ipcMain.handle('qwen-tts:ensure-breeze-ready', async () => {
    try {
      await breezeTtsService.ensureStarted();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle('qwen-tts:list-breeze-voices', () =>
    breezeTtsService.listVoices(),
  );

  ipcMain.on(
    'cyrvis:voice:playback-reference',
    (_event, buffer: ArrayBuffer, startedAt?: number) => {
      if (speakerProbe || !(buffer instanceof ArrayBuffer)) {
        return;
      }
      speakerEchoDetector.addReference(
        new Int16Array(buffer),
        typeof startedAt === 'number' ? startedAt : Date.now(),
      );
    },
  );

  ipcMain.handle('cyrvis:voice:test-audio', async () => {
    if (!env.isDev || !service) {
      return { ok: false, error: 'test audio is only available in dev' };
    }

    const wavPath = process.env.CYRVIS_TEST_WAV;
    if (!wavPath) {
      return {
        ok: false,
        error: 'CYRVIS_TEST_WAV is not set',
      };
    }
    let wav: Buffer;
    try {
      wav = fs.readFileSync(wavPath);
    } catch (error) {
      return {
        ok: false,
        error: `Cannot read CYRVIS_TEST_WAV: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    let offset = 12;
    let data: Buffer | null = null;
    while (offset + 8 <= wav.length) {
      const id = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      if (id === 'data') {
        data = wav.subarray(offset + 8, offset + 8 + size);
        break;
      }
      offset += 8 + size + (size % 2);
    }

    if (!data) {
      return { ok: false, error: 'WAV data chunk not found' };
    }

    logger.info('[cyrvis voice] test audio start', { bytes: data.length });
    testAudioActive = true;
    service.provider.clearAudioBuffer();
    if (selectedVoiceEngine === 'cascade') {
      service.provider.beginUtterance?.();
    }
    try {
      const chunkSize = 640; // 20 ms at 16 kHz PCM16 mono
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.subarray(i, i + chunkSize);
        const pcm = new Int16Array(
          chunk.buffer,
          chunk.byteOffset,
          Math.floor(chunk.byteLength / 2),
        );
        service.provider.sendAudio(pcm);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Streaming ASR needs trailing silence before the manual commit.
      const silence = new Int16Array(16000); // 1 second at 16 kHz
      for (let i = 0; i < silence.length; i += 320) {
        service.provider.sendAudio(silence.subarray(i, i + 320));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (selectedVoiceEngine === 'cascade') {
        service.provider.finishUtterance?.();
      }
    } finally {
      testAudioActive = false;
    }

    logger.info('[cyrvis voice] test audio sent');
    return { ok: true, bytes: data.length };
  });

  ipcMain.handle('cyrvis:voice:set-mode', async (_event, mode: unknown) => {
    if (mode !== 'headset' && mode !== 'speaker') {
      return { ok: false, error: 'mode must be headset or speaker' };
    }
    const nextMode = mode as 'headset' | 'speaker';
    await switchWindowsDefaultOutput(nextMode);
    const changed = audioMode !== nextMode;
    audioMode = nextMode;
    speakerOutputMode = nextMode === 'speaker';
    speakerGuardUntil = 0;
    capturePreroll = [];
    if (speakerProbe) {
      broadcast('cyrvis:voice:playback-resume');
    }
    keywordRejectUntil = 0;
    keywordGate?.reset();
    resetSpeakerDetection();
    logger.info('[cyrvis voice] audio mode', {
      mode: audioMode,
      captureOwner: rendererCapture ? 'renderer' : 'main',
    });
    broadcast('cyrvis:voice:audio-mode', { mode: audioMode });
    if (changed && selectedVoiceEngine === 'omni' && !rendererCapture) {
      // Bluetooth profile/A2DP switches briefly drop the HFP microphone.
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await startCapture(true);
      } catch (error) {
        logger.error('[cyrvis capture] mode switch failed', error);
      }
    }
    return { ok: true, mode: audioMode };
  });

  ipcMain.handle('cyrvis:voice:get-mode', () => ({ mode: audioMode }));

  ipcMain.handle('cyrvis:voice:set-output', (_event, label: unknown) => {
    if (typeof label !== 'string' || !label.trim()) {
      return { ok: false, error: 'output label is required' };
    }
    // Output device and voice mode are independent on purpose: the user can
    // route audio to external speakers while keeping headset/full-duplex mode.
    if (speakerProbe) {
      broadcast('cyrvis:voice:playback-resume');
    }
    externalOutput = isSpeakerOutputLabel(label);
    keywordRejectUntil = 0;
    keywordGate?.reset();
    resetSpeakerDetection();
    logger.info('[cyrvis voice] output label', {
      label,
      mode: audioMode,
      externalOutput,
    });
    broadcast('cyrvis:voice:set-output', label);
    return { ok: true, mode: audioMode, speaker: speakerOutputMode };
  });

  ipcMain.handle('cyrvis:voice:restart-capture', async () => {
    if (selectedVoiceEngine === 'cascade' || rendererCapture) {
      return { ok: true, rendererOwned: true };
    }
    try {
      await startCapture(true);
      return { ok: true };
    } catch (error) {
      logger.error('[cyrvis capture] restart failed', error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.on(
    'cyrvis:voice:playback-stopped',
    (_event, info?: { queuedMs?: number }) => {
      const trace = bargeTrace;
      const stoppedAt = Date.now();
      if (trace?.bargeAt) {
        logger.info('[cyrvis barge trace]', {
          keyword: trace.keyword ?? null,
          score: trace.score ?? null,
          accepted: trace.accepted ?? null,
          onsetToDetect:
            trace.speechOnsetAt && trace.detectedAt
              ? trace.detectedAt - trace.speechOnsetAt
              : null,
          detectToVerify:
            trace.detectedAt && trace.verifiedAt
              ? trace.verifiedAt - trace.detectedAt
              : null,
          detectToBarge: trace.detectedAt
            ? trace.bargeAt - trace.detectedAt
            : null,
          bargeToStop: stoppedAt - trace.bargeAt,
          onsetToStop: trace.speechOnsetAt
            ? stoppedAt - trace.speechOnsetAt
            : null,
          responseToStop: stoppedAt - trace.responseStartedAt,
          queuedMs: info?.queuedMs ?? null,
        });
      }
      bargeTrace = null;
    },
  );

  ipcMain.on('cyrvis:voice:playback-idle', () => {
    const bargeStopPending = speakerBargeStopPending;
    speakerBargeStopPending = false;
    if (speakerBargeStopTimer) {
      clearTimeout(speakerBargeStopTimer);
      speakerBargeStopTimer = null;
    }
    assistantPlaybackActive = false;
    keywordRejectUntil = 0;
    keywordGate?.reset();
    resetSpeakerDetection();
    speakerGuardUntil = !bargeStopPending
      ? Date.now() +
        (speakerOutputMode ? SPEAKER_REVERB_GUARD_MS : HEADSET_REVERB_GUARD_MS)
      : 0;
    service?.provider.notifyPlaybackIdle(
      speakerOutputMode && !bargeStopPending ? 150 : 0,
    );
  });

  ipcMain.on('cyrvis:voice:barge-in', () => {
    triggerBargeIn();
  });

  ipcMain.on(
    'cyrvis:voice:cancel-speech-only',
    (_event, info?: { speakerVerified?: boolean }) => {
      if (!service) {
        return;
      }
      // Only the renderer's playback-reference gate can authorize automatic
      // speaker interruption. Explicit stop uses the separate barge-in channel.
      const verifiedSpeaker = info?.speakerVerified === true;
      if ((speakerOutputMode || externalOutput) && !verifiedSpeaker) {
        logger.info('[cyrvis voice] ignored unverified speaker interruption');
        return;
      }
      if (service.brain.isReadoutSpeechActive() && !verifiedSpeaker) {
        logger.info(
          '[cyrvis gaze] ignored energy-only interruption of readout',
        );
        return;
      }
      logger.info('[cyrvis voice] speech-only barge-in', { verifiedSpeaker });
      assistantPlaybackActive = false;
      service.provider.bargeIn({ forceCommit: false });
      service.brain.handleBargeStop();
      service.provider.muteMicFor(BARGE_MIC_TAIL_MS[selectedVoiceEngine]);
      service.brain.forceAwake();
      broadcast('cyrvis:voice:response-stopped');
    },
  );

  ipcMain.on('cyrvis:voice:force-awake', () => {
    service?.brain.forceAwake();
  });

  ipcMain.on('cyrvis:voice:sleep', () => {
    service?.brain.sleep();
  });
};

/**
 * Starts the voice layer once per Electron main process.
 * No-op when QWEN_API_KEY is absent.
 */
export const startVoiceService = (): VoiceService | null => {
  // Keep the renderer control surface available even when the model key is
  // missing. It reports a clean "not configured" state instead of exposing
  // Electron's missing IPC handler error in the floating panel.
  registerVoiceIpc();

  if (service) {
    return service;
  }

  const settings = SettingStore.getStore();
  selectedVoiceEngine = settings.voiceEngine || env.voiceEngine;
  if (settings.voiceEnabled === false) {
    logger.info('[cyrvis voice] disabled by settings');
    return null;
  }
  energyOnlyBarge =
    selectedVoiceEngine === 'cascade' ||
    process.env.CYRVIS_EXTERNAL_ENERGY_BARGE === '1';
  const apiKey = process.env.QWEN_API_KEY || '';
  if (selectedVoiceEngine === 'omni' && !apiKey) {
    logger.warn(
      '[cyrvis voice] QWEN_API_KEY is not set; voice service is disabled',
    );
    return null;
  }
  // secretlint-disable @secretlint/secretlint-rule-pattern
  const pendingIntentClassifier = createPendingIntentClassifier({
    apiKey:
      process.env.CYRVIS_PENDING_INTENT_LLM === '0'
        ? ''
        : settings.conversationApiKey ||
          process.env.CONVERSATION_API_KEY ||
          process.env.QWEN_API_KEY ||
          '',
    baseUrl:
      settings.conversationBaseUrl ||
      process.env.CONVERSATION_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model:
      process.env.CYRVIS_PENDING_INTENT_MODEL?.trim() ||
      settings.conversationModelName ||
      process.env.CONVERSATION_MODEL_NAME ||
      'qwen-plus',
  });
  // secretlint-enable @secretlint/secretlint-rule-pattern

  const controller = new CyrvisController(new ElectronGUIAdapter());
  const codingAgent = new CodingAgentService({
    workspace:
      process.env.CYRVIS_CODING_WORKSPACE?.trim() ||
      'D:\\Desktop\\project\\CYRVIS-demo',
  });
  logger.info('[cyrvis coding] configured', {
    workspace: codingAgent.getWorkspace(),
    model: process.env.CYRVIS_CODING_MODEL || 'deepseek-flash',
  });
  const companionStore = getCompanionStore();
  const desktopHost = new LocalDesktopHost();
  const runtimeRefreshMs = Number(process.env.CYRVIS_SYSTEM_RUNTIME_REFRESH_MS);
  const fullRefreshMs = Number(process.env.CYRVIS_SYSTEM_FULL_REFRESH_MS);
  const foregroundRefreshMs = Number(process.env.CYRVIS_FOREGROUND_REFRESH_MS);
  const nativeForegroundEvents =
    process.platform === 'win32' &&
    process.env.CYRVIS_VOICE_TEST !== '1' &&
    process.env.CYRVIS_NATIVE_FOREGROUND_EVENTS !== '0';
  const systemState = new SystemStateStore(desktopHost, {
    runtimeRefreshMs:
      Number.isFinite(runtimeRefreshMs) && runtimeRefreshMs >= 1_000
        ? runtimeRefreshMs
        : undefined,
    fullRefreshMs:
      Number.isFinite(fullRefreshMs) && fullRefreshMs >= 60_000
        ? fullRefreshMs
        : undefined,
  });
  systemState.start();
  const userDataDirectory =
    typeof app.getPath === 'function' ? app.getPath('userData') : process.cwd();
  const configuredManifestDirectories = (
    process.env.CYRVIS_PROVIDER_MANIFEST_DIRS || ''
  )
    .split(/[;\r\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const fastToolMatrix =
    process.env.CYRVIS_FAST_TOOLS === '0'
      ? null
      : createFastToolMatrix(desktopHost, process.cwd(), systemState, {
          foregroundRefreshMs:
            Number.isFinite(foregroundRefreshMs) && foregroundRefreshMs >= 500
              ? foregroundRefreshMs
              : undefined,
          nativeForegroundEvents,
          foregroundScriptPath:
            process.env.CYRVIS_FOREGROUND_EVENT_SCRIPT?.trim() || undefined,
          manifestDirectories: [
            path.join(userDataDirectory, 'cyrvis', 'providers'),
            ...(process.resourcesPath
              ? [path.join(process.resourcesPath, 'cyrvis', 'providers')]
              : []),
            ...configuredManifestDirectories,
          ],
          usageStateFile: path.join(
            userDataDirectory,
            'cyrvis-tool-usage.json',
          ),
          usageAuditFile: path.join(
            userDataDirectory,
            'cyrvis-tool-audit.jsonl',
          ),
        });
  const buildVoiceTools = () =>
    buildVoiceToolSurface(fastToolMatrix?.providerCatalog.tools);
  const voiceTools = buildVoiceTools();
  if (fastToolMatrix) {
    logger.info('[cyrvis fast-tools] ready', {
      tools: fastToolMatrix.registry.list().length,
      providerTools: voiceTools.length,
      systemStateScanning: true,
    });
  }
  let provider!: InteractiveVoiceProvider;
  let unsubscribeFastToolUpdates: (() => void) | null = null;
  let unsubscribeContextEvents: (() => void) | null = null;
  let unsubscribeContextSnapshots: (() => void) | null = null;
  const requireWakeWord = settings.voiceRequireWakeWord ?? true;
  const configuredWakeWord = settings.voiceWakeWord?.trim();
  const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wakePatterns = configuredWakeWord
    ? [
        new RegExp(
          `(?:hello|hi|hey|你好|小T)?[\\s,，]*${escapeRegExp(
            configuredWakeWord,
          )}`,
          'i',
        ),
        /\b(cyrvis|service|sirvis|cervis|siris|sirius)\b/i,
      ]
    : undefined;

  const brain = new VoiceBrain(
    controller,
    {
      onAudio: (pcm16) => {
        const copy = pcm16.slice();
        broadcast('cyrvis:voice:audio', copy.buffer);
      },
      onSpeechStarted: () => {
        lastGazeVoiceActivityAt = Date.now();
        logger.info('[cyrvis voice] speech started');
        broadcast('cyrvis:voice:speech-started');
      },
      onSpeechStopped: () => {
        lastGazeVoiceActivityAt = Date.now();
        logger.info('[cyrvis voice] speech stopped');
        broadcast('cyrvis:voice:speech-stopped');
      },
      onTranscript: (text, final) => {
        broadcast('cyrvis:voice:transcript', { text, final });
        if (final) {
          fastToolMatrix?.dynamicContext.recordUserText(text);
          recordTurn('user', text);
        }
      },
      onAssistantText: (text, final) => {
        lastGazeVoiceActivityAt = Date.now();
        logger.info('[cyrvis voice] assistant text', { text, final });
        broadcast('cyrvis:voice:assistant', {
          text,
          final,
          gazeTurnId: activeVoiceReadoutId,
        });
        lastAssistantAt = Date.now();
        lastAssistantText = final ? text : `${lastAssistantText}${text}`;
        if (final) {
          recordTurn('assistant', text);
        }
      },
      onSpeechText: (text, final) => {
        broadcast('cyrvis:voice:speech-text', { text, final });
      },
      onState: (state: VoiceBrainState) =>
        broadcast('cyrvis:voice:state', state),
      onWake: () => {
        logger.info('[cyrvis voice] wake');
        broadcast('cyrvis:voice:wake');
        emitActivity('session', '语音会话已唤醒');
      },
      onSleep: () => {
        logger.info('[cyrvis voice] sleep');
        broadcast('cyrvis:voice:sleep');
        emitActivity('session', '语音会话已休眠');
      },
      onTaskEvent: (event: ControllerEvent) => {
        fastToolMatrix?.dynamicContext.recordTaskEvent(event);
        void syncProviderMemoryContext();
        broadcast('cyrvis:voice:task-event', event);
        const text = describeControllerEvent(event);
        if (text) {
          emitActivity(event.type === 'task_failed' ? 'error' : 'task', text);
        }
      },
      onError: (error) => {
        logger.error('[cyrvis voice] error', error);
        emitActivity('error', `语音服务错误：${error.message}`);
      },
    },
    (callbacks) => {
      const wrapped = {
        ...callbacks,
        onReady: () => {
          logger.info('[cyrvis voice] provider ready', {
            engine: selectedVoiceEngine,
          });
          emitActivity('session', 'Qwen Realtime 已连接');
          callbacks.onReady?.();
        },
        onTranscript: (text: string, final: boolean) => {
          logger.info('[cyrvis voice] transcript', { text, final });
          const pendingConfirmationReply =
            final &&
            fastToolMatrix?.router.isPendingConfirmationReply(text) === true;
          const explicitConfirmation =
            final && fastToolMatrix?.router.isConfirmationIntent(text) === true;
          const gazeConfirmation =
            final &&
            !assistantPlaybackActive &&
            Date.now() >= speakerGuardUntil &&
            service?.brain.isGazeFollowup(text) === true;
          // Opt-in only: the enrolled embedding does not reliably match the
          // Bluetooth/AEC microphone window on this machine (real user speech
          // scored 0.01-0.05 against a 0.22 threshold). Keep the implementation
          // for a re-enrolled/calibrated setup, but do not reject ASR by
          // default.
          const asrVoiceprintEnabled =
            process.env.CYRVIS_ASR_VOICEPRINT_GATE === '1';
          if (
            final &&
            asrVoiceprintEnabled &&
            text.trim() &&
            (speakerOutputMode || externalOutput) &&
            keywordGate?.available &&
            !pendingConfirmationReply &&
            !explicitConfirmation
          ) {
            const score = keywordGate.verify(recentKeywordForVerification());
            if (score !== null && score < keywordGate.speakerThreshold) {
              logger.warn(
                '[cyrvis voice] ASR transcript rejected by voiceprint',
                {
                  transcript: text.slice(0, 120),
                  score: Number(score.toFixed(4)),
                  threshold: keywordGate.speakerThreshold,
                },
              );
              provider?.cancelResponse();
              provider?.clearAudioBuffer();
              broadcast('cyrvis:voice:transcript', { text: '', final: true });
              emitActivity('speech', '已忽略非用户语音，未触发指令');
              return;
            }
          }
          if (
            final &&
            !pendingConfirmationReply &&
            !explicitConfirmation &&
            !gazeConfirmation &&
            isLikelySpeakerEcho(
              text,
              lastAssistantText,
              Date.now() - lastAssistantAt,
            )
          ) {
            logger.warn('[cyrvis voice] ignored likely speaker echo', {
              transcript: text,
            });
            provider?.cancelResponse();
            provider?.clearAudioBuffer();
            broadcast('cyrvis:voice:transcript', { text: '', final: true });
            emitActivity('speech', '已忽略外放回声，未触发追问');
            return;
          }
          if (pendingConfirmationReply) {
            logger.info(
              '[cyrvis voice] pending confirmation reply bypassed echo filter',
              { text },
            );
          }
          return callbacks.onTranscript?.(text, final);
        },
        onReadoutState: (id, phase, error) => gazeChat.speech(id, phase, error),
        onResponseStarted: (info) => {
          activeVoiceReadoutId = info?.readoutId;
          if (service?.brain.shouldSuppressReply()) {
            logger.info('[cyrvis voice] suppress reply after stop command');
            service.provider.cancelResponse();
            return;
          }
          speakerBargeStopPending = false;
          if (speakerBargeStopTimer) {
            clearTimeout(speakerBargeStopTimer);
            speakerBargeStopTimer = null;
          }
          resetSpeakerDetection();
          keywordRejectUntil = 0;
          keywordGate?.reset();
          assistantPlaybackActive = true;
          bargeTrace = {
            responseStartedAt: Date.now(),
            speechOnsetAt: null,
            detectedAt: null,
            verifiedAt: null,
            bargeAt: null,
          };
          voiceOnsetAt = 0;
          bargeSampleBuffer = [];
          referencePreroll = [];
          capturePreroll = [];
          speakerGuardUntil = 0;
          lastAssistantText = '';
          // Never carry playback-tail audio into the next ASR turn, regardless
          // of which output mode the UI currently reports.
          service?.provider.clearAudioBuffer();
          broadcast('cyrvis:voice:response-started', info);
          emitActivity('speech', '助手开始流式回答');
          callbacks.onResponseStarted?.(info);
        },
        onResponseDone: () => {
          // Tool-call-only responses produce no audio. Tell the renderer so
          // its half-duplex gate does not stay closed for the watchdog period
          // and swallow the user's next words (e.g. "stop").
          broadcast('cyrvis:voice:response-done');
          emitActivity('speech', '助手回答完成');
          callbacks.onResponseDone?.();
          activeVoiceReadoutId = undefined;
        },
        onUtteranceCommitted: () => {
          if (pttMode && pttActive) {
            setPttActive(false);
          }
          // The renderer shows "Thinking…" during the gap between end of
          // speech and the first response token, so the user does not repeat
          // themselves thinking they were not heard.
          broadcast('cyrvis:voice:thinking');
          emitActivity('speech', '正在理解语音指令');
          callbacks.onUtteranceCommitted?.();
        },
        onToolCall: (
          call: Parameters<NonNullable<typeof callbacks.onToolCall>>[0],
        ) => {
          logger.info('[cyrvis voice] tool call', call.name, call.args);
          const instruction =
            call.name === 'start_gui_task'
              ? call.args.instruction
              : call.name === 'remember_fact'
                ? call.args.text
                : undefined;
          broadcast('cyrvis:voice:tool-call', {
            name: call.name,
            instruction,
          });
          emitActivity(
            call.name === 'remember_fact' ? 'memory' : 'tool',
            describeVoiceToolCall(call.name as VoiceToolName, instruction),
          );
          callbacks.onToolCall?.(call);
        },
        onError: (error: Error) => {
          if (activeVoiceReadoutId)
            gazeChat.speech(
              activeVoiceReadoutId,
              'failed',
              '语音模型返回错误，请检查语音连接后重新播报。',
            );
          logger.error('[cyrvis voice] provider error', error);
          broadcast('cyrvis:voice:error', { message: error.message });
          emitActivity('error', `语音模型错误：${error.message}`);
          callbacks.onError?.(error);
        },
      };

      provider =
        selectedVoiceEngine === 'cascade'
          ? new CascadeVoiceProvider(wrapped, voiceTools)
          : new QwenOmniProvider({
              apiKey,
              model: process.env.QWEN_MODEL || 'qwen3.8-omni-flash-realtime',
              endpoint:
                process.env.QWEN_REALTIME_URL ||
                process.env.QWEN_ENDPOINT ||
                undefined,
              voice:
                process.env.QWEN_VOICE?.trim() ||
                resolveCompanionSkin(companionStore.get('skinId')).voice,
              callbacks: wrapped,
              tools: voiceTools,
              vadType: 'semantic_vad_ec',
              silenceDurationMs:
                settings.voiceSilenceTimeoutMs ||
                env.voiceSilenceTimeoutMs ||
                600,
            });
      return provider;
    },
    {
      requireWakeWord,
      getGazeActionContext: (text) => {
        const replayed = replayedGazeId && gazeChat.getGaze(replayedGazeId);
        if (replayed && Date.now() - replayed.at < 120_000)
          return { gaze: replayed, observedAt: replayed.at };
        const inspection = gazeInspector.getStatus(),
          suggestion = proactiveGaze.getStatus().suggestion;
        const display = screen.getPrimaryDisplay();
        const history: GazeActionContext[] = [];
        if (suggestion?.gaze)
          history.push({
            gaze: suggestion.gaze,
            observedAt: suggestion.gaze.at,
          });
        if (inspection.gaze && inspection.capturedAt)
          history.push({
            gaze: inspection.gaze,
            observedAt: inspection.capturedAt,
          });
        return selectGazeActionContext(
          text,
          getDesktopGaze(),
          history.filter(
            (item) =>
              item.gaze.displayId === display.id &&
              Object.keys(display.bounds).every(
                (key) =>
                  item.gaze.bounds[key as keyof typeof display.bounds] ===
                  display.bounds[key as keyof typeof display.bounds],
              ),
          ),
        );
      },
      getGazeInspectionId: () => gazeInspector.getStatus().id,
      inspectGaze: (question) => {
        proactiveGaze.snooze();
        return gazeInspector.inspect(question);
      },
      snoozeProactiveGaze: (ms) => proactiveGaze.snooze(ms),
      awakeTimeoutMs: requireWakeWord ? 20_000 : 0,
      wakePatterns,
      proactivity: {
        minGapMs: 5000,
        progressCooldownMs: 30000,
      },
      memoryContextProvider: async () =>
        composeContextSections(
          [
            fastToolMatrix?.dynamicContext.getContext(),
            await voiceMemoryService.getContext(),
            systemState.getContext(40),
          ],
          providerContextMaxChars,
        ),
      fastToolRouter: fastToolMatrix?.router,
      codingAgent,
      classifyPendingIntent: pendingIntentClassifier
        ? (input) => pendingIntentClassifier.classify(input)
        : undefined,
      rememberFact: async (text) => {
        const remembered = await voiceMemoryService.rememberFact(text);
        if (remembered) {
          emitActivity('memory', `已保存长期记忆：${remembered}`);
        }
        return remembered;
      },
    },
  );

  codingAgent.setStatusListener((snapshot) => {
    if (snapshot.status === 'running' && snapshot.lastMessage) {
      emitActivity('task', `编码进度：${snapshot.lastMessage}`);
    }
    brain.notifyCodingStatus(snapshot);
    if (snapshot.status === 'done') {
      const target =
        snapshot.changedFiles[snapshot.changedFiles.length - 1] ||
        snapshot.workspace;
      emitActivity('task', `编码任务完成，正在打开 VS Code：${target}`);
      void openApp('vscode', target).catch((error: unknown) => {
        logger.warn('[cyrvis coding] open vscode failed', error);
        return openApp('explorer', target).catch((fallbackError: unknown) => {
          logger.warn('[cyrvis coding] open workspace failed', fallbackError);
        });
      });
    }
  });

  service = {
    brain,
    provider,
    controller,
    systemState,
    dynamicContext: fastToolMatrix?.dynamicContext,
  };
  const unsubscribeSkin = companionStore.onDidChange('skinId', (skinId) => {
    // Companion voices apply to Omni; cascade retains its configured TTS voice.
    if (!(provider instanceof QwenOmniProvider)) return;
    const configuredVoice = process.env.QWEN_VOICE?.trim();
    if (configuredVoice) {
      // Token Plan exposes a different voice set (longanqian etc.); a companion
      // skin such as "Tina" would reject the whole session.
      logger.info('[cyrvis voice] companion voice overridden by QWEN_VOICE', {
        voice: configuredVoice,
        skinId,
      });
      return;
    }
    const skin = resolveCompanionSkin(skinId);
    if (!provider.setVoice(skin.voice)) return;
    if (assistantPlaybackActive && speakerOutputMode)
      speakerGuardUntil = Date.now() + 800;
    assistantPlaybackActive = false;
    resetSpeakerDetection();
    keywordGate?.reset();
    capturePreroll = [];
    broadcast('cyrvis:voice:response-stopped');
    logger.info('[cyrvis voice] companion voice changed', {
      skinId: skin.id,
      voice: skin.voice,
    });
  });
  unsubscribeFastToolUpdates =
    fastToolMatrix?.providerCatalog.subscribe?.(() => {
      const nextTools = buildVoiceTools();
      provider.setTools?.(nextTools);
      logger.info('[cyrvis fast-tools] tool surface updated', {
        registryTools: fastToolMatrix.registry.list().length,
        providerTools: nextTools.length,
        revision: fastToolMatrix.providerCatalog.revision,
      });
    }) ?? null;
  if (fastToolMatrix) {
    void fastToolMatrix.providerManager
      .start()
      .then(() => {
        logger.info('[cyrvis providers] started', {
          providers: fastToolMatrix.providerManager.list().length,
          tools: fastToolMatrix.registry.list().length,
        });
      })
      .catch((error: unknown) => {
        logger.warn('[cyrvis providers] start failed', error);
      });
  }
  unsubscribeContextEvents =
    fastToolMatrix?.dynamicContext.subscribeEvents((event) => {
      if (event.type === 'foreground_changed') {
        void fastToolMatrix?.providerManager.refresh().catch((error) => {
          logger.warn('[cyrvis providers] foreground refresh failed', error);
        });
      }
    }) ?? null;
  unsubscribeContextSnapshots =
    fastToolMatrix?.dynamicContext.subscribe(() => {
      broadcast(
        'cyrvis:voice:context',
        fastToolMatrix.dynamicContext.getPublicSnapshot(),
      );
    }) ?? null;
  let lastSystemContextSyncAt = 0;
  systemState.onChange(() => {
    const now = Date.now();
    if (now - lastSystemContextSyncAt < 30_000) {
      return;
    }
    lastSystemContextSyncAt = now;
    void syncProviderMemoryContext();
  });

  if (selectedVoiceEngine === 'omni') {
    // Load the local stop-word models before capture starts. If a model is
    // missing the voice service still works; only the keyword fast-path is off.
    keywordGate = new KeywordGate({
      onTrigger: (keyword) => {
        logger.info('[cyrvis voice] keyword barge-in', { keyword });
        triggerBargeIn(true);
      },
      onDetected: (keyword, at) => {
        if (bargeTrace) {
          bargeTrace.keyword = keyword;
          bargeTrace.detectedAt = at;
        }
      },
      onVerified: (keyword, score, accepted, at) => {
        if (bargeTrace) {
          bargeTrace.keyword = keyword;
          bargeTrace.score = score;
          bargeTrace.accepted = accepted;
          bargeTrace.verifiedAt = at;
        }
      },
      onReject: (keyword, score) => {
        dumpBargeFailure('kws-rejected', keyword, score);
      },
    });
    keywordGate.load();
  }

  if (pttMode) {
    const shortcutRegistered = globalShortcut.register(
      'Control+Alt+Space',
      () => setPttActive(!pttActive),
    );
    logger.info('[cyrvis voice] PTT shortcut', {
      accelerator: 'Control+Alt+Space',
      registered: shortcutRegistered,
    });
  }

  // Keyboard fallback for barge-in. Voice barge-in works by speaking, but this
  // is deterministic even when the mic/echo gate is misbehaving.
  const stopShortcut = globalShortcut.register('Control+Alt+X', () =>
    triggerBargeIn(true),
  );
  logger.info('[cyrvis voice] stop-speaking shortcut', {
    accelerator: 'Control+Alt+X',
    registered: stopShortcut,
  });

  // A/B switch for the 11:00 energy behavior. No restart needed.
  if (selectedVoiceEngine === 'omni') {
    const energyShortcut = globalShortcut.register('Control+Alt+E', () => {
      energyOnlyBarge = !energyOnlyBarge;
      resetSpeakerDetection();
      keywordGate?.reset();
      logger.info('[cyrvis voice] energy-only barge toggled', {
        enabled: energyOnlyBarge,
      });
      emitActivity(
        'speech',
        energyOnlyBarge ? '纯能量打断：开' : 'KWS + 声纹打断：开',
      );
    });
    logger.info('[cyrvis voice] energy-only barge shortcut', {
      accelerator: 'Control+Alt+E',
      enabled: energyOnlyBarge,
      registered: energyShortcut,
    });
  }

  app.on('before-quit', () => {
    unsubscribeSkin();
    globalShortcut.unregisterAll();
    captureService?.close();
    captureService = null;
    breezeTtsService.stop();
    qwenTtsRealtimeService.stopAll();
    keywordGate = null;
    unsubscribeFastToolUpdates?.();
    unsubscribeFastToolUpdates = null;
    unsubscribeContextEvents?.();
    unsubscribeContextEvents = null;
    unsubscribeContextSnapshots?.();
    unsubscribeContextSnapshots = null;
    fastToolMatrix?.dispose();
    systemState.stop();
    brain.dispose();
    service = null;
  });

  // Connect eagerly so the app is listening after launch.
  brain
    .start()
    .then(async () => {
      logger.info('[cyrvis voice] provider connected', {
        engine: selectedVoiceEngine,
      });
      if (settings.voiceTtsProvider === 'breeze-local') {
        void breezeTtsService.ensureStarted().catch((error: unknown) => {
          logger.warn('[cyrvis voice] Breeze TTS prewarm failed', error);
        });
      }
    })
    .catch((error) => {
      logger.error('[cyrvis voice] connect/capture failed', error);
      broadcast('cyrvis:voice:capture-error', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  logger.info('[cyrvis voice] service started');
  return service;
};
