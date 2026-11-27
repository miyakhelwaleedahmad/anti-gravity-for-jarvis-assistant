/**
 * tests/duplicateEventsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-19: events handled twice, and a stale graph.
 *
 *   1. One interrupt emits 'interrupted' once. transition() emitted it as
 *      newState.toLowerCase() and then again by name, so the Orchestrator
 *      and BrainLoop handlers each ran twice on a barge-in.
 *   2. "idle" once when speech ends. speakingEnded() emits speaking:end,
 *      whose Orchestrator handler calls conversationEnded() (idle), and then
 *      emitted idle itself: two "Context active" and two wake-word resumes
 *      after the YouTube reply. A later turn is idle again as usual.
 *   3. A finished graph is no longer the current one, and an interrupt does
 *      not mark it "interrupted" (graph_1792484612348_137d5 in the log).
 */

const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
const { conversationBus } = await import('../core/conversationBus.js');
const { taskGraphEngine, TaskGraphBuilder } = await import('../core/taskGraphEngine.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
function toIdle(): void {
  if (!agentStateMachine.is(AgentState.IDLE)) {
    try { agentStateMachine.transition(AgentState.IDLE); } catch { agentStateMachine.reset(); }
  }
}

console.log('\n--- 1. One interrupt, one event ---');
{
  toIdle();
  let interrupts = 0;
  const on = () => { interrupts++; };
  agentStateMachine.on('interrupted', on);
  agentStateMachine.transition(AgentState.LISTENING);
  agentStateMachine.transition(AgentState.PROCESSING_STT);
  agentStateMachine.transition(AgentState.PLANNING);
  agentStateMachine.interrupt();
  agentStateMachine.off('interrupted', on);
  ok('a barge-in emits "interrupted" once', interrupts === 1, `${interrupts} times`);
  agentStateMachine.reset();
}

console.log('\n--- 2. idle once per turn ---');
{
  let idles = 0;
  const onIdle = () => { idles++; };
  conversationBus.on('idle', onIdle);
  // As the Orchestrator does: a deferred conversation end on speaking:end.
  const endOnSpeechEnd = () => conversationBus.conversationEnded();
  conversationBus.on('speaking:end', endOnSpeechEnd);
  conversationBus.conversationStarted();
  conversationBus.speakingStarted();
  conversationBus.speakingEnded();
  ok('a reply that ends the conversation on speaking:end: idle once', idles === 1, `${idles} times`);
  conversationBus.conversationStarted();
  conversationBus.speakingStarted();
  conversationBus.speakingEnded();
  ok('…and once again on the next turn', idles === 2, `${idles} in all`);
  conversationBus.off('speaking:end', endOnSpeechEnd);
  conversationBus.conversationStarted();
  conversationBus.conversationEnded();
  ok('a turn with no speech is idle once too', idles === 3, `${idles} in all`);
  conversationBus.off('idle', onIdle);
}

console.log('\n--- 3. A finished graph is not the current one ---');
{
  const b = new TaskGraphBuilder('play sanam re');
  b.addTask({ tool: 'youtube_search', args: { query: 'sanam re' }, description: 'search' });
  const graph = b.build();
  await taskGraphEngine.execute(graph, async () => 'ok');
  ok('(setup) the graph completed', graph.status === 'completed', graph.status);
  ok('it is no longer the graph in flight', taskGraphEngine.getCurrentGraph() === null, String(taskGraphEngine.getCurrentGraph()?.id));
  taskGraphEngine.interrupt(graph);
  ok('an interrupt leaves a completed graph completed', graph.status === 'completed', graph.status);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
