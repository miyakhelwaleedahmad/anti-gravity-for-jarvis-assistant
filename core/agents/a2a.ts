/**
 * core/agents/a2a.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The A2A v1.0 layer of the multi-agent system: agent-to-agent communication
 * in the official protocol's data model and JSON-RPC binding
 * (a2aproject/A2A docs/specification.md §3, §5, §9; RECURSIVE_AGENT_RESEARCH.md
 * §3.3 for why it is native and not the SDK).
 *
 *  - A2AServer turns A2A operations into Agent Manager actions:
 *      SendMessage            new task for a specialist, or a follow-up message
 *                             to a running agent's task
 *      SendStreamingMessage   the same, with status / artifact updates as they
 *                             happen (first the Task, last a terminal status)
 *      GetTask, ListTasks, CancelTask, SubscribeToTask, Agent Cards
 *    Push notifications and extended cards are not offered (the errors say so).
 *  - InProcessA2AClient: JARVIS → specialist, and agent → agent, in one process.
 *  - A2AHttpServer (optional, off unless JARVIS_A2A_PORT is set): the same
 *    JSON-RPC over HTTP + SSE, on 127.0.0.1 only, with a bearer token and the
 *    A2A-Version header required, so other A2A clients can talk to JARVIS's
 *    agents. Every request becomes an ordinary task: it gets no permission
 *    the user's own voice command would not get.
 *
 * Who may message whom is the same rule as inside the manager: an agent may
 * reach its parent, its children and its siblings, nobody else.
 */

import * as http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentManager } from './agentManager.js';
import type {
  A2AAgentCard, A2AArtifact, A2AMessage, A2APart, A2AStreamResponse, A2ATask, A2ATaskState, AgentEvent,
  AgentTaskRecord, LifecycleState,
} from './types.js';
import { A2A_TERMINAL_STATES, JARVIS_A2A_EXTENSION, isTerminal } from './types.js';
import { JARVIS_AGENT_ID } from './agentManager.js';

// ─── Errors (spec §5.4) ──────────────────────────────────────────────────────

export const A2A_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  EXTENDED_CARD_NOT_CONFIGURED: -32007,
  VERSION_NOT_SUPPORTED: -32009,
} as const;

export class A2AError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'A2AError';
  }
}

export const A2A_PROTOCOL_VERSION = '1.0';

/** Who is calling: the user (JARVIS's own tools, or an HTTP client with the token) or an agent. */
export type A2ACaller = { kind: 'user'; via?: 'inproc' | 'http' } | { kind: 'agent'; agentId: string; taskId: string };

// ─── Lifecycle ↔ A2A ─────────────────────────────────────────────────────────

export function toA2AState(status: LifecycleState): A2ATaskState {
  switch (status) {
    case 'CREATED':
    case 'VALIDATING':
      return 'TASK_STATE_SUBMITTED';
    case 'STARTING':
    case 'RUNNING':
    case 'WAITING':
      return 'TASK_STATE_WORKING';
    case 'COMPLETED':
      return 'TASK_STATE_COMPLETED';
    case 'CANCELLED':
      return 'TASK_STATE_CANCELED';
    default:
      return 'TASK_STATE_FAILED';
  }
}

function agentMessage(text: string, task: { taskId: string; rootTaskId: string }): A2AMessage {
  return { messageId: randomUUID(), contextId: task.rootTaskId, taskId: task.taskId, role: 'ROLE_AGENT', parts: [{ text }] };
}

function iso(ms: number | undefined): string {
  return new Date(ms ?? Date.now()).toISOString();
}

/** Text and data of a message: text parts joined, data parts merged, URLs listed. */
export function readMessage(message: A2AMessage): { text: string; data: Record<string, unknown>; urls: string[] } {
  const texts: string[] = [];
  const data: Record<string, unknown> = {};
  const urls: string[] = [];
  for (const p of message.parts ?? []) {
    if (typeof p.text === 'string') texts.push(p.text);
    else if (p.data && typeof p.data === 'object' && !Array.isArray(p.data)) Object.assign(data, p.data);
    else if (p.data !== undefined) data['value'] = p.data;
    else if (typeof p.url === 'string') urls.push(p.url);
  }
  return { text: texts.join('\n').trim(), data, urls };
}

// ─── The protocol server ─────────────────────────────────────────────────────

const STREAMING_METHODS = new Set(['SendStreamingMessage', 'SubscribeToTask']);

export class A2AServer {
  constructor(private readonly manager: AgentManager) {}

  isStreaming(method: string): boolean {
    return STREAMING_METHODS.has(method);
  }

  // ── Agent Cards ────────────────────────────────────────────────────────────

  /** JARVIS's card: one skill per specialist. */
  jarvisCard(endpoint = `inproc://agents/${JARVIS_AGENT_ID}`): A2AAgentCard {
    const specialists = this.manager.registry.roleList().filter((r) => r.permanent);
    return {
      name: 'JARVIS',
      description: 'Main supervisor. Delegates work to its specialist agents.',
      supportedInterfaces: [{ url: endpoint, protocolBinding: endpoint.startsWith('http') ? 'JSONRPC' : 'INPROC', protocolVersion: A2A_PROTOCOL_VERSION }],
      provider: { organization: 'JARVIS (local)' },
      version: '1.0.0',
      capabilities: {
        streaming: true, pushNotifications: false,
        extensions: [{ uri: JARVIS_A2A_EXTENSION, description: 'Choose the specialist with metadata.jarvis.skill', required: false }],
      },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: specialists.map((s) => ({
        id: s.role, name: s.name, description: s.description, tags: [...s.capabilities],
        ...(s.examples?.length ? { examples: [...s.examples] } : {}),
      })),
    };
  }

  agentCard(agentId: string, endpoint?: string): A2AAgentCard {
    if (agentId === JARVIS_AGENT_ID) return this.jarvisCard(endpoint);
    const card = this.manager.registry.agentCard(agentId);
    if (!card) throw new A2AError(A2A_ERRORS.TASK_NOT_FOUND, `No agent ${agentId}.`);
    if (endpoint) card.supportedInterfaces = [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }];
    return card;
  }

  /** Cards of every agent that exists now (discovery). */
  listCards(): A2AAgentCard[] {
    return [this.jarvisCard(), ...this.manager.registry.all()
      .filter((a) => a.agentId !== JARVIS_AGENT_ID)
      .map((a) => this.manager.registry.agentCard(a.agentId))
      .filter((c): c is A2AAgentCard => !!c)];
  }

  // ── Tasks as A2A ───────────────────────────────────────────────────────────

  private findTask(taskId: string): AgentTaskRecord | undefined {
    const live = this.manager.tasks.get(taskId);
    if (live) return live;
    for (const r of this.manager.rootRuns()) {
      const t = this.manager.tasksOfRoot(r.rootTaskId).find((x) => x.taskId === taskId);
      if (t) return t;
    }
    return undefined;
  }

  toA2ATask(task: AgentTaskRecord, opts: { historyLength?: number; includeArtifacts?: boolean } = {}): A2ATask {
    const ws = this.manager.workspace(task.rootTaskId);
    const statusText = task.result?.summary || task.progress?.note || '';
    const out: A2ATask = {
      id: task.taskId,
      contextId: task.rootTaskId,
      status: {
        state: toA2AState(task.status),
        timestamp: iso(task.completedAt ?? task.lastActivityAt),
        ...(statusText ? { message: agentMessage(statusText, task) } : {}),
      },
      metadata: {
        jarvis: {
          rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, agentId: task.agentId,
          parentAgentId: task.parentAgentId, role: task.role, lifecycle: task.status, depth: task.depth,
          priority: task.priority, dependencies: task.dependencies, attempt: task.attempt,
          cancellation: task.cancellation, ...(task.status === 'TIMED_OUT' ? { timedOut: true } : {}),
          ...(task.result?.error ? { error: task.result.error } : {}),
        },
      },
    };
    if (opts.includeArtifacts !== false) {
      const artifacts: A2AArtifact[] = (ws?.artifacts() ?? [])
        .filter((a) => a.taskId === task.taskId)
        .map((a) => ({ artifactId: a.artifactId, name: a.name, ...(a.description ? { description: a.description } : {}), parts: a.parts }));
      if (task.result && isTerminal(task.status)) {
        const r = task.result;
        artifacts.push({
          artifactId: `result-${task.taskId}`,
          name: 'result',
          parts: [
            { text: r.summary },
            {
              data: {
                status: r.status, confidence: r.confidence, findings: r.findings, sources: r.sources,
                limitations: r.limitations, data: r.data ?? {}, truncated: !!r.truncated, usage: r.usage,
              },
              mediaType: 'application/json',
            },
          ],
        });
      }
      out.artifacts = artifacts;
    }
    if (opts.historyLength !== 0) {
      const history: A2AMessage[] = [{
        messageId: `request-${task.taskId}`, contextId: task.rootTaskId, taskId: task.taskId, role: 'ROLE_USER',
        parts: [{ text: task.description }, ...(task.input && Object.keys(task.input).length ? [{ data: task.input }] : [])],
      }];
      for (const m of ws?.messages ?? []) {
        if (m.taskId !== task.taskId && m.to !== task.agentId) continue;
        if (m.kind === 'assignment') continue; // the request above is the assignment
        history.push({
          messageId: m.id, contextId: task.rootTaskId, taskId: task.taskId,
          role: m.from === task.agentId ? 'ROLE_AGENT' : 'ROLE_USER',
          parts: [{ text: m.text }], metadata: { jarvis: { from: m.from, to: m.to, kind: m.kind } },
        });
      }
      out.history = opts.historyLength && opts.historyLength > 0 ? history.slice(-opts.historyLength) : history;
    }
    return out;
  }

  // ── Operations ─────────────────────────────────────────────────────────────

  /** A non-streaming operation on `agentId`'s endpoint. */
  async handle(agentId: string, method: string, params: Record<string, unknown>, caller: A2ACaller): Promise<unknown> {
    switch (method) {
      case 'SendMessage': return this.sendMessage(agentId, params, caller);
      case 'GetTask': return this.getTask(params);
      case 'ListTasks': return this.listTasks(params);
      case 'CancelTask': return this.cancelTask(params, caller);
      case 'GetExtendedAgentCard':
        throw new A2AError(A2A_ERRORS.EXTENDED_CARD_NOT_CONFIGURED, 'No extended Agent Card is configured.');
      case 'CreateTaskPushNotificationConfig':
      case 'GetTaskPushNotificationConfig':
      case 'ListTaskPushNotificationConfigs':
      case 'DeleteTaskPushNotificationConfig':
        throw new A2AError(A2A_ERRORS.PUSH_NOTIFICATION_NOT_SUPPORTED, 'Push notifications are not supported; use SubscribeToTask.');
      case 'SendStreamingMessage':
      case 'SubscribeToTask':
        throw new A2AError(A2A_ERRORS.INVALID_REQUEST, `${method} is a streaming method.`);
      default:
        throw new A2AError(A2A_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /** A streaming operation. The first item is the Task; the stream ends at a terminal state. */
  stream(agentId: string, method: string, params: Record<string, unknown>, caller: A2ACaller, signal?: AbortSignal): AsyncGenerator<A2AStreamResponse> {
    if (method === 'SendStreamingMessage') return this.sendStreaming(agentId, params, caller, signal);
    if (method === 'SubscribeToTask') return this.subscribeToTask(params, signal);
    throw new A2AError(A2A_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  private parseSend(params: Record<string, unknown>): { message: A2AMessage; returnImmediately: boolean; historyLength?: number } {
    const message = params['message'] as A2AMessage | undefined;
    if (!message || typeof message !== 'object' || !Array.isArray(message.parts) || !message.parts.length) {
      throw new A2AError(A2A_ERRORS.INVALID_PARAMS, 'params.message with at least one part is required.');
    }
    if (message.role && message.role !== 'ROLE_USER' && message.role !== 'ROLE_AGENT') {
      throw new A2AError(A2A_ERRORS.INVALID_PARAMS, `Unknown role ${String(message.role)}.`);
    }
    const config = (params['configuration'] ?? {}) as Record<string, unknown>;
    const historyLength = typeof config['historyLength'] === 'number' ? config['historyLength'] : undefined;
    return { message, returnImmediately: config['returnImmediately'] === true, ...(historyLength !== undefined ? { historyLength } : {}) };
  }

  /** Which specialist a message to `agentId` goes to (JARVIS's endpoint needs metadata.jarvis.skill). */
  private specialistFor(agentId: string, message: A2AMessage, params: Record<string, unknown>): string {
    if (agentId !== JARVIS_AGENT_ID) return agentId;
    const meta = ((message.metadata?.['jarvis'] ?? (params['metadata'] as Record<string, unknown> | undefined)?.['jarvis']) ?? {}) as Record<string, unknown>;
    const skill = typeof meta['skill'] === 'string' ? meta['skill'] : undefined;
    const skills = this.manager.registry.roleList().filter((r) => r.permanent).map((r) => r.role);
    if (!skill || !skills.includes(skill)) {
      throw new A2AError(A2A_ERRORS.INVALID_PARAMS, `Choose a specialist with metadata.jarvis.skill: ${skills.join(', ')}.`, { skills });
    }
    return skill;
  }

  private async sendMessage(agentId: string, params: Record<string, unknown>, caller: A2ACaller): Promise<{ task: A2ATask } | { message: A2AMessage }> {
    const { message, returnImmediately, historyLength } = this.parseSend(params);
    if (message.taskId) return { task: this.followUp(agentId, message, caller) };
    const { task, done } = await this.startTask(agentId, message, params, caller);
    if (returnImmediately) return { task: this.toA2ATask(task, { historyLength }) };
    await done;
    return { task: this.toA2ATask(this.findTask(task.taskId) ?? task, { historyLength }) };
  }

  /** A new root task for a specialist. Only the user (JARVIS, or an HTTP client with the token) starts one. */
  private async startTask(agentId: string, message: A2AMessage, params: Record<string, unknown>, caller: A2ACaller): Promise<{ task: AgentTaskRecord; done: Promise<unknown> }> {
    if (caller.kind === 'agent') {
      throw new A2AError(A2A_ERRORS.UNSUPPORTED_OPERATION, 'Agents create children through the Agent Factory, not by starting tasks on other agents.');
    }
    const role = this.specialistFor(agentId, message, params);
    const def = this.manager.registry.hasRole(role) ? this.manager.registry.role(role) : undefined;
    if (!def?.permanent) {
      throw new A2AError(A2A_ERRORS.UNSUPPORTED_OPERATION, `${role} is not a specialist; a new task can only go to a specialist (or a follow-up to a running task).`);
    }
    const { text, data, urls } = readMessage(message);
    if (!text) throw new A2AError(A2A_ERRORS.INVALID_PARAMS, 'The message needs a text part with the request.');
    const meta = (message.metadata?.['jarvis'] ?? {}) as Record<string, unknown>;
    const handle = await this.manager.startRootTask({
      request: text,
      source: meta['source'] === 'voice' ? 'voice' : 'cli',
      specialistRole: role,
      task: { description: text, input: { ...data, ...(urls.length ? { urls } : {}) } },
      ...(typeof meta['priority'] === 'number' ? { priority: meta['priority'] } : {}),
      ...(typeof meta['timeoutMs'] === 'number' ? { timeoutMs: meta['timeoutMs'] } : {}),
    }).catch((err: Error & { code?: string; reasons?: string[] }) => {
      throw new A2AError(A2A_ERRORS.UNSUPPORTED_OPERATION, err.message, { code: err.code, reasons: err.reasons });
    });
    const task = this.manager.tasks.get(handle.taskId)!;
    return { task, done: handle.result };
  }

  /** A message to a running task: delivered to that agent, under the messaging rule. */
  private followUp(agentId: string, message: A2AMessage, caller: A2ACaller): A2ATask {
    const task = this.findTask(message.taskId!);
    if (!task) throw new A2AError(A2A_ERRORS.TASK_NOT_FOUND, `Task not found: ${message.taskId}`);
    if (agentId !== JARVIS_AGENT_ID && task.agentId !== agentId) {
      throw new A2AError(A2A_ERRORS.INVALID_PARAMS, `Task ${task.taskId} does not belong to ${agentId}.`);
    }
    if (message.contextId && message.contextId !== task.rootTaskId) {
      throw new A2AError(A2A_ERRORS.INVALID_PARAMS, 'contextId does not match the task.');
    }
    if (isTerminal(task.status)) {
      throw new A2AError(A2A_ERRORS.UNSUPPORTED_OPERATION, `Task ${task.taskId} has ended (${task.status}).`);
    }
    let from = 'user';
    if (caller.kind === 'agent') {
      const senderTask = this.manager.tasks.get(caller.taskId);
      if (!senderTask || senderTask.agentId !== caller.agentId || senderTask.rootTaskId !== task.rootTaskId
        || !this.manager.messageTargets(senderTask).has(task.agentId)) {
        throw new A2AError(A2A_ERRORS.UNSUPPORTED_OPERATION, `${caller.agentId} may message only its parent, children and siblings.`);
      }
      from = caller.agentId;
    }
    const { text, data } = readMessage(message);
    this.manager.deliver({
      id: message.messageId || randomUUID(), from, to: task.agentId, rootTaskId: task.rootTaskId, taskId: task.taskId,
      kind: 'request', text, ...(Object.keys(data).length ? { data } : {}), at: Date.now(),
    });
    return this.toA2ATask(task);
  }

  private getTask(params: Record<string, unknown>): A2ATask {
    const id = String(params['id'] ?? '');
    const task = id ? this.findTask(id) : undefined;
    if (!task) throw new A2AError(A2A_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`);
    const historyLength = typeof params['historyLength'] === 'number' ? params['historyLength'] : undefined;
    return this.toA2ATask(task, { ...(historyLength !== undefined ? { historyLength } : {}) });
  }

  private listTasks(params: Record<string, unknown>): { tasks: A2ATask[]; nextPageToken: string; pageSize: number; totalSize: number } {
    const contextId = typeof params['contextId'] === 'string' ? params['contextId'] : undefined;
    const status = typeof params['status'] === 'string' && params['status'] !== 'TASK_STATE_UNSPECIFIED' ? params['status'] : undefined;
    const pageSize = Math.max(1, Math.min(100, Number(params['pageSize'] ?? 50) || 50));
    const offset = params['pageToken'] ? Number(Buffer.from(String(params['pageToken']), 'base64url').toString()) || 0 : 0;
    const includeArtifacts = params['includeArtifacts'] === true;
    const historyLength = typeof params['historyLength'] === 'number' ? params['historyLength'] : 0;
    const all = this.manager.rootRuns()
      .flatMap((r) => this.manager.tasksOfRoot(r.rootTaskId))
      .filter((t) => (!contextId || t.rootTaskId === contextId) && (!status || toA2AState(t.status) === status))
      .sort((a, b) => (b.completedAt ?? b.lastActivityAt) - (a.completedAt ?? a.lastActivityAt));
    const page = all.slice(offset, offset + pageSize);
    const next = offset + pageSize < all.length ? Buffer.from(String(offset + pageSize)).toString('base64url') : '';
    return {
      tasks: page.map((t) => this.toA2ATask(t, { includeArtifacts, historyLength })),
      nextPageToken: next, pageSize, totalSize: all.length,
    };
  }

  private async cancelTask(params: Record<string, unknown>, caller: A2ACaller): Promise<A2ATask> {
    const id = String(params['id'] ?? '');
    const task = id ? this.findTask(id) : undefined;
    if (!task) throw new A2AError(A2A_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`);
    if (isTerminal(task.status)) throw new A2AError(A2A_ERRORS.TASK_NOT_CANCELABLE, `Task not cancelable: ${id} is ${task.status}`);
    if (caller.kind === 'agent') {
      // An agent may cancel only tasks below its own.
      let cur: AgentTaskRecord | undefined = task;
      let below = false;
      while (cur?.parentTaskId) {
        if (cur.parentTaskId === caller.taskId) { below = true; break; }
        cur = this.manager.tasks.get(cur.parentTaskId);
      }
      if (!below) throw new A2AError(A2A_ERRORS.TASK_NOT_CANCELABLE, `${caller.agentId} may cancel only its own descendants.`);
      this.manager.tasks.cancel(task.taskId, `cancelled by ${caller.agentId}`, 'parent');
    } else if (task.parentTaskId && this.manager.tasks.get(task.parentTaskId)?.agentId === JARVIS_AGENT_ID) {
      // The specialist's task stands for the whole request: stop the root.
      this.manager.cancelRoot(task.rootTaskId, 'cancelled through A2A');
    } else {
      this.manager.cancelTask(task.taskId, 'cancelled through A2A');
    }
    // Wait briefly for the work to stop, then report the state.
    const until = Date.now() + 2_000;
    while (!isTerminal((this.findTask(id) ?? task).status) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    return this.toA2ATask(this.findTask(id) ?? task);
  }

  // ── Streams ────────────────────────────────────────────────────────────────

  private async *sendStreaming(agentId: string, params: Record<string, unknown>, caller: A2ACaller, signal?: AbortSignal): AsyncGenerator<A2AStreamResponse> {
    const { message } = this.parseSend(params);
    if (message.taskId) {
      yield { task: this.followUp(agentId, message, caller) };
      yield* this.follow(message.taskId, signal, false);
      return;
    }
    const { task } = await this.startTask(agentId, message, params, caller);
    yield* this.follow(task.taskId, signal, true);
  }

  private async *subscribeToTask(params: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<A2AStreamResponse> {
    const id = String(params['id'] ?? '');
    const task = id ? this.findTask(id) : undefined;
    if (!task) throw new A2AError(A2A_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`);
    if (isTerminal(task.status)) throw new A2AError(A2A_ERRORS.UNSUPPORTED_OPERATION, `Task ${id} has ended (${task.status}); use GetTask.`);
    yield* this.follow(id, signal, true);
  }

  /**
   * The updates of one task: its own status changes and progress, progress of
   * the agents below it, findings and artifacts as they appear, and a final
   * status with the result. Recorded events are replayed first, so nothing
   * that happened before the subscription is missed.
   */
  private async *follow(taskId: string, signal: AbortSignal | undefined, sendTaskFirst: boolean): AsyncGenerator<A2AStreamResponse> {
    const start = this.findTask(taskId);
    if (!start) throw new A2AError(A2A_ERRORS.TASK_NOT_FOUND, `Task not found: ${taskId}`);
    const rootTaskId = start.rootTaskId;
    const contextId = rootTaskId;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.manager.events.subscribe({ rootTaskId }, (e) => { queue.push(e); wake?.(); });
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    const seen = new Set<number>();
    const replay = [...(this.manager.workspace(rootTaskId)?.events ?? [])];
    const below = (e: AgentEvent): boolean => {
      if (!e.taskId) return false;
      if (e.taskId === taskId) return true;
      let cur = this.manager.tasks.get(e.taskId);
      while (cur?.parentTaskId) {
        if (cur.parentTaskId === taskId) return true;
        cur = this.manager.tasks.get(cur.parentTaskId);
      }
      return false;
    };
    try {
      if (sendTaskFirst) yield { task: this.toA2ATask(start, { includeArtifacts: false, historyLength: 0 }) };
      const pending = [...replay];
      while (true) {
        pending.push(...queue.splice(0));
        pending.sort((a, b) => a.seq - b.seq);
        while (pending.length) {
          const e = pending.shift()!;
          if (seen.has(e.seq)) continue;
          seen.add(e.seq);
          if (!below(e)) continue;
          const item = this.toStreamItem(e, taskId, contextId);
          if (item) yield item;
          if (e.taskId === taskId && e.type === 'AGENT_STATE_CHANGED' && isTerminal(e.data['to'] as LifecycleState)) {
            const final = this.findTask(taskId);
            if (final) {
              const t = this.toA2ATask(final, { historyLength: 0 });
              for (const a of t.artifacts ?? []) if (a.artifactId.startsWith('result-')) yield { artifactUpdate: { taskId, contextId, artifact: a, lastChunk: true } };
              yield { statusUpdate: { taskId, contextId, status: t.status, metadata: t.metadata } };
            }
            return;
          }
        }
        const now = this.findTask(taskId);
        if (now && isTerminal(now.status)) {
          const t = this.toA2ATask(now, { historyLength: 0 });
          yield { statusUpdate: { taskId, contextId, status: t.status, metadata: t.metadata } };
          return;
        }
        if (signal?.aborted) return;
        await new Promise<void>((r) => { wake = r; });
        wake = undefined;
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private toStreamItem(e: AgentEvent, taskId: string, contextId: string): A2AStreamResponse | undefined {
    const own = e.taskId === taskId;
    const jarvis = { jarvis: { event: e.type, seq: e.seq, fromTaskId: e.taskId, fromAgentId: e.agentId } };
    switch (e.type) {
      case 'AGENT_STATE_CHANGED': {
        if (!own || isTerminal(e.data['to'] as LifecycleState)) return undefined;
        const state = toA2AState(e.data['to'] as LifecycleState);
        if (state === toA2AState(e.data['from'] as LifecycleState)) return undefined;
        return { statusUpdate: { taskId, contextId, status: { state, timestamp: iso(e.at) }, metadata: jarvis } };
      }
      case 'PROGRESS_UPDATE':
      case 'AGENT_CREATED':
      case 'TASK_FAILED':
      case 'TASK_COMPLETED':
      case 'TASK_CANCELLED':
      case 'TASK_TIMED_OUT': {
        if (own && e.type !== 'PROGRESS_UPDATE') return undefined;
        const who = e.agentId ?? 'agent';
        const text = e.type === 'PROGRESS_UPDATE' ? `${who}: ${String(e.data['note'] ?? '')}`
          : e.type === 'AGENT_CREATED' ? `${who} created (${String(e.data['reason'] ?? '')})`
          : `${who}: ${e.type.replace('TASK_', '').toLowerCase()}`;
        return {
          statusUpdate: {
            taskId, contextId,
            status: { state: 'TASK_STATE_WORKING', timestamp: iso(e.at), message: agentMessage(text, { taskId, rootTaskId: contextId }) },
            metadata: jarvis,
          },
        };
      }
      case 'FINDING_DISCOVERED':
        return {
          artifactUpdate: {
            taskId, contextId, append: true, lastChunk: false, metadata: jarvis,
            artifact: { artifactId: `findings-${taskId}`, name: 'findings', parts: [{ data: { ...e.data, agentId: e.agentId }, mediaType: 'application/json' }] },
          },
        };
      case 'ARTIFACT_CREATED': {
        const art = this.manager.workspace(contextId)?.artifacts().find((a) => a.artifactId === e.data['artifactId']);
        if (!art) return undefined;
        return { artifactUpdate: { taskId, contextId, artifact: { artifactId: art.artifactId, name: art.name, parts: art.parts }, metadata: jarvis } };
      }
      default:
        return undefined;
    }
  }
}

// ─── In-process client ───────────────────────────────────────────────────────

/** An A2A client for JARVIS (as the user) or for an agent, in the same process. */
export class InProcessA2AClient {
  constructor(private readonly server: A2AServer, private readonly caller: A2ACaller = { kind: 'user', via: 'inproc' }) {}

  card(agentId: string): A2AAgentCard {
    return this.server.agentCard(agentId);
  }

  sendMessage(agentId: string, params: { message: A2AMessage; configuration?: { returnImmediately?: boolean; historyLength?: number }; metadata?: Record<string, unknown> }): Promise<{ task: A2ATask } | { message: A2AMessage }> {
    return this.server.handle(agentId, 'SendMessage', params as Record<string, unknown>, this.caller) as Promise<{ task: A2ATask } | { message: A2AMessage }>;
  }

  sendMessageStream(agentId: string, params: { message: A2AMessage; metadata?: Record<string, unknown> }, signal?: AbortSignal): AsyncGenerator<A2AStreamResponse> {
    return this.server.stream(agentId, 'SendStreamingMessage', params as Record<string, unknown>, this.caller, signal);
  }

  getTask(id: string, historyLength?: number): Promise<A2ATask> {
    return this.server.handle(JARVIS_AGENT_ID, 'GetTask', { id, ...(historyLength !== undefined ? { historyLength } : {}) }, this.caller) as Promise<A2ATask>;
  }

  listTasks(params: { contextId?: string; status?: A2ATaskState; pageSize?: number; pageToken?: string; includeArtifacts?: boolean } = {}): Promise<{ tasks: A2ATask[]; nextPageToken: string; pageSize: number; totalSize: number }> {
    return this.server.handle(JARVIS_AGENT_ID, 'ListTasks', params, this.caller) as Promise<{ tasks: A2ATask[]; nextPageToken: string; pageSize: number; totalSize: number }>;
  }

  cancelTask(id: string): Promise<A2ATask> {
    return this.server.handle(JARVIS_AGENT_ID, 'CancelTask', { id }, this.caller) as Promise<A2ATask>;
  }

  subscribe(id: string, signal?: AbortSignal): AsyncGenerator<A2AStreamResponse> {
    return this.server.stream(JARVIS_AGENT_ID, 'SubscribeToTask', { id }, this.caller, signal);
  }
}

/** A user message with text and optional data. */
export function userMessage(text: string, data?: Record<string, unknown>, metadata?: Record<string, unknown>): A2AMessage {
  const parts: A2APart[] = [{ text }];
  if (data) parts.push({ data, mediaType: 'application/json' });
  return { messageId: randomUUID(), role: 'ROLE_USER', parts, ...(metadata ? { metadata } : {}) };
}

/** Whether a stream item ends the stream (a terminal status update). */
export function isFinalStreamItem(item: A2AStreamResponse): boolean {
  return 'statusUpdate' in item && A2A_TERMINAL_STATES.has(item.statusUpdate.status.state);
}

// ─── Optional HTTP binding (JSON-RPC + SSE, localhost only) ──────────────────

const MAX_BODY = 1_000_000;

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface A2AHttpOptions {
  port: number;
  token: string;
  host?: '127.0.0.1';
}

/**
 * JSON-RPC over HTTP for A2A clients outside JARVIS. Routes:
 *   GET  /.well-known/agent-card.json               JARVIS's card
 *   GET  /a2a/agents/<id>/.well-known/agent-card.json
 *   POST /a2a/agents/<id>                           JSON-RPC (SSE for streams)
 * Every route needs `Authorization: Bearer <JARVIS_A2A_TOKEN>`; JSON-RPC also
 * needs `A2A-Version: 1.0` (spec §3.6.2: no header means 0.3, not supported).
 * Requests from browsers (an Origin header) and for other Host names are
 * refused, against DNS rebinding.
 */
export class A2AHttpServer {
  private server: http.Server | undefined;
  private port = 0;

  constructor(private readonly a2a: A2AServer, private readonly opts: A2AHttpOptions) {
    if (!opts.token || opts.token.length < 16) throw new Error('JARVIS_A2A_TOKEN must be at least 16 characters.');
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => { this.route(req, res).catch((err) => this.fail(res, null, err)); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
    return this.port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = undefined;
    await new Promise<void>((r) => s.close(() => r()));
    s.closeAllConnections?.();
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private fail(res: http.ServerResponse, id: unknown, err: unknown): void {
    const e = err instanceof A2AError ? err : new A2AError(A2A_ERRORS.INTERNAL_ERROR, 'Internal error');
    if (!(err instanceof A2AError)) console.warn(`[A2A] ${(err as Error)?.message ?? String(err)}`);
    this.send(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = String(req.headers.host ?? '');
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) { this.send(res, 421, { error: 'wrong host' }); return; }
    if (req.headers.origin) { this.send(res, 403, { error: 'browser requests are not accepted' }); return; }
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), this.opts.token)) { this.send(res, 401, { error: 'missing or wrong token' }); return; }

    const url = new URL(req.url ?? '/', this.url);
    const cardMatch = url.pathname.match(/^\/a2a\/agents\/([A-Za-z0-9_.-]+)\/\.well-known\/agent-card\.json$/);
    if (req.method === 'GET' && (url.pathname === '/.well-known/agent-card.json' || cardMatch)) {
      const agentId = cardMatch ? cardMatch[1] : JARVIS_AGENT_ID;
      try {
        this.send(res, 200, this.a2a.agentCard(agentId, `${this.url}/a2a/agents/${agentId}`));
      } catch {
        this.send(res, 404, { error: 'no such agent' });
      }
      return;
    }
    const rpcMatch = url.pathname.match(/^\/a2a\/agents\/([A-Za-z0-9_.-]+)$/);
    if (req.method !== 'POST' || !rpcMatch) { this.send(res, 404, { error: 'not found' }); return; }
    const agentId = rpcMatch[1];

    const version = String(req.headers['a2a-version'] ?? url.searchParams.get('A2A-Version') ?? '').trim();
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) { this.send(res, 413, { error: 'request too large' }); req.destroy(); return; }
    }
    let rpc: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
    try {
      rpc = JSON.parse(body);
    } catch {
      this.fail(res, null, new A2AError(A2A_ERRORS.PARSE_ERROR, 'Parse error'));
      return;
    }
    if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      this.fail(res, (rpc as { id?: unknown })?.id, new A2AError(A2A_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC request'));
      return;
    }
    if (version.split('.').slice(0, 2).join('.') !== A2A_PROTOCOL_VERSION) {
      this.fail(res, rpc.id, new A2AError(A2A_ERRORS.VERSION_NOT_SUPPORTED, `A2A-Version "${version || '(none, meaning 0.3)'}" is not supported; send A2A-Version: 1.0.`));
      return;
    }
    const params = (rpc.params && typeof rpc.params === 'object' ? rpc.params : {}) as Record<string, unknown>;
    const caller: A2ACaller = { kind: 'user', via: 'http' };

    if (this.a2a.isStreaming(rpc.method)) {
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      let started = false;
      try {
        for await (const item of this.a2a.stream(agentId, rpc.method, params, caller, abort.signal)) {
          if (!started) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            started = true;
          }
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result: item })}\n\n`);
        }
        if (!started) res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end();
      } catch (err) {
        if (!started) { this.fail(res, rpc.id, err); return; }
        const e = err instanceof A2AError ? err : new A2AError(A2A_ERRORS.INTERNAL_ERROR, 'Internal error');
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: e.code, message: e.message } })}\n\n`);
        res.end();
      }
      return;
    }
    try {
      const result = await this.a2a.handle(agentId, rpc.method, params, caller);
      this.send(res, 200, { jsonrpc: '2.0', id: rpc.id ?? null, result });
    } catch (err) {
      this.fail(res, rpc.id, err);
    }
  }
}
