/**
 * core/agents/permissions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Permission scopes for agents. A scope lists the tools (or single actions of
 * a tool) an agent may call, the highest risk of one call, and whether it may
 * create children.
 *
 * Rules (RECURSIVE_AGENT_RESEARCH.md §4.2, §4.3):
 *  - A child's scope is a subset of its parent's: every tool entry is covered
 *    by the parent, its maxRisk is not higher, and it can spawn only if the
 *    parent can. A request asking for more is rejected, not trimmed, so an
 *    escalation attempt is visible.
 *  - The model never chooses permissions: they come from the parent and the
 *    role definition.
 *  - Some tools are never given to any agent (session control, the user's
 *    cancel button), whatever a role says. Deny wins.
 *  - A scope only narrows what an agent may try. Every call still goes
 *    through toolRegistryV2.execute: permission floor, risk engine, rate
 *    limit and the approval gate. Agents cannot bypass them.
 */

import type { RiskTier, ToolMeta } from '../toolRegistryV2.js';
import { assessRisk } from '../../security/riskEngine.js';
import type { PermissionScope } from './types.js';

/** What permissions.ts needs from the tool registry (toolRegistryV2 has it). */
export interface ToolInfoSource {
  names(): string[];
  riskOf(name: string, args?: Record<string, unknown>): RiskTier;
  getMeta(name: string): ToolMeta | undefined;
}

/** Never given to an agent: they change JARVIS's own permission session or stop the user's request. */
export const AGENT_DENIED_TOOLS: readonly string[] = [
  'enable_full_control_session',
  'disable_full_control_session',
  'cancel_current_action',
  // JARVIS's own delegation tools: agents create children only through the Agent Factory.
  'delegate_task',
  'agent_status',
  'cancel_agent_task',
];

/** Single actions never given to an agent. */
export const AGENT_DENIED_ACTIONS: readonly string[] = [
  'control_system:restart_jarvis',
];

/** Tool categories never given to an agent: messages to people, scheduled jobs. */
export const AGENT_DENIED_CATEGORIES: readonly string[] = ['COMMUNICATION', 'SCHEDULING'];

/** Highest risk any agent may be given. Level 4 needs a typed code from the user. */
export const AGENT_MAX_RISK: RiskTier = 3;

export interface ScopeEntry {
  tool: string;
  action?: string;
}

export function parseEntry(entry: string): ScopeEntry {
  const i = entry.indexOf(':');
  return i === -1 ? { tool: entry } : { tool: entry.slice(0, i), action: entry.slice(i + 1) };
}

function formatEntry(e: ScopeEntry): string {
  return e.action ? `${e.tool}:${e.action}` : e.tool;
}

/** Whether `entries` allow `wanted` (a whole tool needs a whole-tool entry). */
export function covers(entries: readonly string[], wanted: string): boolean {
  const w = parseEntry(wanted);
  for (const raw of entries) {
    const e = parseEntry(raw);
    if (e.tool !== w.tool) continue;
    if (!e.action) return true;
    if (w.action && e.action === w.action) return true;
  }
  return false;
}

export function isDeniedForAgents(entry: string, registry?: ToolInfoSource): boolean {
  const e = parseEntry(entry);
  if (AGENT_DENIED_TOOLS.includes(e.tool)) return true;
  if (e.action && AGENT_DENIED_ACTIONS.includes(formatEntry(e))) return true;
  const category = registry?.getMeta(e.tool)?.category;
  return !!category && AGENT_DENIED_CATEGORIES.includes(category);
}

/**
 * Removes denied tools. A whole-tool entry whose tool has a denied action is
 * split into its allowed actions, so the denied one stays out.
 */
export function withoutDenied(entries: readonly string[], registry?: ToolInfoSource): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    if (isDeniedForAgents(raw, registry)) continue;
    const e = parseEntry(raw);
    const deniedActions = AGENT_DENIED_ACTIONS.filter((d) => parseEntry(d).tool === e.tool);
    if (!e.action && deniedActions.length) {
      const actions = Object.keys(registry?.getMeta(e.tool)?.actions ?? {});
      for (const a of actions) {
        const entry = `${e.tool}:${a}`;
        if (!AGENT_DENIED_ACTIONS.includes(entry)) out.push(entry);
      }
      continue;
    }
    out.push(raw);
  }
  return [...new Set(out)];
}

/** The scope JARVIS (depth 0) hands down: every registered tool an agent may have. */
export function rootScope(registry: ToolInfoSource): PermissionScope {
  return { tools: withoutDenied(registry.names(), registry), maxRisk: AGENT_MAX_RISK, canSpawn: true };
}

/** Entries allowed by both `a` and `b` (the narrower entry wins). */
export function intersectEntries(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  for (const e of a) if (covers(b, e)) out.add(e);
  for (const e of b) if (covers(a, e)) out.add(e);
  // Drop action entries already implied by a whole-tool entry.
  return [...out].filter((e) => {
    const p = parseEntry(e);
    return !p.action || !out.has(p.tool);
  });
}

export interface ScopeCheck {
  ok: boolean;
  violations: string[];
}

/** Whether `child` stays inside `parent`. */
export function isSubsetScope(child: PermissionScope, parent: PermissionScope): ScopeCheck {
  const violations: string[] = [];
  for (const t of child.tools) {
    if (!covers(parent.tools, t)) violations.push(`tool "${t}" is not in the parent's scope`);
  }
  if (child.maxRisk > parent.maxRisk) {
    violations.push(`maxRisk ${child.maxRisk} is above the parent's ${parent.maxRisk}`);
  }
  if (child.canSpawn && !parent.canSpawn) violations.push('canSpawn is true but the parent cannot spawn');
  return { ok: violations.length === 0, violations };
}

export interface ChildScopeInput {
  parent: PermissionScope;
  /** The role's own maximum: its tool list, maxRisk and whether it may spawn. */
  role: PermissionScope;
  /** CreateChildAgentRequest.allowedTools. */
  allowedTools?: string[];
  /** CreateChildAgentRequest.permissionScope. */
  requested?: Partial<PermissionScope>;
  /** False when the child would sit at the maximum depth (leaf rule). */
  depthAllowsSpawn: boolean;
  registry?: ToolInfoSource;
}

export interface ChildScopeResult {
  scope: PermissionScope;
  /** Non-empty: the request asked for more than it may have; reject it. */
  escalations: string[];
}

/**
 * The child's scope: parent ∩ role ∩ request. Asking for a tool, risk or
 * spawn right the parent lacks is an escalation; asking for one the role
 * lacks is also refused (the role defines what that kind of agent may do).
 */
export function deriveChildScope(input: ChildScopeInput): ChildScopeResult {
  const escalations: string[] = [];
  const asked = [...(input.allowedTools ?? []), ...(input.requested?.tools ?? [])];
  for (const t of asked) {
    if (isDeniedForAgents(t, input.registry)) escalations.push(`tool "${t}" is never given to agents`);
    else if (!covers(input.parent.tools, t)) escalations.push(`tool "${t}" is not in the parent's scope`);
    else if (!covers(input.role.tools, t)) escalations.push(`tool "${t}" is not allowed for this role`);
  }
  const reqRisk = input.requested?.maxRisk;
  if (reqRisk !== undefined && reqRisk > input.parent.maxRisk) {
    escalations.push(`maxRisk ${reqRisk} is above the parent's ${input.parent.maxRisk}`);
  }
  if (input.requested?.canSpawn && !input.parent.canSpawn) {
    escalations.push('canSpawn requested but the parent cannot spawn');
  }

  let tools = intersectEntries(input.parent.tools, input.role.tools);
  if (input.allowedTools) tools = intersectEntries(tools, input.allowedTools);
  if (input.requested?.tools) tools = intersectEntries(tools, input.requested.tools);
  tools = withoutDenied(tools, input.registry);

  const maxRisk = Math.min(
    input.parent.maxRisk, input.role.maxRisk, reqRisk ?? AGENT_MAX_RISK, AGENT_MAX_RISK,
  ) as RiskTier;
  const canSpawn = input.parent.canSpawn && input.role.canSpawn && input.depthAllowsSpawn
    && input.requested?.canSpawn !== false;
  return { scope: { tools, maxRisk, canSpawn }, escalations };
}

export interface CallCheck {
  allowed: boolean;
  code?: 'AGENT_SCOPE_DENIED' | 'AGENT_RISK_DENIED' | 'AGENT_TOOL_DENIED';
  reason?: string;
  risk: RiskTier;
}

/** Whether an agent with `scope` may make this call (before the registry's own gates). */
export function checkCall(
  scope: PermissionScope,
  tool: string,
  args: Record<string, unknown>,
  registry: ToolInfoSource,
): CallCheck {
  const action = typeof args['action'] === 'string' ? String(args['action']).toLowerCase() : undefined;
  const entry = action ? `${tool}:${action}` : tool;
  if (isDeniedForAgents(entry, registry)) {
    return { allowed: false, code: 'AGENT_TOOL_DENIED', reason: `${entry} is never available to agents`, risk: 0 };
  }
  if (!covers(scope.tools, entry)) {
    return { allowed: false, code: 'AGENT_SCOPE_DENIED', reason: `${entry} is outside this agent's permissions`, risk: 0 };
  }
  let risk: RiskTier;
  try {
    risk = assessRisk({ tool, args, baseRisk: registry.riskOf(tool, args) }).level;
  } catch {
    // Fail closed, as the registry does.
    return { allowed: false, code: 'AGENT_RISK_DENIED', reason: `the risk of ${entry} could not be assessed`, risk: 4 };
  }
  if (risk > scope.maxRisk) {
    return {
      allowed: false, code: 'AGENT_RISK_DENIED',
      reason: `${entry} is risk ${risk}; this agent may make calls up to risk ${scope.maxRisk}`, risk,
    };
  }
  return { allowed: true, risk };
}
