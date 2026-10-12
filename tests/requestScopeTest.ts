/**
 * tests/requestScopeTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * REL-04 / REL-05: two requests that overlap (the second said while the
 * first is still planning).
 *
 * REL-04: the orchestrator kept one `activeGoal` field. The first request
 * finishing cleared it while the second was still running, so an interrupt or
 * a reset could no longer reach the second request's goal.
 * REL-05: model calls took this.currentAbortController's signal (the newest
 * request's) instead of their own request's.
 *
 *   1. while the second request runs, its goal is still tracked after the
 *      first one ended
 *   2. each model call carries its own request's signal: the first request's
 *      call is cancelled when the second starts; the second's is not
 *   3. each request keeps its own plan outcome (ARCH-03): the cancelled one
 *      fails, the one answered directly succeeds
 * Scripted model; no tool is run.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-request-scope-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const { modelRouter } = await import('../bridge/modelRouter.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { goalManager } = await import('../core/goalManager.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { installFakeTts } = await import('./fakeTts.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const calls: Array<{ input: string; signal?: AbortSignal }> = [];
let releaseSecond!: () => void;
const secondHeld = new Promise<void>((r) => { releaseSecond = r; });
const fakeProvider = {
  isConfigured: () => true,
  async chat(req: any) {
    const input = String([...(req.messages ?? [])].reverse().find((m: any) => m.role === 'user')?.content ?? '');
    calls.push({ input, signal: req.signal });
    if (req.tools) {
      if (/printing press/.test(input)) {
        // The first request's plan: waits until it is cancelled.
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(resolve, 10_000);
        });
        throw new Error('AbortError: aborted');
      }
      await secondHeld;
    }
    return { content: 'Here is a short answer, sir.' };
  },
  async *streamChat() { yield 'Fine, sir.'; },
};
modelRouter.registerProvider((modelRouter as any).primary, fakeProvider as any);
modelRouter.registerProvider('openai', fakeProvider as any);
const tts = installFakeTts(orchestrator, nodeBridge);
await goalManager.init();

const tracked = (): string[] => {
  const o = orchestrator as any;
  if (o.activeGoals instanceof Map) return [...o.activeGoals.values()].map((g: any) => g.id);
  return o.activeGoal ? [o.activeGoal.id] : [];
};
const until = async (cond: () => boolean, ms = 8_000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

console.log('\n=== Overlapping requests (REL-04, REL-05) ===\n');
const first = orchestrator.process('figure out why my printing press project keeps failing and plan the next three steps', 'cli');
await until(() => calls.some((c) => /printing press/.test(c.input)));
const second = orchestrator.process('figure out why my telescope project keeps failing and plan the next three steps', 'cli');
await first;
await until(() => calls.some((c) => /telescope/.test(c.input)));
await new Promise((r) => setTimeout(r, 200));

console.log('--- 1. The second request\'s goal ---');
const telescope = goalManager.listGoals({ kinds: ['request'] }).find((g: any) => /telescope/.test(g.description));
ok('the second request has a goal', !!telescope);
ok('…still tracked after the first request ended', !!telescope && tracked().includes(telescope.id), `tracked: ${tracked().join(',') || 'none'}`);

console.log('\n--- 2. Signals ---');
const firstCall = calls.find((c) => /printing press/.test(c.input));
const secondCall = calls.find((c) => /telescope/.test(c.input));
ok('the first request\'s call was cancelled when the second began', firstCall?.signal?.aborted === true);
ok('the second request\'s call was not', !!secondCall?.signal && secondCall.signal.aborted === false);
ok('…they are different signals', !!firstCall?.signal && firstCall.signal !== secondCall?.signal);

releaseSecond();
await second;
await tts.idle();
ok('nothing is tracked once both have ended', tracked().length === 0, tracked().join(','));

console.log('\n--- 3. Each request keeps its own plan outcome (ARCH-03) ---');
const ended = goalManager.listGoals({ kinds: ['request'] });
const g1 = ended.find((g: any) => /printing press/.test(g.description));
const g2 = ended.find((g: any) => /telescope/.test(g.description));
ok('the cancelled first request did not end as a success', !!g1 && g1.status !== 'completed', g1?.status);
ok('the second request, answered directly, ended as a success', g2?.status === 'completed', g2?.status);
const orchSource = fs.readFileSync(new URL('../core/orchestrator.ts', import.meta.url), 'utf8');
ok('plan outcome and timings are not fields shared by all requests', !/this\.lastPlanOutcome|_planStageTimings/.test(orchSource));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { await (goalManager as any).flush?.(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
