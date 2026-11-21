import { describe, expect, it } from 'vitest';

import { SpeakerEchoDetector, isNearEndSpeech } from './speaker-barge';

const makeNoise = (length: number, seed: number): Int16Array => {
  const output = new Int16Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    output[index] = Math.round((state / 0xffffffff) * 18000 - 9000);
  }
  return output;
};

const downsample24kTo16k = (input: Int16Array): Int16Array => {
  const output = new Int16Array(Math.floor((input.length * 2) / 3));
  for (let index = 0; index < output.length; index += 1) {
    const position = index * 1.5;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    output[index] = Math.round(
      input[left] * (1 - (position - left)) + input[right] * (position - left),
    );
  }
  return output;
};

describe('SpeakerEchoDetector', () => {
  it('identifies delayed playback leakage from the reference signal', () => {
    const detector = new SpeakerEchoDetector();
    const reference = makeNoise(36000, 11);
    const reference16k = downsample24kTo16k(reference);
    const microphone = reference16k.slice(14080, 14400);

    detector.addReference(reference, 1000);
    const result = detector.analyze(microphone, 2000);

    expect(result.referenceActive).toBe(true);
    expect(result.correlation).toBeGreaterThan(0.95);
    expect(result.likelyEcho).toBe(true);
  });

  it('detects delayed echo beyond one playback segment', () => {
    const detector = new SpeakerEchoDetector();
    const reference = makeNoise(36000, 15);
    const reference16k = downsample24kTo16k(reference);
    const microphone = reference16k.slice(12800, 13120);

    detector.addReference(reference, 1000);
    const result = detector.analyze(microphone, 2700);

    expect(result.referenceActive).toBe(true);
    expect(result.correlation).toBeGreaterThan(0.95);
    expect(result.likelyEcho).toBe(true);
  });

  it('keeps an unrelated loud near-end signal available for barge-in', () => {
    const detector = new SpeakerEchoDetector();
    const reference = makeNoise(36000, 21);
    const microphone = makeNoise(320, 99);

    detector.addReference(reference, 1000);
    const result = detector.analyze(microphone, 2000);

    expect(result.referenceActive).toBe(true);
    expect(result.correlation).toBeLessThan(0.25);
    expect(result.likelyEcho).toBe(false);
  });

  it('keeps mixed user speech from being treated as pure echo', () => {
    const detector = new SpeakerEchoDetector();
    const reference = makeNoise(36000, 51);
    const reference16k = downsample24kTo16k(reference);
    const echo = reference16k.slice(14080, 14400);
    const user = makeNoise(320, 61);
    const microphone = new Int16Array(320);
    for (let index = 0; index < microphone.length; index += 1) {
      microphone[index] = Math.max(
        -32768,
        Math.min(32767, Math.round(echo[index] * 0.6 + user[index])),
      );
    }

    detector.addReference(reference, 1000);
    const result = detector.analyze(microphone, 2000);

    expect(result.correlation).toBeGreaterThan(0.18);
    expect(result.likelyEcho).toBe(false);
  });

  it('keeps near-term references when a long reply is queued ahead', () => {
    const detector = new SpeakerEchoDetector();
    // Establishes the capture clock, as the first analyze() in production does.
    detector.analyze(makeNoise(320, 7), 1000);

    const blocks = Array.from({ length: 10 }, (_, index) =>
      makeNoise(24000, 100 + index),
    );
    // The renderer now schedules ~1s blocks and a long TTS reply can be queued
    // tens of seconds ahead. Pruning against the newest (future) start time
    // used to discard the block that is playing right now.
    blocks.forEach((block, index) => {
      detector.addReference(block, 1000 * (index + 1));
    });

    const first = downsample24kTo16k(blocks[0]);
    const result = detector.analyze(first.slice(7680, 8000), 1500);

    expect(result.referenceActive).toBe(true);
    expect(result.correlation).toBeGreaterThan(0.95);
    expect(result.likelyEcho).toBe(true);
  });

  it('does not classify microphone audio as echo while playback is paused', () => {
    const detector = new SpeakerEchoDetector();
    detector.addReference(makeNoise(36000, 31), 1000);
    detector.setReferenceEnabled(false);

    const result = detector.analyze(makeNoise(320, 41), 2000);

    expect(result.referenceActive).toBe(false);
    expect(result.likelyEcho).toBe(false);
  });
});

it('aligns speaker echo between the old 20 ms delay grid without classifying it as near-end speech', () => {
  const reference = makeNoise(48_000, 17);
  const reference16k = downsample24kTo16k(reference);
  const end = 16_000 - 2357; // 147.3125 ms speaker delay, deliberately off-grid.
  const mic = reference16k.slice(end - 1365, end);
  const detector = new SpeakerEchoDetector(true);
  detector.addReference(reference, 1000);
  const result = detector.analyze(mic, 2000);
  expect(result.correlation).toBeGreaterThan(0.99);
  expect(isNearEndSpeech(result, 0.05)).toBe(false);
  expect(
    isNearEndSpeech(detector.analyze(makeNoise(1365, 999), 2000), 0.05),
  ).toBe(true);
});
