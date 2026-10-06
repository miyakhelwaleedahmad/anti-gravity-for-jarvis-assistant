/**
 * core/taskGraphEngine.ts  (v2 — true parallel DAG)
 * ─────────────────────────────────────────────────────────────────────────────
 * DAG-based task planning and parallel execution engine.
 *
 * KEY UPGRADE: fromToolCalls now builds a PARALLEL graph by default.
 * All tool calls in a single LLM response are assumed to be INDEPENDENT and
 * run concurrently. Only if a tool's args contain a `_depends_on` array field
 * (list of sibling tool-call IDs) will dependencies be wired explicitly.
 *
 * This means:
 *   - "search AND save memory" → 2 nodes, no dependencies → run in parallel
 *   - "search THEN write file" → 2 nodes, file_write._depends_on = [search_id]
 */

import { EventEmitter } from 'events';
import { isPermissionDenial } from '../control/permissionDenial.js';
import { runInTaskNode } from './taskContext.js';
import type { ApprovalDecision } from '../security/approvalRequest.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'retry' | 'skipped';

export interface TaskNode {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  dependencies: string[];
  status: TaskStatus;
  retryCount: number;
  maxRetries: number;
  result?: string;
  error?: string;
  priority: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  description: string;
  /** Phase 5: error classification for smarter retry decisions */
  errorType?: 'timeout' | 'abort' | 'permission' | 'transient' | 'fatal';
  /** Approval decisions made while this node ran (security/approvalGate.ts). */
  approvals?: ApprovalDecision[];
}

export interface TaskGraph {
  id: string;
  goal: string;
  nodes: Map<string, TaskNode>;
  status: 'building' | 'running' | 'completed' | 'failed' | 'interrupted';
  createdAt: number;
  completedAt?: number;
}

export type TaskExecutorFn = (
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal
) => Promise<string>;

/**
 * Phase 5: Execution summary for post-mortem analysis and planner loop guard.
 */
export interface GraphExecutionSummary {
  graphId: string;
  goal: string;
  status: TaskGraph['status'];
  durationMs: number;
  totalNodes: number;
  succeededNodes: number;
  failedNodes: number;
  skippedNodes: number;
  retryTotal: number;
  /** Failed node details for orchestrator re-planning decisions */
  failures: Array<{ nodeId: string; tool: string; error: string; errorType?: string; retries: number }>;
}

// ─── Task Graph Builder ───────────────────────────────────────────────────────

export class TaskGraphBuilder {
  private nodes: TaskNode[] = [];
  private graphId: string;
  private goal: string;

  constructor(goal: string) {
    this.goal = goal;
    this.graphId = `graph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  addTask(params: {
    tool: string;
    args: Record<string, unknown>;
    description: string;
    dependencies?: string[];
    priority?: number;
    maxRetries?: number;
  }): string {
    const id = `task_${this.nodes.length + 1}_${params.tool.replace(/[^a-z0-9]/gi, '_')}`;
    this.nodes.push({
      id,
      tool: params.tool,
      args: params.args,
      description: params.description,
      dependencies: params.dependencies ?? [],
      status: 'pending',
      retryCount: 0,
      maxRetries: params.maxRetries ?? 2,
      priority: params.priority ?? 5,
      createdAt: Date.now(),
    });
    return id;
  }

  build(): TaskGraph {
    const nodeMap = new Map<string, TaskNode>();
    for (const node of this.nodes) {
      nodeMap.set(node.id, node);
    }

    // Validate: all dependency IDs exist
    for (const node of this.nodes) {
      for (const depId of node.dependencies) {
        if (!nodeMap.has(depId)) {
          throw new Error(`[TaskGraph] Task "${node.id}" has unknown dependency "${depId}"`);
        }
      }
    }

    // Detect cycles via DFS
    detectCycle(nodeMap);

    return {
      id: this.graphId,
      goal: this.goal,
      nodes: nodeMap,
      status: 'building',
      createdAt: Date.now(),
    };
  }

  /**
   * Build a PARALLEL graph from LLM tool_calls output.
   *
   * All tool calls in the same LLM response are INDEPENDENT by default —
   * they will all run concurrently. The only exception is when a tool's
   * parsed args contain a `_depends_on` field (array of sibling call index,
   * 0-based), which wires an explicit dependency.
   *
   * This is the key change that enables true parallel DAG execution.
   */
  static fromToolCalls(
    goal: string,
    toolCalls: Array<{ id?: string; function: { name: string; arguments: string | Record<string, unknown> } }>
  ): TaskGraph {
    const builder = new TaskGraphBuilder(goal);

    // First pass: register all nodes and collect IDs
    const callIds: string[] = [];

    for (const call of toolCalls) {
      let args: Record<string, unknown>;
      if (typeof call.function.arguments === 'string') {
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = { raw: call.function.arguments };
        }
      } else {
        args = call.function.arguments;
      }

      // Extract optional explicit dependency indices (removed from actual args)
      const dependsOnIndices: number[] = Array.isArray(args['_depends_on'])
        ? (args['_depends_on'] as number[])
        : [];
      delete args['_depends_on']; // don't pass internal field to tool

      callIds.push('__placeholder__'); // will be replaced below
      builder.nodes.push({
        id: '', // set below
        tool: call.function.name,
        args,
        description: `Call ${call.function.name}`,
        dependencies: [], // resolved in second pass
        status: 'pending',
        retryCount: 0,
        maxRetries: 2,
        priority: 5,
        createdAt: Date.now(),
      });

      const idx = builder.nodes.length - 1;
      const id = `task_${idx + 1}_${call.function.name.replace(/[^a-z0-9]/gi, '_')}`;
      builder.nodes[idx]!.id = id;
      callIds[idx] = id;
    }

    // Second pass: resolve dependencies
    for (let i = 0; i < builder.nodes.length; i++) {
      const node = builder.nodes[i]!;
      let args: Record<string, unknown>;
      // Re-parse to get _depends_on (it was already stripped above, need a different approach)
      // Actually the dependencies were stored during first pass — rebuild from toolCalls
      const call = toolCalls[i]!;
      let rawArgs: Record<string, unknown>;
      if (typeof call.function.arguments === 'string') {
        try { rawArgs = JSON.parse(call.function.arguments); } catch { rawArgs = {}; }
      } else {
        rawArgs = call.function.arguments as Record<string, unknown>;
      }

      const dependsOnIndices: number[] = Array.isArray(rawArgs['_depends_on'])
        ? (rawArgs['_depends_on'] as number[])
        : [];

      node.dependencies = dependsOnIndices
        .filter(idx => idx >= 0 && idx < callIds.length && idx !== i)
        .map(idx => callIds[idx]!);
    }

    return builder.build();
  }
}

// ─── Cycle Detection ─────────────────────────────────────────────────────────

function detectCycle(nodes: Map<string, TaskNode>): void {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string): void {
    if (inStack.has(id)) {
      throw new Error(`[TaskGraph] Circular dependency detected at node "${id}"`);
    }
    if (visited.has(id)) return;

    visited.add(id);
    inStack.add(id);

    const node = nodes.get(id);
    if (node) {
      for (const dep of node.dependencies) {
        dfs(dep);
      }
    }

    inStack.delete(id);
  }

  for (const id of nodes.keys()) {
    dfs(id);
  }
}

// ─── Task Graph Engine ────────────────────────────────────────────────────────

export class TaskGraphEngine extends EventEmitter {
  private readonly MAX_CONCURRENCY = 3;
  private readonly BASE_RETRY_DELAY_MS = 1_000;
  /**
   * Phase 5: Planner retry guard.
   * Limits how many times the orchestrator can re-plan a failed graph for
   * the same goal before giving up and surfacing the error to the user.
   */
  private readonly MAX_GRAPH_RETRIES = 2;
  private _graphRetryCount = new Map<string, number>(); // goal → retry count
  /** Upper bound on the retry-guard map, so a long session cannot grow it without limit. */
  private readonly MAX_TRACKED_GOALS = 100;

  private abortControllers = new Map<string, AbortController>();
  private toolExecutionQueues = new Map<string, Promise<void>>();
  /**
   * Last invocation time per tool, used to space out calls to the same tool.
   * Bounded by the number of registered tools.
   */
  private lastToolInvocation = new Map<string, number>();
  /**
   * Minimum gap between two calls to the *same* tool. Previously this was an
   * unconditional 500 ms sleep before every node, including the first call to a
   * tool, which added 500 ms to every tool-using request (JARVIS-004).
   */
  private readonly MIN_TOOL_GAP_MS = Math.max(
    0,
    Number(process.env['JARVIS_MIN_TOOL_GAP_MS'] ?? 250),
  );
  private currentGraph: TaskGraph | null = null;

  constructor() {
    super();
  }

  getCurrentGraph(): TaskGraph | null {
    return this.currentGraph;
  }

  /**
   * Execute a task graph to completion.
   * Returns when all nodes are done/failed or an interrupt occurs.
   * Phase 5: respects planner retry guard and emits execution summary.
   */
  async execute(graph: TaskGraph, executor: TaskExecutorFn): Promise<TaskGraph> {
    // Phase 5: planner retry guard — prevent infinite re-plan loops
    const goal = graph.goal;
    const prevRetries = this._graphRetryCount.get(goal) ?? 0;
    if (prevRetries >= this.MAX_GRAPH_RETRIES) {
      console.warn(`[TaskGraph] ⚠️ Planner retry guard: goal "${goal.slice(0, 60)}" has already been re-planned ${prevRetries} time(s). Returning failed graph without re-planning.`);
      graph.status = 'failed';
      graph.completedAt = Date.now();
      for (const node of graph.nodes.values()) {
        if (node.status === 'pending') {
          node.status = 'skipped';
          node.error = 'Skipped by planner retry guard';
        }
      }
      this._graphRetryCount.delete(goal); // reset so user can retry manually
      return graph;
    }
    this.currentGraph = graph;
    graph.status = 'running';
    this.emit('graph_started', { graphId: graph.id, goal: graph.goal });

    const parallelCount = [...graph.nodes.values()].filter(n => n.dependencies.length === 0).length;
    console.log(`[TaskGraph] ▶️  Starting graph "${graph.id}" — goal: "${graph.goal}"`);
    console.log(`[TaskGraph]    Nodes: ${graph.nodes.size} | Parallel root tasks: ${parallelCount}`);

    try {
      await this.runLoop(graph, executor);
    } catch (err) {
      console.error('[TaskGraph] Fatal error during execution:', err);
      graph.status = 'failed';
    }

    // Determine final status
    const allNodes = [...graph.nodes.values()];
    const anyFailed = allNodes.some(n => n.status === 'failed');
    const allDone = allNodes.every(n => n.status === 'done' || n.status === 'skipped' || n.status === 'failed');

    if ((graph.status as string) !== 'interrupted') {
      graph.status = allDone ? (anyFailed ? 'failed' : 'completed') : 'failed';
    }

    graph.completedAt = Date.now();

    // Clear the replan guard once the goal settles successfully. Previously the
    // counter was only deleted inside the guard branch itself and
    // `resetReplanCount()` had no callers, so a goal that had used up its
    // replans stayed poisoned: repeating the same command later in the session
    // failed instantly without executing anything (JARVIS-008).
    if (graph.status === 'completed') {
      this._graphRetryCount.delete(graph.goal);
    }

    this.emit('graph_completed', {
      graphId: graph.id,
      status: graph.status,
      durationMs: graph.completedAt - graph.createdAt,
    });

    console.log(`[TaskGraph] ✅ Graph "${graph.id}" finished with status: ${graph.status}`);
    return graph;
  }

  /**
   * Main execution loop — continues until all nodes settle or interrupt.
   */
  private async runLoop(graph: TaskGraph, executor: TaskExecutorFn): Promise<void> {
    let iterations = 0;
    const MAX_ITERATIONS = graph.nodes.size * 5; // safety cap

    while (!this.isComplete(graph) && iterations < MAX_ITERATIONS) {
      iterations++;

      if (graph.status === 'interrupted') {
        console.log('[TaskGraph] 🛑 Graph interrupted. Stopping loop.');
        break;
      }

      const ready = this.getReadyNodes(graph);

      if (ready.length === 0) {
        // Check for deadlock: nodes pending but none ready
        const pending = [...graph.nodes.values()].filter(n => n.status === 'pending');
        if (pending.length > 0) {
          console.warn(`[TaskGraph] ⚠️  Deadlock: ${pending.length} pending nodes but none are ready. Marking as failed.`);
          for (const node of pending) {
            node.status = 'failed';
            node.error = 'Deadlock: dependencies never resolved';
          }
        }
        break;
      }

      // SAFEGUARD: Yield to event loop to prevent starvation
      await new Promise(resolve => setImmediate(resolve));

      // Dispatch full batch up to MAX_CONCURRENCY — true parallel execution
      const batch = ready.slice(0, this.MAX_CONCURRENCY);
      console.log(`[TaskGraph] 🔄 Iteration ${iterations}: dispatching ${batch.length} node(s) in parallel`);

      await Promise.allSettled(batch.map(node => this.executeNode(node, graph, executor)));
    }
  }

  /**
   * Returns nodes that are ready to run: status=pending AND all deps done.
   * Sorted by priority descending.
   */
  getReadyNodes(graph: TaskGraph): TaskNode[] {
    return [...graph.nodes.values()]
      .filter(node => {
        if (node.status !== 'pending') return false;
        return node.dependencies.every(depId => {
          const dep = graph.nodes.get(depId);
          return dep?.status === 'done' || dep?.status === 'skipped';
        });
      })
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Execute a single node, handling retries and abort signals.
   */
  private async executeNode(
    node: TaskNode,
    graph: TaskGraph,
    executor: TaskExecutorFn
  ): Promise<void> {
    if (graph.status === 'interrupted') return;

    node.status = 'running';
    node.startedAt = Date.now();

    const ac = new AbortController();
    this.abortControllers.set(node.id, ac);

    this.emit('node_started', { nodeId: node.id, tool: node.tool, args: node.args });
    console.log(`[TaskGraph]   → Queuing node "${node.id}" (tool: ${node.tool})`);

    try {
      // ── TOOL EXECUTION SCHEDULER & RATE LIMITER ──
      // Prevents hammering the same external API simultaneously.
      const previousExecution = this.toolExecutionQueues.get(node.tool) || Promise.resolve();
      
      const executionPromise = previousExecution.then(async () => {
        // Space out repeat calls to the same tool, but never delay its first
        // call. Measured start-to-start, so a slow tool needs no extra wait.
        const last = this.lastToolInvocation.get(node.tool);
        const wait = last === undefined
          ? 0
          : Math.max(0, this.MIN_TOOL_GAP_MS - (Date.now() - last));
        if (wait > 0) await sleep(wait);
        this.lastToolInvocation.set(node.tool, Date.now());
        if (graph.status === 'interrupted') throw new Error('interrupted');
        return runInTaskNode(node, () => executor(node.tool, node.args, ac.signal));
      }).catch(err => {
         // Pass the error down to the node retry logic, don't break the queue chain
         throw err;
      });

      // Update the queue head for this tool
      this.toolExecutionQueues.set(node.tool, executionPromise.then(() => {}).catch(() => {}));

      const result = await executionPromise;

      node.result = result;
      node.status = 'done';
      node.completedAt = Date.now();

      this.emit('node_completed', {
        nodeId: node.id,
        tool: node.tool,
        result,
        durationMs: node.completedAt - (node.startedAt ?? node.completedAt),
      });

      console.log(`[TaskGraph]   ✅ Node "${node.id}" done (${node.completedAt - (node.startedAt ?? 0)}ms)`);

    } catch (err: unknown) {
      const errMsg = String(err instanceof Error ? err.message : err);
      node.error = errMsg;
      node.retryCount++;

      // Phase 5: Classify error type for smarter retry decisions
      const errLower = errMsg.toLowerCase();
      const errorType: TaskNode['errorType'] =
        errLower.includes('abort') || errLower.includes('cancelled')      ? 'abort'
        : errLower.includes('timeout') || errLower.includes('timed out')   ? 'timeout'
        // Refused by JARVIS's permission levels, or by a tool's policy (allow-list,
        // safety block), or nothing to act on: the same call fails the same way,
        // so retrying only added ~3 s before the reply.
        : isPermissionDenial(errMsg) || errLower.includes('allowlist') || errLower.includes('policy') || errLower.includes('no open application') ? 'fatal'
        : errLower.includes('permission') || errLower.includes('access denied') ? 'permission'
        : errLower.includes('not registered') || errLower.includes('not found') ? 'fatal'
        // Bad arguments or a tool/action that does not exist fail the same way
        // every time; they were retried as 'transient' (~3 s of silence).
        : errLower.includes('missing required argument') || errLower.includes('expects type')
          || errLower.includes('must be one of') || errLower.includes('invalid arguments for tool')
          || errLower.includes('unknown tool') || /unknown \w+ action/.test(errLower) ? 'fatal'
        // Missing or rejected configuration (e.g. "SERPER_API_KEY is not set")
        // cannot fix itself; retrying only added ~3 s of silence to the reply.
        : errLower.includes('is not set') || errLower.includes('api key') || errLower.includes('unauthorized') ? 'fatal'
        : 'transient';
      node.errorType = errorType;

      const isFatal = errorType === 'fatal' || errorType === 'abort';

      console.error(`[TaskGraph]   ❌ Node "${node.id}" failed [${errorType}] (attempt ${node.retryCount}/${node.maxRetries + 1}): ${errMsg}`);

      // Fatal/abort errors skip retries immediately
      const canRetry = !isFatal
        && node.retryCount <= node.maxRetries
        && (graph.status as string) !== 'interrupted';

      if (canRetry) {
        const delay = this.BASE_RETRY_DELAY_MS * Math.pow(2, node.retryCount - 1);
        console.log(`[TaskGraph]   ⟳  Retry in ${delay}ms... [${errorType}]`);
        node.status = 'retry';
        await sleep(delay);
        node.status = 'pending';
        this.emit('node_retry', { nodeId: node.id, retryCount: node.retryCount, delay, errorType });
      } else {
        if (isFatal) {
          console.warn(`[TaskGraph]   ⛔ Node "${node.id}" marked fatal [${errorType}] — no retry.`);
        }
        node.status = 'failed';
        node.completedAt = Date.now();
        this.emit('node_failed', { nodeId: node.id, tool: node.tool, error: errMsg, errorType });
      }

    } finally {
      this.abortControllers.delete(node.id);
    }
  }

  /**
   * Interrupt all running nodes immediately.
   */
  interrupt(graph: TaskGraph): void {
    graph.status = 'interrupted';

    for (const [nodeId, ac] of this.abortControllers.entries()) {
      console.log(`[TaskGraph] 🛑 Aborting node "${nodeId}"`);
      ac.abort();
    }
    this.abortControllers.clear();

    // Mark all pending/running nodes as skipped
    for (const node of graph.nodes.values()) {
      if (node.status === 'pending' || node.status === 'running') {
        node.status = 'skipped';
      }
    }

    this.emit('graph_interrupted', { graphId: graph.id });
  }

  /**
   * Check if the graph has no more executable nodes.
   */
  private isComplete(graph: TaskGraph): boolean {
    return [...graph.nodes.values()].every(n =>
      n.status === 'done' || n.status === 'failed' || n.status === 'skipped'
    );
  }

  getGraphSummary(graph: TaskGraph): string {
    const nodes = [...graph.nodes.values()];
    const done = nodes.filter(n => n.status === 'done').length;
    const failed = nodes.filter(n => n.status === 'failed').length;
    const total = nodes.length;
    return `Graph "${graph.id}": ${done}/${total} done, ${failed} failed. Status: ${graph.status}`;
  }

  /**
   * Phase 5: Structured execution summary for post-mortem analysis.
   * Used by the orchestrator to decide whether to re-plan or surface error.
   */
  getExecutionSummary(graph: TaskGraph): GraphExecutionSummary {
    const nodes = [...graph.nodes.values()];
    const failures = nodes
      .filter(n => n.status === 'failed')
      .map(n => ({
        nodeId: n.id,
        tool: n.tool,
        error: n.error ?? 'unknown',
        errorType: n.errorType,
        retries: n.retryCount,
      }));
    return {
      graphId: graph.id,
      goal: graph.goal,
      status: graph.status,
      durationMs: (graph.completedAt ?? Date.now()) - graph.createdAt,
      totalNodes: nodes.length,
      succeededNodes: nodes.filter(n => n.status === 'done').length,
      failedNodes: nodes.filter(n => n.status === 'failed').length,
      skippedNodes: nodes.filter(n => n.status === 'skipped').length,
      retryTotal: nodes.reduce((sum, n) => sum + n.retryCount, 0),
      failures,
    };
  }

  /**
   * Phase 5: Register a graph re-plan attempt for the planner retry guard.
   * Call this before re-planning a previously failed graph.
   * Returns true if re-planning is allowed, false if the guard is triggered.
   */
  canReplan(goal: string): boolean {
    const count = this._graphRetryCount.get(goal) ?? 0;
    if (count >= this.MAX_GRAPH_RETRIES) return false;
    // Evict the oldest entry rather than letting the map grow for the life of
    // the process (Map preserves insertion order).
    if (!this._graphRetryCount.has(goal) && this._graphRetryCount.size >= this.MAX_TRACKED_GOALS) {
      const oldest = this._graphRetryCount.keys().next();
      if (!oldest.done) this._graphRetryCount.delete(oldest.value);
    }
    this._graphRetryCount.set(goal, count + 1);
    return true;
  }

  /** Reset the planner retry guard for a goal (e.g. when user provides new input). */
  resetReplanCount(goal: string): void {
    this._graphRetryCount.delete(goal);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const taskGraphEngine = new TaskGraphEngine();
