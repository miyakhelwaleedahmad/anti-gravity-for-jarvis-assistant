/**
 * core/voiceEchoFilter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Determines whether an STT result is an acoustic echo of the last TTS output
 * rather than a genuine user command.
 *
 * Phase 4 improvements:
 *   - Narrower echo window: 4s (was 8s). Audio hardware typically settles within
 *     150-300ms after TTS ends; 8s was causing false-positive rejections of real
 *     commands made up to 8 seconds later.
 *   - Bigram / N-gram similarity: adds a lightweight bigram overlap score in
 *     addition to the existing unigram overlap. Bigrams catch phrase-level echo
 *     more precisely than single-word counts (e.g. "one moment sir" echoes the
 *     phrase, not just individual words).
 *   - Barge-in TTS protection: if the STT text was received WHILE TTS was playing
 *     (startedMs < ttsEndMs), the audio was almost certainly captured while the
 *     speaker was still open and is therefore likely echo. This is a new guard
 *     separate from the window check.
 *   - Tuned thresholds: command-keyword threshold raised 0.75 → 0.80 (more
 *     lenient for real commands); non-command threshold raised 0.60 → 0.65.
 */

import type { JarvisOrchestrator } from './orchestrator.js';

// Phase 4: Narrowed from 8s → 4s to prevent false-positive echo rejections.
const ECHO_WINDOW_MS = 4_000;

const COMMAND_KEYWORDS_SET = new Set([
  'open', 'launch', 'start', 'close', 'run', 'stop', 'play', 'search',
  'youtube', 'google', 'chrome', 'notepad', 'calculator', 'spotify',
]);

function cleanSpeech(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function hasCommandKeyword(text: string): boolean {
  const words = cleanSpeech(text).split(/\s+/).filter(Boolean);
  return words.some(w => COMMAND_KEYWORDS_SET.has(w));
}

function isCommandLike(text: string): boolean {
  const words = cleanSpeech(text).split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const commandVerbs = ['open', 'launch', 'start', 'run', 'play', 'search', 'close', 'stop'];
  return words.some(w => commandVerbs.includes(w));
}

/** Unigram overlap ratio (existing) */
function unigramOverlap(sttWords: string[], ttsWords: string[]): number {
  if (sttWords.length === 0 || ttsWords.length === 0) return 0;
  let count = 0;
  for (const w of sttWords) if (ttsWords.includes(w)) count++;
  return count / Math.max(sttWords.length, ttsWords.length);
}

/**
 * Phase 4: Bigram overlap ratio.
 * Bigrams catch phrase-level echo more accurately than individual word counts.
 * Example: ["one","moment","sir"] → bigrams ["one moment", "moment sir"]
 */
function bigramOverlap(sttWords: string[], ttsWords: string[]): number {
  const toBigrams = (words: string[]): string[] =>
    words.length < 2 ? [] : words.slice(0, -1).map((w, i) => `${w} ${words[i + 1]}`);

  const sttBi = toBigrams(sttWords);
  const ttsBi = toBigrams(ttsWords);
  if (sttBi.length === 0 || ttsBi.length === 0) return 0;

  let count = 0;
  for (const bi of sttBi) if (ttsBi.includes(bi)) count++;
  return count / Math.max(sttBi.length, ttsBi.length);
}

function overlapScore(cleanStt: string, cleanTts: string): { unigram: number; bigram: number; combined: number } {
  const sttWords = cleanStt.split(/\s+/).filter(Boolean);
  const ttsWords = cleanTts.split(/\s+/).filter(Boolean);
  const unigram = unigramOverlap(sttWords, ttsWords);
  const bigram  = bigramOverlap(sttWords, ttsWords);
  // Weighted: 60% unigram + 40% bigram (bigrams are more specific but sparser)
  const combined = 0.6 * unigram + 0.4 * bigram;
  return { unigram, bigram, combined };
}

export interface EchoDecision {
  isEcho: boolean;
  reason: string;
  overlapScore: number;   // combined score 0–1
  unigramScore: number;
  bigramScore: number;
  sttText: string;
  lastTtsText: string;
}

export function evaluateEcho(
  sttText: string,
  lastTtsText: string,
  orchestrator?: Pick<JarvisOrchestrator, 'matchDeterministicCommand'>,
  lastTtsTimestampMs?: number,
  /** Phase 4: timestamp when TTS playback STARTED (for barge-in detection) */
  ttsStartedMs?: number,
): EchoDecision {
  const cleanStt = cleanSpeech(sttText);
  const cleanTts = cleanSpeech(lastTtsText);
  const scores   = overlapScore(cleanStt, cleanTts);

  const makeResult = (isEcho: boolean, reason: string): EchoDecision => ({
    isEcho,
    reason,
    overlapScore: scores.combined,
    unigramScore: scores.unigram,
    bigramScore:  scores.bigram,
    sttText,
    lastTtsText,
  });

  // ── Guard 1: TTS expired (Phase 4: 4s window instead of 8s) ─────────────────
  if (lastTtsTimestampMs !== undefined) {
    const age = Date.now() - lastTtsTimestampMs;
    if (age > ECHO_WINDOW_MS) {
      return makeResult(false, `tts_expired (age=${age}ms > ${ECHO_WINDOW_MS}ms)`);
    }
  }

  // ── Guard 2: Phase 4 — Barge-in detection ────────────────────────────────────
  // If TTS started AFTER this STT result's analysis (i.e. the audio was captured
  // while the speaker was active), this is almost certainly barge-in echo.
  // We only apply this guard for non-command-like text (commands barge in intentionally).
  if (ttsStartedMs !== undefined && !isCommandLike(cleanStt)) {
    const sttArrivedApprox = Date.now(); // approximate — within the call frame
    if (sttArrivedApprox - ttsStartedMs < 500) {
      // STT arrived within 500ms of TTS starting — captured during speaker warmup
      return makeResult(true, `barge-in echo (arrived within 500ms of tts_start)`);
    }
  }

  // ── Guard 3: Command-like speech is protected ─────────────────────────────────
  if (isCommandLike(cleanStt)) {
    return makeResult(false, 'command-like speech protected');
  }

  // ── Guard 4: Deterministic command protected ─────────────────────────────────
  if (orchestrator?.matchDeterministicCommand(sttText)) {
    return makeResult(false, 'deterministic command protected');
  }

  // ── Guard 5: Common phrase exact match ───────────────────────────────────────
  const commonPhrases = [
    'one moment sir',
    'i will get to that right after',
    'would you like me to',
    'let me know',
    'here are',
    'one moment sir i will get to that right after this',
    'jarvis version 2 is online sir autonomous systems are fully operational',
  ];

  for (const phrase of commonPhrases) {
    if (cleanStt.includes(phrase) || phrase.includes(cleanStt)) {
      return makeResult(true, `matched common phrase: ${phrase}`);
    }
  }

  if (!cleanTts) {
    return makeResult(false, 'no last TTS text');
  }

  // ── Guard 6: Exact/containment match ─────────────────────────────────────────
  if (cleanStt === cleanTts || cleanTts.includes(cleanStt) || cleanStt.includes(cleanTts)) {
    return makeResult(true, 'exact/containment match with last TTS');
  }

  // ── Guard 7: Overlap threshold (Phase 4: raised thresholds) ──────────────────
  // Combined score (unigram + bigram weighted) reduces false positives from
  // short utterances where a few words accidentally overlap.
  const threshold = hasCommandKeyword(cleanStt) ? 0.80 : 0.65;  // was 0.75 / 0.60
  if (scores.combined > threshold) {
    return makeResult(
      true,
      `combined overlap ${scores.combined.toFixed(2)} (uni=${scores.unigram.toFixed(2)}, bi=${scores.bigram.toFixed(2)}) exceeded ${threshold}`,
    );
  }

  return makeResult(
    false,
    `combined overlap ${scores.combined.toFixed(2)} within threshold ${threshold}`,
  );
}
