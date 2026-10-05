/**
 * control/permissionDenial.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Recognising a refusal by JARVIS's own permission levels, and what to say
 * about it. No imports, so the task engine can use it without loading the
 * permission session.
 */

/** What JARVIS says when an action needs a full-control session. */
export const FULL_CONTROL_HINT =
  "That needs full control mode, sir. Say 'enable full control mode', then ask again.";

/**
 * True for a refusal by the dispatch gate (PERMISSION_DENIED) or a
 * controller's level check. Retrying cannot raise the level, so callers stop
 * and say how to grant it. A file system "EACCES: permission denied" is not
 * one of these.
 */
export function isPermissionDenial(text: string): boolean {
  return /PERMISSION_DENIED|permission level \d|^permission denied\.?$|full[- ]control session/i.test(text.trim());
}
