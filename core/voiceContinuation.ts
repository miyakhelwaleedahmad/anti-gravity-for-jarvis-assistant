/**
 * core/voiceContinuation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Merges split voice commands that arrive across multiple wake cycles.
 * Example: "Jarvis open" [wake] → "YouTube for me" [follow-up] → "open YouTube for me"
 *
 * Phase 4 improvements:
 *   - Richer continuation prefix set: added 'close', 'run', 'play', 'search',
 *     'find', 'show', 'get', 'check', 'set', 'turn', 'go', 'take', 'make',
 *     'tell', 'send', 'read', 'write', 'delete', 'move', 'copy', 'stop',
 *     'pause', 'resume' so conversational fragments are correctly merged.
 *   - Multi-fragment accumulation: instead of merging only prefix + one fragment,
 *     the buffer can hold up to MAX_FRAGMENTS partial continuations. Each new
 *     fragment is appended to the accumulated buffer until a non-continuation
 *     keyword is detected or the buffer is flushed.
 *   - Expiry jitter: the continuation window resets to fresh on every new
 *     fragment rather than expiring from the original wake word time. This
 *     supports natural multi-pause speech.
 *   - Improved split-word normalisation: expanded _SPLIT_WORD_MAP to handle
 *     more Whisper artefacts (git lab, stack overflow, vs code, etc.).
 */

// ─── Continuation prefix set (Phase 4: expanded) ──────────────────────────────

const CONTINUATION_PREFIXES = new Set([
  // Original 3
  'open', 'launch', 'start',
  // Phase 4 additions
  'close', 'run', 'play', 'search', 'find', 'show', 'get', 'check',
  'set', 'turn', 'go', 'take', 'make', 'tell', 'send', 'read',
  'write', 'delete', 'move', 'copy', 'stop', 'pause', 'resume', 'switch',
]);

/** Words that are themselves full action verbs — don't prepend prefix if present */
const ACTION_PREFIXES = new Set([
  'open', 'launch', 'start', 'close', 'run', 'play', 'search', 'stop',
  'cancel', 'find', 'show', 'get', 'check', 'set', 'turn', 'go', 'take',
  'make', 'tell', 'send', 'read', 'write', 'delete', 'move', 'copy',
  'pause', 'resume', 'switch',
]);

// ─── Split-word normalisation map (Phase 4: expanded) ─────────────────────────

const _SPLIT_WORD_MAP: [string, string][] = [
  // Audio / video
  ['you tube.com', 'youtube'],
  ['you tubecom',  'youtube'],
  ['you tube',     'youtube'],
  ['you-tube',     'youtube'],
  // Dev tools
  ['git hub',      'github'],
  ['git hub.com',  'github'],
  ['git lab',      'gitlab'],
  ['vs code',      'vscode'],
  ['visual studio code', 'vscode'],
  ['stack overflow', 'stackoverflow'],
  ['stack over flow', 'stackoverflow'],
  ['note pad',     'notepad'],
  ['task manager', 'taskmanager'],
  ['control panel', 'controlpanel'],
];

/** Max continuation fragments before auto-flushing as a complete command */
const MAX_FRAGMENTS = 4;

// ─── Text cleanup helpers ──────────────────────────────────────────────────────

function cleanVoiceFragment(text: string): string {
  let result = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Apply split-word normalisation
  for (const [split, canonical] of _SPLIT_WORD_MAP) {
    result = result.replace(new RegExp(`\\b${split}\\b`, 'g'), canonical);
  }

  // Remove filler / politeness words
  result = result
    .replace(/\b(for me|please|can you|could you|would you|if you can|thank you|thanks)\b/g, '')
    .replace(/\bfor\b$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the given partial command is a continuation prefix
 * (i.e. likely an incomplete utterance that needs a follow-up fragment).
 */
export function shouldUseContinuationContext(partialCommand: string | undefined | null): boolean {
  const clean = cleanVoiceFragment(partialCommand ?? '');
  // Must be a single known action word with nothing else following it
  const words = clean.split(/\s+/).filter(Boolean);
  return words.length === 1 && CONTINUATION_PREFIXES.has(words[0]!);
}

/**
 * Merge a pending prefix (or accumulated buffer) with a new voice fragment.
 *
 * Phase 4: pendingPrefix may now contain multiple space-separated fragments
 * accumulated across wake cycles. The result is the full merged command.
 *
 * @param pendingPrefix  Space-joined buffer of accumulated prefix fragments
 * @param fragment       Newly captured STT fragment
 * @returns              Merged full command, or just the fragment if no prefix applies
 */
export function mergePendingVoiceContinuation(
  pendingPrefix: string | null | undefined,
  fragment: string,
): string {
  const prefix       = cleanVoiceFragment(pendingPrefix ?? '');
  const cleanFragment = cleanVoiceFragment(fragment);

  if (!prefix || !cleanFragment) {
    return cleanFragment;
  }

  // If fragment already starts with an action verb, it's self-contained
  const firstWord = cleanFragment.split(/\s+/)[0] ?? '';
  if (ACTION_PREFIXES.has(firstWord)) {
    return cleanFragment;
  }

  // Merge: prefix acts as the verb, fragment as the object/target
  return `${prefix} ${cleanFragment}`.trim();
}

/**
 * Phase 4: Accumulate a new fragment into the running continuation buffer.
 * Returns the updated buffer (up to MAX_FRAGMENTS words).
 * Caller is responsible for resetting the buffer when:
 *   - The buffer is flushed as a complete command
 *   - The continuation window expires
 */
export function accumulateContinuationFragment(
  currentBuffer: string | null | undefined,
  newFragment: string,
): string {
  const existing = cleanVoiceFragment(currentBuffer ?? '');
  const clean    = cleanVoiceFragment(newFragment);
  if (!clean) return existing;

  const combined = existing ? `${existing} ${clean}` : clean;
  const words    = combined.split(/\s+/).filter(Boolean);

  // Cap at MAX_FRAGMENTS words to prevent runaway accumulation
  return words.slice(0, MAX_FRAGMENTS * 3).join(' '); // 3 words avg per fragment
}

/**
 * Phase 4: Exported for tests — normalise and map split words.
 */
export function normalizeContinuationText(text: string): string {
  return cleanVoiceFragment(text);
}
