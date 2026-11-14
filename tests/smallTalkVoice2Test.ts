/**
 * tests/smallTalkVoice2Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Voice #2 (owner's PC, 2026-11-06, data/logs/stt_debug.log): in the follow-up
 * window JARVIS took the owner's small talk as new requests:
 *   14:04:05 "ok thanks"      → the LLM planner
 *   14:04:14 "close jar"      → queued behind it, dropped after 45 s
 *   14:08:08 "thank you jar"  → the LLM planner
 * The fast route knew only exact phrases ("thank you", "ok").
 *
 * And while JARVIS is busy, jarvis.ts runs any fast-route phrase at once
 * (orchestrator.process), and process() aborts the request in progress
 * (core/orchestrator.ts), so even "thank you" said mid-task cancelled the task.
 *
 *   1. the phrases and their routes; lookalikes do not match
 *   2. the logged phrases, idle: the reply, no planner call
 *   3. small talk while a request runs: ignored, the request is not cancelled
 *   4. "stop" and "cancel" while a request runs still cancel it
 *   5. "close jarvis": the reply only, no stop and no planner call
 *   6. jarvis.ts decides before it calls orchestrator.process()
 *   7. jarvis.ts's busy branch itself, run with stand-ins: small talk returns
 *      before orchestrator.process() and the queue; "stop" still runs
 *
 * Throwaway data folder; the model is a stand-in; speech is captured, not played.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const skillsDir = path.join(repoRoot, 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-small-talk-v2-'));
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
const routes = await import('../core/deterministicRoutes.js');
registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

// The rule jarvis.ts applies to a voice command heard while busy. Before Voice #2
// there was no such function: any fast route ran at once, anything else waited.
const BEFORE = (r: unknown) => (r ? 'run' : 'queue');
const voiceWhileBusy: (r: unknown) => string = (routes as any).voiceWhileBusy ?? BEFORE;
console.log(`(busy rule: ${(routes as any).voiceWhileBusy ? 'voiceWhileBusy() from core/deterministicRoutes.ts' : 'not found; the rule jarvis.ts used before'})`);

const ANSWER = 'Paris is sunny today, sir.';
let plannerCalls = 0;
let chatDelayMs = 0;
modelRouter.chat = async () => { plannerCalls++; if (chatDelayMs) await sleep(chatDelayMs); return { content: ANSWER } as any; };
modelRouter.streamChat = async function* () { plannerCalls++; yield ANSWER; } as any;
const spoken: string[] = [];
const { nodeBridge } = await import('../bridge/nodeBridge.js');
installFakeTts(orchestrator, nodeBridge, 5, spoken, true);
const ttsCommands: string[] = [];
{
  const send = nodeBridge.sendToRole.bind(nodeBridge);
  (nodeBridge as any).sendToRole = (role: string, msg: any) => {
    if (role === 'tts' && msg?.type === 'command') ttsCommands.push(String(msg.payload?.action));
    return send(role as never, msg);
  };
}

const THANKS_REPLY = 'Anytime, sir.';
const CLOSE_REPLY = "I can't close myself by voice, sir. Close my window or press Ctrl+C.";
const PLANNER_INPUT = 'what is the weather in paris today';
const route = (t: string) => orchestrator.matchDeterministicCommand(t);

async function idle(text: string): Promise<{ said: string; planner: number; tts: string[] }> {
  agentStateMachine.reset();
  spoken.length = 0; ttsCommands.length = 0;
  const before = plannerCalls;
  await orchestrator.process(text, 'voice').catch((e: Error) => spoken.push(`THROWN: ${e.message}`));
  await sleep(250);
  return { said: spoken.join(' | '), planner: plannerCalls - before, tts: [...ttsCommands] };
}

/** Starts a planner request that takes 1.5 s and waits until JARVIS is busy with it. */
async function startBusyRequest(): Promise<{ done: Promise<void>; busyState: string }> {
  agentStateMachine.reset();
  spoken.length = 0; ttsCommands.length = 0;
  chatDelayMs = 1500;
  const done = orchestrator.process(PLANNER_INPUT, 'voice').catch((e: Error) => { spoken.push(`THROWN: ${e.message}`); });
  const busy = [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING, AgentState.REPAIRING] as string[];
  for (let i = 0; i < 40 && !busy.includes(agentStateMachine.currentState); i++) await sleep(25);
  return { done, busyState: agentStateMachine.currentState };
}

/** What jarvis.ts does with `text` heard while busy (its busy branch). */
async function heardWhileBusy(text: string): Promise<string> {
  const decision = voiceWhileBusy(route(text));
  if (decision === 'run') await orchestrator.process(text, 'voice').catch(() => {});
  return decision;
}

console.log('\n=== Voice #2: small talk is not a request, and never cancels one ===\n');

console.log('--- 1. Phrases and their routes ---');
for (const t of ['ok thanks', 'okay thanks', 'ok thank you', 'okay thank you', 'cool thanks', 'alright thanks',
  'thank you jar', 'thank you jarvis', 'thanks jar', 'thanks jarvis', 'OK, thanks!', 'Thank you, Jarvis.']) {
  const r = route(t);
  ok(`1. "${t}": small talk, "${THANKS_REPLY}"`, r?.type === 'simple_reply' && r?.reply === THANKS_REPLY, JSON.stringify(r));
}
for (const t of ['close jar', 'close jarvis', 'Close Jarvis.']) {
  const r = route(t);
  ok(`1. "${t}": the close-myself reply, no close action`, r?.type === 'simple_reply' && r?.reply === CLOSE_REPLY, JSON.stringify(r));
}
for (const [t, reply] of [['thank you', THANKS_REPLY], ['thanks', THANKS_REPLY], ['ok', 'Understood.'], ['okay', 'Understood.'],
  ['jarvis thank you', THANKS_REPLY]] as const) {
  const r = route(t);
  ok(`1. existing "${t}" unchanged`, r?.type === 'simple_reply' && r?.reply === reply, JSON.stringify(r));
}
for (const t of ['no thanks', 'open jar file', 'thank you for opening youtube', 'close notepad', 'close jarvis window please', 'ok thanks open youtube']) {
  const r = route(t);
  ok(`1. "${t}" is not taken as small talk`, !(r?.type === 'simple_reply' && (r.reply === THANKS_REPLY || r.reply === CLOSE_REPLY)), JSON.stringify(r));
}

console.log('\n--- 2. The logged phrases with JARVIS idle ---');
for (const [t, reply] of [['ok thanks', THANKS_REPLY], ['thank you jar', THANKS_REPLY], ['close jar', CLOSE_REPLY]] as const) {
  const r = await idle(t);
  ok(`2. "${t}": JARVIS says "${reply}"`, r.said === reply, r.said);
  ok(`2. "${t}": no planner call`, r.planner === 0, `planner calls: ${r.planner}`);
}

console.log('\n--- 3. Small talk while a request runs: ignored, the request is not cancelled ---');
// "hello" and "are you there" are greetings (route type 'greeting'), the rest simple replies.
for (const t of ['ok thanks', 'thank you jar', 'close jar', 'thank you', 'hello', 'are you there']) {
  const { done, busyState } = await startBusyRequest();
  const decision = await heardWhileBusy(t);
  await done; await sleep(250);
  chatDelayMs = 0;
  const said = spoken.join(' | ');
  ok(`3. "${t}" while ${busyState}: ignored`, decision === 'ignore', `decision: ${decision}`);
  ok(`3. "${t}" while ${busyState}: the request in progress still answers, and nothing else is said`, said === ANSWER, said);
}
for (const type of ['simple_reply', 'greeting']) {
  const decision = voiceWhileBusy({ type, reply: '' });
  ok(`3. a '${type}' route while busy is ignored`, decision === 'ignore', `decision: ${decision}`);
}

console.log('\n--- 4. "stop" and "cancel" while a request runs still cancel it ---');
for (const t of ['stop', 'cancel']) {
  const { done, busyState } = await startBusyRequest();
  const decision = await heardWhileBusy(t);
  await done; await sleep(250);
  chatDelayMs = 0;
  const said = spoken.join(' | ');
  ok(`4. "${t}" while ${busyState}: run at once`, decision === 'run', `decision: ${decision}`);
  ok(`4. "${t}" while ${busyState}: the request in progress is cancelled ("Stopped, sir.", no answer)`,
    said.includes('Stopped, sir.') && !said.includes(ANSWER), said);
}

console.log('\n--- 5. "close jarvis" does nothing but reply ---');
for (const t of ['close jarvis', 'close jar']) {
  const r = await idle(t);
  ok(`5. "${t}": the reply only`, r.said === CLOSE_REPLY, r.said);
  ok(`5. "${t}": no stop command and no planner call`, !r.tts.includes('stop') && r.planner === 0, `tts: [${r.tts.join(', ')}], planner: ${r.planner}`);
  ok(`5. "${t}": not the stop/shutdown route`, route(t)?.type !== 'stop', JSON.stringify(route(t)));
}

console.log('\n--- 6. jarvis.ts asks voiceWhileBusy() before it calls orchestrator.process() ---');
{
  const src = fs.readFileSync(path.join(repoRoot, 'jarvis.ts'), 'utf8');
  const start = src.indexOf('Busy-state arbitration');
  const branch = start < 0 ? '' : src.slice(start, src.indexOf('Normal path: safe states', start));
  const decides = branch.indexOf('voiceWhileBusy(');
  const ignores = branch.search(/===\s*'ignore'\)\s*\{[\s\S]*?return;/);
  const runs = branch.indexOf("orchestrator.process(text, 'voice')");
  ok('6. the busy branch asks voiceWhileBusy(), and returns on "ignore", before orchestrator.process()',
    decides >= 0 && ignores > decides && runs > ignores, `voiceWhileBusy at ${decides}, ignore-return at ${ignores}, process at ${runs}`);
}

console.log("\n--- 7. jarvis.ts's busy branch, run with stand-ins ---");
{
  // The body of `if (BUSY_STATES.includes(nextState)) { ... }`, taken from
  // jarvis.ts as it is and run as a function: the real early return is what
  // keeps small talk from reaching orchestrator.process() and the queue.
  const src = fs.readFileSync(path.join(repoRoot, 'jarvis.ts'), 'utf8');
  const head = src.search(/if \(BUSY_STATES\.includes\(nextState\)\) \{/);
  let body = '';
  if (head >= 0) {
    const open = src.indexOf('{', head);
    for (let i = open, depth = 0; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { body = src.slice(open + 1, i); break; }
    }
  }
  ok('7. the busy branch was found in jarvis.ts', body.includes('orchestrator.process(text'), `${body.length} characters`);

  const runBranch = (heard: string) => {
    const r = route(heard);
    const calls = { processed: [] as string[], said: [] as string[], logged: [] as string[] };
    const queue = [{ text: 'open notepad', timestamp: 1 }];      // a command already waiting
    let error = '';
    try {
      const branch = new Function('orchestrator', 'voiceWhileBusy', 'nextState', 'text', 'voiceInputQueue',
        'nodeBridge', 'pipelineRegistry', 'sttJsLog', 'console', body);
      branch(
        { matchDeterministicCommand: () => r, process: (t: string) => { calls.processed.push(t); return Promise.resolve(); } },
        voiceWhileBusy, 'PLANNING', heard, queue,
        { speakToClients: (t: string) => calls.said.push(t) },
        { recordFailure: () => {} },
        (event: string) => calls.logged.push(event),
        { log: () => {}, error: () => {} },
      );
    } catch (e) { error = (e as Error).message; }
    return { ...calls, queue: queue.map((q) => q.text), error, type: r?.type ?? 'none' };
  };

  for (const heard of ['ok thanks', 'thank you jar', 'close jar', 'hello', 'are you there']) {
    const b = runBranch(heard);
    ok(`7. "${heard}" (${b.type}): returns before orchestrator.process(), the queue and any speech`,
      !b.error && b.processed.length === 0 && b.said.length === 0 && b.queue.join() === 'open notepad'
        && b.logged.includes('STT_SMALL_TALK_IGNORED_BUSY'),
      `processed: [${b.processed}], said: [${b.said}], queue: [${b.queue}], logged: [${b.logged}]${b.error ? `, error: ${b.error}` : ''}`);
  }
  for (const heard of ['stop', 'cancel']) {
    const b = runBranch(heard);
    ok(`7. "${heard}" (${b.type}): still goes to orchestrator.process() at once`,
      !b.error && b.processed.join() === heard && b.said.length === 0 && b.queue.join() === 'open notepad',
      `processed: [${b.processed}], said: [${b.said}], queue: [${b.queue}]${b.error ? `, error: ${b.error}` : ''}`);
  }
  {
    const b = runBranch(PLANNER_INPUT);
    ok('7. a request with no fast route still waits in the queue ("One moment, sir")',
      !b.error && b.processed.length === 0 && b.queue.join() === PLANNER_INPUT && /^One moment, sir/.test(b.said.join()),
      `processed: [${b.processed}], said: [${b.said}], queue: [${b.queue}]${b.error ? `, error: ${b.error}` : ''}`);
  }
}

agentStateMachine.reset();
process.chdir(repoRoot);
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
