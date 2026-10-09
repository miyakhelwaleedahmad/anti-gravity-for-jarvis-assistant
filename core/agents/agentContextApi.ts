/**
 * core/agents/agentContextApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What an agent behaviour can do: the only door to tools, the model, children,
 * the shared workspace and other agents. Every method enforces the limits and
 * permissions of the agent it belongs to (agentManager.ts implements it).
 */

import type { ToolResult } from '../toolRegistryV2.js';
import type { ILLMRequest, ILLMResponse } from '../../bridge/llmTypes.js';
import type { AgentLimits } from './config.js';
import type { AgentEventFilter } from './events.js';
import type {
  AgentEvent, AgentMessage, AgentRecord, AgentTaskRecord, ChildResult, Claim, Conflict,
  CreateChildAgentRequest, Finding, Source, WorkspaceArtifact,
} from './types.js';
import type { SharedWorkspace } from './workspace.js';
import type { SpawnDecision, SpawnDecisionInput } from './spawnPolicy.js';

/** A child request as an agent writes it; lineage is filled in by the context. */
export type SpawnRequest = Omit<CreateChildAgentRequest, 'parentAgentId' | 'parentTaskId' | 'rootTaskId'>;

export interface ChildHandle {
  agentId: string;
  taskId: string;
  role: string;
  name: string;
  /** Always resolves (never rejects) with the child's result, whatever its status. */
  result: Promise<ChildResult>;
}

export class SpawnRejectedError extends Error {
  constructor(readonly code: string, readonly reasons: string[]) {
    super(`Child agent not created (${code}): ${reasons.join('; ')}`);
    this.name = 'SpawnRejectedError';
  }
}

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(readonly kind: 'llmCalls' | 'toolCalls' | 'tokens', readonly taskId: string) {
    super(`The ${kind} budget is used up (task ${taskId}).`);
    this.name = 'BudgetExceededError';
  }
}

export interface AgentContext {
  readonly agent: Readonly<AgentRecord>;
  readonly task: Readonly<AgentTaskRecord>;
  readonly workspace: SharedWorkspace;
  readonly signal: AbortSignal;
  readonly limits: Readonly<AgentLimits>;
  /** The user's words that started the root task. */
  readonly rootRequest: string;
  /** Minimal context given by the parent. */
  readonly input: Record<string, unknown>;
  /** Results of the tasks this one waited for, by task id. */
  readonly dependencyResults: Readonly<Record<string, ChildResult>>;
  /** This agent's own notes for this task; not shared. */
  readonly memory: Map<string, unknown>;

  // ── Delegation ─────────────────────────────────────────────────────────────
  /** Should this work be split among children? Records the reasons. */
  decideSpawn(input: SpawnDecisionInput): SpawnDecision;
  /** Creates a child after the factory's checks; throws SpawnRejectedError. */
  spawn(request: SpawnRequest): Promise<ChildHandle>;
  /** Waits for children; this agent gives up its work slot while it waits. */
  wait(handles: ChildHandle[], mode?: 'all' | 'any'): Promise<ChildResult[]>;
  /** Waits for any promise without holding a work slot. */
  idleWait<T>(promise: Promise<T>): Promise<T>;
  /** A replacement for a failed child (counts against JARVIS_AGENT_MAX_RETRIES). */
  retry(handle: ChildHandle, changes?: Partial<SpawnRequest>): Promise<ChildHandle>;
  cancelChild(handle: ChildHandle, reason: string): void;
  children(): ChildHandle[];

  // ── Work ───────────────────────────────────────────────────────────────────
  /** A tool call through toolRegistryV2, after this agent's permission check. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** A model call through modelRouter, counted against the budget. */
  llm(request: Omit<ILLMRequest, 'signal'>): Promise<ILLMResponse>;
  /** Throws if the task was cancelled or timed out. */
  checkpoint(): void;

  // ── Sharing ────────────────────────────────────────────────────────────────
  addSource(input: Omit<Source, 'id' | 'retrievedAt' | 'addedBy'>): Source;
  addFinding(input: { text: string; sourceIds?: string[]; confidence: number; tags?: string[]; data?: Record<string, unknown> }): Finding;
  addClaim(input: { subject: string; attribute: string; value: string; sourceIds?: string[]; confidence: number }): { claim: Claim; conflict?: Conflict };
  addArtifact(input: { name: string; description?: string; parts: WorkspaceArtifact['parts'] }): WorkspaceArtifact;
  progress(note: string, percent?: number): void;
  /** To the parent, a child, or a sibling only. */
  sendMessage(to: string, kind: AgentMessage['kind'], text: string, data?: Record<string, unknown>): AgentMessage;
  inbox(): AgentMessage[];
  onMessage(handler: (m: AgentMessage) => void): () => void;
  /**
   * Events of this root task only. With `replay`, matching events that already
   * happened are delivered first, so an agent that starts late misses nothing.
   */
  onEvent(filter: Omit<AgentEventFilter, 'rootTaskId'>, handler: (e: AgentEvent) => void, opts?: { replay?: boolean }): () => void;
}
