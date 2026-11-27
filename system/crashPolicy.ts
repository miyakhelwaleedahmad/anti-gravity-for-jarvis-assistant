/**
 * system/crashPolicy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What JARVIS does after an error nothing caught (REL-02).
 *
 * jarvis.ts only logged uncaught exceptions and unhandled rejections and went
 * on running. After an uncaught exception Node's own documentation says the
 * process is in an undefined state: a half-finished approval, a lock never
 * released, a state machine stuck between states. JARVIS kept listening and
 * acting in that state.
 *
 *   - An uncaught exception: logged, then the normal shutdown (memory and
 *     goals saved, subsystems stopped) and exit code 1. If shutdown itself
 *     hangs, the process exits after `forceExitMs`.
 *   - An unhandled rejection: logged. One is usually a forgotten `.catch()`;
 *     `maxRejections` within `windowMs` mean something keeps failing, and
 *     that is treated like an exception.
 *
 * Exit code 1 lets a supervisor restart JARVIS (scripts/superviseJarvis.ts).
 */

export interface CrashPolicyOptions {
  /** The normal shutdown, given the reason and the exit code it must end with. */
  shutdown: (reason: string, exitCode: number) => Promise<void> | void;
  exit?: (code: number) => void;
  log?: (message: string, err: unknown) => void;
  forceExitMs?: number;
  maxRejections?: number;
  windowMs?: number;
  now?: () => number;
}

export interface CrashPolicy {
  onUncaughtException(err: unknown): void;
  onUnhandledRejection(reason: unknown): void;
  /** True once a fatal error started the shutdown. */
  readonly stopping: boolean;
}

export function createCrashPolicy(opts: CrashPolicyOptions): CrashPolicy {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((message: string, err: unknown) => console.error(message, err));
  const forceExitMs = opts.forceExitMs ?? 10_000;
  const maxRejections = opts.maxRejections ?? 5;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const rejections: number[] = [];
  let stopping = false;

  const fatal = (reason: string, err: unknown) => {
    log(`[JARVIS] ${reason} — JARVIS's state is no longer known; saving and shutting down (exit code 1).`, err);
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => exit(1), forceExitMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => opts.shutdown(reason, 1))
      .catch((shutdownErr) => log('[JARVIS] Shutdown after a fatal error failed:', shutdownErr))
      .finally(() => { clearTimeout(timer); exit(1); });
  };

  return {
    get stopping() { return stopping; },
    onUncaughtException(err) {
      fatal('UNCAUGHT EXCEPTION', err);
    },
    onUnhandledRejection(reason) {
      const t = now();
      rejections.push(t);
      while (rejections.length && t - rejections[0]! > windowMs) rejections.shift();
      if (rejections.length >= maxRejections) {
        fatal(`${rejections.length} UNHANDLED PROMISE REJECTIONS within ${Math.round(windowMs / 1000)} s`, reason);
      } else {
        log(`[JARVIS] UNHANDLED PROMISE REJECTION (${rejections.length} of ${maxRejections} allowed within ${Math.round(windowMs / 1000)} s):`, reason);
      }
    },
  };
}
