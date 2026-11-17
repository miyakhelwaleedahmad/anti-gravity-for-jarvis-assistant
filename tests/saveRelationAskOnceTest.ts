/**
 * tests/saveRelationAskOnceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review INDEPENDENT_REVIEW_SAVE_RELATION_CONFIRM.md M-3: through the real
 * orchestrator, the owner is asked once whether to keep a fact. A "no" or no
 * answer is final: the task graph does not ask the same question again.
 * "Yes" stores it once. Based on the reviewer's probe r4.
 * Stand-in memory store, planner model and owner; the real speech path (no
 * client is connected, so nothing is spoken); no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Each answer runs in its own process, so one case's approval state cannot affect the next.
const MODE = process.argv[2] as 'no' | 'timeout' | 'yes' | undefined;
if (!MODE) {
  const here = fileURLToPath(import.meta.url);
  const tsx = path.join(path.dirname(here), '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let passed = 0;
  let failed = 0;
  const ok = (label: string, condition: boolean, detail = ''): void => {
    if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
    else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
  };
  const run = (mode: string): { asked: string[]; stored: string[] } | undefined => {
    const r = spawnSync(process.execPath, [tsx, here, mode], { encoding: 'utf8', timeout: 120_000 });
    const line = `${r.stdout}`.split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) console.error(`${r.stdout}${r.stderr}`.slice(-1500));
    return line ? JSON.parse(line.slice(7)) : undefined;
  };
  console.log('\n=== The owner is asked once (M-3) ===\n');
  const no = run('no');
  ok('"no": asked once, nothing stored', no?.asked.length === 1 && no.stored.length === 0, `asked ${no?.asked.length}; stored ${no?.stored.length}`);
  const none = run('timeout');
  ok('no answer: asked once, nothing stored', none?.asked.length === 1 && none.stored.length === 0, `asked ${none?.asked.length}; stored ${none?.stored.length}`);
  const yes = run('yes');
  ok('"yes": asked once, stored once (control)', yes?.asked.length === 1 && yes.stored.length === 1, `asked ${yes?.asked.length}; stored ${yes?.stored.length}`);
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-save-ask-once-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const n of ['ANTHROPIC_API_KEY', 'JARVIS_FALLBACK_API_KEY', 'JARVIS_FALLBACK_BASE_URL', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'SERPER_API_KEY']) process.env[n] = '';

const { memoryManager } = await import('../memory/memoryManager.js');
const stored: string[] = [];
(memoryManager as any).rememberFact = async (fact: string) => { stored.push(fact); };
const realFacts = (memoryManager as any).getLongTermFacts.bind(memoryManager);
// The after-action check reads what the stand-in stored, as it would read the real store.
(memoryManager as any).getLongTermFacts = (n?: number) => [...stored.map((fact) => ({ fact })), ...realFacts(n)];

// The owner answers at the prompt level, so the real approval gate runs.
const { approvalGate } = await import('../security/approvalGate.js');
const asked: string[] = [];
let mode: 'no' | 'timeout' | 'yes' = 'no';
const owner = async (request: any) => {
  asked.push(String(request?.target ?? ''));
  if (mode === 'timeout') throw new Error('APPROVAL_TIMEOUT');
  return mode;
};
(approvalGate as any)._promptWithTimeout = async (_p: string, _ms: number, request: any) => owner(request);
(approvalGate as any)._voiceOrTextPromptWithTimeout = async (request: any) => owner(request);

const { modelRouter } = await import('../bridge/modelRouter.js');
modelRouter.registerNamedProvider('anthropic', { isConfigured: () => true, async chat(req: any) { return { content: 'ok', model: req.model }; } } as never);   // no real Claude adapter
const { registerAllTools } = await import('../core/tools/index.js');
const { orchestrator } = await import('../core/orchestrator.js');
{ const { worldState } = await import('../core/worldState.js'); (worldState as any).refresh = async () => {}; }
registerAllTools();
await memoryManager.init();

let script: Array<{ name: string; args: Record<string, unknown> }> = [];
modelRouter.chat = async (req: any) => {
  if (req.tools && script.length) {
    const calls = script; script = [];
    return { content: '', tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } as any;
  }
  return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' } as any;
};
modelRouter.streamChat = async function* () { yield 'Done, sir.'; } as any;

async function ask(answer: 'no' | 'timeout' | 'yes') {
  mode = answer;
  asked.length = 0;
  stored.length = 0;
  script = [{ name: 'save_relation', args: { entity1: 'User', relation: 'HAS_EXAM_ON', entity2: 'Friday' } }];
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { await orchestrator.process('Remember that my exam is on Friday', 'cli'); } finally { console.log = log; console.warn = warn; console.error = error; }
  return { asked: [...asked], stored: [...stored] };
}

const result = await ask(MODE);
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
