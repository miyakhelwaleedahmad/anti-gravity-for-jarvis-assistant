/**
 * core/clarification.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A reply that asks the owner something back ("Which language do you want,
 * sir?") ends the turn: it is neither done nor failed. BUG-9: such a reply
 * to "language task set" was recorded as a FAILED goal with retry 1/3, and
 * the goal was saved as paused on shutdown, ready to run again.
 */

/** True when the reply's last sentence is a question. */
export function isClarifyingQuestion(reply: string | undefined): boolean {
  if (!reply) return false;
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/[\s\p{Extended_Pictographic}\uFE0F]+$/u, '').trim();
  if (!text || text.length > 600) return false;
  return /\?["')\]]*$/.test(text);
}
