/**
 * tests/qaModelFailureTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner's decision 2026-11-15 (REVIEW_HANDOVER.md §5, MM-1A-P1): JARVIS never
 * reports a QA check, or a configured coding agent's work, as done when its
 * model failed. Through the real specialists and the real tool loop
 * (core/agents/behaviors/toolLoop.ts), the real model router and stand-in
 * providers; tools go to a stand-in executor that records what was called.
 *
 *   1. QA's configured model fails → the task is FAILED with the full reason;
 *      no keyword-rule tool runs; no other model is asked
 *   2. QA with nothing configured, model down → FAILED, no keyword rules
 *   3. QA's model fails after a first tool call → FAILED, not COMPLETED
 *   4. QA splits work across workers; a worker answered by keyword rules →
 *      the QA task is FAILED and names it
 *   5. a configured coding agent whose model fails → FAILED, no keyword rules
 *   6. a coding agent with nothing configured, model down → still COMPLETED by
 *      keyword rules (as agentSpecialistsTest expects), marked as not the model's answer
 *   7. a queue-wait time-out ends the task FAILED for any role
 *   8. a QA run whose model answers → COMPLETED, marked as the model's answer
 *   9. a QA call cancelled while it runs → CANCELLED (unchanged)
 * No network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qa-failure-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');
const { conversationBus } = await import('../core/conversationBus.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

registerAllTools();

// ── Tools: a stand-in executor that records every call (the registry's own definitions are used) ──
const toolCalls: string[] = [];
const executor = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) { toolCalls.push(name); return { success: true, output: `${name}: stand-in output`, tool: name, durationMs: 1 }; },
};

// ── Models: the real router; providers are stand-ins ─────────────────────────
const LONG_REASON = 'the QA provider rejected the request because the account quota for this model was exhausted and the request id was qa-req-0123456789abcdef-0123456789abcdef (HTTP 500)';
interface ModelCall { who: string; role?: string; model?: string }
const modelCalls: ModelCall[] = [];
type Mode = 'ok' | 'down' | 'toolThenDown' | 'hang';
const mode: Record<string, Mode> = {};     // per agent role, for the default provider
const defaultProvider = {
  isConfigured: () => true,
  async chat(req: any) {
    modelCalls.push({ who: 'default', role: req.agentRole, model: req.model });
    const m = mode[req.agentRole ?? ''] ?? 'ok';
    if (m === 'down') throw new Error('default model is down (503)');
    if (m === 'hang') return new Promise((_res, rej) => req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    if (m === 'toolThenDown') {
      if (!req.messages.some((x: any) => x.role === 'tool')) return { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'dev_status', arguments: '{}' } }] };
      throw new Error('default model is down after the first tool call (503)');
    }
    return { content: `${req.agentRole} model answer` };
  },
};
modelRouter.registerProvider((modelRouter as any).primary, defaultProvider as never);
modelRouter.registerProvider('openai', defaultProvider as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
const failing = (who: string, reason: string) => ({
  isConfigured: () => true,
  async chat(req: any) { modelCalls.push({ who, role: req.agentRole, model: req.model }); throw new Error(reason); },
});
modelRouter.registerNamedProvider('qastub', failing('qastub', LONG_REASON) as never);
modelRouter.registerNamedProvider('codingstub', failing('codingstub', 'the coding provider is down (500)') as never);
modelRouter.registerNamedProvider('slowqueue', { isConfigured: () => true, async chat() { modelCalls.push({ who: 'slowqueue' }); return { content: 'should not be sent' }; } } as never);

const m = new AgentManager(agentEvents, loadAgentLimits({}));
m.useToolExecutor(executor as never);
registerAgentRoles(m);

async function run(role: string, description: string) {
  toolCalls.length = 0;
  modelCalls.length = 0;
  const h = await m.startRootTask({ request: description, specialistRole: role, task: { description } });
  const r = await h.result;
  return { r, h };
}
const errorOf = (r: any) => String(r.specialist?.error?.message ?? '');

console.log('\n=== A failed model never becomes a completed QA check (owner, 2026-11-15) ===\n');

console.log('--- 1. QA\'s configured model fails ---');
{
  process.env['JARVIS_MODEL_AGENT_QA_AGENT'] = 'qastub:qa-model';
  const { r } = await run('qa_agent', 'Run the type check of the project and report what fails');
  ok('the QA task is FAILED, not COMPLETED', r.status === 'FAILED', `${r.status}: ${r.answer.slice(0, 80)}`);
  ok('…with the provider\'s full reason, not cut short', errorOf(r).includes(LONG_REASON), errorOf(r).slice(0, 300));
  ok('…and it says the strict route failed', /StrictRouteError|strict/.test(errorOf(r)), errorOf(r).slice(0, 120));
  ok('no keyword-rule tool ran in its place', toolCalls.length === 0, toolCalls.join(','));
  ok('the default (coding) model was not asked instead', !modelCalls.some((c) => c.who === 'default'), modelCalls.map((c) => c.who).join(','));
  delete process.env['JARVIS_MODEL_AGENT_QA_AGENT'];
}

console.log('\n--- 2. QA with nothing configured, its model down ---');
{
  mode['qa_agent'] = 'down';
  const { r } = await run('qa_agent', 'Run the type check of the project and report what fails');
  ok('the QA task is FAILED', r.status === 'FAILED', `${r.status}: ${r.answer.slice(0, 80)}`);
  ok('…with the original reason', /default model is down \(503\)/.test(errorOf(r)), errorOf(r).slice(0, 200));
  ok('no keyword-rule tool ran in its place', toolCalls.length === 0, toolCalls.join(','));
  delete mode['qa_agent'];
}

console.log('\n--- 3. QA\'s model fails after a first tool call ---');
{
  mode['qa_agent'] = 'toolThenDown';
  const { r } = await run('qa_agent', 'Check the project status');
  ok('the QA task is FAILED, not "Stopped before a final answer"', r.status === 'FAILED', `${r.status}: ${r.answer.slice(0, 80)}`);
  ok('…with the original reason', /down after the first tool call/.test(errorOf(r)), errorOf(r).slice(0, 200));
  delete mode['qa_agent'];
}

console.log('\n--- 4. QA split across workers; one worker answered by keyword rules ---');
{
  mode['test_runner_worker'] = 'down';
  const { r, h } = await run('qa_agent', 'Run the type check; then run the lint script');
  const kids = m.spawnedBy(h.rootTaskId, 'qa_agent');
  ok('QA handed parts to Test Runner Workers', kids.length >= 1 && kids.every((k: any) => k.role === 'test_runner_worker'), kids.map((k: any) => `${k.role}/${k.status}`).join(', '));
  ok('a worker answered by keyword rules makes the QA task FAILED', r.status === 'FAILED', `${r.status}: ${r.answer.slice(0, 80)}`);
  ok('…and the reason names the worker and the keyword rules', /keyword rules/.test(errorOf(r)), errorOf(r).slice(0, 200));
  delete mode['test_runner_worker'];
}

console.log('\n--- 5. A configured coding agent whose model fails ---');
{
  process.env['JARVIS_MODEL_AGENT_CODING_AGENT'] = 'codingstub:code-model';
  const { r } = await run('coding_agent', 'What changed in git recently?');
  ok('the coding task is FAILED', r.status === 'FAILED', `${r.status}: ${r.answer.slice(0, 80)}`);
  ok('…with the provider\'s reason', /the coding provider is down \(500\)/.test(errorOf(r)), errorOf(r).slice(0, 200));
  ok('no keyword-rule tool ran in its place', toolCalls.length === 0, toolCalls.join(','));
  ok('no other model was asked', !modelCalls.some((c) => c.who === 'default'), modelCalls.map((c) => c.who).join(','));
  delete process.env['JARVIS_MODEL_AGENT_CODING_AGENT'];
}

console.log('\n--- 6. A coding agent with nothing configured, its model down ---');
{
  mode['coding_agent'] = 'down';
  const { r } = await run('coding_agent', 'What changed in git recently?');
  ok('it still completes with keyword rules (unchanged)', r.status === 'COMPLETED' && toolCalls.includes('git_overview'), `${r.status}; tools ${toolCalls.join(',')}`);
  ok('…the limitation says the model was not available, with the full reason', r.limitations.some((l: string) => /model was not available/.test(l) && /default model is down \(503\)/.test(l)), r.limitations.join(' | '));
  ok('…and the result is marked as not the model\'s answer', r.specialist.data?.['modelUsed'] === false && r.specialist.data?.['answeredBy'] === 'keyword_rules', JSON.stringify(r.specialist.data));
  delete mode['coding_agent'];
}

console.log('\n--- 7. A queue-wait time-out ends the task, for any role ---');
{
  process.env['JARVIS_MODEL_AGENT_BROWSER_AGENT'] = 'slowqueue:m';
  process.env['JARVIS_MODEL_CONVERSATION'] = 'slowqueue:talk';   // the provider the conversation uses: background calls wait for it
  process.env['JARVIS_MODEL_QUEUE_WAIT_MS'] = '200';
  process.env['JARVIS_BACKGROUND_YIELD_MS'] = '5000';
  conversationBus.conversationStarted();
  const { r } = await run('browser_agent', 'What do my open tabs say?');
  conversationBus.conversationEnded();
  ok('the task is FAILED with the queue-wait reason', r.status === 'FAILED' && /JARVIS_MODEL_QUEUE_WAIT_MS/.test(errorOf(r)), `${r.status}: ${errorOf(r).slice(0, 160)}`);
  ok('…the model was not asked and no keyword rule ran', !modelCalls.some((c) => c.who === 'slowqueue') && toolCalls.length === 0, `${modelCalls.map((c) => c.who).join(',')} / ${toolCalls.join(',')}`);
  for (const k of ['JARVIS_MODEL_AGENT_BROWSER_AGENT', 'JARVIS_MODEL_CONVERSATION', 'JARVIS_MODEL_QUEUE_WAIT_MS', 'JARVIS_BACKGROUND_YIELD_MS']) delete process.env[k];
}

console.log('\n--- 8. QA whose model answers (unchanged) ---');
{
  const { r } = await run('qa_agent', 'Review the change summary');
  ok('the QA task is COMPLETED with the model\'s answer', r.status === 'COMPLETED' && /qa_agent model answer/.test(r.answer), `${r.status}: ${r.answer.slice(0, 80)}`);
  ok('…marked as the model\'s answer', r.specialist.data?.['modelUsed'] === true && r.specialist.data?.['answeredBy'] === 'model', JSON.stringify(r.specialist.data));
}

console.log('\n--- 9. A QA call cancelled while it runs (unchanged) ---');
{
  mode['qa_agent'] = 'hang';
  toolCalls.length = 0;
  const h = await m.startRootTask({ request: 'review', specialistRole: 'qa_agent', task: { description: 'Review the change summary' } });
  await tick(100);
  m.cancelRoot(h.rootTaskId, 'test cancels');
  const r = await h.result;
  ok('it ends CANCELLED', r.status === 'CANCELLED', r.status);
  ok('…and no keyword rule ran', toolCalls.length === 0, toolCalls.join(','));
  delete mode['qa_agent'];
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* still in use on Windows */ }
process.exit(failed > 0 ? 1 : 0);
