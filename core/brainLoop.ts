/**
 * core/brainLoop.ts  (v2 — delegate to orchestrator)
 * ─────────────────────────────────────────────────────────────────────────────
 * The BrainLoop is now a thin lifecycle wrapper.
 * All reasoning logic lives in core/orchestrator.ts.
 *
 * Previously this had a ConsciousnessClock timer tick that drained a flat
 * taskQueue. That is now replaced by the orchestrator's PLAN→EXECUTE→REFLECT
 * state machine, which is event-driven — not timer-driven.
 *
 * Backward-compat: BrainLoop class and brainLoop singleton are preserved.
 * jarvis.ts calls brainLoop.start() just as before.
 */

import { orchestrator } from './orchestrator.js';
import { agentStateMachine, AgentState } from './agentStateMachine.js';
import { messageBus } from './messageBus.js';

export class BrainLoop {
  private isRunning = false;

  constructor() {
    // Listen for interrupt signals and reset state machine
    agentStateMachine.on('interrupted', () => {
      console.log('[BrainLoop] 🛑 Interrupt received — resetting state after 2s cooldown.');
      setTimeout(() => {
        if (agentStateMachine.is(AgentState.INTERRUPTED)) {
          agentStateMachine.reset();
          console.log('[BrainLoop] ♻️  State machine reset to IDLE.');
        }
      }, 2000);
    });

    // Publish agent state changes to messageBus for any legacy subscribers
    agentStateMachine.on('transition', ({ from, to }: { from: string; to: string }) => {
      messageBus.publish('AGENT_STATE_CHANGED', { from, to }, 4);
    });

    // Legacy: TASK_COMPLETED still fired on success for backward compat
    agentStateMachine.on(AgentState.IDLE.toLowerCase(), () => {
      // Only publish if we just completed a task (came from REFLECTING/REPAIRING)
      const history = agentStateMachine.stateHistory;
      const last = history[history.length - 2];
      if (last && (last.state === AgentState.REFLECTING || last.state === AgentState.SPEAKING)) {
        messageBus.publish('TASK_COMPLETED', { goal: 'user_request', result: 'completed' }, 4);
      }
    });
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    orchestrator.startLoop();
    console.log('[BrainLoop] ♾️  Autonomy loop active. Orchestrator ready.');
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    orchestrator.stopLoop();
    console.log('[BrainLoop] ⏹️  Autonomy loop stopped.');
  }
}

export const brainLoop = new BrainLoop();
