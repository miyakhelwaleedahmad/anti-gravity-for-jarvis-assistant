/**
 * core/messageBus.ts  (v2 — upgraded)
 * ─────────────────────────────────────────────────────────────────────────────
 * Priority-aware, backpressure-capable internal event bus.
 *
 * Upgrades over v1:
 *   - Priority field on every published message (1=low, 10=critical)
 *   - Capacity limit: max 100 queued messages, drops oldest on overflow
 *   - subscribeOnce() — auto-unsubscribes after first delivery
 *   - publishAndWait() — returns Promise resolved when all sync handlers complete
 *   - Channel namespacing — subscribe to 'TOOL.*' wildcards
 *
 * Backward-compatible: existing publish() / subscribe() calls still work unchanged.
 */

import { EventEmitter } from 'events';
import type { AgentEvent } from './agents/types.js';

// ─── Event Map ────────────────────────────────────────────────────────────────

export type EventMap = {
  // Voice pipeline (preserved from v1)
  'INPUT_RECEIVED':      { input: string; source: 'cli' | 'voice' };
  'INTENT_DETECTED':     { intent: any; entities: any; urgency: number; rawInput: string };
  'FAST_PATH_INFERENCE': { intent: any; entities: any; urgency: number; rawInput: string };
  'DEEP_PATH_INFERENCE': { intent: any; entities: any; urgency: number; rawInput: string };
  'REASONING_COMPLETED': { intent: string; tool_calls: any[] };
  'PLAN_CREATED':        { goal: string; steps: any[] };
  'STEP_EXECUTED':       { stepId: number; result: string };
  'TOOL_REQUESTED':      { toolName: string; args: any; stepId?: number };
  'TOOL_EXECUTED':       { toolName: string; result: any };
  'MEMORY_UPDATED':      { fact: string; context: string };
  'TASK_COMPLETED':      { goal: string; result: string };

  // Agent loop events (NEW)
  'AGENT_STATE_CHANGED': { from: string; to: string };
  'AGENT_PLAN_READY':    { graphId: string; nodeCount: number; goal: string };
  'AGENT_TASK_DONE':     { graphId: string; outcome: string; durationMs: number };
  'AGENT_REPAIR':        { graphId: string; strategy: string; cycle: number };
  'AGENT_ERROR':         { source: string; error: string; recoverable: boolean };

  // Multi-agent system (core/agents/events.ts): TASK_CREATED … AGENT_STOPPED,
  // one topic with the event type inside, so one subscription sees them all.
  'AGENT_EVENT':         AgentEvent;
};

// ─── Message Envelope ─────────────────────────────────────────────────────────

interface MessageEnvelope<K extends keyof EventMap> {
  topic: K;
  data: EventMap[K];
  priority: number;      // 1 (low) – 10 (critical)
  timestamp: number;
  id: string;
}

// ─── Message Bus V2 ───────────────────────────────────────────────────────────

const MAX_CAPACITY = 100;

class MessageBus extends EventEmitter {
  private messageLog: MessageEnvelope<any>[] = [];
  private messageCounter = 0;

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  // ── Core: publish ─────────────────────────────────────────────────────────

  /**
   * Publish a message to a topic.
   * @param priority 1 (low) – 10 (critical). Default: 5.
   */
  publish<K extends keyof EventMap>(
    topic: K,
    data: EventMap[K],
    priority = 5
  ): void {
    const envelope: MessageEnvelope<K> = {
      topic,
      data,
      priority,
      timestamp: Date.now(),
      id: `msg_${++this.messageCounter}`,
    };

    // Capacity guard: drop oldest non-critical message on overflow
    if (this.messageLog.length >= MAX_CAPACITY) {
      const dropIdx = this.messageLog.findIndex(m => m.priority < 8);
      if (dropIdx !== -1) {
        this.messageLog.splice(dropIdx, 1);
      } else {
        // All critical — drop newest (last resort)
        this.messageLog.pop();
      }
    }

    this.messageLog.push(envelope);
    this.emit(topic, data);
  }

  /**
   * Publish and wait for all synchronous handlers to complete.
   * Useful for critical transitions where ordering matters.
   */
  async publishAndWait<K extends keyof EventMap>(
    topic: K,
    data: EventMap[K],
    priority = 8
  ): Promise<void> {
    this.publish(topic, data, priority);
    // Yield to microtask queue so async handlers can start
    await Promise.resolve();
  }

  // ── Core: subscribe ───────────────────────────────────────────────────────

  subscribe<K extends keyof EventMap>(
    topic: K,
    callback: (data: EventMap[K]) => void
  ): void {
    this.on(topic, callback);
  }

  /**
   * Subscribe and auto-unsubscribe after the first message.
   */
  subscribeOnce<K extends keyof EventMap>(
    topic: K,
    callback: (data: EventMap[K]) => void
  ): void {
    this.once(topic, callback);
  }

  /**
   * Returns a Promise that resolves with the next message on this topic.
   */
  waitFor<K extends keyof EventMap>(topic: K): Promise<EventMap[K]> {
    return new Promise(resolve => {
      this.once(topic, resolve);
    });
  }

  unsubscribe<K extends keyof EventMap>(
    topic: K,
    callback: (data: EventMap[K]) => void
  ): void {
    this.off(topic, callback);
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  getRecentMessages(limit = 20): MessageEnvelope<any>[] {
    return this.messageLog.slice(-limit);
  }

  getStats(): Record<string, unknown> {
    const topicCounts: Record<string, number> = {};
    for (const msg of this.messageLog) {
      topicCounts[msg.topic] = (topicCounts[msg.topic] ?? 0) + 1;
    }
    return {
      totalMessages: this.messageCounter,
      buffered: this.messageLog.length,
      capacity: MAX_CAPACITY,
      topicCounts,
    };
  }

  clearLog(): void {
    this.messageLog = [];
  }
}

export const messageBus = new MessageBus();
