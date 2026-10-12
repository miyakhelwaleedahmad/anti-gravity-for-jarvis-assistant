/**
 * core/voiceInput.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Normalises a spoken or typed command before routing: lower case, no
 * punctuation, brand names joined ("you tube" → "youtube"), wake word and
 * filler words removed. Moved out of core/orchestrator.ts unchanged (ARCH-01);
 * the orchestrator re-exports it.
 */

export function normalizeVoiceInput(text: string): string {
  if (!text) return "";

  // 1. Lowercase and replace punctuation (keeping hyphens for now to handle "you-tube")
  let result = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim();

  // Collapse spaces
  result = result.replace(/\s+/g, ' ');

  // 2. Normalize brand names
  result = result.replace(/\byou tube\b/g, 'youtube');
  result = result.replace(/\byou-tube\b/g, 'youtube');
  result = result.replace(/\bgit-hub\b/g, 'github');
  result = result.replace(/\bgit hub\b/g, 'github');

  // Strip remaining hyphens
  result = result.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

  // 3. Strip wake word prefixes
  const wakePrefixes = ['hey jarvis', 'jarvis'];
  for (const prefix of wakePrefixes) {
    if (result.startsWith(prefix + ' ')) {
      result = result.substring(prefix.length).trim();
      break;
    } else if (result === prefix) {
      result = '';
      break;
    }
  }

  // 4. Strip filler words/phrases
  const fillers = ['for me', 'please', 'can you', 'could you', 'would you'];
  for (const filler of fillers) {
    const regex = new RegExp(`\\b${filler}\\b`, 'g');
    result = result.replace(regex, '');
  }
  result = result.replace(/\bfor\b$/g, '');

  // Collapse spaces and trim one last time
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}
