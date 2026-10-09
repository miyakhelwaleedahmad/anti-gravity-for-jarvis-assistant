/**
 * core/agents/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Types for the hierarchical multi-agent system.
 *
 * Two groups:
 *  - A2A v1.0 wire types (Task, Message, Part, Artifact, Agent Card, update
 *    events), in the JSON shape the specification uses: camelCase fields and
 *    ProtoJSON enum names such as "TASK_STATE_WORKING". Source:
 *    a2aproject/A2A docs/specification.md (v1.0.0). See
 *    RECURSIVE_AGENT_RESEARCH.md §3.
 *  - JARVIS's own types for what A2A does not define: agent lineage, the
 *    child lifecycle, limits, permission scopes, budgets, the shared
 *    workspace and events. They travel in A2A `metadata` under
 *    JARVIS_A2A_EXTENSION.
 *
 * Field names are camelCase like the rest of the codebase; the request's
 * snake_case names map one to one (parent_agent_id → parentAgentId).
 */

import type { RiskTier } from '../toolRegistryV2.js';

// ─── A2A v1.0 wire types ─────────────────────────────────────────────────────

export type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED';

export const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED',
]);

export type A2ARole = 'ROLE_USER' | 'ROLE_AGENT';

/** Exactly one of text, raw (base64), url or data is set. */
export interface A2APart {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: A2ARole;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  /** ISO 8601. */
  timestamp?: string;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  metadata?: Record<string, unknown>;
}

export interface A2ATaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/** One item of a SendStreamingMessage / SubscribeToTask stream. */
export type A2AStreamResponse =
  | { task: A2ATask }
  | { message: A2AMessage }
  | { statusUpdate: A2ATaskStatusUpdateEvent }
  | { artifactUpdate: A2ATaskArtifactUpdateEvent };

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentInterface {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
  tenant?: string;
}

export interface A2AAgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: A2AAgentExtension[];
  extendedAgentCard?: boolean;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  supportedInterfaces: A2AAgentInterface[];
  provider?: { organization: string; url?: string };
  version: string;
  capabilities: A2AAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  metadata?: Record<string, unknown>;
}

/** Extension URI under which JARVIS puts lineage, scope and budget in A2A metadata. */
export const JARVIS_A2A_EXTENSION = 'urn:jarvis:a2a:hierarchy:v1';

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * The child lifecycle: CREATED → VALIDATING → STARTING → RUNNING ⇄ WAITING →
 * COMPLETED, or FAILED / CANCELLED / TIMED_OUT. A task's status uses the same
 * values; a temporary agent's status is its task's status.
 */
export type LifecycleState =
  | 'CREATED'
  | 'VALIDATING'
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

export const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set([
  'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT',
]);

export function isTerminal(state: LifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

/** A permanent agent (JARVIS, the seven specialists) is READY between tasks. */
export type AgentStatus = LifecycleState | 'READY';

// ─── Permissions and budgets ─────────────────────────────────────────────────

/**
 * What an agent may do. `tools` entries are a tool name (all its actions) or
 * `tool:action` (one action). A child's scope is always a subset of its
 * parent's: see permissions.ts.
 */
export interface PermissionScope {
  tools: string[];
  /** Highest risk (0–4) of a single call the agent may make. */
  maxRisk: RiskTier;
  /** Whether the agent may create children. False at the depth limit. */
  canSpawn: boolean;
}

export interface ResourceBudget {
  llmCalls: number;
  toolCalls: number;
  /** Tokens reported by the model; calls without usage data count 0. */
  tokens: number;
}

export interface ResourceUsage {
  llmCalls: number;
  toolCalls: number;
  tokens: number;
}

// ─── Requests and results ────────────────────────────────────────────────────

export interface ChildTaskSpec {
  /** What the child must do, in one or two sentences. */
  description: string;
  /** Task type the role declares in supportedTaskTypes (optional). */
  taskType?: string;
  /** Structured input: the minimal context the child needs. */
  input?: Record<string, unknown>;
  /** What the parent expects back. */
  expectedOutput?: string;
}

/** CREATE_CHILD_AGENT: validated by the Agent Factory before anything runs. */
export interface CreateChildAgentRequest {
  parentAgentId: string;
  parentTaskId: string;
  rootTaskId: string;
  childRole: string;
  childTask: ChildTaskSpec;
  requiredCapabilities?: string[];
  /** Narrows the child's tools further; must be within the parent's scope. */
  allowedTools?: string[];
  /** 1 (low) – 10 (high). Default 5. */
  priority?: number;
  /** Absolute deadline (epoch ms). Capped at the parent's deadline. */
  deadline?: number;
  resourceBudget?: Partial<ResourceBudget>;
  /** Explicit scope; must be a subset of the parent's. */
  permissionScope?: Partial<PermissionScope>;
  /** Display name, e.g. "Project B Deep Analysis Worker". */
  name?: string;
  /** Tasks (siblings) whose results this child needs before it starts. */
  dependencies?: string[];
  /** Why the parent creates this child (shown when asked "why"). */
  reason?: string;
  /** Set by retries and replacements. */
  retryOf?: string;
}

export interface Source {
  id: string;
  url?: string;
  title: string;
  /** e.g. "github", "web", "docs", "local". */
  kind: string;
  /** 0–1: how much the source is trusted (official docs high, forum low). */
  quality: number;
  retrievedAt: number;
  addedBy: string;
  metadata?: Record<string, unknown>;
}

export interface Finding {
  id: string;
  text: string;
  sourceIds: string[];
  /** 0–1. */
  confidence: number;
  addedBy: string;
  taskId: string;
  addedAt: number;
  /** Agents that reported the same finding independently. */
  corroboratedBy: string[];
  tags?: string[];
  data?: Record<string, unknown>;
  /** Set when the finding was promoted to the parent or to long-term memory. */
  promoted?: 'parent' | 'memory';
}

/** A checkable statement: subject + attribute = value, with evidence. */
export interface Claim {
  id: string;
  subject: string;
  attribute: string;
  value: string;
  sourceIds: string[];
  confidence: number;
  addedBy: string;
  addedAt: number;
}

export interface Conflict {
  id: string;
  subject: string;
  attribute: string;
  claimIds: string[];
  status: 'open' | 'resolved' | 'unresolved';
  detectedAt: number;
  resolution?: { value: string; reason: string; confidence: number; by: string; at: number };
}

export interface WorkspaceArtifact {
  artifactId: string;
  name: string;
  description?: string;
  parts: A2APart[];
  producedBy: string;
  taskId: string;
  createdAt: number;
  /** 1 for the first artifact of this name from this task; each new one adds 1. */
  version?: number;
  /** The version this one replaces. Earlier versions stay readable. */
  previousArtifactId?: string;
}

/** What every child returns to its parent. Never thrown, always returned. */
export interface ChildResult {
  taskId: string;
  agentId: string;
  role: string;
  status: LifecycleState;
  summary: string;
  findings: Finding[];
  sources: Source[];
  artifacts: WorkspaceArtifact[];
  /** 0–1. */
  confidence: number;
  limitations: string[];
  /** Structured output for the parent (e.g. a list of repositories). */
  data?: Record<string, unknown>;
  /** True when a budget, timeout or cancellation cut the work short. */
  truncated?: boolean;
  error?: { code: string; message: string };
  usage: ResourceUsage;
  durationMs: number;
}

/** What an agent behaviour returns; the manager adds ids, status and usage. */
export interface AgentOutcome {
  summary: string;
  findings?: Finding[];
  sources?: Source[];
  artifacts?: WorkspaceArtifact[];
  confidence: number;
  limitations?: string[];
  data?: Record<string, unknown>;
}

// ─── Task records ────────────────────────────────────────────────────────────

export interface CancellationState {
  requested: boolean;
  reason?: string;
  /** Who asked: the user, a parent, the deadline, the idle watchdog. */
  by?: 'user' | 'parent' | 'timeout' | 'idle' | 'parent_failed' | 'dependency_failed' | 'shutdown';
  at?: number;
}

export interface AgentTaskRecord {
  taskId: string;
  parentTaskId?: string;
  rootTaskId: string;
  agentId: string;
  parentAgentId?: string;
  role: string;
  description: string;
  input?: Record<string, unknown>;
  status: LifecycleState;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  priority: number;
  dependencies: string[];
  result?: ChildResult;
  confidence?: number;
  errors: string[];
  cancellation: CancellationState;
  deadline: number;
  /** Depth of the task in the task tree (root task = 0). */
  depth: number;
  attempt: number;
  retryOf?: string;
  reason?: string;
  progress?: { percent?: number; note: string; at: number };
  lastActivityAt: number;
}

export interface AgentRecord {
  agentId: string;
  role: string;
  name: string;
  description: string;
  capabilities: string[];
  /** Same as permissions.tools; kept for the registry fields the spec lists. */
  tools: string[];
  status: AgentStatus;
  version: string;
  /** inproc://agents/<id>, or the A2A HTTP URL when the endpoint is on. */
  endpoint: string;
  permissions: PermissionScope;
  parentAgentId?: string;
  supportedTaskTypes: string[];
  depth: number;
  permanent: boolean;
  /** Temporary agents belong to one root task. */
  rootTaskId?: string;
  taskIds: string[];
  createdAt: number;
  endedAt?: number;
  budget: ResourceBudget;
  usage: ResourceUsage;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type AgentEventType =
  | 'TASK_CREATED'
  | 'TASK_ASSIGNED'
  | 'TASK_STARTED'
  | 'PROGRESS_UPDATE'
  | 'FINDING_DISCOVERED'
  | 'ARTIFACT_CREATED'
  | 'RESULT_AVAILABLE'
  | 'RESULT_UPDATED'
  | 'TASK_BLOCKED'
  | 'TASK_FAILED'
  | 'TASK_COMPLETED'
  | 'TASK_CANCELLED'
  | 'TASK_TIMED_OUT'
  | 'AGENT_CREATED'
  | 'AGENT_STOPPED'
  | 'AGENT_STATE_CHANGED'
  | 'SPAWN_DECISION'
  | 'SPAWN_REJECTED'
  | 'CONFLICT_DETECTED'
  | 'CONFLICT_RESOLVED'
  | 'AGENT_MESSAGE'
  | 'PERMISSION_DENIED';

export interface AgentEvent {
  id: string;
  /** Per-root sequence number, starting at 1. */
  seq: number;
  type: AgentEventType;
  at: number;
  rootTaskId: string;
  taskId?: string;
  agentId?: string;
  parentAgentId?: string;
  data: Record<string, unknown>;
}

/**
 * Message kinds. The first ten are the original ones; the last five cover the
 * requested types (docs/agents/SEVEN_AGENT_DESIGN.md §4): task assignment and
 * acceptance (sent by the manager), delegation request, failure
 * notification and verification result. `error` stays for older senders.
 */
export type AgentMessageKind =
  | 'progress' | 'partial_result' | 'finding' | 'artifact' | 'warning' | 'error' | 'completion' | 'cancellation' | 'request' | 'info'
  | 'assignment' | 'acceptance' | 'delegation_request' | 'failure' | 'verification';

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  rootTaskId: string;
  taskId?: string;
  /** The sender's parent task, when it has one. */
  parentTaskId?: string;
  /** The message this one answers (request → info, delegation_request → reply). */
  correlationId?: string;
  kind: AgentMessageKind;
  text: string;
  data?: Record<string, unknown>;
  /** For replies and failures. */
  status?: 'ok' | 'failed' | 'rejected';
  error?: { code: string; message: string };
  at: number;
}

/** Optional fields of a message an agent sends. Messages never carry permissions. */
export interface MessageOptions {
  correlationId?: string;
  status?: AgentMessage['status'];
  error?: AgentMessage['error'];
}
