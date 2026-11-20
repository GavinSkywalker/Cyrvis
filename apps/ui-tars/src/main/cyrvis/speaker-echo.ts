const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'“”‘’]/g, '')
    .trim();

// ASR often hears "CYRVIS" as service/savage/S voice. These are wake attempts,
// not speaker leakage, even when they start with the assistant's "Hello".
const WAKE_HINT =
  /cyrvis|cyrus|cyris|savis|savage|service|svoice|s voice|赛维斯|萨维斯|瑟维斯|塞维斯/i;

const bigrams = (text: string): Set<string> => {
  const result = new Set<string>();
  if (text.length < 2) {
    return result;
  }
  for (let index = 0; index < text.length - 1; index += 1) {
    result.add(text.slice(index, index + 2));
  }
  return result;
};

const diceSimilarity = (left: string, right: string): number => {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (!leftBigrams.size || !rightBigrams.size) {
    return left === right ? 1 : 0;
  }

  let intersection = 0;
  for (const value of leftBigrams) {
    if (rightBigrams.has(value)) {
      intersection += 1;
    }
  }
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
};

/**
 * Detects a final ASR transcript that is likely speaker leakage from the
 * assistant's immediately preceding reply. PCM gating is the primary defense;
 * this text check catches device latency and Bluetooth/audio-queue tails.
 */
export const isLikelySpeakerEcho = (
  transcript: string,
  assistantText: string,
  assistantAgeMs: number,
  maxAgeMs = 6_000,
): boolean => {
  if (assistantAgeMs < 0 || assistantAgeMs > maxAgeMs) {
    return false;
  }

  const heard = normalize(transcript);
  const spoken = normalize(assistantText);
  if (heard.length < 2 || spoken.length < 2) {
    return false;
  }
  if (WAKE_HINT.test(heard)) {
    return false;
  }
  if (heard === spoken) {
    return true;
  }

  const short = heard.length <= spoken.length ? heard : spoken;
  const long = heard.length > spoken.length ? heard : spoken;
  // A one-word assistant fragment such as "Hello" is too weak to judge: the
  // user's wake phrase also starts with "Hello". Only match prefixes/suffixes
  // once the assistant actually said a full phrase.
  if (spoken.length >= 8 && short.length >= 3 && long.startsWith(short)) {
    return true;
  }
  // Echo recognition often returns only a short suffix of the assistant's
  // sentence. If that complete fragment is present in the just-spoken reply,
  // treat it as leakage instead of starting a new conversational turn.
  if (spoken.length >= 8 && short.length >= 3 && long.includes(short)) {
    return true;
  }

  return diceSimilarity(heard, spoken) >= 0.72;
};
