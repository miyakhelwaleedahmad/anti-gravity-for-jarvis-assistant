/**
 * core/voiceSettings.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Voice-loop settings read from the environment, with their defaults. Kept
 * apart from jarvis.ts so they can be tested without starting the assistant.
 */

type Env = Record<string, string | undefined>;

function numberFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * How long a command heard while JARVIS was busy may wait in the queue.
 * JARVIS answers "One moment, sir. I will get to that right after this.", so
 * the wait has to cover a whole request: the old fixed 6 s dropped most queued
 * commands on a slow PC. JARVIS_QUEUED_COMMAND_MAX_AGE_MS, default 30000.
 */
export function queuedCommandMaxAgeMs(env: Env = process.env): number {
  return Math.max(1_000, numberFrom(env, 'JARVIS_QUEUED_COMMAND_MAX_AGE_MS', 30_000));
}

/**
 * Said when a queued command is dropped anyway, instead of dropping it
 * silently. It does not repeat the command: right after a reply JARVIS listens
 * without the wake word, and "open notepad" from the speakers could be heard
 * as a new command.
 */
export const DROPPED_COMMAND_NOTICE =
  'Sorry, sir. Your last request waited too long, so I skipped it. Please say it again.';

/**
 * Seconds after a reply in which a follow-up needs no wake word.
 * JARVIS_FOLLOWUP_SECONDS, default 15; 0 turns follow-ups off.
 */
export function followUpSeconds(env: Env = process.env): number {
  return Math.min(120, Math.round(numberFrom(env, 'JARVIS_FOLLOWUP_SECONDS', 15)));
}

/**
 * Whether to start the screen-capture (Vision) service. Nothing in the current
 * code sends it "vision_start", so it only holds memory (OpenCV, NumPy); set
 * JARVIS_VISION=off on a low-memory PC. Default on.
 */
export function visionEnabled(env: Env = process.env): boolean {
  const raw = env['JARVIS_VISION']?.trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'no');
}
