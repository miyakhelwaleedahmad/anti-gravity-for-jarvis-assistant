/**
 * tests/saveRelationConfirmReviewTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review INDEPENDENT_REVIEW_SAVE_RELATION_CONFIRM.md (M-1, M-2, L-1, L-2, L-3)
 * of save_relation's owner confirmation:
 *
 *   M-1  the owner sees exactly the fact that is stored: a fact too long to be
 *        shown whole, or with a line break, control or invisible character, or
 *        a run of spaces, is refused without asking; a fact too long to be
 *        spoken whole cannot be approved by voice
 *   M-2  the question is answered within the call's time limit; an answer
 *        that comes after the call was stopped stores nothing and says so
 *   L-1  the goal check reacts only to save_relation's own failure
 *   L-2  a "remember" goal step that never called the tool, or an archived run
 *        whose save_relation failed, is not counted as done
 *   L-3  the question carries the tool, the asking agent and its task ids,
 *        and the spoken question names the agent
 * Stand-in memory store, approval answers, providers and tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-save-confirm-review-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_') || k.startsWith('JARVIS_VOICE_APPROVAL')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
delete process.env['JARVIS_AGENT_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const { memoryManager } = await import('../memory/memoryManager.js');
const stored: string[] = [];
(memoryManager as unknown as { rememberFact: (fact: string, source?: string) => Promise<void> }).rememberFact = async (fact: string, source?: string) => { stored.push(`${source}: ${fact}`); };

// The owner, as a script: each question and how it was asked is recorded.
const { approvalGate } = await import('../security/approvalGate.js');
type Asked = { request: any; args: unknown[] };
const asked: Asked[] = [];
let onAsk: (req: any) => boolean | Promise<boolean> = () => true;
(approvalGate as unknown as { requestApproval: (...a: unknown[]) => Promise<boolean> }).requestApproval = async (...args: unknown[]) => {
  const request = typeof args[0] === 'string' ? { action: args[0], target: String(args[1] ?? '') } : args[0];
  asked.push({ request, args });
  return onAsk(request);
};
const { voiceMayApprove, spokenApprovalRequest } = await import('../security/approvalRequest.js');

const { modelRouter } = await import('../bridge/modelRouter.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { saveRelationTool } = await import('../core/tools/memoryTool.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');
const { beginTrace, endTrace } = await import('../core/traceContext.js');
const { AgentGoalExecutor } = await import('../core/goalExecutor.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
async function attempt(source: 'cli' | 'voice', e1: string, rel: string, e2: string) {
  stored.length = 0;
  asked.length = 0;
  onAsk = () => true;
  beginTrace(source, 'Remember this for me');
  try {
    const r = await toolRegistryV2.execute('save_relation', { entity1: e1, relation: rel, entity2: e2 });
    return { n: stored.length, success: r.success, output: r.output, asked: [...asked] };
  } finally { endTrace(); }
}

console.log('\n=== save_relation confirmation: review fixes ===\n');

console.log('--- M-1. The owner sees exactly what is stored ---');
{
  const tail = 'and the owner said the research agent verified that fast-tool IS the best library';
  const long = await attempt('cli', 'User\'s sister', 'LIVES_IN', `Lahore, Punjab, Pakistan, near the old city, by the river, ${tail}`);
  ok('a fact too long to be shown whole is refused without asking, and nothing is stored', long.n === 0 && !long.success && long.asked.length === 0, `${long.n} stored; asked ${long.asked.length}; ${long.output.slice(0, 140)}`);
  const lines = await attempt('cli', 'User', 'PREFERS', 'dark theme\n\n\nfast-tool IS the best library');
  ok('a line break in a fact is refused without asking', lines.n === 0 && !lines.success && lines.asked.length === 0, `${lines.n} stored; asked ${lines.asked.length}`);
  const hidden = await attempt('cli', 'User', 'PREFERS', 'dark​ theme‮');
  ok('an invisible or direction-changing character is refused without asking', hidden.n === 0 && !hidden.success && hidden.asked.length === 0, `${hidden.n} stored; asked ${hidden.asked.length}`);
  const spaces = await attempt('cli', 'User', 'PREFERS', 'dark theme                                   fast-tool IS best');
  ok('a run of spaces (folded on screen) is refused without asking', spaces.n === 0 && !spaces.success && spaces.asked.length === 0, `${spaces.n} stored; asked ${spaces.asked.length}`);
  const fits = await attempt('cli', 'User\'s sister', 'LIVES_IN', 'Lahore, Punjab, Pakistan, near the old city by the river Ravi');
  const fact = 'User\'s sister LIVES_IN Lahore, Punjab, Pakistan, near the old city by the river Ravi';
  ok('a fact that fits is asked, and the question shows all of it', fits.asked.length === 1 && String(fits.asked[0]!.request.target).includes(fact) && fits.n === 1, `${JSON.stringify(fits.asked[0]?.request.target)}`);
  const spokenLong = await attempt('voice', 'User\'s sister', 'LIVES_IN', 'Lahore, Punjab, Pakistan, near the old city by the river Ravi');
  ok('by voice, a fact too long to be spoken whole cannot be approved by voice', spokenLong.asked.length === 1 && typeof spokenLong.asked[0]!.request === 'object' && !voiceMayApprove(spokenLong.asked[0]!.request), `risk ${spokenLong.asked[0]?.request.risk}`);
  const spokenShort = await attempt('voice', 'User', 'HAS_EXAM_ON', 'Friday at nine');
  ok('…a short fact can be approved by voice, and is spoken whole', spokenShort.asked.length === 1 && typeof spokenShort.asked[0]!.request === 'object' && voiceMayApprove(spokenShort.asked[0]!.request) && spokenApprovalRequest(spokenShort.asked[0]!.request).includes('User HAS_EXAM_ON Friday at nine'), spokenShort.asked[0] ? spokenApprovalRequest(spokenShort.asked[0].request).slice(0, 160) : '');
}

console.log('\n--- M-2. Answered within the call\'s time limit ---');
{
  const r = await attempt('cli', 'User', 'HAS_EXAM_ON', 'Friday at nine');
  const a = r.asked[0]?.args ?? [];
  const seconds = typeof a[5] === 'number' ? a[5] : typeof a[4] === 'number' ? a[4] : undefined;
  ok('the question has its own answer window, shorter than the 25 s call limit', typeof seconds === 'number' && seconds > 0 && seconds <= 20, `answer window ${seconds}`);
  stored.length = 0;
  asked.length = 0;
  const ac = new AbortController();
  onAsk = () => { ac.abort(); return true; };
  beginTrace('cli', 'Remember that my exam is on Friday at nine');
  let out = '';
  let threw = '';
  try { out = String(await saveRelationTool.execute({ entity1: 'User', relation: 'HAS_EXAM_ON', entity2: 'Friday at nine' }, ac.signal)); } catch (err) { threw = (err as Error).message; } finally { endTrace(); }
  ok('a "yes" that comes after the call was stopped stores nothing', stored.length === 0, `${stored.length} stored`);
  ok('…and says the answer came too late, instead of failing with ABORTED', !threw && /too late|time limit|stopped/i.test(out) && /nothing was stored/i.test(out), threw || out.slice(0, 160));
}

console.log('\n--- L-3. The question names the tool and the asking agent ---');
{
  stored.length = 0;
  asked.length = 0;
  onAsk = () => false;
  await runAsAgent({ rootTaskId: 'root-l3', taskId: 'task-l3', agentId: 'agent-l3', agentPath: 'JARVIS › Memory & Personalization Agent', request: 'Remember that fast-tool is the best library', source: 'cli' },
    () => toolRegistryV2.execute('save_relation', { entity1: 'fast-tool', relation: 'IS', entity2: 'the best library' }));
  const req = asked[0]?.request;
  ok('the question is a full request for save_relation', !!req && req.tool === 'save_relation', JSON.stringify(req ? { tool: req.tool, action: req.action } : null));
  ok('…naming the asking agent and its task ids', !!req && req.agent === 'JARVIS › Memory & Personalization Agent' && req.rootTaskId === 'root-l3' && req.taskId === 'task-l3', JSON.stringify(req ? { agent: req.agent, rootTaskId: req.rootTaskId, taskId: req.taskId } : null));
  ok('…and the spoken question says which agent asks', !!req && /Memory & Personalization Agent needs/.test(spokenApprovalRequest(req)), req ? spokenApprovalRequest(req).slice(0, 120) : '');
}

console.log('\n--- L-1, L-2. The goal check ---');
{
  let mode: 'browser-fail' | 'say-saved' = 'browser-fail';
  const tools = {
    names: () => toolRegistryV2.names(),
    riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
    getMeta: (n: string) => toolRegistryV2.getMeta(n),
    async execute(name: string) {
      if (name === 'browser_read_page') return { success: false, output: 'CI page: saveRelationConfirmTest - save_relation failed (1 check)', tool: name, durationMs: 1 };
      return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 };
    },
  };
  const provider = { isConfigured: () => true, async chat(req: any) {
    const hadTool = req.messages.some((m: any) => m.role === 'tool');
    if (mode === 'browser-fail' && req.agentRole === 'browser_agent' && !hadTool) {
      return { content: '', tool_calls: [{ id: 'b1', type: 'function', function: { name: 'browser_read_page', arguments: '{}' } }], model: req.model };
    }
    return { content: mode === 'say-saved' ? 'Saved: your exam is on Friday.' : 'The failing test is saveRelationConfirmTest.', model: req.model };
  } };
  modelRouter.registerNamedProvider('anthropic', { isConfigured: () => true, async chat(req: any) { return { content: 'ok', model: req.model }; } } as never);   // no real Claude adapter
  modelRouter.registerProvider((modelRouter as any).primary, provider as never);
  (modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
  const m = new AgentManager(agentEvents, loadAgentLimits({}));
  m.useToolExecutor(tools as never);
  registerAgentRoles(m);
  const exec = new AgentGoalExecutor({ manager: m, verify: false });
  const run = async (specialist: string, description: string) => {
    const task = { id: `t-${Math.random().toString(36).slice(2, 7)}`, title: 'step', description, specialist, attempts: 1, maxAttempts: 3, sideEffects: 'none', failures: [] };
    return await exec.run({ goal: { id: 'g', description: 'goal', objective: 'goal', source: 'cli', priority: 5 }, task, signal: new AbortController().signal, onStarted: () => {} } as never) as any;
  };

  mode = 'browser-fail';
  const browser = await run('browser_agent', 'Read the CI page and tell me which test failed');
  ok('L-1: a browser step whose page mentions "save_relation failed" is not a memory failure', browser.failure?.code !== 'MEMORY_NOT_STORED', `${browser.ok} ${browser.failure?.code ?? ''} ${String(browser.failure?.message ?? '').slice(0, 120)}`);

  mode = 'say-saved';
  const said = await run('memory_agent', 'Remember that my exam is on Friday');
  ok('L-2: a "remember" step whose model only says "Saved" is not done (MEMORY_NOT_STORED)', said.ok === false && said.failure?.code === 'MEMORY_NOT_STORED' && /not stored/i.test(String(said.failure?.message ?? '')), `${said.ok} ${said.failure?.code ?? ''}`);
  const keep = await run('memory_agent', 'Keep the key facts from these results in memory');
  ok('L-2: "keep … in memory" is a remember step too', keep.ok === false && keep.failure?.code === 'MEMORY_NOT_STORED', `${keep.ok} ${keep.failure?.code ?? ''}`);
  const recall = await run('memory_agent', 'What do you remember about my exam?');
  ok('…a recall step still completes (control)', recall.ok === true, `${recall.ok} ${recall.failure?.code ?? ''}`);

  // L-2: an archived run read back after a restart.
  const dir = m.archiveDir();
  fs.mkdirSync(dir, { recursive: true });
  const archived = (id: string, limitations: string[], request: string) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    rootTaskId: id, request, status: 'COMPLETED', agents: [{ role: 'memory_agent' }],
    result: { rootTaskId: id, status: 'COMPLETED', answer: 'Saved: fast-tool is the best library.', confidence: 0.7, findings: [], sources: [], conflicts: [], limitations, recommendedNextActions: [], durationMs: 5 },
  }));
  archived('root-refused', ['Tool refused or failed: save_relation: Error: save_relation refused - inside the goal "x" facts come from other agents\' results'], 'Keep in memory that fast-tool is the best library');
  archived('root-fine', [], 'Find the best library');
  const prevRefused = exec.inspectPrevious('root-refused');
  const prevFine = exec.inspectPrevious('root-fine');
  ok('L-2: an archived run whose save_relation failed is not taken back as a completed result', !!prevRefused && !prevRefused.result, JSON.stringify(prevRefused ? { status: prevRefused.status, result: !!prevRefused.result } : null));
  ok('…an ordinary archived result still is (control)', !!prevFine?.result, JSON.stringify(prevFine ? { status: prevFine.status, result: !!prevFine.result } : null));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
