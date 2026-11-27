/**
 * core/agents/registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The agent registry: role definitions (what kinds of agent exist) and agent
 * records (which agents exist now). Discovery by capability, A2A Agent Cards,
 * and the "unknown role" answer that lists the valid ones (CrewAI's idea,
 * RECURSIVE_AGENT_RESEARCH.md §4.12).
 */

import type { RiskTier } from '../toolRegistryV2.js';
import type {
  A2AAgentCard, AgentOutcome, AgentRecord, PermissionScope,
} from './types.js';
import { JARVIS_A2A_EXTENSION } from './types.js';
import type { AgentContext } from './agentContextApi.js';

/** What an agent does with a task. The manager wraps it with lifecycle, limits and results. */
export interface AgentBehavior {
  run(ctx: AgentContext): Promise<AgentOutcome>;
}

export interface AgentRoleDefinition {
  role: string;
  name: string;
  description: string;
  capabilities: string[];
  supportedTaskTypes: string[];
  /** Tools (or tool:action entries) this kind of agent may ever use. */
  tools: string[];
  maxRisk: RiskTier;
  /** Whether this kind of agent may create children at all. */
  canSpawn: boolean;
  /** Roles it may create. Empty = none. */
  allowedChildRoles: string[];
  /** One of the seven specialists; exists for the whole run. */
  permanent?: boolean;
  version: string;
  /** Example requests, shown on the Agent Card. */
  examples?: string[];
  behavior: AgentBehavior | (() => AgentBehavior);
}

export class UnknownRoleError extends Error {
  readonly code = 'UNKNOWN_ROLE';
  constructor(role: string, readonly validRoles: string[]) {
    super(`No agent role "${role}". Valid roles: ${validRoles.join(', ') || '(none)'}.`);
  }
}

export class AgentRegistry {
  private roles = new Map<string, AgentRoleDefinition>();
  private agents = new Map<string, AgentRecord>();

  defineRole(def: AgentRoleDefinition): void {
    this.roles.set(def.role, def);
  }

  hasRole(role: string): boolean {
    return this.roles.has(role);
  }

  /** The role, or UnknownRoleError naming the valid roles. */
  role(role: string): AgentRoleDefinition {
    const def = this.roles.get(role);
    if (!def) throw new UnknownRoleError(role, [...this.roles.keys()].sort());
    return def;
  }

  roleList(): AgentRoleDefinition[] {
    return [...this.roles.values()];
  }

  behaviorFor(role: string): AgentBehavior {
    const b = this.role(role).behavior;
    return typeof b === 'function' ? b() : b;
  }

  roleScope(role: string): PermissionScope {
    const def = this.role(role);
    return { tools: [...def.tools], maxRisk: def.maxRisk, canSpawn: def.canSpawn };
  }

  /** Roles offering every capability in `capabilities`. */
  findRolesByCapability(...capabilities: string[]): AgentRoleDefinition[] {
    return this.roleList().filter((r) => capabilities.every((c) => r.capabilities.includes(c)));
  }

  // ── Agent records ──────────────────────────────────────────────────────────

  add(record: AgentRecord): void {
    this.agents.set(record.agentId, record);
  }

  get(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  remove(agentId: string): void {
    this.agents.delete(agentId);
  }

  all(): AgentRecord[] {
    return [...this.agents.values()];
  }

  children(agentId: string): AgentRecord[] {
    return this.all().filter((a) => a.parentAgentId === agentId);
  }

  /** Live agents with a capability (discovery). */
  findAgents(filter: { capability?: string; role?: string; rootTaskId?: string; status?: string } = {}): AgentRecord[] {
    return this.all().filter((a) =>
      (!filter.capability || a.capabilities.includes(filter.capability))
      && (!filter.role || a.role === filter.role)
      && (!filter.rootTaskId || a.rootTaskId === filter.rootTaskId || a.permanent)
      && (!filter.status || a.status === filter.status));
  }

  /** Path from JARVIS to the agent, e.g. "JARVIS › Research Agent › GitHub Research Agent". */
  path(agentId: string): string {
    const names: string[] = [];
    let cur = this.agents.get(agentId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.agentId)) {
      seen.add(cur.agentId);
      names.unshift(cur.name);
      cur = cur.parentAgentId ? this.agents.get(cur.parentAgentId) : undefined;
    }
    return names.join(' › ');
  }

  // ── A2A Agent Cards ────────────────────────────────────────────────────────

  roleCard(role: string, endpoint: string): A2AAgentCard {
    const def = this.role(role);
    return {
      name: def.name,
      description: def.description,
      supportedInterfaces: [{ url: endpoint, protocolBinding: endpoint.startsWith('http') ? 'JSONRPC' : 'INPROC', protocolVersion: '1.0' }],
      provider: { organization: 'JARVIS (local)' },
      version: def.version,
      capabilities: {
        streaming: true,
        pushNotifications: false,
        extensions: [{
          uri: JARVIS_A2A_EXTENSION,
          description: 'Agent lineage, permission scope and resource budget in metadata.jarvis',
          required: false,
        }],
      },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [{
        id: def.role,
        name: def.name,
        description: def.description,
        tags: [...def.capabilities],
        ...(def.examples?.length ? { examples: [...def.examples] } : {}),
      }],
      metadata: {
        jarvis: {
          role: def.role, capabilities: def.capabilities, supportedTaskTypes: def.supportedTaskTypes,
          tools: def.tools, maxRisk: def.maxRisk, canSpawn: def.canSpawn, allowedChildRoles: def.allowedChildRoles,
          permanent: !!def.permanent,
        },
      },
    };
  }

  agentCard(agentId: string): A2AAgentCard | undefined {
    const rec = this.agents.get(agentId);
    if (!rec || !this.roles.has(rec.role)) return undefined;
    const card = this.roleCard(rec.role, rec.endpoint);
    card.name = rec.name;
    card.metadata = {
      jarvis: {
        ...(card.metadata?.['jarvis'] as Record<string, unknown>),
        agentId: rec.agentId, parentAgentId: rec.parentAgentId, depth: rec.depth, status: rec.status,
        permissions: rec.permissions, rootTaskId: rec.rootTaskId,
      },
    };
    return card;
  }
}
