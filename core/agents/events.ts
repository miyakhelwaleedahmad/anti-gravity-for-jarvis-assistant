/**
 * core/agents/events.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Agent events (TASK_CREATED … AGENT_STOPPED) on JARVIS's existing message
 * bus. There is one transport: every event is published on the bus topic
 * AGENT_EVENT, and subscribers here are bus subscribers with a filter. This
 * module adds what the bus lacks for agents: per-root sequence numbers, a
 * per-root record (kept by the shared workspace), filtered subscriptions and
 * an async stream for A2A streaming.
 *
 * Delivery is synchronous, as on the bus: a sibling sees a finding while the
 * agent that found it is still working. A failing subscriber is logged and
 * never breaks the publisher.
 */

import { randomUUID } from 'node:crypto';
import { messageBus } from '../messageBus.js';
import type { AgentEvent, AgentEventType } from './types.js';

export interface AgentEventFilter {
  rootTaskId?: string;
  /** Any of these task ids. */
  taskIds?: readonly string[];
  agentId?: string;
  types?: readonly AgentEventType[];
}

const IMPORTANT: ReadonlySet<AgentEventType> = new Set([
  'TASK_FAILED', 'TASK_CANCELLED', 'TASK_TIMED_OUT', 'AGENT_STOPPED', 'SPAWN_REJECTED', 'PERMISSION_DENIED',
]);

const RECENT_LIMIT = 500;

export function matches(event: AgentEvent, filter: AgentEventFilter): boolean {
  if (filter.rootTaskId && event.rootTaskId !== filter.rootTaskId) return false;
  if (filter.taskIds && (!event.taskId || !filter.taskIds.includes(event.taskId))) return false;
  if (filter.agentId && event.agentId !== filter.agentId) return false;
  if (filter.types && !filter.types.includes(event.type)) return false;
  return true;
}

export class AgentEventHub {
  private seqByRoot = new Map<string, number>();
  private recorders = new Map<string, (e: AgentEvent) => void>();
  private recent: AgentEvent[] = [];

  /** The workspace of a root task records every event of that root. */
  setRecorder(rootTaskId: string, record: ((e: AgentEvent) => void) | undefined): void {
    if (record) this.recorders.set(rootTaskId, record);
    else { this.recorders.delete(rootTaskId); this.seqByRoot.delete(rootTaskId); }
  }

  emit(
    type: AgentEventType,
    rootTaskId: string,
    ids: { taskId?: string; agentId?: string; parentAgentId?: string } = {},
    data: Record<string, unknown> = {},
  ): AgentEvent {
    const seq = (this.seqByRoot.get(rootTaskId) ?? 0) + 1;
    this.seqByRoot.set(rootTaskId, seq);
    const event: AgentEvent = {
      id: randomUUID(), seq, type, at: Date.now(), rootTaskId,
      ...(ids.taskId ? { taskId: ids.taskId } : {}),
      ...(ids.agentId ? { agentId: ids.agentId } : {}),
      ...(ids.parentAgentId ? { parentAgentId: ids.parentAgentId } : {}),
      data,
    };
    this.recent.push(event);
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
    try {
      this.recorders.get(rootTaskId)?.(event);
    } catch (err) {
      console.warn(`[Agents] Could not record ${type}: ${(err as Error).message}`);
    }
    messageBus.publish('AGENT_EVENT', event, IMPORTANT.has(type) ? 6 : 3);
    return event;
  }

  /** Calls `handler` for matching events until the returned function is called. */
  subscribe(filter: AgentEventFilter, handler: (e: AgentEvent) => void): () => void {
    const listener = (e: AgentEvent) => {
      if (!matches(e, filter)) return;
      try {
        handler(e);
      } catch (err) {
        console.warn(`[Agents] Event subscriber failed on ${e.type}: ${(err as Error).message}`);
      }
    };
    messageBus.subscribe('AGENT_EVENT', listener);
    return () => messageBus.unsubscribe('AGENT_EVENT', listener);
  }

  /**
   * Matching events as they happen, until `until` returns true for one (it is
   * still yielded) or the signal aborts.
   */
  async *stream(
    filter: AgentEventFilter,
    opts: { signal?: AbortSignal; until?: (e: AgentEvent) => boolean } = {},
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const unsubscribe = this.subscribe(filter, (e) => {
      if (done) return;
      queue.push(e);
      if (opts.until?.(e)) done = true;
      wake?.();
    });
    const onAbort = () => { done = true; wake?.(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (done || opts.signal?.aborted) return;
        await new Promise<void>((r) => { wake = r; });
        wake = undefined;
      }
    } finally {
      unsubscribe();
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  recentEvents(limit = 50, filter: AgentEventFilter = {}): AgentEvent[] {
    return this.recent.filter((e) => matches(e, filter)).slice(-limit);
  }
}

export const agentEvents = new AgentEventHub();
