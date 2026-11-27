/**
 * Read-only reproduction (phase B4, N-PC2): text typed while JARVIS is in
 * LISTENING (after "Jarvis") or left in REFLECTING. Nothing on the PC is
 * touched: throwaway data folder, speech captured, no model call.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const repo = process.cwd();
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-b4-probe-'));
for (const d of ['memory', 'data']) fs.mkdirSync(path.join(ws, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = ws; process.env['JARVIS_DATA_ROOT'] = ws;
process.env['JARVIS_CHROME_AUTOSTART'] = 'off'; process.env['JARVIS_CHROME_PROFILE'] = path.join(ws, 'p');
process.chdir(ws);
const imp = (p: string) => import(path.join(repo, p));
const { registerAllTools } = await imp('core/tools/index.ts');
const { SkillLoader } = await imp('core/skillLoader.ts');
const { orchestrator } = await imp('core/orchestrator.ts');
{ const { worldState } = await imp('core/worldState.ts'); (worldState as any).refresh = async () => {}; }
const { modelRouter } = await imp('bridge/modelRouter.ts');
const { memoryManager } = await imp('memory/memoryManager.ts');
const { agentStateMachine, AgentState } = await imp('core/agentStateMachine.ts');
const { installFakeTts } = await imp('tests/fakeTts.ts');
registerAllTools(); await new SkillLoader(path.join(repo, 'skills')).loadSkills(); await memoryManager.init();
modelRouter.chat = async () => ({ content: 'It is a sunny day, sir.' }) as any;
modelRouter.streamChat = async function* () { yield 'It is a sunny day, sir.'; } as any;
const spoken: string[] = [];
installFakeTts(orchestrator, (await imp('bridge/nodeBridge.ts')).nodeBridge, 5, spoken, true);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const [label, path_] of [
  ['LISTENING (wake word heard, waiting for speech)', [AgentState.LISTENING]],
  ['REFLECTING (a state left over with no request running)', [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING]],
] as const) {
  agentStateMachine.reset();
  for (const s of path_) agentStateMachine.transition(s);
  spoken.length = 0;
  const before = agentStateMachine.currentState;
  await orchestrator.process('open notepad and tell me a joke about cats', 'cli').catch((e: Error) => spoken.push(`THROWN: ${e.message}`));
  await sleep(300);
  console.log(`CASE ${label}\n  state before: ${before}\n  said: ${spoken.join(' | ') || '(nothing)'}\n  state after: ${agentStateMachine.currentState}`);
}
process.exit(0);
