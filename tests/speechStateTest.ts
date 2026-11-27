/**
 * tests/speechStateTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Speech and the agent state machine (BUG-02, HYP-01):
 *
 *   - announce() (a progress message while a task goes on) speaks without
 *     moving the state machine; speak() (the reply) moves it to SPEAKING
 *   - TTS starting to play moves the state machine only from IDLE or
 *     INTERRUPTED: a background approval prompt that starts playing while the
 *     foreground task is REFLECTING leaves the task free to go on to
 *     REPAIRING → EXECUTING
 *   - the loop states still refuse transitions the table does not allow
 *     (nothing was loosened to make the errors disappear)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-speech-state-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const { agentStateMachine, AgentState, speechStartMovesState } = await import('../core/agentStateMachine.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { conversationBus } = await import('../core/conversationBus.js');
const { installFakeTts } = await import('./fakeTts.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const legal = (to: any) => { try { agentStateMachine.transition(to); return true; } catch { return false; } };

const tts = installFakeTts(orchestrator, nodeBridge);
// What jarvis.ts does when tts.py reports that playback started.
conversationBus.on('speaking:start', () => {
  const cur = agentStateMachine.currentState;
  if (cur !== AgentState.SPEAKING && speechStartMovesState(cur)) agentStateMachine.transition(AgentState.SPEAKING);
});

console.log('\n=== Speech and state ===\n');

console.log('--- 1. Which states a starting playback moves ---');
ok('IDLE and INTERRUPTED move to SPEAKING', speechStartMovesState(AgentState.IDLE) && speechStartMovesState(AgentState.INTERRUPTED));
ok('PLANNING, EXECUTING, OBSERVING, REFLECTING, REPAIRING do not',
  [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING, AgentState.REPAIRING].every((s) => !speechStartMovesState(s)));

console.log('\n--- 2. A progress message in the middle of a task ---');
agentStateMachine.reset();
agentStateMachine.transition(AgentState.PLANNING);
agentStateMachine.transition(AgentState.EXECUTING);
agentStateMachine.transition(AgentState.OBSERVING);
agentStateMachine.transition(AgentState.REFLECTING);
agentStateMachine.transition(AgentState.REPAIRING);
orchestrator.announce('I restarted the dev_server first, sir.');
await tts.idle();
ok('announce() is spoken', tts.spoken.at(-1) === 'I restarted the dev server first, sir.', tts.spoken.at(-1));
ok('…and the state machine stays REPAIRING, through playback start and end', agentStateMachine.currentState === AgentState.REPAIRING, agentStateMachine.currentState);
ok('…so the next step can run (REPAIRING → EXECUTING)', legal(AgentState.EXECUTING), agentStateMachine.currentState);

console.log('\n--- 3. A background approval prompt during the foreground task (HYP-01) ---');
agentStateMachine.transition(AgentState.OBSERVING);
agentStateMachine.transition(AgentState.REFLECTING);
nodeBridge.speakToClients('Sir, a goal needs your approval to write a file.');
await tts.idle();
ok('the prompt plays, and the foreground task stays REFLECTING', agentStateMachine.currentState === AgentState.REFLECTING, agentStateMachine.currentState);
ok('…and goes on to REPAIRING', legal(AgentState.REPAIRING));

console.log('\n--- 4. The reply still moves to SPEAKING ---');
orchestrator.speak('Done, sir.');
ok('speak() moves REPAIRING → SPEAKING (through IDLE)', agentStateMachine.currentState === AgentState.SPEAKING, agentStateMachine.currentState);
await tts.idle();

console.log('\n--- 5. Nothing was loosened ---');
agentStateMachine.reset();
agentStateMachine.transition(AgentState.SPEAKING);
ok('SPEAKING → EXECUTING is still refused', !legal(AgentState.EXECUTING));
ok('SPEAKING → PLANNING is still refused', !legal(AgentState.PLANNING));
agentStateMachine.reset();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
