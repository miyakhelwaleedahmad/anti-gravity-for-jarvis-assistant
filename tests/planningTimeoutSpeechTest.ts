/**
 * tests/planningTimeoutSpeechTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE-002: when the PLANNING watchdog ends a request, JARVIS says so.
 *
 * The watchdog reset everything and the request ended in silence: the reset
 * aborts the request, and an aborted request is not allowed to speak. A slow
 * answer looked like JARVIS ignoring the owner.
 *
 * A real request plans against a stand-in model; the state machine's
 * watchdog reset is fired by hand (the timer itself waits for the whole retry
 * budget, see llmTimingTest). Real NodeBridge, real WebSocket client standing
 * in for tts.py. Three cases:
 *   1. a fast answer still completes and is spoken, with no timeout message;
 *   2. a model that never answers: JARVIS says it took too long, once, and is
 *      ready again;
 *   3. a model that answers anyway after the reset, with a tool call (an
 *      answer that ignores the abort): the tool does not run, nothing more is
 *      said, and no second goal starts.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-planning-timeout-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const TOKEN = 'test-bridge-token-timeout-0123456789';
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['BRIDGE_PORT'] = String(await freePort());
process.env['HEALTH_PORT'] = String(await freePort());
process.env['JARVIS_BRIDGE_TOKEN'] = TOKEN;
process.env['GROQ_API_KEY'] = 'fake-test-key';
process.env['LLM_PROVIDER'] = 'groq';

// The stand-in model. 'fast': answers at once in words. 'never': no answer
// until aborted. 'late': no answer, then one with a tool call 300 ms after the
// reset, whatever the abort says.
let mode: 'fast' | 'never' | 'late' = 'fast';
let resetAt = 0;
const realFetch = globalThis.fetch;
const reply = (message: Record<string, unknown>) => new Response(JSON.stringify({
  id: 'x', model: 'qwen-2.5-32b', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: message['tool_calls'] ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen-2.5-32b' }] }), { status: 200 });
  if (u.endsWith('/chat/completions')) {
    if (mode === 'fast') return reply({ content: 'The printing press was invented around 1440, sir.' });
    if (mode === 'late') {
      return new Promise<Response>((resolve) => {
        const t = setInterval(() => {
          if (resetAt && Date.now() - resetAt > 300) {
            clearInterval(t);
            resolve(reply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_system_info', arguments: '{}' } }] }));
          }
        }, 20);
      });
    }
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted'))));
  }
  return realFetch(url, init);
}) as typeof fetch;

const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
const { connectTtsStandIn } = await import('./ttsBridgeClient.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { goalManager } = await import('../core/goalManager.js');
const { conversationBus } = await import('../core/conversationBus.js');
conversationBus.on('idle', () => { if (!agentStateMachine.is(AgentState.IDLE)) agentStateMachine.transition(AgentState.IDLE); });
const toolsRun: string[] = [];
toolRegistryV2.onCall((c) => toolsRun.push(c.tool));

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

nodeBridge.start();
await sleep(300);
const tts = await connectTtsStandIn(Number(process.env['BRIDGE_PORT']), TOKEN);

const fireReset = () => { resetAt = Date.now(); (agentStateMachine as unknown as { _watchdogReset(s: unknown, r: string): void })._watchdogReset(AgentState.PLANNING, 'planning_timeout'); };
const untilIdle = async (ms: number) => { for (let i = 0; i < ms / 20 && !agentStateMachine.is(AgentState.IDLE); i++) await sleep(20); };
console.log('\n=== A request ended by the planning watchdog is not silent (VOICE-002) ===\n');

console.log('--- 1. A fast answer ---');
await goalManager.init();
let before = tts.received.length;
await Promise.race([orchestrator.process('tell me about the history of the printing press', 'voice'), sleep(8_000)]);
await sleep(400);
let said = tts.received.slice(before);
ok('is spoken', said.some((t) => /1440/.test(t)), JSON.stringify(said));
ok('…with no timeout message', !said.some((t) => /too long/i.test(t)), JSON.stringify(said));
await untilIdle(3_000);
ok('and JARVIS is idle again', agentStateMachine.is(AgentState.IDLE), agentStateMachine.currentState);

console.log('\n--- 2. A model that never answers ---');
mode = 'never';
const request = orchestrator.process('write me a long essay about the history of the printing press', 'voice');
for (let i = 0; i < 250 && !agentStateMachine.is(AgentState.PLANNING); i++) await sleep(20);
ok('(setup) the request is planning, waiting for the model', agentStateMachine.is(AgentState.PLANNING), agentStateMachine.currentState);
before = tts.received.length;
fireReset();
await Promise.race([request, sleep(8_000)]);
await sleep(500);
said = tts.received.slice(before);
ok('JARVIS says the answer took too long', said.some((t) => /too long/i.test(t)), JSON.stringify(said));
ok('…once, and nothing else after the reset', said.length === 1, JSON.stringify(said));
for (let i = 0; i < 100 && !agentStateMachine.is(AgentState.IDLE); i++) await sleep(20);
ok('JARVIS is idle again, ready for the next request', agentStateMachine.is(AgentState.IDLE), agentStateMachine.currentState);

console.log('\n--- 3. A model that answers anyway after the reset ---');
mode = 'late'; resetAt = 0;
const goalsBefore = goalManager.listGoals().length;
toolsRun.length = 0;
const late = orchestrator.process('check my system status and tell me the details', 'voice');
for (let i = 0; i < 250 && !agentStateMachine.is(AgentState.PLANNING); i++) await sleep(20);
ok('(setup) planning', agentStateMachine.is(AgentState.PLANNING), agentStateMachine.currentState);
before = tts.received.length;
fireReset();
await Promise.race([late, sleep(8_000)]);
await sleep(1_500);   // the late answer arrives 300 ms after the reset
said = tts.received.slice(before);
ok('the tool in the late answer does not run', toolsRun.length === 0, toolsRun.join(', '));
ok('only the timeout message is said', said.length === 1 && /too long/i.test(said[0] ?? ''), JSON.stringify(said));
ok('no second goal is started for it', goalManager.listGoals().length - goalsBefore <= 1, `${goalManager.listGoals().length - goalsBefore} new`);
await untilIdle(3_000);
ok('JARVIS is idle again', agentStateMachine.is(AgentState.IDLE), agentStateMachine.currentState);

tts.close();
nodeBridge.stop();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
