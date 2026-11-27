/**
 * Reviewer probe (B4, N-PC2). Read-only: throwaway data folder, fake TTS, no model call.
 * P1: left-over REFLECTING + a voice item queued + typed input (jarvis.ts drain copied).
 * P1b: same with a request really running (pre-existing concurrent branch).
 * P2: a superseded request's finally clears _loopExecuting while the newer one runs.
 * P3: typed takeover in LISTENING, then an STT result arrives while the typed request is busy.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const repo = '/home/user/anti-gravity-for-jarvis-assistant';
const ws = fs.mkdtempSync(path.join(process.env['JARVIS_DATA_ROOT'] ?? os.tmpdir(), 'ws-'));
for (const d of ['memory', 'data']) fs.mkdirSync(path.join(ws, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = ws; process.env['JARVIS_DATA_ROOT'] = ws;
process.chdir(ws);
const imp = (p: string) => import(path.join(repo, p));
const { registerAllTools } = await imp('core/tools/index.ts');
const { SkillLoader } = await imp('core/skillLoader.ts');
const { orchestrator } = await imp('core/orchestrator.ts');
{ const { worldState } = await imp('core/worldState.ts'); (worldState as any).refresh = async () => {}; }
const { modelRouter } = await imp('bridge/modelRouter.ts');
const { memoryManager } = await imp('memory/memoryManager.ts');
const { agentStateMachine, AgentState, tryTransition } = await imp('core/agentStateMachine.ts');
const { installFakeTts } = await imp('tests/fakeTts.ts');
registerAllTools(); await new SkillLoader(path.join(repo, 'skills')).loadSkills(); await memoryManager.init();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const delays: Record<string, number> = {};
const answerFor = (req: any): string => {
  const s = JSON.stringify(req?.messages ?? []).toLowerCase();
  // the last user message decides
  const users = (req?.messages ?? []).filter((m: any) => m.role === 'user');
  const last = String(users[users.length - 1]?.content ?? s).toLowerCase();
  for (const city of ['paris', 'london', 'berlin', 'rome']) if (last.includes(city)) return city.toUpperCase();
  return 'OTHER';
};
modelRouter.chat = async (req: any) => { const a = answerFor(req); if (delays[a]) await sleep(delays[a]); return { content: `It is sunny in ${a}, sir.` } as any; };
modelRouter.streamChat = async function* (req: any) { yield `It is sunny in ${answerFor(req)}, sir.`; } as any;
const spoken: string[] = [];
const { nodeBridge } = await imp('bridge/nodeBridge.ts');
installFakeTts(orchestrator, nodeBridge, 5, spoken, true);

// ── Faithful copy of jarvis.ts drainVoiceInputQueue + the state_changed(IDLE) hook ──
const voiceInputQueue: { text: string; timestamp: number }[] = [];
const drained: string[] = [];
function drain(): void {
  if (voiceInputQueue.length === 0) return;
  const item = voiceInputQueue.shift()!;
  const BUSY = [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING, AgentState.REPAIRING, AgentState.SPEAKING];
  if (BUSY.includes(agentStateMachine.currentState)) { voiceInputQueue.unshift(item); return; }
  drained.push(item.text);
  tryTransition(AgentState.PROCESSING_STT, 'queued voice command');
  orchestrator.process(item.text, 'voice').catch(() => {});
}
agentStateMachine.on('state_changed', (s: string) => { if (s === AgentState.IDLE) drain(); });

const warns: string[] = [];
const ow = console.warn; console.warn = (...a: any[]) => { const t = a.map(String).join(' '); if (/Concurrent|left over|takes over/.test(t)) warns.push(t.slice(0, 110)); ow(...a); };
const ol = console.log; console.log = (...a: any[]) => { const t = a.map(String).join(' '); if (/takes over/.test(t)) warns.push(t.slice(0, 110)); ol(...a); };
const out: string[] = [];
const report = (label: string) => { out.push(`${label}\n  spoken: ${spoken.join(' | ') || '(nothing)'}\n  drained: ${drained.join(', ') || '-'}\n  branch logs: ${warns.join(' || ') || '-'}\n  state: ${agentStateMachine.currentState}`); spoken.length = 0; drained.length = 0; warns.length = 0; };

orchestrator.onBargeIn.push(() => { voiceInputQueue.length = 0; });
// R3-A: LISTENING with a spoken request waiting, typed "paris" (the M1 difference).
agentStateMachine.reset(); await sleep(50); spoken.length = 0; drained.length = 0; warns.length = 0;
agentStateMachine.transition(AgentState.LISTENING);
voiceInputQueue.push({ text: 'what is the weather in london today', timestamp: Date.now() });
await orchestrator.process('what is the weather in paris today', 'cli').catch(() => {});
await sleep(800);
report(`R3-A LISTENING + queued voice "london", typed "paris" (queue left: ${voiceInputQueue.length})`);

// R3-B: left-over REFLECTING, typed "paris", queued "london" (owner case, regression check).
agentStateMachine.reset(); await sleep(50); spoken.length = 0; drained.length = 0; warns.length = 0;
for (const s of [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING]) agentStateMachine.transition(s);
voiceInputQueue.push({ text: 'what is the weather in london today', timestamp: Date.now() });
await orchestrator.process('what is the weather in paris today', 'cli').catch(() => {});
await sleep(800);
report('R3-B left-over REFLECTING + queued voice "london", typed "paris"');

// R3-C: left-over REFLECTING, arbitrated spoken fast route, queued "london" (N1).
agentStateMachine.reset(); await sleep(50); spoken.length = 0; drained.length = 0; warns.length = 0;
for (const s of [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING]) agentStateMachine.transition(s);
voiceInputQueue.push({ text: 'what is the weather in london today', timestamp: Date.now() });
await orchestrator.process('what time is it', 'voice').catch(() => {});
await sleep(800);
report('R3-C left-over REFLECTING + queued voice "london", arbitrated voice "what time is it"');

// R3-D: queue drain path: PROCESSING_STT from IDLE, voice request (normal path).
agentStateMachine.reset(); await sleep(50); spoken.length = 0; drained.length = 0; warns.length = 0;
agentStateMachine.transition(AgentState.PROCESSING_STT);
await orchestrator.process('what is the weather in rome today', 'voice').catch(() => {});
await sleep(500);
report('R3-D voice in PROCESSING_STT (normal/drain path)');

console.log = ol; console.warn = ow;
console.log('\n================ PROBE RESULTS ================\n' + out.join('\n\n'));
process.exit(0);
