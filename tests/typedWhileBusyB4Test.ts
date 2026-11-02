/**
 * tests/typedWhileBusyB4Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase B4, N-PC2 (owner's PC, 2026-10-31 and 2026-11-02): text typed while
 * JARVIS was LISTENING (after "Jarvis") or left in REFLECTING crashed with
 * "ILLEGAL TRANSITION … -> PLANNING" and "I encountered an unexpected error".
 *
 *   1. typed in LISTENING: the request runs (planner and fast route)
 *   2. typed in a state left over with no request running (PLANNING,
 *      EXECUTING, OBSERVING, REFLECTING, REPAIRING): the request runs
 *   3. unchanged: barge-in while SPEAKING; a request still running is
 *      aborted by the new one; the state rules themselves (LISTENING →
 *      PLANNING stays illegal)
 *
 * Throwaway data folder; the model is a stand-in; speech is captured, not played.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-typed-busy-b4-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';
process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'no-chrome-profile');
process.chdir(workspace);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { orchestrator } = await import('../core/orchestrator.js');
{ const { worldState } = await import('../core/worldState.js'); (worldState as any).refresh = async () => {}; }
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

const ANSWER = 'Paris is sunny today, sir.';
const LONDON = 'London is rainy today, sir.';
let chatDelayMs = 0;
/** One answer per request: London's for a request about London (review R5), else Paris's. */
const answerFor = (req: any) => {
  const last = [...(req?.messages ?? [])].reverse().find((m: any) => m?.role === 'user');
  return /london/i.test(String(last?.content ?? '')) ? LONDON : ANSWER;
};
modelRouter.chat = async (req: any) => { if (chatDelayMs) await sleep(chatDelayMs); return { content: answerFor(req) } as any; };
modelRouter.streamChat = async function* (req: any) { yield answerFor(req); } as any;
const spoken: string[] = [];
const { nodeBridge } = await import('../bridge/nodeBridge.js');
installFakeTts(orchestrator, nodeBridge, 5, spoken, true);
/** Commands sent to tts.py (the fake replaces sendToRole; this records them on top of it). */
const ttsCommands: string[] = [];
{
  const send = nodeBridge.sendToRole.bind(nodeBridge);
  (nodeBridge as any).sendToRole = (role: string, msg: any) => {
    if (role === 'tts' && msg?.type === 'command') ttsCommands.push(String(msg.payload?.action));
    return send(role as never, msg);
  };
}

const ERROR = /unexpected error/i;
const PLANNER_INPUT = 'what is the weather in paris today';
/** Puts the state machine in `state` the way JARVIS gets there, with no request running. */
function leaveIn(state: string): void {
  agentStateMachine.reset();
  const paths: Record<string, string[]> = {
    LISTENING: [AgentState.LISTENING],
    PLANNING: [AgentState.PLANNING],
    EXECUTING: [AgentState.PLANNING, AgentState.EXECUTING],
    OBSERVING: [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING],
    REFLECTING: [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING],
    REPAIRING: [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING, AgentState.REPAIRING],
    SPEAKING: [AgentState.SPEAKING],
  };
  for (const s of paths[state]!) agentStateMachine.transition(s as never);
}
async function typed(input: string): Promise<string> {
  spoken.length = 0;
  await orchestrator.process(input, 'cli').catch((e: Error) => spoken.push(`THROWN: ${e.message}`));
  await sleep(250);
  return spoken.join(' | ');
}

console.log('\n=== Typed input while JARVIS is listening or busy (phase B4) ===\n');

console.log('--- 1. typed while LISTENING (after "Jarvis") ---');
{
  leaveIn('LISTENING');
  const said = await typed(PLANNER_INPUT);
  ok('a planner request typed in LISTENING runs and is answered', said.includes(ANSWER) && !ERROR.test(said), said);
  ok('…and JARVIS ends idle', agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
}
{
  leaveIn('LISTENING');
  const said = await typed('what time is it');
  ok('a fast route ("what time is it") typed in LISTENING runs', /^It is .+, sir\.$/.test(said) && !ERROR.test(said), said);
  ok('…and JARVIS ends idle', agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
}
{
  // A fast route that goes through PLANNING. No JARVIS Chrome runs here, so it acts on nothing.
  leaveIn('LISTENING');
  const said = await typed('close youtube tab');
  ok('a fast route through planning ("close youtube tab") typed in LISTENING runs (and says its Chrome is not running)', /Chrome is not running/i.test(said) && !ERROR.test(said), said);
  ok('…and JARVIS ends idle', agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
}
{
  // Review R6: small talk goes to the direct chat stream, not the planner.
  leaveIn('LISTENING');
  const said = await typed('hello');
  ok('small talk ("hello") typed in LISTENING is answered', said.length > 0 && !ERROR.test(said), said);
  ok('…and JARVIS ends idle', agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
}

console.log('--- 2. typed in a state left over with no request running ---');
for (const state of ['PLANNING', 'EXECUTING', 'OBSERVING', 'REFLECTING', 'REPAIRING']) {
  leaveIn(state);
  const said = await typed(PLANNER_INPUT);
  ok(`left in ${state}: the typed request runs and is answered`, said.includes(ANSWER) && !ERROR.test(said), said);
  ok(`…and JARVIS ends idle (${state})`, agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
}

{
  // Review R1 (owner's choice, 2026-11-02): a spoken request waiting in the voice
  // queue does not replace the typed one. The queue and its drain on IDLE are
  // wired as in jarvis.ts (voiceInputQueue, onBargeIn, state_changed).
  const voiceInputQueue: string[] = [];
  const clearQueue = () => { voiceInputQueue.length = 0; };
  orchestrator.onBargeIn.push(clearQueue);
  const drain = (state: string) => {
    if (state === AgentState.IDLE && voiceInputQueue.length) {
      const next = voiceInputQueue.shift()!;
      agentStateMachine.transition(AgentState.PROCESSING_STT);
      void orchestrator.process(next, 'voice').catch(() => undefined);
    }
  };
  agentStateMachine.on('state_changed', drain);
  leaveIn('REFLECTING');
  voiceInputQueue.push('what is the weather in london today');
  const said = await typed(PLANNER_INPUT);
  await sleep(500);
  const all = spoken.join(' | ');
  ok('left in REFLECTING with a spoken request waiting: the typed request is answered', all.includes(ANSWER) && !ERROR.test(all), all);
  ok('…and the waiting spoken request is dropped, not run instead (as barge-in drops it)', !all.includes(LONDON) && voiceInputQueue.length === 0, `${all} | queue=${voiceInputQueue.length}`);
  agentStateMachine.off('state_changed', drain);
  orchestrator.onBargeIn.splice(orchestrator.onBargeIn.indexOf(clearQueue), 1);
  void said;
}
{
  // Review round 2, N1: the owner's choice is for TYPED text. A spoken fast route
  // that arrives by arbitration in a left-over state keeps the base behaviour:
  // the waiting spoken request still runs too.
  const voiceInputQueue: string[] = [];
  const clearQueue = () => { voiceInputQueue.length = 0; };
  orchestrator.onBargeIn.push(clearQueue);
  const drain = (state: string) => {
    if (state === AgentState.IDLE && voiceInputQueue.length) {
      const next = voiceInputQueue.shift()!;
      agentStateMachine.transition(AgentState.PROCESSING_STT);
      void orchestrator.process(next, 'voice').catch(() => undefined);
    }
  };
  agentStateMachine.on('state_changed', drain);
  leaveIn('REFLECTING');
  voiceInputQueue.push('what is the weather in london today');
  spoken.length = 0;
  await orchestrator.process('what time is it', 'voice').catch(() => undefined);
  await sleep(800);
  const all = spoken.join(' | ');
  ok('spoken fast route in a left-over state (arbitration): it is answered', /It is .+, sir\./.test(all) && !ERROR.test(all), all);
  ok('…and the waiting spoken request still runs (not dropped: only typed text replaces it)', all.includes(LONDON), all);
  agentStateMachine.off('state_changed', drain);
  orchestrator.onBargeIn.splice(orchestrator.onBargeIn.indexOf(clearQueue), 1);
  agentStateMachine.reset();
}

console.log('--- 3. unchanged ---');
{
  leaveIn('SPEAKING');
  ttsCommands.length = 0;
  const said = await typed(PLANNER_INPUT);
  ok('typed while SPEAKING: barge-in, the new request is answered', said.includes(ANSWER) && !ERROR.test(said), said);
  ok('…and the barge-in stops the reply being spoken (a "stop" to tts.py)', ttsCommands.includes('stop'), ttsCommands.join(',') || 'no command sent');
}
{
  agentStateMachine.reset();
  spoken.length = 0;
  chatDelayMs = 1_500;
  const first = orchestrator.process('what is the weather in london today', 'cli').catch(() => undefined);
  await sleep(300);
  chatDelayMs = 0;
  const second = orchestrator.process(PLANNER_INPUT, 'cli').catch(() => undefined);
  await Promise.all([first, second]);
  await sleep(300);
  const said = spoken.join(' | ');
  ok('typed while another request runs: the new one is answered', said.includes(ANSWER) && !ERROR.test(said), said);
  ok('…and the one it replaced is not (it was aborted; review R5)', !said.includes(LONDON), said);
}
{
  agentStateMachine.reset();
  agentStateMachine.transition(AgentState.LISTENING);
  let threw = false;
  try { agentStateMachine.transition(AgentState.PLANNING); } catch { threw = true; }
  ok('the state rules are unchanged: LISTENING → PLANNING is still refused', threw);
  agentStateMachine.reset();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
