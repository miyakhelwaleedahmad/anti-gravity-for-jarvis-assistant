/**
 * core/spokenText.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Text as the voice says it (BUG-13). An LLM reply with a numbered list and
 * **bold** was read out marker by marker, and a streamed reply had no length
 * limit: the 3-sentence cap ran on each streamed chunk, not on the reply.
 *
 *   stripMarkdown    whole text: list and heading markers, bold, code ticks
 *                    and links removed; each line ends as a sentence.
 *                    nodeBridge.speakToClients runs it on everything spoken.
 *   speakableStream  the same for a reply that is still arriving: only what
 *                    can no longer change is returned.
 *   SentenceBudget   the cap for one whole reply, across streamed chunks.
 */

export const SPOKEN_MAX_SENTENCES = 3;
export const CONSOLE_NOTE = 'I have printed the full details to the console, sir.';

/** "1. ", "- ", "* ", "• ", "## ", "> " at the start of a line. */
const LINE_MARKER = /^\s*(?:#{1,6}|>|[-*+•]|\d{1,3}[.)])\s+/;

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/g, '');
}

function plainLine(line: string): string {
  return line
    .replace(LINE_MARKER, '')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')   // [text](url) → text
    .replace(/```[\w-]*|\*\*|__|[*`~]/g, '')
    .trim();
}

/** The text without markdown; a list is read as one sentence per item. */
export function stripMarkdown(text: string): string {
  const lines = stripThink(text).split(/\r?\n/).map(plainLine).filter(Boolean);
  return lines
    .map((line, i) => (i < lines.length - 1 && !/[.!?:;,]$/.test(line) ? `${line}.` : line))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * A reply still arriving, ready to speak: complete lines lose their markers
 * and end as sentences; the open line loses a marker once it is complete. A
 * line start that may still become a marker ("1", "1.", "-") and trailing
 * spaces are held back, so what this returns for a longer text always starts
 * with what it returned before. Links are left to the per-chunk cleanup.
 */
export function speakableStream(text: string): string {
  const raw = stripThink(text);
  const cut = raw.lastIndexOf('\n');
  const streamLine = (line: string) => line.replace(LINE_MARKER, '').replace(/[*`~]/g, '').trimEnd();
  const head = (cut < 0 ? [] : raw.slice(0, cut).split('\n'))
    .map(streamLine)
    .filter((line) => line.trim() && !/^\s*(?:#{1,6}|>|[-*+•]|\d{1,3}[.)]?)$/.test(line))
    .map((line) => (/[.!?:;,]$/.test(line) ? `${line}\n` : `${line}.\n`))
    .join('');
  const open = raw.slice(cut + 1);
  return head + (/^\s*(?:#{1,6}|>|[-*+•]|\d{1,3}[.)]?)?$/.test(open) ? '' : streamLine(open));
}

/** What one reply may still say: at most `max` sentences in all. */
export class SentenceBudget {
  private left: number;
  /** Something was left unsaid. */
  truncated = false;

  constructor(max = SPOKEN_MAX_SENTENCES) {
    this.left = max;
  }

  /** The part of `text` still within the budget ('' once it is spent). */
  take(text: string): string {
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    const kept = sentences.slice(0, Math.max(0, this.left));
    if (sentences.length > kept.length) this.truncated = true;
    this.left -= kept.length;
    return kept.join(' ');
  }
}

/**
 * A streamed reply spoken as it arrives, in sentence-sized chunks, within one
 * SentenceBudget for the whole reply; the full text is printed. end() speaks
 * what is left and, when the budget cut something, says it is in the console.
 */
export class SpokenStream {
  private full = '';
  private printed = 0;
  private taken = 0;
  private buffer = '';
  private readonly budget = new SentenceBudget();

  constructor(private readonly speak: (text: string) => void, private readonly print: (text: string) => void = () => {}) {}

  push(chunk: string): void {
    this.full += chunk;
    const shown = stripThink(this.full).trimStart();
    if (shown.length > this.printed) {
      this.print(shown.substring(this.printed));
      this.printed = shown.length;
    }
    const clean = speakableStream(shown);
    const newPart = clean.substring(this.taken);
    if (!newPart) return;
    this.buffer += newPart;
    this.taken = clean.length;

    // Send to TTS at sentence boundaries
    if (/[.!?\n]\s/.test(this.buffer)) {
      const parts = this.buffer.split(/(?<=[.!?\n])\s+/);
      this.buffer = parts.pop() ?? '';
      let chunk2Send = '';
      for (const part of parts) {
        chunk2Send += part + ' ';
        if (chunk2Send.length > 25 || parts.length === 1) {
          this.say(chunk2Send.trim());
          chunk2Send = '';
        }
      }
      if (chunk2Send.trim()) this.buffer = chunk2Send + this.buffer;
    }
  }

  end(): void {
    if (this.buffer.trim()) this.say(this.buffer.trim());
    this.buffer = '';
    if (this.budget.truncated) this.speak(CONSOLE_NOTE);
  }

  private say(text: string): void {
    const part = this.budget.take(text);
    if (part) this.speak(part);
  }
}
