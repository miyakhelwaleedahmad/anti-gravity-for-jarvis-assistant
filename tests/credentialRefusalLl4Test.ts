/**
 * tests/credentialRefusalLl4Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review INDEPENDENT_REVIEW_FINAL_LOWS.md, LL-4: save_relation refuses a
 * credential ("I don't store passwords, keys or tokens"), but the refusal was
 * worded as a plain tool error. The task graph classed it 'transient' and ran
 * the node three times (about 3 s of retry delay), and JARVIS said "One of my
 * tools failed, sir." although nothing failed: the memory policy refused.
 *
 *   1  a credential in one part: run once, not retried; said as a refusal
 *   2  a credential split across the parts (final review L-3): the same
 *   3  nothing is asked and nothing is stored in either case
 *   4  control: an ordinary fact is still asked and stored once
 *
 * Through the real orchestrator, task graph, registry and save_relation; a
 * stand-in model makes the tool call, the owner's answer is stood in, and
 * speech goes to tests/fakeTts.ts. No network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeTts } from './fakeTts.js';

// A throwaway workspace: nothing written here may reach the real memory/ and data/ folders.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-credential-ll4-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { approvalGate } = await import('../security/approvalGate.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await memoryManager.init();

// The stand-in model: on a planning call it makes the scripted tool call once.
let script: Array<{ name: string; args: Record<string, unknown> }> = [];
modelRouter.chat = async (req: any) => {
  if (req.tools && script.length) {
    const calls = script;
    script = [];
    return { content: '', tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } as any;
  }
  return { content: '{"failureClass":"unknown","repairStrategy":"retry_same","context":""}' } as any;
};
modelRouter.streamChat = async function* () { yield 'Done, sir.'; } as any;

// The owner's answer to "May I keep …?": yes, and every question is counted.
let asked = 0;
(approvalGate as any).requestApproval = async () => { asked++; return true; };
// Facts that reach long-term memory.
const stored: string[] = [];
const rememberFact = memoryManager.rememberFact.bind(memoryManager);
(memoryManager as any).rememberFact = async (fact: string, ...rest: unknown[]) => { stored.push(fact); return (rememberFact as any)(fact, ...rest); };

const spoken: string[] = [];
installFakeTts(orchestrator, (await import('../bridge/nodeBridge.js')).nodeBridge, 5, spoken, true);

/**
 * Start a case from clean save_relation statistics: the planner skips a tool with 3 or more calls and 40 % or more
 * failures as "likely to fail" (core/plannerIntelligence.ts), so one case's refusals must not decide the next one.
 */
const resetStats = () => { (toolRegistryV2 as any)._metrics.delete('save_relation'); };

/** One owner request; how often save_relation ran, what was said, how long it took. */
async function request(input: string, args: Record<string, unknown>): Promise<{ runs: number; reply: string; ms: number }> {
  spoken.length = 0; asked = 0; stored.length = 0;
  script = [{ name: 'save_relation', args }];
  const seen = toolRegistryV2.getHistory(1000).length;
  const t0 = Date.now();
  await orchestrator.process(input, 'cli');
  const runs = toolRegistryV2.getHistory(1000).slice(seen).filter((h: any) => h.tool === 'save_relation').length;
  return { runs, reply: spoken.join(' | '), ms: Date.now() - t0 };
}

console.log('\n=== A credential refused by save_relation (LL-4) ===\n');

const cases: Array<[string, string, Record<string, unknown>]> = [
  ['1  a credential in one part', 'Remember my API key', { entity1: 'User', relation: 'HAS_API_KEY', entity2: 'sk-proj-4f9aT2xQ8mN3vB7cK1zR6wY5' }],
  ['2  a credential split across the parts', 'Remember my wifi password', { entity1: "User's wifi password", relation: 'IS', entity2: 'hunter22x' }],
];
for (const [label, input, args] of cases) {
  resetStats();
  const r = await request(input, args);
  ok(`${label}: save_relation runs once, not retried`, r.runs === 1, `${r.runs} runs`);
  ok(`${label}: no retry delay`, r.ms < 2_500, `${r.ms} ms`);
  ok(`${label}: said as a refusal, not "One of my tools failed"`, !/One of my tools failed/i.test(r.reply) && /couldn't do that/i.test(r.reply), r.reply.slice(0, 160));
  ok(`${label}: the reason is said, without "Error:"`, /don't store passwords, keys or tokens/.test(r.reply) && !/\bError\b/.test(r.reply), r.reply.slice(0, 160));
  ok(`3  ${label.slice(3)}: nothing asked, nothing stored`, asked === 0 && stored.length === 0, `asked ${asked}; stored ${stored.length}`);
}

console.log('\n--- 4. An ordinary fact, also right after a refused credential ---');
{
  resetStats();
  let r = await request('Remember that I like tea', { entity1: 'User', relation: 'LIKES', entity2: 'tea' });
  ok('4  control: an ordinary fact is asked once and stored once', r.runs === 1 && asked === 1 && stored.length === 1, `${r.runs} runs; asked ${asked}; stored ${stored.length}`);
  // A refusal retried three times counted three failures, and the planner then skipped save_relation as "likely to fail".
  resetStats();
  await request('Remember my wifi password', { entity1: "User's wifi password", relation: 'IS', entity2: 'hunter22x' });
  r = await request('Remember that I like coffee', { entity1: 'User', relation: 'LIKES', entity2: 'coffee' });
  ok('4  after one refused credential, the next ordinary fact is still asked and stored', r.runs === 1 && asked === 1 && stored.length === 1, `${r.runs} runs; asked ${asked}; stored ${stored.length}; ${r.reply.slice(0, 100)}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
