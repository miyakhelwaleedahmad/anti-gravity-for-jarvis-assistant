/**
 * tests/saveRelationRepliesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review INDEPENDENT_REVIEW_FINAL_MEMORY.md L-4 and L-6, through the real
 * orchestrator (task graph and reflection):
 *
 *   - after the owner's "no", JARVIS says the owner did not approve it
 *   - a policy refusal (a line break in the fact) says why, not only "I'm
 *     missing something"
 *   - a store error after "yes": the owner is asked once; a retry stores it
 * The reply is read from the reflection's result, not from a speech stand-in.
 * Each case runs in its own process. Stand-in memory store, planner model and
 * owner; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const MODE = process.argv[2] as 'no' | 'linebreak' | 'busy' | undefined;
if (!MODE) {
  const here = fileURLToPath(import.meta.url);
  const tsx = path.join(path.dirname(here), '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let passed = 0;
  let failed = 0;
  const ok = (label: string, condition: boolean, detail = ''): void => {
    if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
    else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
  };
  const run = (mode: string): { asked: number; stored: number; replies: string[] } | undefined => {
    const r = spawnSync(process.execPath, [tsx, here, mode], { encoding: 'utf8', timeout: 120_000 });
    const line = `${r.stdout}`.split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) console.error(`${r.stdout}${r.stderr}`.slice(-1500));
    return line ? JSON.parse(line.slice(7)) : undefined;
  };
  console.log('\n=== What JARVIS says after a refused or failed save_relation ===\n');
  const no = run('no');
  ok('after "no": "You did not approve it, so nothing was done"', !!no && no.replies.some((s) => /did not approve it/i.test(s)) && no.stored === 0, JSON.stringify(no?.replies));
  const lb = run('linebreak');
  ok('a policy refusal says why (line break), asks nothing', !!lb && lb.asked === 0 && lb.replies.some((s) => /line break/i.test(s)), JSON.stringify(lb?.replies));
  const busy = run('busy');
  ok('a store error after "yes": asked once, stored on the retry', !!busy && busy.asked === 1 && busy.stored === 1, JSON.stringify(busy));
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-save-replies-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const n of ['ANTHROPIC_API_KEY', 'JARVIS_FALLBACK_API_KEY', 'JARVIS_FALLBACK_BASE_URL', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'SERPER_API_KEY']) process.env[n] = '';

const { memoryManager } = await import('../memory/memoryManager.js');
const stored: string[] = [];
let storeFails = MODE === 'busy' ? 1 : 0;
(memoryManager as any).rememberFact = async (fact: string) => {
  if (storeFails > 0) { storeFails--; throw new Error('EBUSY: the fact store is busy'); }
  stored.push(fact);
};
const realFacts = (memoryManager as any).getLongTermFacts.bind(memoryManager);
// The after-action check reads what the stand-in stored, as it would read the real store.
(memoryManager as any).getLongTermFacts = (n?: number) => [...stored.map((fact) => ({ fact })), ...realFacts(n)];

const { approvalGate } = await import('../security/approvalGate.js');
let asked = 0;
const owner = async () => { asked++; return MODE === 'no' ? 'no' : 'yes'; };
(approvalGate as any)._promptWithTimeout = owner;
(approvalGate as any)._voiceOrTextPromptWithTimeout = owner;

const { modelRouter } = await import('../bridge/modelRouter.js');
modelRouter.registerNamedProvider('anthropic', { isConfigured: () => true, async chat(req: any) { return { content: 'ok', model: req.model }; } } as never);   // no real Claude adapter
const { registerAllTools } = await import('../core/tools/index.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { reflectionEngine } = await import('../core/reflectionEngine.js');
{ const { worldState } = await import('../core/worldState.js'); (worldState as any).refresh = async () => {}; }
registerAllTools();
await memoryManager.init();

// The reply JARVIS would speak, read from the reflection's result.
const replies: string[] = [];
const realReflect = reflectionEngine.reflect.bind(reflectionEngine);
(reflectionEngine as any).reflect = async (...a: unknown[]) => { const r = await (realReflect as any)(...a); if (r?.voiceMessage) replies.push(r.voiceMessage); return r; };

let script: Array<{ name: string; args: Record<string, unknown> }> = [{ name: 'save_relation', args: { entity1: 'User', relation: 'HAS_EXAM_ON', entity2: MODE === 'linebreak' ? 'Friday\nand more' : 'Friday' } }];
modelRouter.chat = async (req: any) => {
  if (req.tools && script.length) {
    const calls = script; script = [];
    return { content: '', tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } as any;
  }
  return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' } as any;
};
modelRouter.streamChat = async function* () { yield 'Done, sir.'; } as any;

const log = console.log;
const warn = console.warn;
const error = console.error;
console.log = () => {}; console.warn = () => {}; console.error = () => {};
try { await orchestrator.process('Remember that my exam is on Friday', 'cli'); } finally { console.log = log; console.warn = warn; console.error = error; }
console.log(`RESULT ${JSON.stringify({ asked, stored: stored.length, replies })}`);
process.exit(0);
