const REFERENCE_SAMPLE_RATE = 24000;
const MIC_SAMPLE_RATE = 16000;
const MAX_REFERENCE_AGE_MS = 5000;
const MAX_ECHO_DELAY_MS = 1800;
const ECHO_DELAY_STEP_MS = 20;
const MIN_REFERENCE_RMS = 80;
// Real speaker/mic paths on this hardware correlate around 0.69-0.76 because
// of room reverb and Bluetooth mic processing. 0.72 left those in the
// "ambiguous" band, causing repeated 700ms probe pauses during every reply.
const ECHO_CORRELATION = 0.65;
const AMBIGUOUS_CORRELATION = 0.18;

interface ReferenceSegment {
  samples: Float32Array;
  startedAt: number;
  integral?: Float64Array;
}

export interface SpeakerEchoAnalysis {
  average: number;
  referenceAverage: number;
  correlation: number;
  referenceActive: boolean;
  likelyEcho: boolean;
  ambiguous: boolean;
  /** Microphone audio after subtracting the best-aligned playback reference. */
  residual: Int16Array;
  /** Best-aligned playback reference (16 kHz), used for relative voiceprint. */
  reference: Float32Array | null;
}

const toFloat = (input: Int16Array): Float32Array => {
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = input[index] / 0x8000;
  }
  return output;
};

const resample24kTo16k = (input: Float32Array): Float32Array => {
  const outputLength = Math.floor(
    (input.length * MIC_SAMPLE_RATE) / REFERENCE_SAMPLE_RATE,
  );
  const output = new Float32Array(outputLength);
  const ratio = REFERENCE_SAMPLE_RATE / MIC_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
};

const averageAbsolute = (samples: Float32Array): number => {
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    total += Math.abs(samples[index]);
  }
  return samples.length ? total / samples.length : 0;
};

const rms = (samples: Float32Array): number => {
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    total += samples[index] * samples[index];
  }
  return samples.length ? Math.sqrt(total / samples.length) : 0;
};

const correlation = (
  microphone: Float32Array,
  reference: Float32Array,
): number => {
  if (microphone.length !== reference.length || microphone.length === 0) {
    return 0;
  }

  let micMean = 0;
  let referenceMean = 0;
  for (let index = 0; index < microphone.length; index += 1) {
    micMean += microphone[index];
    referenceMean += reference[index];
  }
  micMean /= microphone.length;
  referenceMean /= microphone.length;

  let dot = 0;
  let micEnergy = 0;
  let referenceEnergy = 0;
  for (let index = 0; index < microphone.length; index += 1) {
    const mic = microphone[index] - micMean;
    const ref = reference[index] - referenceMean;
    dot += mic * ref;
    micEnergy += mic * mic;
    referenceEnergy += ref * ref;
  }

  const denominator = Math.sqrt(micEnergy * referenceEnergy);
  return denominator > 1e-9 ? Math.abs(dot / denominator) : 0;
};

/**
 * Compares microphone PCM with the PCM that is actually being played locally.
 * The playback segment start time is sent by the renderer, so correlation does
 * not depend on when Qwen generated the audio.
 */
export class SpeakerEchoDetector {
  private references: ReferenceSegment[] = [];
  private referenceEnabled = true;
  // Wall-clock time of the most recent analyze() call. Playback segments can
  // be scheduled far in the future (a long TTS reply is queued ahead in 1s
  // blocks), so pruning must be relative to the current capture clock, not to
  // the newest segment's start time: pruning against a future start time
  // dropped every near-term reference as soon as the queue was scheduled.
  private clock = 0;

  constructor(private readonly fineAlignment = false) {}

  addReference(pcm24k: Int16Array, startedAt = Date.now()): void {
    if (!pcm24k.length) {
      return;
    }
    const samples = resample24kTo16k(toFloat(pcm24k.slice()));
    const integral = this.fineAlignment
      ? new Float64Array(samples.length + 1)
      : undefined;
    if (integral) {
      for (let index = 0; index < samples.length; index++)
        integral[index + 1] = integral[index] + samples[index];
    }
    this.references.push({ samples, startedAt, integral });
    if (this.clock > 0) {
      this.prune(this.clock);
    }
  }

  setReferenceEnabled(enabled: boolean): void {
    this.referenceEnabled = enabled;
  }

  reset(): void {
    this.references = [];
    this.referenceEnabled = true;
  }

  analyze(microphone16k: Int16Array, now = Date.now()): SpeakerEchoAnalysis {
    if (now > this.clock) {
      this.clock = now;
    }
    const microphone = toFloat(microphone16k);
    const average = averageAbsolute(microphone);
    if (!this.referenceEnabled || microphone.length === 0) {
      return {
        average,
        referenceAverage: 0,
        correlation: 0,
        referenceActive: false,
        likelyEcho: false,
        ambiguous: false,
        residual: microphone16k.slice(),
        reference: null,
      };
    }

    this.prune(now);
    let bestCorrelation = 0;
    let bestReferenceAverage = 0;
    let bestReference: Float32Array | null = null;

    for (const segment of this.references) {
      // Segments queued ahead of the current playback position cannot explain
      // what the microphone is hearing yet.
      if (segment.startedAt > now) {
        continue;
      }
      if (this.fineAlignment && segment.integral) {
        // Find timing at 1 ms resolution on a low-pass signal, then refine
        // sample-by-sample. A 20 ms-only search can miss perfectly ordinary
        // speaker delays (e.g. 147 ms) and mistake pure echo for new speech.
        const blockSize = 16;
        const size = Math.floor(microphone.length / blockSize);
        if (!size) continue;
        const micBlocks = new Float32Array(size);
        for (let block = 0; block < size; block++) {
          for (let offset = 0; offset < blockSize; offset++)
            micBlocks[block] +=
              microphone[block * blockSize + offset] / blockSize;
        }
        const refBlocks = new Float32Array(size);
        const latestEnd = Math.floor(
          ((now - segment.startedAt) * MIC_SAMPLE_RATE) / 1000,
        );
        let bestStart = -1;
        let coarseScore = 0;
        for (
          let delay = 0;
          delay <= MAX_ECHO_DELAY_MS * 16;
          delay += blockSize
        ) {
          const end = latestEnd - delay;
          const start = end - microphone.length;
          if (start < 0 || end > segment.samples.length) continue;
          for (let block = 0; block < size; block++) {
            const left = start + block * blockSize;
            refBlocks[block] =
              (segment.integral[left + blockSize] - segment.integral[left]) /
              blockSize;
          }
          const score = correlation(micBlocks, refBlocks);
          if (score > coarseScore) {
            coarseScore = score;
            bestStart = start;
          }
        }
        if (bestStart < 0) continue;
        for (let shift = -blockSize; shift <= blockSize; shift++) {
          const start = bestStart + shift;
          if (start < 0 || start + microphone.length > segment.samples.length)
            continue;
          const reference = segment.samples.subarray(
            start,
            start + microphone.length,
          );
          if (rms(reference) < MIN_REFERENCE_RMS / 0x8000) continue;
          const score = correlation(microphone, reference);
          if (score > bestCorrelation) {
            bestCorrelation = score;
            bestReferenceAverage = averageAbsolute(reference);
            bestReference = reference;
          }
        }
      } else {
        for (
          let delayMs = 0;
          delayMs <= MAX_ECHO_DELAY_MS;
          delayMs += ECHO_DELAY_STEP_MS
        ) {
          const ageMs = now - segment.startedAt - delayMs;
          if (ageMs < 0) continue;
          const end = Math.floor((ageMs * MIC_SAMPLE_RATE) / 1000);
          const start = end - microphone.length;
          if (start < 0 || end > segment.samples.length) continue;
          const reference = segment.samples.subarray(start, end);
          if (rms(reference) < MIN_REFERENCE_RMS / 0x8000) continue;
          const score = correlation(microphone, reference);
          if (score > bestCorrelation) {
            bestCorrelation = score;
            bestReferenceAverage = averageAbsolute(reference);
            bestReference = reference;
          }
        }
      }
    }

    const referenceActive = bestReferenceAverage > 0;
    const residual = new Int16Array(microphone.length);
    if (bestReference && bestCorrelation > 0.05) {
      // Least-squares echo subtraction for the aligned 20ms window. This is a
      // coarse single-tap canceller, not full AEC, but it removes enough of
      // the assistant's voice for speaker verification to see the user.
      let dot = 0;
      let energy = 0;
      for (let index = 0; index < microphone.length; index += 1) {
        dot += microphone[index] * bestReference[index];
        energy += bestReference[index] * bestReference[index];
      }
      const gain = energy > 1e-9 ? dot / energy : 0;
      for (let index = 0; index < microphone.length; index += 1) {
        const value = microphone[index] - gain * bestReference[index];
        residual[index] = Math.max(
          -32768,
          Math.min(32767, Math.round(value * 0x8000)),
        );
      }
    } else {
      residual.set(microphone16k);
    }

    return {
      average,
      referenceAverage: bestReferenceAverage,
      correlation: bestCorrelation,
      referenceActive,
      likelyEcho:
        referenceActive &&
        average > 0.012 &&
        bestCorrelation >= ECHO_CORRELATION,
      ambiguous:
        referenceActive &&
        average > 0.012 &&
        bestCorrelation >= AMBIGUOUS_CORRELATION &&
        bestCorrelation < ECHO_CORRELATION,
      residual,
      reference: bestReference,
    };
  }

  private prune(now: number): void {
    this.references = this.references.filter(
      (segment) => now - segment.startedAt <= MAX_REFERENCE_AGE_MS,
    );
  }
}

/** Conservative double-talk gate, used before stopping local playback. */
export const isNearEndSpeech = (
  analysis: SpeakerEchoAnalysis,
  minimumRms: number,
): boolean => {
  if (
    !analysis.referenceActive ||
    analysis.likelyEcho ||
    analysis.correlation >= 0.5
  )
    return false;
  let energy = 0;
  for (const sample of analysis.residual) energy += (sample / 0x8000) ** 2;
  const residualRms = analysis.residual.length
    ? Math.sqrt(energy / analysis.residual.length)
    : 0;
  return residualRms >= minimumRms;
};
