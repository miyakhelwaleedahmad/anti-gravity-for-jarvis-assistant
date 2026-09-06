/**
 * core/systemController.ts  (v2 — compatibility shim)
 * ─────────────────────────────────────────────────────────────────────────────
 * Backward-compatibility proxy over agentStateMachine.
 *
 * All existing code that imports systemController / SystemState will continue
 * to work without changes. Internally, this just delegates to agentStateMachine
 * which now owns the authoritative state.
 *
 * New code should import agentStateMachine directly.
 */

import { agentStateMachine, AgentState } from './agentStateMachine.js';

// Re-export SystemState enum mapped to AgentState values
// This preserves backward compat for all imports of SystemState
export enum SystemState {
  IDLE           = 'IDLE',
  LISTENING      = 'LISTENING',
  PROCESSING_STT = 'PROCESSING_STT',
  THINKING       = 'THINKING',       // Maps to PLANNING in new system
  SPEAKING       = 'SPEAKING',
  INTERRUPTED    = 'INTERRUPTED',
}

class SystemController {
  get currentState(): SystemState {
    const s = agentStateMachine.currentState;
    // Map new PLANNING/EXECUTING/REFLECTING states to legacy THINKING
    if (s === AgentState.PLANNING ||
        s === AgentState.EXECUTING ||
        s === AgentState.OBSERVING ||
        s === AgentState.REFLECTING ||
        s === AgentState.REPAIRING) {
      return SystemState.THINKING;
    }
    return s as unknown as SystemState;
  }

  setState(newState: SystemState): void {
    // Map legacy THINKING to PLANNING in new system
    if (newState === SystemState.THINKING) {
      agentStateMachine.transition(AgentState.PLANNING);
      return;
    }
    agentStateMachine.transition(newState as unknown as AgentState);
  }

  is(state: SystemState): boolean {
    return this.currentState === state;
  }

  isInterrupted(): boolean {
    return agentStateMachine.isInterrupted();
  }

  can(action: string): boolean {
    return agentStateMachine.can(action);
  }

  // Delegate event subscriptions to agentStateMachine
  on(event: string, listener: (...args: any[]) => void): this {
    agentStateMachine.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    agentStateMachine.off(event, listener);
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    return agentStateMachine.emit(event, ...args);
  }
}

export const systemController = new SystemController();
