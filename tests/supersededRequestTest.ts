/**
 * tests/supersededRequestTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A request replaced by a newer one (or interrupted) must stop and stay
 * silent. Its checks read this.currentAbortController, which by then was the
 * newer request's, so on the owner's PC (JARVIS log, 2026-10-08):
 *
 *  1. "full control mode" was replaced by "enable full control mode" while
 *     planning. Its aborted LLM call was taken for an outage: JARVIS said
 *     "I'm experiencing difficulty reaching my primary reasoning systems",
 *     moved the shared state to IDLE under the new request, and the approval
 *     question waited behind that sentence.
 *  2. "maximize the notification" was interrupted by "maximize the notepad"
 *     while its step was still running. When the step ended, the old request
 *     went on, spoke its result and left the state at SPEAKING; the new
 *     request then failed with SPEAKING -> OBSERVING and said "I encountered
 *     an unexpected error".
 *
 * The model and the tool are stand-ins; nothing on the PC is changed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-superseded-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

// Everything JARVIS says goes through speakToClients; speak() itself stays real.
let spoken: string[] = [];
nodeBridge.speakToClients = ((text: string) => { spoken.push(text); }) as typeof nodeBridge.speakToClients;

// Stand-in model. A planning call follows the plan set for its request; a
// planning call can be held until it is aborted, as the real one was.
type Plan = { hold?: boolean; tool?: string; args?: Record<string, unknown> };
const plans = new Map<string, Plan>();
modelRouter.chat = async (req: any) => {
  const user = [...(req.messages ?? [])].reverse().find((m: any) => m.role === 'user');
  const text = String(user?.content ?? '');
  const plan = [...plans.entries()].find(([input]) => text.includes(input))?.[1];
  if (req.tools && plan?.hold) {
    return new Promise((_, reject) => {
      const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
      if (req.signal?.aborted) abort();
      req.signal?.addEventListener('abort', abort);
    });
  }
  if (req.tools && plan?.tool) {
    return { content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: plan.tool, arguments: JSON.stringify(plan.args ?? {}) } }] } as any;
  }
  return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' } as any;
};
modelRouter.streamChat = async function* () { yield 'Done, sir.'; } as any;

// A read-only stand-in step whose run time and answer the test sets per call.
const tool = toolRegistryV2.get('get_system_info')! as any;
tool.execute = async (args: Record<string, unknown>) => {
  await sleep(Number(args['ms'] ?? 0));
  return String(args['answer'] ?? 'ok');
};

const illegal: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => {
  const line = a.map(String).join(' ');
  if (/ILLEGAL TRANSITION|Unhandled error in agent loop/.test(line)) illegal.push(line.slice(0, 160));
  origError(...a);
};

console.log('\n=== Superseded Request Test ===\n');

console.log('--- 1. Replaced while planning (the full control case) ---');
{
  agentStateMachine.reset();
  spoken = []; illegal.length = 0;
  plans.clear();
  plans.set('full control mode please', { hold: true });
  plans.set('tell me the system status now', { tool: 'get_system_info', args: { ms: 300, answer: 'The new request answered.' } });
  const first = orchestrator.process('full control mode please', 'voice');
  await sleep(150); // the first request is now waiting on the model
  // States from the new request's planning until it is done.
  const states: string[] = [];
  let planning = false;
  let done = false;
  const onChanged = (s: string) => {
    if (s === AgentState.PLANNING) planning = true;
    if (planning && !done) states.push(s);
  };
  agentStateMachine.on('state_changed', onChanged);
  const second = orchestrator.process('tell me the system status now', 'voice').then(() => { done = true; });
  await Promise.all([first, second]);
  agentStateMachine.off('state_changed', onChanged);

  const all = spoken.join(' | ');
  ok('the replaced request does not claim an outage', !/difficulty reaching/i.test(all), all);
  ok('the new request gives its own answer', all.includes('The new request answered.'), all);
  ok('the replaced request did not move the state to IDLE under the new one', !states.includes(AgentState.IDLE), states.join(' > '));
  ok('no illegal state change or unexpected error', illegal.length === 0 && !/unexpected error/i.test(all), illegal.join(' / '));
}

console.log('\n--- 2. Interrupted while its step runs, then a new request (the maximize case) ---');
{
  await sleep(50);
  agentStateMachine.reset();
  spoken = []; illegal.length = 0;
  plans.clear();
  plans.set('maximize the notification', { tool: 'get_system_info', args: { ms: 400, answer: 'The old request answered.' } });
  plans.set('maximize the notepad', { tool: 'get_system_info', args: { ms: 900, answer: 'The new request answered.' } });

  const first = orchestrator.process('maximize the notification', 'voice');
  for (let i = 0; i < 40 && agentStateMachine.currentState !== AgentState.EXECUTING; i++) await sleep(25);
  ok('the first request is running its step', agentStateMachine.currentState === AgentState.EXECUTING, agentStateMachine.currentState);

  // What the wake word did: interrupt, hand over, and start the new request.
  agentStateMachine.interrupt();
  agentStateMachine.transition(AgentState.PROCESSING_STT);
  const second = orchestrator.process('maximize the notepad', 'voice');
  await Promise.all([first, second]);

  const all = spoken.join(' | ');
  ok('the interrupted request stays silent', !all.includes('The old request answered.'), all);
  ok('the new request gives its own answer', all.includes('The new request answered.'), all);
  ok('no illegal state change or unexpected error', illegal.length === 0 && !/unexpected error/i.test(all), illegal.join(' / '));
}

console.log('\n--- 3. A request on its own is unchanged ---');
{
  await sleep(50);
  agentStateMachine.reset();
  spoken = []; illegal.length = 0;
  plans.clear();
  plans.set('what is the system status', { tool: 'get_system_info', args: { ms: 50, answer: 'All systems normal.' } });
  await orchestrator.process('what is the system status', 'voice');
  const all = spoken.join(' | ');
  ok('it answers', all.includes('All systems normal.'), all);
  ok('no errors', illegal.length === 0, illegal.join(' / '));
}

console.error = origError;
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
