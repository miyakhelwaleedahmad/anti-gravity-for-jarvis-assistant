/**
 * core/toolRegistryV2.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Advanced modular tool registry with schema validation, fallback chains,
 * and structured ToolResult outputs.
 *
 * Replaces:
 *   - core/toolRegistry.ts       (static OpenAI definitions only)
 *   - core/toolExecutor.ts       (hard-coded switch/case)
 *   - execution/toolExecutor.ts  (cache wrapper with switch/case)
 *
 * Usage:
 *   // Register a tool
 *   toolRegistryV2.register(myTool);
 *
 *   // Execute with full validation + fallback handling
 *   const result = await toolRegistryV2.execute('web_search', { query: 'TypeScript' });
 *
 *   // Get OpenAI-compatible definitions for LLM context
 *   const defs = toolRegistryV2.getLLMDefinitions();
 */

// ─── Types ────────────────────────────────────────────────────────────────────

import { toolExecutionSandbox } from './toolExecutionSandbox.js';
import { permissionSession } from '../control/permissionSession.js';
import { securityAuditLogger } from '../security/securityAuditLogger.js';
import { TOOL_CATALOG, deriveMeta } from './toolCatalog.js';
import { assessRisk, callLabel, decide, level2Policy, type RiskAssessment, type RiskDecision } from '../security/riskEngine.js';
import { approvalGate } from '../security/approvalGate.js';
import { runApproved, type ApprovedCall } from '../security/approvalScope.js';
import { getRequestSource, getRequestText } from './traceContext.js';
import { buildApprovalRequest } from '../security/approvalRequest.js';
import { redact, redactDeep } from '../security/redactor.js';
import { verifyCall, type Verification, type Verifier } from './verifiers.js';

/** Execution risk: drives sandboxing, caching and queueing (not permissions). */
export type RiskLevel = 'low' | 'medium' | 'high';

// ─── Capability metadata (docs/upgrade/TOOL_REGISTRY.md) ─────────────────────

export type ToolCategory =
  | 'OBSERVATION' | 'BROWSER' | 'COMPUTER' | 'FILESYSTEM' | 'TERMINAL' | 'DEVELOPMENT'
  | 'NETWORK' | 'COMMUNICATION' | 'SCHEDULING' | 'MEMORY' | 'SYSTEM';

/** Display order of categories. */
export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'OBSERVATION', 'BROWSER', 'COMPUTER', 'FILESYSTEM', 'TERMINAL', 'DEVELOPMENT',
  'NETWORK', 'COMMUNICATION', 'SCHEDULING', 'MEMORY', 'SYSTEM',
];

/** Risk of one call: 0 observe, 1 low, 2 moderate, 3 high, 4 critical (docs/upgrade/PERMISSION_MODEL.md). */
export type RiskTier = 0 | 1 | 2 | 3 | 4;
export type Reversibility = 'yes' | 'partial' | 'no';
/** `query`: sends data out to get information; `change`: changes something outside the PC. */
export type ExternalEffect = 'none' | 'query' | 'change';
/** Derived from risk: 0–1 none, 2 by the user's policy, 3–4 always. */
export type ApprovalNeed = 'none' | 'policy' | 'required';

export interface ActionMeta {
  risk: RiskTier;
  reversible?: Reversibility;
  /** Expected effect, shown in approval requests. */
  effect?: string;
}

export interface ToolMeta {
  category: ToolCategory;
  /** For tools with actions: the highest action risk. */
  risk: RiskTier;
  reversible: Reversibility;
  external: ExternalEffect;
  effect: string;
  output: { format: 'text' | 'json'; description: string };
  /** Per value of the tool's `action` argument. */
  actions?: Record<string, ActionMeta>;
}

export interface CapabilityEntry {
  name: string;
  summary: string;
  /** Lowest and highest risk over the tool's actions. */
  risk: [RiskTier, RiskTier];
  approval: ApprovalNeed;
  reversible: Reversibility;
  external: ExternalEffect;
  actions?: string[];
}

export interface CapabilityGroup {
  category: ToolCategory;
  tools: CapabilityEntry[];
}

export function approvalNeedFor(risk: RiskTier): ApprovalNeed {
  return risk >= 3 ? 'required' : risk === 2 ? 'policy' : 'none';
}

export interface ToolSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  enum?: string[];
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  tool: string;
  durationMs: number;
  fromFallback?: string;
  fromCache?: boolean;
  /** Phase 5: which retry attempt produced this result (0 = first attempt) */
  attemptNumber?: number;
  /** P5: the check of the call's real effect (core/verifiers.ts). */
  verification?: Verification;
}

/**
 * Phase 5: Per-tool retry policy.
 * Overrides registry defaults for individual tools.
 */
export interface RetryPolicy {
  /** Max retry attempts after initial failure (default: 2) */
  maxRetries: number;
  /** Base delay in ms between retries — doubled per attempt (exponential backoff) */
  baseDelayMs: number;
  /** If true, do NOT retry on AbortError/timeout (default: true) */
  skipRetryOnTimeout: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  /**
   * Minimum permission level required to dispatch this tool (JARVIS-005).
   *
   * Enforced by `execute()` before any dispatch, as defence in depth — the
   * fine-grained checks inside `control/*` remain the primary authority and are
   * deliberately NOT removed.
   *
   * Omitted means "no dispatch-layer requirement" (level 0). It is NOT derived
   * from `riskLevel`, because that mapping is unsafe in this codebase:
   *   - `enable_full_control_session` is riskLevel 'high' but is the very tool
   *     that grants level 2, so requiring level 2 to run it deadlocks elevation;
   *   - `open_app` is 'medium' and must stay usable at the default level 0;
   *   - `run_command` is 'high' and legitimately serves allow-listed developer
   *     commands at level 0.
   * Tools that need a floor declare one explicitly instead.
   */
  requiredLevel?: number;
  inputSchema: Record<string, ToolSchemaProperty>;
  fallbacks: string[];
  /**
   * Low-risk tools only: identical calls within 30 s reuse the last result.
   * Opt-in, because most low-risk tools read state that changes ("is notepad
   * open?") or act ("disable full control"), and a cached answer is wrong
   * for them.
   */
  cacheable?: boolean;
  /** Phase 5: optional per-tool retry policy (overrides registry default) */
  retryPolicy?: Partial<RetryPolicy>;
  /**
   * Category, risk per action, reversibility, external effect, output. Taken
   * from core/toolCatalog.ts at registration unless the tool declares it.
   */
  meta?: ToolMeta;
  /**
   * P5: a check of the call's real effect, run after a reported success.
   * Without one, core/verifiers.ts has the check or the reason there is none.
   */
  verify?: Verifier;
  /**
   * Phase 5: optional rollback hook.
   * Called when the tool succeeded but a downstream step failed and
   * the orchestrator requests undoing this tool's side effects.
   */
  rollback?(args: Record<string, unknown>, executionResult: string): Promise<void>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/**
 * Phase 5: Per-tool health and metrics tracking.
 */
export interface ToolMetrics {
  tool: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  /** Running average execution duration in ms */
  avgDurationMs: number;
  /** Consecutive failure count — resets on any success */
  consecutiveFailures: number;
  /** True if the tool has been automatically degraded due to repeated failures */
  degraded: boolean;
  lastFailureReason?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

/** Phase 5: Execution history entry */
export interface ExecutionRecord {
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  error?: string;
  attemptNumber: number;
  timestamp: number;
}

// OpenAI-compatible definition shape (used in LLM API calls)
export interface LLMToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];
    };
  };
}

/**
 * open_app and the control_* skills answer with JSON carrying their own
 * "success" field. Only "Error:"-prefixed text used to count as a failure, so
 * a refused or failed action was reported as done ("Opening paint, sir.").
 */
export function reportedFailure(output: string): { failed: boolean; reason?: string } {
  const text = output.trimStart();
  if (!text.startsWith('{')) return { failed: false };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.success === false) {
      const reason = typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : undefined;
      return reason ? { failed: true, reason } : { failed: true };
    }
  } catch {
    // Not JSON: judged by the text prefix as before.
  }
  return { failed: false };
}

// ─── Tool Registry V2 ─────────────────────────────────────────────────────────

/** Calls per tool per minute at risk level 0–4 (JARVIS_TOOL_RATE_LIMITS overrides; 0 = no limit). */
const DEFAULT_RATE_LIMITS = [120, 60, 20, 10, 10] as const;
const RATE_WINDOW_MS = 60_000;

export function rateLimitFor(level: number, env: Record<string, string | undefined> = process.env): number {
  const configured = (env['JARVIS_TOOL_RATE_LIMITS'] ?? '').split(',').map((v) => v.trim());
  const value = Number(configured[level]);
  if (configured[level] !== undefined && configured[level] !== '' && Number.isFinite(value) && value >= 0) return value;
  return DEFAULT_RATE_LIMITS[Math.max(0, Math.min(4, level))] ?? 10;
}

/** A tool result with credentials replaced in what it says. */
function redactResult(result: ToolResult): ToolResult {
  const output = redact(result.output);
  const error = result.error === undefined ? undefined : redact(result.error);
  if (output === result.output && error === result.error) return result;
  return { ...result, output, ...(error !== undefined ? { error } : {}) };
}

export class ToolRegistryV2 {
  private tools = new Map<string, AgentTool>();
  /** Tools registered without catalogue or declared metadata. */
  private _derivedMeta = new Set<string>();
  private resultCache = new Map<string, { result: string; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 30_000;
  private readonly EXECUTION_TIMEOUT_MS = 25_000;
  private executionQueue = Promise.resolve<any>(null);

  private _llmDefCache: LLMToolDefinition[] | null = null;
  private _singleDefMap = new Map<string, { def: LLMToolDefinition; tokens: number }>();

  // Phase 5 additions
  private _metrics = new Map<string, ToolMetrics>();
  /** Execution history ring buffer (max 200 entries) */
  private _history: ExecutionRecord[] = [];
  /** When each tool was last dispatched, for the per-minute limits. */
  private _callTimes = new Map<string, number[]>();
  private readonly HISTORY_MAX = 200;
  /** Consecutive failures before a tool is auto-degraded */
  private readonly DEGRADE_THRESHOLD = 5;
  /** Default retry policy for all tools (can be overridden per-tool) */
  private readonly DEFAULT_RETRY: RetryPolicy = {
    maxRetries: 2,
    baseDelayMs: 500,
    skipRetryOnTimeout: true,
  };

  // ── Registration ──────────────────────────────────────────────────────────

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      const existing = this.tools.get(tool.name);
      if (existing === tool) {
        return; // Exact duplicate reference, skip
      }
      // If description and schema are identical, skip overwriting
      if (existing && existing.description === tool.description && JSON.stringify(existing.inputSchema) === JSON.stringify(tool.inputSchema)) {
        return;
      }
      console.log(`[ToolRegistry] Updating registered tool: "${tool.name}"`);
    }
    // JARVIS-005: a high-risk tool with no declared floor is authorised only by
    // whatever controller it happens to call. That is the gap P1-04 describes,
    // so make it visible at registration rather than leaving it implicit.
    if (tool.riskLevel === 'high' && typeof tool.requiredLevel !== 'number') {
      console.warn(
        `[ToolRegistry] ⚠️  High-risk tool "${tool.name}" declares no requiredLevel — ` +
        'dispatch-layer authorization is not enforced for it; it relies entirely on ' +
        'its own controller checks.',
      );
    }

    // Category, risks and effects. A tool the catalogue does not know gets
    // derived defaults (never risk 0) and a warning.
    this._derivedMeta.delete(tool.name);
    if (!tool.meta) {
      const catalogued = TOOL_CATALOG[tool.name];
      if (catalogued) {
        tool.meta = catalogued;
      } else {
        tool.meta = deriveMeta(tool);
        this._derivedMeta.add(tool.name);
        console.warn(
          `[ToolRegistry] ⚠️  Tool "${tool.name}" has no metadata in core/toolCatalog.ts — ` +
          `using derived defaults (risk ${tool.meta.risk}).`,
        );
      }
    }

    this.tools.set(tool.name, tool);
    this._llmDefCache = null; // Invalidate cached definitions

    // Pre-build single tool definition & pre-compute estimated tokens
    const def: LLMToolDefinition = {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object' as const,
          properties: Object.fromEntries(
            Object.entries(tool.inputSchema).map(([key, prop]) => [
              key,
              {
                type: prop.type,
                description: prop.description,
                ...(prop.enum ? { enum: prop.enum } : {}),
              },
            ])
          ),
          required: Object.entries(tool.inputSchema)
            .filter(([, prop]) => prop.required)
            .map(([key]) => key),
        },
      },
    };

    const estTokens = Math.ceil(JSON.stringify(def).length / 4);
    this._singleDefMap.set(tool.name, { def, tokens: estTokens });

    for (const fallback of tool.fallbacks) {
      if (!this.tools.has(fallback)) {
        console.warn(`[ToolRegistry] ⚠️  Tool "${tool.name}" declares fallback "${fallback}" which is not yet registered.`);
      }
    }

    // Debug log only if explicitly enabled
    if (process.env.JARVIS_VERBOSE_LOGS === 'true') {
      console.log(`[ToolRegistry] Registered: "${tool.name}" [risk: ${tool.riskLevel}]`);
    }
  }

  registerMany(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
    console.log(`[ToolRegistry] ✅ Registered ${tools.length} tool(s) into registry.`);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  getAll(): AgentTool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  // ── Capabilities ──────────────────────────────────────────────────────────

  getMeta(name: string): ToolMeta | undefined {
    return this.tools.get(name)?.meta;
  }

  /** Tools registered with derived metadata because the catalogue has no entry. */
  derivedMetaTools(): string[] {
    return [...this._derivedMeta];
  }

  /**
   * Risk of one call. For a tool with actions, the requested action's risk; an
   * unknown or missing action gets the tool's highest risk, never a lower one.
   * An unregistered tool is 4.
   */
  riskOf(name: string, args: Record<string, unknown> = {}): RiskTier {
    const meta = this.getMeta(name);
    if (!meta) return 4;
    const action = typeof args['action'] === 'string' ? args['action'].toLowerCase() : '';
    const risk = meta.actions ? meta.actions[action]?.risk ?? meta.risk : meta.risk;
    // Changing something outside the PC (sending, posting) is never below 2.
    return meta.external === 'change' ? (Math.max(2, risk) as RiskTier) : risk;
  }

  /** What JARVIS can do, grouped by category, optionally filtered. */
  describeCapabilities(filter: { category?: string; maxRisk?: number } = {}): CapabilityGroup[] {
    const wanted = filter.category?.trim().toUpperCase();
    const groups = new Map<ToolCategory, CapabilityEntry[]>();
    for (const tool of this.tools.values()) {
      const meta = tool.meta;
      if (!meta || (wanted && meta.category !== wanted)) continue;
      const risks = meta.actions ? Object.values(meta.actions).map((a) => a.risk) : [meta.risk];
      const min = Math.min(...risks) as RiskTier;
      const max = Math.max(...risks) as RiskTier;
      if (filter.maxRisk !== undefined && min > filter.maxRisk) continue;
      const entries = groups.get(meta.category) ?? [];
      entries.push({
        name: tool.name,
        summary: meta.effect,
        risk: [min, max],
        approval: approvalNeedFor(max),
        reversible: meta.reversible,
        external: meta.external,
        ...(meta.actions ? { actions: Object.keys(meta.actions) } : {}),
      });
      groups.set(meta.category, entries);
    }
    return TOOL_CATEGORIES
      .filter((category) => groups.has(category))
      .map((category) => ({
        category,
        tools: groups.get(category)!.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }

  /** One line per category with its tools, e.g. for the console. */
  capabilitySummary(): string {
    return this.describeCapabilities()
      .map((group) => `${group.category}: ${group.tools.map((t) => t.name).join(', ')}`)
      .join('\n');
  }

  // ── LLM Definitions ───────────────────────────────────────────────────────

  /**
   * Returns OpenAI-compatible tool definitions to pass in LLM API calls.
   * Cached per tool for maximum planning performance.
   */
  getLLMDefinitions(toolNames?: string[]): LLMToolDefinition[] {
    if (toolNames && toolNames.length > 0) {
      const defs: LLMToolDefinition[] = [];
      for (const name of toolNames) {
        const cached = this._singleDefMap.get(name);
        if (cached) defs.push(cached.def);
      }
      return defs;
    }

    if (this._llmDefCache) {
      return this._llmDefCache;
    }

    const defs: LLMToolDefinition[] = [];
    for (const entry of this._singleDefMap.values()) {
      defs.push(entry.def);
    }

    this._llmDefCache = defs;
    return defs;
  }

  /**
   * Fast token estimation for selected tools without JSON.stringify overhead.
   */
  getToolTokensEstimate(toolNames?: string[]): number {
    if (toolNames && toolNames.length > 0) {
      let total = 0;
      for (const name of toolNames) {
        const cached = this._singleDefMap.get(name);
        if (cached) total += cached.tokens;
      }
      return total;
    }

    let total = 0;
    for (const entry of this._singleDefMap.values()) {
      total += entry.tokens;
    }
    return total;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  private validateArgs(
    tool: AgentTool,
    args: Record<string, unknown>
  ): string | null {
    for (const [key, schema] of Object.entries(tool.inputSchema)) {
      if (schema.required && !(key in args)) {
        return `Missing required argument: "${key}"`;
      }
      if (key in args) {
        const val = args[key];
        const actualType = Array.isArray(val) ? 'array' : typeof val;
        if (actualType !== schema.type) {
          return `Argument "${key}" expects type "${schema.type}" but got "${actualType}"`;
        }
        // Skills lower-case the value themselves, so "Close" is accepted as "close".
        if (schema.enum && typeof val === 'string' && !schema.enum.some((e) => e.toLowerCase() === val.toLowerCase())) {
          return `Argument "${key}" must be one of: ${schema.enum.join(', ')}`;
        }
      }
    }
    return null; // valid
  }

  // ── Cache ─────────────────────────────────────────────────────────────────

  private isCacheable(tool: AgentTool): boolean {
    return tool.cacheable === true && tool.riskLevel === 'low';
  }

  private getCacheKey(name: string, args: Record<string, unknown>): string {
    return `${name}::${JSON.stringify(args)}`;
  }

  private getFromCache(name: string, args: Record<string, unknown>): string | null {
    const key = this.getCacheKey(name, args);
    const entry = this.resultCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.resultCache.delete(key);
      return null;
    }
    return entry.result;
  }

  private setCache(name: string, args: Record<string, unknown>, result: string): void {
    const key = this.getCacheKey(name, args);
    this.resultCache.set(key, { result, expiresAt: Date.now() + this.CACHE_TTL_MS });
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  /**
   * Execute a tool by name.
   * Pipeline:
   *   1. Tool exists check
   *   2. Schema validation
   *   3. Cache lookup
   *   4. Execute with AbortSignal + timeout
   *   5. On failure: try fallback tools in order
   *   6. Return structured ToolResult
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<ToolResult> {
    const start = Date.now();

    // 1. Tool exists?
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: `Tool "${name}" is not registered. Available: ${this.names().join(', ')}`,
        error: `Unknown tool: ${name}`,
        tool: name,
        durationMs: Date.now() - start,
      };
    }

    // 2. Authorization gate (JARVIS-005).
    // Runs before schema validation, so an unauthorized caller gets
    // PERMISSION_DENIED rather than learning the tool's argument schema from a
    // validation error. Also before the cache, so a denied call is never served
    // a cached result, and before dispatch, so a tool that does not route
    // through a control/* controller still inherits a gate.
    let belowFloor = false;
    if (typeof tool.requiredLevel === 'number' && tool.requiredLevel > 0) {
      if (!permissionSession.checkPermission(tool.requiredLevel, name)) {
        // Policy `ask`: an approval can stand in for full control mode, so the
        // risk engine below decides — still before anything runs.
        if (level2Policy() === 'ask' && tool.requiredLevel <= 2) {
          belowFloor = true;
        } else {
          securityAuditLogger.denied(
            name,
            'HIGH_RISK',
            `Dispatch denied: requires permission level ${tool.requiredLevel}`,
            name,
          );
          return {
            success: false,
            output:
              `Tool "${name}" requires permission level ${tool.requiredLevel}. ` +
              'Enable a full-control session first, sir.',
            error: 'PERMISSION_DENIED',
            tool: name,
            durationMs: Date.now() - start,
          };
        }
      }
    }

    // 3. Schema validation
    const validationError = this.validateArgs(tool, args);
    if (validationError) {
      return {
        success: false,
        output: `Invalid arguments for tool "${name}": ${validationError}`,
        error: validationError,
        tool: name,
        durationMs: Date.now() - start,
      };
    }

    // Check abort signal first
    if (externalSignal?.aborted) {
      return {
        success: false,
        output: `Execution of tool "${name}" was aborted: Error: ABORTED`,
        error: 'ABORTED',
        tool: name,
        durationMs: Date.now() - start,
      };
    }

    // 3b. Risk engine (docs/upgrade/PERMISSION_MODEL.md): run, ask, or refuse
    // this concrete call. It runs after the checks above and never lets
    // through what they refuse.
    let assessment: RiskAssessment;
    let decision: RiskDecision;
    try {
      assessment = assessRisk({ tool: name, args, baseRisk: this.riskOf(name, args) });
      decision = decide(assessment, {
        sessionLevel: permissionSession.getCurrentLevel(),
        policy: level2Policy(),
        floor: belowFloor ? tool.requiredLevel : 0,
      });
    } catch (err) {
      // Fail closed: a call whose risk cannot be assessed does not run.
      const message = `Refused by safety policy: the risk check failed (${err instanceof Error ? err.message : String(err)}).`;
      console.error(`[ToolRegistry] ⛔ ${message}`);
      securityAuditLogger.denied(name, 'LEVEL_4', message, name);
      return { success: false, output: message, error: 'RISK_REFUSED', tool: name, durationMs: Date.now() - start };
    }
    if (decision.outcome === 'deny') {
      console.warn(`[ToolRegistry] ⛔ ${decision.message}`);
      securityAuditLogger.denied(name, `LEVEL_${assessment.level}`, decision.message, name);
      return { success: false, output: decision.message, error: decision.code, tool: name, durationMs: Date.now() - start };
    }

    // Per-minute limit by the call's risk, before anyone is asked to approve it.
    const overLimit = this.overRateLimit(name, assessment.level);
    if (overLimit) {
      console.warn(`[ToolRegistry] ⛔ ${overLimit}`);
      securityAuditLogger.denied(name, `LEVEL_${assessment.level}`, overLimit, name);
      return { success: false, output: overLimit, error: 'RATE_LIMITED', tool: name, durationMs: Date.now() - start };
    }
    let approvedCall: ApprovedCall | undefined;
    if (decision.outcome === 'approve') {
      const label = callLabel(name, assessment.action);
      const actionMeta = assessment.action ? tool.meta?.actions?.[assessment.action] : undefined;
      const effect = actionMeta?.effect ?? tool.meta?.effect;
      const reversible = actionMeta?.reversible ?? tool.meta?.reversible;
      const request = buildApprovalRequest({
        tool: name,
        ...(assessment.action ? { action: assessment.action } : {}),
        target: assessment.target ?? JSON.stringify(args),
        request: getRequestText(),
        reason: assessment.reasons[0],
        risk: assessment.level,
        // The rule that set the level, when it was an argument and not the metadata.
        ...(assessment.reasons.length > 1 ? { riskDetail: assessment.reasons[assessment.reasons.length - 1] } : {}),
        ...(effect ? { effect } : {}),
        ...(reversible ? { reversible } : {}),
        source: getRequestSource() ?? 'cli',
      });
      const approved = await approvalGate.requestApproval(request);
      if (!approved) {
        return {
          success: false,
          output: `Action cancelled by user: ${label} was not approved.`,
          error: 'APPROVAL_DENIED',
          tool: name,
          durationMs: Date.now() - start,
        };
      }
      approvedCall = {
        tool: name, args, level: assessment.level, grantsLevel: decision.grantsLevel,
        approvedAt: Date.now(), requestId: request.id,
      };
    }

    const dispatch = (): Promise<ToolResult> => this.dispatch(tool, args, externalSignal, start);
    return approvedCall ? runApproved(approvedCall, dispatch) : dispatch();
  }

  /** Cache lookup, then execution: low-risk tools directly, others one at a time. */
  private async dispatch(
    tool: AgentTool,
    args: Record<string, unknown>,
    externalSignal: AbortSignal | undefined,
    start: number,
  ): Promise<ToolResult> {
    const name = tool.name;

    // 4. Cache lookup (cacheable low-risk tools only)
    if (this.isCacheable(tool)) {
      const cached = this.getFromCache(name, args);
      if (cached !== null) {
        return {
          success: true,
          output: cached,
          tool: name,
          durationMs: Date.now() - start,
          fromCache: true,
        };
      }
    }

    this.noteCall(name);
    const runUnderLock = async () => {
      // 4. Execute with timeout + abort signal. What a tool returns goes on to
      // the LLM, memory and logs, so credentials in it are replaced here.
      const ran = redactResult(await this.executeWithFallbacks(tool, args, externalSignal, start));
      // A reported success counts once its effect has been checked.
      const result = ran.success ? await this.verifyResult(tool, args, ran) : ran;

      // 5. Cache successful results of cacheable tools
      if (result.success && this.isCacheable(tool)) {
        this.setCache(name, args, result.output);
      }
      return result;
    };

    if (tool.riskLevel === 'low') {
      return runUnderLock();
    }

    // Queue medium/high risk executions sequentially
    const queuedResult = new Promise<ToolResult>((resolve) => {
      this.executionQueue = this.executionQueue.then(async () => {
        try {
          const res = await runUnderLock();
          resolve(res);
        } catch (err: any) {
          resolve({
            success: false,
            output: redact(`Queue execution error: ${err.message}`),
            error: redact(String(err.message)),
            tool: tool.name,
            durationMs: Date.now() - start,
          });
        }
      });
    });

    return queuedResult;
  }

  /**
   * Attempts the primary tool then falls through to each fallback in order.
   * Phase 5: applies per-tool retry policy with exponential backoff,
   * records metrics and execution history on every attempt.
   */
  private async executeWithFallbacks(
    tool: AgentTool,
    args: Record<string, unknown>,
    externalSignal: AbortSignal | undefined,
    startTime: number
  ): Promise<ToolResult> {
    const chain = [tool.name, ...tool.fallbacks];

    for (let i = 0; i < chain.length; i++) {
      const toolName = chain[i]!;
      const currentTool = this.tools.get(toolName);

      if (!currentTool) {
        console.warn(`[ToolRegistry] Fallback tool "${toolName}" not registered. Skipping.`);
        continue;
      }

      // Phase 5: warn if degraded but still attempt (degraded != disabled)
      const metrics = this._ensureMetrics(toolName);
      if (metrics.degraded) {
        console.warn(`[ToolRegistry] ⚠️ Tool "${toolName}" is degraded (${metrics.consecutiveFailures} consecutive failures). Attempting anyway.`);
      }

      // Phase 5: resolve retry policy (per-tool overrides default)
      const policy: RetryPolicy = {
        ...this.DEFAULT_RETRY,
        ...(currentTool.retryPolicy ?? {}),
      };

      let lastErr: string | undefined;
      let attemptNumber = 0;

      // Retry loop for this tool in the chain
      for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        attemptNumber = attempt;
        const attemptStart = Date.now();

        // Backoff before retry (not before first attempt)
        if (attempt > 0) {
          const delay = policy.baseDelayMs * Math.pow(2, attempt - 1);
          console.log(`[ToolRegistry] Retry ${attempt}/${policy.maxRetries} for "${toolName}" in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }

        try {
          // Phase 5: route through sandbox for medium/high risk tools
          let output: string;
          if (currentTool.riskLevel === 'low') {
            output = await this._executeRaw(currentTool, args, externalSignal);
          } else {
            output = await toolExecutionSandbox.run(currentTool, args, externalSignal);
          }
          const durationMs = Date.now() - attemptStart;

          const reported = reportedFailure(output);
          const isError = output.toLowerCase().startsWith('error:') ||
                          output.toLowerCase().startsWith('tool "') ||
                          reported.failed;

          // Record metrics and history
          this._recordMetric(toolName, !isError, durationMs, isError ? output : undefined);
          this._pushHistory({ tool: toolName, args, success: !isError, durationMs, error: isError ? output : undefined, attemptNumber, timestamp: Date.now() });

          if (!isError || i === chain.length - 1) {
            return {
              success: !isError,
              output,
              ...(reported.reason ? { error: reported.reason } : {}),
              tool: toolName,
              durationMs: Date.now() - startTime,
              attemptNumber,
              ...(i > 0 ? { fromFallback: toolName } : {}),
            };
          }

          console.warn(`[ToolRegistry] Tool "${toolName}" returned error, trying fallback...`);
          break; // move to next in chain

        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const durationMs = Date.now() - attemptStart;
          lastErr = errMsg;

          // Phase 5: skip retry on timeout/abort if policy says so
          const isTimeout = errMsg.includes('AbortError') || errMsg.includes('aborted') || errMsg.includes('timeout');
          if (isTimeout && policy.skipRetryOnTimeout) {
            console.warn(`[ToolRegistry] Tool "${toolName}" timed out — no retry per policy.`);
            this._recordMetric(toolName, false, durationMs, errMsg);
            this._pushHistory({ tool: toolName, args, success: false, durationMs, error: errMsg, attemptNumber, timestamp: Date.now() });
            break;
          }

          this._recordMetric(toolName, false, durationMs, errMsg);
          this._pushHistory({ tool: toolName, args, success: false, durationMs, error: errMsg, attemptNumber, timestamp: Date.now() });

          if (attempt < policy.maxRetries) {
            console.warn(`[ToolRegistry] Tool "${toolName}" threw (attempt ${attempt + 1}/${policy.maxRetries + 1}): ${errMsg}. Retrying...`);
          }
        }
      } // end retry loop

      // If we've exhausted retries for this chain entry, try next fallback
      if (i < chain.length - 1) {
        console.warn(`[ToolRegistry] Tool "${toolName}" exhausted retries. Trying next fallback...`);
      } else {
        // All options exhausted
        return {
          success: false,
          output: `All tool attempts failed for "${tool.name}". Last error: ${lastErr ?? 'unknown'}`,
          error: lastErr,
          tool: toolName,
          durationMs: Date.now() - startTime,
          attemptNumber,
        };
      }
    }

    return {
      success: false,
      output: `No tools available for "${tool.name}"`,
      error: 'All tools unavailable',
      tool: tool.name,
      durationMs: Date.now() - startTime,
    };
  }

  /** Direct execution with global timeout — used for low-risk tools only.
   *  Medium/high risk tools go through toolExecutionSandbox.run() instead. */
  private async _executeRaw(
    tool: AgentTool,
    args: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<string> {
    const ac = new AbortController();

    // Chain external abort signal
    if (externalSignal) {
      externalSignal.addEventListener('abort', () => ac.abort(), { once: true });
    }

    const timeoutId = setTimeout(() => ac.abort(), this.EXECUTION_TIMEOUT_MS);

    try {
      const result = await tool.execute(args, ac.signal);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  /**
   * Find tools that could handle a given capability description.
   * Simple keyword matching — good enough for dynamic tool selection.
   */
  findByCapability(capability: string): AgentTool[] {
    const lower = capability.toLowerCase();
    return [...this.tools.values()].filter(tool =>
      tool.description.toLowerCase().includes(lower) ||
      tool.name.toLowerCase().includes(lower)
    );
  }

  getStats(): Record<string, unknown> {
    return {
      totalTools: this.tools.size,
      cacheSize: this.resultCache.size,
      tools: this.names(),
    };
  }

  // ── Phase 5: Metrics, Health, History, Rollback ───────────────────────────

  private _ensureMetrics(name: string): ToolMetrics {
    if (!this._metrics.has(name)) {
      this._metrics.set(name, {
        tool: name, totalCalls: 0, successCount: 0, failureCount: 0,
        avgDurationMs: 0, consecutiveFailures: 0, degraded: false,
      });
    }
    return this._metrics.get(name)!;
  }

  private _recordMetric(name: string, success: boolean, durationMs: number, error?: string): void {
    const m = this._ensureMetrics(name);
    m.totalCalls++;
    m.avgDurationMs = Math.round((m.avgDurationMs * (m.totalCalls - 1) + durationMs) / m.totalCalls);
    if (success) {
      m.successCount++;
      m.consecutiveFailures = 0;
      m.lastSuccessAt = Date.now();
      if (m.degraded) {
        console.log(`[ToolRegistry] ✅ Tool "${name}" recovered — marking healthy.`);
        m.degraded = false;
      }
    } else {
      m.failureCount++;
      m.consecutiveFailures++;
      m.lastFailureReason = error;
      m.lastFailureAt = Date.now();
      if (m.consecutiveFailures >= this.DEGRADE_THRESHOLD && !m.degraded) {
        console.warn(`[ToolRegistry] ⚠️ Tool "${name}" degraded after ${m.consecutiveFailures} consecutive failures.`);
        m.degraded = true;
      }
    }
  }

  private _pushHistory(record: ExecutionRecord): void {
    if (this._history.length >= this.HISTORY_MAX) {
      this._history.shift(); // drop oldest
    }
    // Kept without credentials: action_history shows it, and arguments can
    // carry a token (a command line, a URL).
    this._history.push({
      ...record,
      args: redactDeep(record.args),
      ...(record.error !== undefined ? { error: redact(record.error) } : {}),
    });
  }

  /** Returns metrics for all tools or a specific tool. */
  getMetrics(toolName?: string): ToolMetrics[] {
    if (toolName) {
      const m = this._metrics.get(toolName);
      return m ? [m] : [];
    }
    return [...this._metrics.values()];
  }

  /** P5: check the effect of a successful call; a failed check fails the call. */
  private async verifyResult(tool: AgentTool, args: Record<string, unknown>, result: ToolResult): Promise<ToolResult> {
    const ran = (result.fromFallback ? this.tools.get(result.fromFallback) : undefined) ?? tool;
    const verification = await verifyCall(ran.name, args, result.output, ran.verify);
    if (!verification) return result;
    if (verification.status !== 'failed') {
      if (verification.status === 'verified') console.log(`[ToolRegistry] ✓ ${ran.name}: checked — ${verification.evidence}.`);
      return { ...result, verification };
    }
    const evidence = redact(verification.evidence);
    console.warn(`[ToolRegistry] ✗ ${ran.name} reported success, but ${evidence}.`);
    this._pushHistory({
      tool: ran.name, args, success: false, durationMs: 0, error: `VERIFICATION_FAILED: ${evidence}`,
      attemptNumber: result.attemptNumber ?? 0, timestamp: Date.now(),
    });
    return {
      ...result,
      success: false,
      output: `${ran.name} reported success, but the check found that ${evidence}.`,
      error: 'VERIFICATION_FAILED',
      verification: { status: 'failed', evidence },
    };
  }

  /** The limit message when `name` has run as often as its limit allows this minute. */
  private overRateLimit(name: string, level: number): string | null {
    const limit = rateLimitFor(level);
    if (limit <= 0) return null;
    const now = Date.now();
    const recent = (this._callTimes.get(name) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    this._callTimes.set(name, recent);
    return recent.length >= limit
      ? `Rate limit: ${name} ran ${recent.length} times in the last minute (limit ${limit} at risk level ${level}). Try again in a minute.`
      : null;
  }

  private noteCall(name: string): void {
    const times = this._callTimes.get(name) ?? [];
    times.push(Date.now());
    this._callTimes.set(name, times);
  }

  /** Returns recent execution history (newest last). */
  getHistory(limit = 50): ExecutionRecord[] {
    return this._history.slice(-limit);
  }

  /** Health report: lists degraded tools and overall registry health. */
  getHealthReport(): { healthy: boolean; degradedTools: string[]; metrics: ToolMetrics[] } {
    const metrics = [...this._metrics.values()];
    const degradedTools = metrics.filter(m => m.degraded).map(m => m.tool);
    return { healthy: degradedTools.length === 0, degradedTools, metrics };
  }

  /**
   * Phase 5: Execute rollback for a previously succeeded tool.
   * Calls tool.rollback() if defined; no-op otherwise.
   */
  async rollback(name: string, args: Record<string, unknown>, executionResult: string): Promise<void> {
    const tool = this.tools.get(name);
    if (!tool?.rollback) {
      console.log(`[ToolRegistry] No rollback defined for "${name}" — skipping.`);
      return;
    }
    try {
      console.log(`[ToolRegistry] Rolling back "${name}"...`);
      await tool.rollback(args, executionResult);
      console.log(`[ToolRegistry] Rollback for "${name}" completed.`);
    } catch (err) {
      console.error(`[ToolRegistry] Rollback for "${name}" failed:`, err);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const toolRegistryV2 = new ToolRegistryV2();
