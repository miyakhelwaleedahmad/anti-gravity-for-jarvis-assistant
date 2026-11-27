/**
 * system/shutdownSteps.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Stopping JARVIS's subsystems one after another (ARCH-07).
 *
 * jarvis.ts stopped each subsystem as `try { …stop(); } catch {}` and then
 * printed "JARVIS shut down cleanly". A goal runtime or agent system that
 * failed to stop (and so may not have saved its state) left no trace, and
 * the clean message was printed anyway.
 *
 * runShutdownSteps() runs every step even when one fails, gives each a time
 * limit (a stuck stop must not keep JARVIS from exiting), logs what failed,
 * and returns the failures so the caller can say so.
 */

import { redact } from '../security/redactor.js';

export interface ShutdownStep {
  name: string;
  run: () => unknown;
}

export interface ShutdownFailure {
  name: string;
  error: string;
}

export async function runShutdownSteps(
  steps: ShutdownStep[],
  opts: { stepTimeoutMs?: number; log?: (message: string) => void } = {},
): Promise<ShutdownFailure[]> {
  const stepTimeoutMs = opts.stepTimeoutMs ?? 5_000;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const failures: ShutdownFailure[] = [];
  for (const step of steps) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not stop within ${stepTimeoutMs} ms`)), stepTimeoutMs); }),
      ]);
    } catch (err) {
      const error = redact(err instanceof Error ? err.message : String(err));
      failures.push({ name: step.name, error });
      log(`[JARVIS] ⚠️  Shutdown step "${step.name}" failed: ${error.slice(0, 200)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return failures;
}
