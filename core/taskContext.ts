/**
 * core/taskContext.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The task-graph node whose tool call is running, so that code deep inside the
 * call (the approval gate) can record on that node what happened.
 *
 * AsyncLocalStorage, because nodes run in parallel.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TaskNode } from './taskGraphEngine.js';

const store = new AsyncLocalStorage<TaskNode>();

export function runInTaskNode<T>(node: TaskNode, fn: () => Promise<T>): Promise<T> {
  return store.run(node, fn);
}

/** The node this code runs for, if it runs inside a task graph. */
export function currentTaskNode(): TaskNode | undefined {
  return store.getStore();
}
