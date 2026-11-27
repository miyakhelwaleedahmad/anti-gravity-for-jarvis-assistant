/**
 * core/agents/spawnPolicy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Whether an agent should create children for its work, or do it itself.
 * Children cost model calls, slots and time, so the default is to do the work
 * directly; splitting has to be worth it.
 *
 * The questions asked (and recorded, so "why did the Research Agent create
 * these?" has an answer):
 *   divisible · independent · parallelism helps · enough work · budget left ·
 *   depth available · capabilities available · duplicate work
 *
 * Duplicates are not re-done: a finished result for the same task is REUSEd,
 * a running one is SUBSCRIBEd to (or WAITed for). A subtask that is the
 * agent's whole task is never delegated (ReDel's guard, research §4.4).
 */

import type { ChildResult } from './types.js';
import { similarity } from './similarity.js';

export type SpawnAction = 'SPAWN' | 'SELF' | 'REUSE' | 'SUBSCRIBE' | 'WAIT' | 'ASK_PARENT';

export interface PlannedSubtask {
  description: string;
  role: string;
  /** Indices of other subtasks in the same list that must finish first. */
  dependsOn?: number[];
  /** Rough size in units of work (one tool call or model call ≈ 1). Default 1. */
  estimatedUnits?: number;
  /** Capabilities the subtask needs. */
  capabilities?: string[];
}

export interface SpawnDecisionInput {
  subtasks: PlannedSubtask[];
  /** Below this many total units, splitting is not worth a child. Default 3. */
  minUnitsToSpawn?: number;
}

export interface SubtaskPlan {
  index: number;
  action: SpawnAction;
  reason: string;
  /** For REUSE: the finished task. For SUBSCRIBE/WAIT: the running one. */
  existingTaskId?: string;
}

export interface SpawnDecision {
  decision: SpawnAction;
  reasons: string[];
  plan: SubtaskPlan[];
  questions: {
    divisible: boolean;
    independent: boolean;
    parallelismHelps: boolean;
    enoughWork: boolean;
    budgetLeft: boolean;
    depthAvailable: boolean;
    capabilitiesAvailable: boolean;
    duplicateWork: boolean;
  };
}

/** What the policy needs to know about the agent and the system. */
export interface SpawnEnvironment {
  ownTask: string;
  ownCapabilities: string[];
  canSpawn: boolean;
  /** Children this agent may still add (maxChildren − active children). */
  childSlotsLeft: number;
  /** Agents the system may still add. */
  globalSlotsLeft: number;
  /** Work slots (concurrent agents) in total. */
  concurrency: number;
  /** Remaining model calls of this task's budget. */
  llmCallsLeft: number;
  /** Remaining tool calls of this task's budget. */
  toolCallsLeft: number;
  allowedChildRoles: string[];
  knownRoles: string[];
  /** Tasks of the same root that are not finished: id, role, description. */
  activeTasks: { taskId: string; role: string; description: string }[];
  /** Finished results of the same root. */
  finishedResults: ChildResult[];
}

const SAME_TASK = 0.8;

export function decideSpawn(input: SpawnDecisionInput, env: SpawnEnvironment): SpawnDecision {
  const subtasks = input.subtasks;
  const minUnits = input.minUnitsToSpawn ?? 3;
  const reasons: string[] = [];
  const plan: SubtaskPlan[] = [];

  const units = subtasks.reduce((s, t) => s + Math.max(1, t.estimatedUnits ?? 1), 0);
  const independentCount = subtasks.filter((t) => !(t.dependsOn?.length)).length;
  const divisible = subtasks.length >= 2;
  const independent = independentCount >= 2;
  const parallelismHelps = independent && env.concurrency > 1;
  const enoughWork = units >= minUnits;
  // A child needs at least one model call or a few tool calls to be useful.
  const budgetLeft = env.llmCallsLeft >= subtasks.length || env.toolCallsLeft >= 2 * subtasks.length;
  const depthAvailable = env.canSpawn && env.childSlotsLeft > 0 && env.globalSlotsLeft > 0;
  const missingRoles = subtasks.filter((t) => !env.knownRoles.includes(t.role) || !env.allowedChildRoles.includes(t.role));
  const capabilitiesAvailable = missingRoles.length === 0;

  let duplicateWork = false;
  let spawnCount = 0;
  for (let i = 0; i < subtasks.length; i++) {
    const t = subtasks[i];
    if (similarity(t.description, env.ownTask) >= SAME_TASK) {
      plan.push({ index: i, action: 'SELF', reason: 'this is the agent\'s own whole task; delegating it would only pass it down' });
      continue;
    }
    const done = env.finishedResults.find((r) =>
      r.status === 'COMPLETED' && r.role === t.role
      && similarity(String(r.data?.['taskDescription'] ?? ''), t.description) >= SAME_TASK);
    if (done) {
      duplicateWork = true;
      plan.push({ index: i, action: 'REUSE', reason: 'a finished task already answered this', existingTaskId: done.taskId });
      continue;
    }
    const running = env.activeTasks.find((a) => a.role === t.role && similarity(a.description, t.description) >= SAME_TASK);
    if (running) {
      duplicateWork = true;
      plan.push({ index: i, action: 'SUBSCRIBE', reason: 'another agent is already doing this; follow its findings', existingTaskId: running.taskId });
      continue;
    }
    if (!env.knownRoles.includes(t.role) || !env.allowedChildRoles.includes(t.role)) {
      const own = (t.capabilities ?? []).every((c) => env.ownCapabilities.includes(c));
      plan.push({
        index: i, action: own ? 'SELF' : 'ASK_PARENT',
        reason: own ? `no allowed child role "${t.role}"; the agent can do it itself`
          : `no allowed child role "${t.role}" and the agent lacks ${(t.capabilities ?? []).join(', ') || 'the capability'}`,
      });
      continue;
    }
    plan.push({ index: i, action: 'SPAWN', reason: 'independent part of the work' });
    spawnCount++;
  }

  // Reasons that turn SPAWN back into SELF. Size and divisibility do not apply
  // to a part that needs a capability this agent lacks: that part must go to
  // a child (or back to the parent) however small it is.
  const needsOther = (i: number) => !(subtasks[i].capabilities ?? []).every((c) => env.ownCapabilities.includes(c));
  const hardBlockers: string[] = [];
  if (!env.canSpawn) hardBlockers.push('at the depth limit: this agent may not create children');
  else if (env.childSlotsLeft <= 0) hardBlockers.push('this agent already has its maximum number of active children');
  else if (env.globalSlotsLeft <= 0) hardBlockers.push('the system has its maximum number of active agents');
  if (!budgetLeft) hardBlockers.push('not enough budget left for children');
  const softBlockers: string[] = [];
  if (!enoughWork) softBlockers.push(`too little work to split (${units} unit(s), threshold ${minUnits})`);
  if (!divisible && spawnCount <= 1) softBlockers.push('the work is not divisible');

  for (const p of plan) {
    if (p.action !== 'SPAWN') continue;
    if (hardBlockers.length) {
      if (needsOther(p.index)) { p.action = 'ASK_PARENT'; p.reason = `${hardBlockers[0]}, and the agent lacks the capability`; }
      else { p.action = 'SELF'; p.reason = hardBlockers[0]; }
    } else if (softBlockers.length && !needsOther(p.index)) {
      p.action = 'SELF'; p.reason = softBlockers[0];
    }
  }
  reasons.push(...hardBlockers);
  if (!hardBlockers.length && plan.some((p) => p.action === 'SELF' && softBlockers.includes(p.reason))) reasons.push(...softBlockers);

  const stillSpawning = plan.filter((p) => p.action === 'SPAWN').length;
  if (!hardBlockers.length && stillSpawning > env.childSlotsLeft) {
    // More parts than child slots: spawn what fits, do the rest itself.
    let allowed = env.childSlotsLeft;
    for (const p of plan) {
      if (p.action !== 'SPAWN') continue;
      if (allowed > 0) allowed--;
      else { p.action = 'SELF'; p.reason = 'no child slot left; done by the agent itself'; }
    }
    reasons.push(`only ${env.childSlotsLeft} child slot(s) left for ${stillSpawning} part(s)`);
  }

  const spawned = plan.filter((p) => p.action === 'SPAWN').length;
  if (spawned) {
    reasons.push(`${spawned} part(s) for children`);
    if (parallelismHelps) reasons.push(`${independentCount} independent part(s) can run at the same time`);
    else if (!independent) reasons.push('parts depend on each other; children run in order');
  }
  if (duplicateWork) reasons.push('some parts duplicate work already done or running');

  const actions = new Set(plan.map((p) => p.action));
  const decision: SpawnAction = spawned ? 'SPAWN'
    : actions.has('ASK_PARENT') ? 'ASK_PARENT'
    : actions.has('SUBSCRIBE') ? 'SUBSCRIBE'
    : actions.has('REUSE') && !actions.has('SELF') ? 'REUSE'
    : 'SELF';
  if (!reasons.length) reasons.push(decision === 'SELF' ? 'doing the work directly is cheaper' : 'see the plan');

  return {
    decision, reasons, plan,
    questions: {
      divisible, independent, parallelismHelps, enoughWork, budgetLeft, depthAvailable, capabilitiesAvailable, duplicateWork,
    },
  };
}
