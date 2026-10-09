/**
 * core/agents/agentScope.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Which agent the current code runs for. AsyncLocalStorage, because many
 * agents run at once in one process.
 *
 * Used by core/traceContext.ts: an approval asked from inside an agent shows
 * the user's original request and the agent that asked, not whatever request
 * JARVIS happens to be handling at that moment (traceContext is otherwise one
 * module-level value for the single foreground request).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface AgentScopeInfo {
  rootTaskId: string;
  taskId: string;
  agentId: string;
  /** "Research Agent › GitHub Research Agent". */
  agentPath: string;
  /** The user's words that started the root task. */
  request: string;
  source: 'voice' | 'cli';
}

const store = new AsyncLocalStorage<AgentScopeInfo>();

export function runAsAgent<T>(info: AgentScopeInfo, fn: () => Promise<T>): Promise<T> {
  return store.run(info, fn);
}

export function currentAgentScope(): AgentScopeInfo | undefined {
  return store.getStore();
}
