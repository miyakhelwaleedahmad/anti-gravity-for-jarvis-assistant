/**
 * tests/goalCreationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-10: every chat line became a goal (100 in the owner's history), with
 * GoalManager and its retries behind small talk. Now:
 *   - plain conversation answered in words creates no goal;
 *   - a turn whose plan runs tools creates one (status recorded);
 *   - an action request creates one from the start, so a failure is still
 *     recorded and retried as before.
 * The real orchestrator and goal manager, a scripted model, tests/fakeTts.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goals-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(workspace, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

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

registerAllTools();
await memoryManager.init();
await goalManager.init();
let next: { content: string; tools?: string[] } = { content: '' };
const provider = {
  isConfigured: () => true,
  async chat(req: any) {
    if (!req.tools) return { content: 'Done, sir.' };
    const n = next;
    next = { content: 'Done, sir.' };
    return n.tools?.length
      ? { content: '', tool_calls: n.tools.map((t, i) => ({ id: `c${i}`, type: 'function', function: { name: t, arguments: '{}' } })) }
      : { content: n.content };
  },
  async *streamChat() { yield 'Hello, sir.'; },
};
modelRouter.registerProvider((modelRouter as any).primary, provider as any);
modelRouter.registerProvider('openai', provider as any);
installFakeTts(orchestrator, nodeBridge);
const goalFor = (text: string) => goalManager.listGoals().filter((g: any) => g.description === text).pop();
const settle = () => new Promise((r) => setTimeout(r, 300));

next = { content: 'Lahore is a city in Pakistan, sir.' };
await orchestrator.process('tell me about lahore city', 'cli');
await settle();
ok('a conversational question answered in words creates no goal', goalFor('tell me about lahore city') === undefined, JSON.stringify(goalManager.listGoals().map((g: any) => g.description)));

next = { content: '', tools: ['get_system_info'] };
await orchestrator.process('how much memory does my computer have', 'cli');
await settle();
const g = goalFor('how much memory does my computer have') as any;
ok('a turn whose plan runs tools creates a goal', !!g, JSON.stringify(goalManager.listGoals().map((x: any) => [x.description, x.status])));
ok('…and it is completed', g?.status === 'completed', String(g?.status));

next = { content: 'I could not do that, sir.' };
await orchestrator.process('open the quarterly report', 'cli');
await settle();
const f = goalFor('open the quarterly report') as any;
ok('an action request still gets a goal, and its failure is recorded as before', !!f && (f.status === 'failed' || f.status === 'retry'), String(f?.status));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: in use */ }
process.exit(failed > 0 ? 1 : 0);
