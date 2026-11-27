/**
 * tests/replyChecks.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a test: checks on what JARVIS said (TEST-04).
 *
 * Tests looked for the expected words in the reply (`/opened notepad/`). A
 * reply that said the expected words and then "I encountered an unexpected
 * error, sir" passed, which is how BUG-02 went unseen.
 */

/** JARVIS's own generic failure replies (core/orchestrator.ts, core/reflectionEngine.ts). */
export const FAILURE_PHRASE = /unexpected error|unable to recover|critical failure|I could not process|my reasoning systems timed out/i;

/** True when the reply contains none of JARVIS's generic failure phrases. */
export function noFailurePhrase(reply: string): boolean {
  return !FAILURE_PHRASE.test(reply);
}

/** The reply says what was expected and no generic failure. */
export function saysOnly(reply: string, expected: RegExp): boolean {
  return expected.test(reply) && noFailurePhrase(reply);
}
