/**
 * scripts/superviseJarvis.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs JARVIS and starts it again after a crash (REL-02).
 *
 * After an uncaught error JARVIS now saves its state and exits with code 1
 * instead of running on in an unknown state. This restarts it, after a pause
 * that grows with each crash, and gives up after `maxRestarts` crashes within
 * `windowMs` (a crash at every start would otherwise loop forever).
 * A normal stop (exit code 0, Ctrl+C) ends the supervisor too.
 *
 *   pnpm dev:supervised        (npx tsx scripts/superviseJarvis.ts)
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

export interface SuperviseOptions {
  start: () => ChildProcess;
  maxRestarts?: number;
  windowMs?: number;
  baseDelayMs?: number;
  log?: (line: string) => void;
}

/** Resolves with the exit code the supervisor ends with. */
export function supervise(opts: SuperviseOptions): Promise<number> {
  const maxRestarts = opts.maxRestarts ?? 5;
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const baseDelayMs = opts.baseDelayMs ?? 2_000;
  const log = opts.log ?? ((line: string) => console.log(line));
  const crashes: number[] = [];

  return new Promise((resolve) => {
    const run = () => {
      const child = opts.start();
      child.on('exit', (code, signal) => {
        if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') {
          log('[Supervisor] JARVIS stopped normally.');
          resolve(0);
          return;
        }
        const now = Date.now();
        crashes.push(now);
        while (crashes.length && now - crashes[0]! > windowMs) crashes.shift();
        if (crashes.length > maxRestarts) {
          log(`[Supervisor] JARVIS crashed ${crashes.length} times within ${Math.round(windowMs / 60_000)} min — not restarting. Read the log above for the error.`);
          resolve(code ?? 1);
          return;
        }
        const delay = baseDelayMs * 2 ** (crashes.length - 1);
        log(`[Supervisor] JARVIS exited with code ${code ?? signal}; restarting in ${Math.round(delay / 1000)} s (crash ${crashes.length} of ${maxRestarts} allowed).`);
        setTimeout(run, delay);
      });
    };
    run();
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let current: ChildProcess | null = null;
  const forward = (sig: NodeJS.Signals) => { current?.kill(sig); };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  const code = await supervise({
    start: () => {
      current = spawn(process.execPath, [path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'jarvis.ts'], { cwd: repo, stdio: 'inherit' });
      return current;
    },
  });
  process.exit(code);
}
