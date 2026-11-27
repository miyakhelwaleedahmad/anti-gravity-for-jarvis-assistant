/**
 * tests/clarificationGoalTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-9: for "language task set" JARVIS asked which language, and the goal
 * was marked FAILED with retry 1/3 (then saved as paused on shutdown, ready to
 * run again). A question back ends the turn: the goal is closed (cancelled,
 * with the reason), never failed, retried or resumed.
 *
 * The real orchestrator and goal manager; a scripted model; tts.py replaced
 * by tests/fakeTts.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-clarify-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(workspace, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const { isClarifyingQuestion } = await import('../core/clarification.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { goalManager } = await import('../core/goalManager.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { installFakeTts } = await import('./fakeTts.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

console.log('\n--- 1. What counts as a question back ---');
ok('"Which language would you like, sir?" is a question', isClarifyingQuestion('Sure. Which language would you like, sir?'));
ok('a question with a closing quote or emoji still is', isClarifyingQuestion('Which one do you mean: "A" or "B"?') && isClarifyingQuestion('Should I open it? 🙂'));
ok('a statement is not', !isClarifyingQuestion('I set the language to Urdu, sir.'));
ok('a long answer that ends with a question is not a clarification', !isClarifyingQuestion('x'.repeat(700) + ' ok?'));
ok('nothing is not', !isClarifyingQuestion(undefined) && !isClarifyingQuestion(''));

console.log('\n--- 2. Through the orchestrator ---');
registerAllTools();
await memoryManager.init();
await goalManager.init();
let reply = 'Which language should I set for the task, sir?';
const provider = {
  isConfigured: () => true,
  async chat(req: any) { return req.tools ? { content: reply } : { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' }; },
  async *streamChat() { yield 'Hello, sir.'; },
};
modelRouter.registerProvider((modelRouter as any).primary, provider as any);
modelRouter.registerProvider('openai', provider as any);
const tts = installFakeTts(orchestrator, nodeBridge);

const goalFor = (text: string) => goalManager.listGoals().filter((g: any) => g.description === text).pop();
await orchestrator.process('language task set', 'cli');
await new Promise((r) => setTimeout(r, 300));
let g: any = goalFor('language task set');
ok('the question was said', tts.spoken.some((s: string) => /Which language/.test(s)), JSON.stringify(tts.spoken));
ok('the goal is closed as cancelled, with the reason', g?.status === 'cancelled' && /asked the owner a question/.test(JSON.stringify(g)), JSON.stringify(g?.status));
ok('…not failed and not retried', g && g.status !== 'failed' && (g.retries ?? 0) === 0, `status ${g?.status}, retries ${g?.retries}`);

reply = 'I cannot set that, sir.';
await orchestrator.process('set the printer task', 'cli');
await new Promise((r) => setTimeout(r, 300));
g = goalFor('set the printer task');
ok('an action request answered without doing it is still a failure, retried as before (unchanged)', g?.status === 'failed' || g?.status === 'retry', `${g?.status} ${JSON.stringify(goalManager.listGoals().map((x: any) => [x.description, x.status]))}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: in use */ }
process.exit(failed > 0 ? 1 : 0);
