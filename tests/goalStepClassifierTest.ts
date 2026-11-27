/**
 * tests/goalStepClassifierTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review INDEPENDENT_REVIEW_FINAL_LOWS.md, LL-2 (owner approval 2026-11-24,
 * decisions D-1 to D-4): which Memory-agent goal steps "ask to keep a fact".
 * Inside a goal nothing is stored, so such a step ends MEMORY_NOT_STORED and
 * waits for the owner's review; any other step completes. English phrasing
 * only, read from the start of the step.
 *
 *   A  the phrasings of the existing tests keep their outcome (guard)
 *   B  "Remember when/who/where/how …: value" asks to keep (regression; D-3)
 *   C  other keep steps: a leading "First,/Then/Next,", "make sure to
 *      remember", "keep track of", "log/write down/learn that", "persist",
 *      "set/change the user's preference", "do not forget that"
 *   D  steps that keep nothing are not held: "remember to …", "don't forget
 *      to …", "keep in mind", "add up", "record the answer", "store hours",
 *      "save time", "what we keep in memory", "update the user on …"
 *   E  documented limits, unchanged: "Note that …" is held (D-1); a request
 *      in the middle of the step (D-2) and other languages (D-4) are not
 *   F  controls: another specialist is never held for its wording; a refused
 *      save_relation still holds a step whatever its wording; an archived
 *      run read back after a restart follows the same check
 *
 * Through the real AgentGoalExecutor and AgentManager; stand-in provider and
 * tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goal-step-classifier-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
delete process.env['JARVIS_AGENT_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const { modelRouter } = await import('../bridge/modelRouter.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');
const { AgentGoalExecutor } = await import('../core/goalExecutor.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
// The model answers in words, or, in "call-save" mode, a Memory-agent step first calls save_relation.
let mode: 'answer' | 'call-save' = 'answer';
const tools = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) {
    // Inside a goal save_relation refuses (memoryTool.relationRefusedInGoal); the stand-in says so.
    if (name === 'save_relation') return { success: false, output: 'Error: save_relation refused - inside the goal "g" facts come from other agents\' results, which are not verified, so nothing was stored', tool: name, durationMs: 1 };
    return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 };
  },
};
const provider = { isConfigured: () => true, async chat(req: any) {
  const hadTool = (req.messages ?? []).some((m: any) => m.role === 'tool');
  if (mode === 'call-save' && req.agentRole === 'memory_agent' && !hadTool && req.tools) {
    return { content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'save_relation', arguments: JSON.stringify({ entity1: 'User', relation: 'HAS_EXAM_ON', entity2: 'Friday' }) } }], model: req.model };
  }
  return { content: 'Here is what I found.', model: req.model };
} };
modelRouter.registerNamedProvider('anthropic', { isConfigured: () => true, async chat(req: any) { return { content: 'ok', model: req.model }; } } as never);   // no real Claude adapter
modelRouter.registerProvider((modelRouter as any).primary, provider as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
const m = new AgentManager(agentEvents, loadAgentLimits({}));
m.useToolExecutor(tools as never);
registerAgentRoles(m);
const exec = new AgentGoalExecutor({ manager: m, verify: false });

async function run(description: string, specialist = 'memory_agent'): Promise<any> {
  const task = { id: `t-${Math.random().toString(36).slice(2, 7)}`, title: 'step', description, specialist, attempts: 1, maxAttempts: 3, sideEffects: 'none', failures: [] };
  const log = console.log; const warn = console.warn; const error = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    return await exec.run({ goal: { id: 'g', description: 'goal', objective: 'goal', source: 'cli', priority: 5 }, task, signal: new AbortController().signal, onStarted: () => {} } as never);
  } finally { console.log = log; console.warn = warn; console.error = error; }
}
const held = (r: any) => r?.ok === false && r?.failure?.code === 'MEMORY_NOT_STORED';
const completes = (r: any) => r?.ok === true;
const outcome = (r: any) => `${r?.ok} ${r?.failure?.code ?? ''}`.trim();
async function expectHeld(group: string, d: string): Promise<void> { const r = await run(d); ok(`${group} held for review: "${d}"`, held(r), outcome(r)); }
async function expectCompletes(group: string, d: string): Promise<void> { const r = await run(d); ok(`${group} completes: "${d}"`, completes(r), outcome(r)); }

console.log('\n=== Goal steps that ask to keep a fact (LL-2) ===\n');

console.log('--- A. Phrasings of the existing tests (unchanged outcome) ---');
for (const d of ["Store the user's exam date (Friday)", 'Record that the exam is on Friday', 'Memorize the exam date: Friday', 'Make a note that the exam is on Friday',
  'Update the user profile: exam on Friday', 'Remember that my exam is on Friday', 'Keep the key facts from these results in memory']) await expectHeld('A', d);
for (const d of ['Remember what the user said about the exam and summarise it', 'Note which remembered facts about the exam are out of date',
  'Save time: read the remembered facts first, then answer', 'What do you remember about my exam?']) await expectCompletes('A', d);

console.log('\n--- B. A wh-word with a value after a colon asks to keep it (D-3) ---');
for (const d of ['Remember when the exam is: Friday', "Remember who the user's manager is: Sara", 'Note where the user lives: Lahore',
  'Remember how the user takes coffee: black']) await expectHeld('B', d);

console.log('\n--- C. Other ways of asking to keep a fact ---');
for (const d of ['First, remember that the exam is on Friday', 'Then store the exam date: Friday', 'Next, save that the exam is on Friday',
  'Make sure to remember that the exam is Friday', 'Keep track of the exam date: Friday', 'Log that the exam is on Friday', 'Write down that the exam is on Friday',
  "Set the user's preference: tea", "Change the user's preference to tea", 'Learn that the user prefers tea', 'Persist the exam date: Friday',
  'Do not forget that the exam is Friday']) await expectHeld('C', d);

console.log('\n--- D. Steps that keep nothing are not held ---');
for (const d of ['Remember to check the remembered facts first', "Don't forget to search memory before answering", "Keep in mind the user's time zone",
  'Add up the expenses in the report', 'Add the exam date to the summary', 'Record the answer in the final report', 'Store hours: 9 to 5',
  'Save some time by reading the summary', 'List what you store in memory about the exam', 'Check what we keep in memory about the user',
  'Summarise what the user asked to save in memory', 'Update the user on what is in memory', "Update the summary using the user's preferences"]) await expectCompletes('D', d);

console.log('\n--- E. Documented limits (D-1, D-2, D-4) ---');
await expectHeld('E (D-1, "note that" stays on the safe side)', 'Note that the remembered facts may be stale');
for (const d of ['The Memory agent should remember the exam date', 'Find the exam date and just save it']) await expectCompletes('E (D-2, a request in the middle is not read)', d);
await expectCompletes('E (D-4, other languages are not read)', 'Recuerda que el examen es el viernes');

console.log('\n--- F. Controls ---');
{
  const other = await run('Remember that my exam is on Friday', 'browser_agent');
  ok('F: another specialist is not held for its wording', completes(other), outcome(other));

  mode = 'call-save';
  const refused = await run('Look up the exam date in the notes');
  mode = 'answer';
  ok('F: a Memory-agent step whose save_relation was refused is held, whatever its wording', held(refused) && /not stored/i.test(String(refused?.failure?.message ?? '')), `${outcome(refused)}; ${String(refused?.failure?.message ?? '').slice(0, 90)}`);

  // An archived run read back after a restart (inspectPrevious): the same check on its request.
  const dir = m.archiveDir();
  fs.mkdirSync(dir, { recursive: true });
  const archived = (id: string, request: string, role: string) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    rootTaskId: id, request, status: 'COMPLETED', agents: [{ role }],
    result: { rootTaskId: id, status: 'COMPLETED', answer: 'Saved.', confidence: 0.7, findings: [], sources: [], conflicts: [], limitations: [], recommendedNextActions: [] },
  }));
  archived('root-keep-value', "Remember who the user's manager is: Sara", 'memory_agent');
  archived('root-recall', 'Remember what the user said about the exam', 'memory_agent');
  archived('root-other-role', 'Remember that my exam is on Friday', 'research_agent');
  const keep = exec.inspectPrevious('root-keep-value');
  const recall = exec.inspectPrevious('root-recall');
  const otherRole = exec.inspectPrevious('root-other-role');
  ok('F: an archived Memory-agent step that asked to keep a fact is not taken back as done', !!keep && !keep.result, JSON.stringify(keep ? { status: keep.status, result: !!keep.result } : null));
  ok('F: …an archived recall step is taken back as done', !!recall?.result, JSON.stringify(recall ? { status: recall.status, result: !!recall.result } : null));
  ok('F: …and so is another specialist\'s archived step, whatever its wording', !!otherRole?.result, JSON.stringify(otherRole ? { status: otherRole.status, result: !!otherRole.result } : null));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
