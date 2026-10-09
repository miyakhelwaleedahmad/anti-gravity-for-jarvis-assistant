/**
 * core/agents/workspace.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The shared workspace of one root task: the question, sources, findings,
 * claims, evidence, conflicts, artifacts, worker results, decisions, messages,
 * progress, events and the final synthesis. Every agent of the root reads and
 * adds to it, so no agent redoes another's work.
 *
 * Append-only with merge, not last-write-wins (the weakness of shared session
 * state noted in RECURSIVE_AGENT_RESEARCH.md §4.7):
 *  - a source with the same URL is the same source;
 *  - a finding with the same text is the same finding, corroborated by the
 *    second agent instead of duplicated;
 *  - two claims about the same subject and attribute with different values
 *    open a conflict record instead of overwriting each other.
 *
 * Each addition emits its event at once (FINDING_DISCOVERED, ARTIFACT_CREATED,
 * CONFLICT_DETECTED …), so other agents learn of it while it is being made.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentEvent, AgentEventType, AgentMessage, ChildResult, Claim, Conflict, Finding, Source, WorkspaceArtifact,
} from './types.js';
import { normalizeText, normalizeUrl, similarity, statementKey } from './similarity.js';

export type WorkspaceEmit = (
  type: AgentEventType,
  ids: { taskId?: string; agentId?: string },
  data: Record<string, unknown>,
) => void;

export interface SpawnDecisionRecord {
  at: number;
  agentId: string;
  taskId: string;
  decision: string;
  reasons: string[];
  childRole?: string;
  childAgentId?: string;
  childTaskId?: string;
}

export interface ProgressEntry {
  taskId: string;
  agentId: string;
  percent?: number;
  note: string;
  at: number;
}

const EVENT_LIMIT = 2_000;
const MESSAGE_LIMIT = 500;

function nowMs(): number {
  return Date.now();
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function normalizeValue(v: string): string {
  const t = v.trim().toLowerCase().replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) && t !== '' ? String(n) : normalizeText(t);
}

export class SharedWorkspace {
  readonly createdAt = nowMs();
  private readonly sourcesById = new Map<string, Source>();
  private readonly sourceByUrl = new Map<string, string>();
  private readonly findingsById = new Map<string, Finding>();
  private readonly findingByKey = new Map<string, string>();
  private readonly claimsById = new Map<string, Claim>();
  private readonly conflictsById = new Map<string, Conflict>();
  private readonly artifactsById = new Map<string, WorkspaceArtifact>();
  private readonly resultsByTask = new Map<string, ChildResult>();
  private readonly progressByTask = new Map<string, ProgressEntry>();
  readonly decisions: SpawnDecisionRecord[] = [];
  readonly messages: AgentMessage[] = [];
  readonly events: AgentEvent[] = [];
  /** Agent-to-agent notes kept for the root (key → value), e.g. "plan". */
  readonly notes = new Map<string, unknown>();
  finalSynthesis?: { summary: string; confidence: number; at: number; by: string };

  constructor(
    readonly rootTaskId: string,
    readonly question: string,
    private readonly emit: WorkspaceEmit,
  ) {}

  // ── Events (recorded by the event hub) ─────────────────────────────────────

  record(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  addSource(input: Omit<Source, 'id' | 'retrievedAt' | 'addedBy'> & { retrievedAt?: number }, by: string): { source: Source; duplicate: boolean } {
    const key = input.url ? normalizeUrl(input.url) : `title:${normalizeText(input.title)}`;
    const existingId = this.sourceByUrl.get(key);
    if (existingId) {
      const existing = this.sourcesById.get(existingId)!;
      if (input.quality > existing.quality) existing.quality = clamp01(input.quality);
      if (input.metadata) existing.metadata = { ...existing.metadata, ...input.metadata };
      return { source: existing, duplicate: true };
    }
    const source: Source = {
      id: `src-${randomUUID().slice(0, 8)}`,
      ...input,
      quality: clamp01(input.quality),
      retrievedAt: input.retrievedAt ?? nowMs(),
      addedBy: by,
    };
    this.sourcesById.set(source.id, source);
    this.sourceByUrl.set(key, source.id);
    return { source, duplicate: false };
  }

  getSource(id: string): Source | undefined {
    return this.sourcesById.get(id);
  }

  sources(): Source[] {
    return [...this.sourcesById.values()];
  }

  /** The known source for a URL, so a worker can skip one already read. */
  sourceForUrl(url: string): Source | undefined {
    const id = this.sourceByUrl.get(normalizeUrl(url));
    return id ? this.sourcesById.get(id) : undefined;
  }

  // ── Findings ───────────────────────────────────────────────────────────────

  addFinding(
    input: { text: string; sourceIds?: string[]; confidence: number; tags?: string[]; data?: Record<string, unknown> },
    by: { agentId: string; taskId: string },
  ): { finding: Finding; duplicate: boolean } {
    const key = statementKey(input.text);
    const existingId = this.findingByKey.get(key);
    if (existingId) {
      const existing = this.findingsById.get(existingId)!;
      if (existing.addedBy !== by.agentId && !existing.corroboratedBy.includes(by.agentId)) {
        existing.corroboratedBy.push(by.agentId);
        // An independent second report raises confidence, never above 0.95.
        existing.confidence = Math.min(0.95, Math.max(existing.confidence, clamp01(input.confidence)) + 0.05);
      }
      for (const s of input.sourceIds ?? []) if (!existing.sourceIds.includes(s)) existing.sourceIds.push(s);
      return { finding: existing, duplicate: true };
    }
    const finding: Finding = {
      id: `fnd-${randomUUID().slice(0, 8)}`,
      text: input.text.trim(),
      sourceIds: [...(input.sourceIds ?? [])],
      confidence: clamp01(input.confidence),
      addedBy: by.agentId,
      taskId: by.taskId,
      addedAt: nowMs(),
      corroboratedBy: [],
      ...(input.tags ? { tags: [...input.tags] } : {}),
      ...(input.data ? { data: input.data } : {}),
    };
    this.findingsById.set(finding.id, finding);
    this.findingByKey.set(key, finding.id);
    this.emit('FINDING_DISCOVERED', { taskId: by.taskId, agentId: by.agentId }, {
      findingId: finding.id, text: finding.text, confidence: finding.confidence,
      sourceIds: finding.sourceIds, ...(finding.tags ? { tags: finding.tags } : {}),
      ...(finding.data ? { data: finding.data } : {}),
    });
    return { finding, duplicate: false };
  }

  findings(filter: { agentId?: string; taskId?: string; tag?: string } = {}): Finding[] {
    return [...this.findingsById.values()].filter((f) =>
      (!filter.agentId || f.addedBy === filter.agentId || f.corroboratedBy.includes(filter.agentId))
      && (!filter.taskId || f.taskId === filter.taskId)
      && (!filter.tag || (f.tags ?? []).includes(filter.tag)));
  }

  getFinding(id: string): Finding | undefined {
    return this.findingsById.get(id);
  }

  // ── Claims and conflicts ───────────────────────────────────────────────────

  addClaim(
    input: { subject: string; attribute: string; value: string; sourceIds?: string[]; confidence: number },
    by: { agentId: string; taskId: string },
  ): { claim: Claim; conflict?: Conflict } {
    const claim: Claim = {
      id: `clm-${randomUUID().slice(0, 8)}`,
      subject: input.subject.trim(),
      attribute: input.attribute.trim(),
      value: input.value.trim(),
      sourceIds: [...(input.sourceIds ?? [])],
      confidence: clamp01(input.confidence),
      addedBy: by.agentId,
      addedAt: nowMs(),
    };
    this.claimsById.set(claim.id, claim);
    const same = this.claims({ subject: claim.subject, attribute: claim.attribute });
    const differing = same.filter((c) => normalizeValue(c.value) !== normalizeValue(claim.value));
    if (!differing.length) return { claim };

    let conflict = [...this.conflictsById.values()].find((c) =>
      c.status === 'open'
      && normalizeText(c.subject) === normalizeText(claim.subject)
      && normalizeText(c.attribute) === normalizeText(claim.attribute));
    if (conflict) {
      if (!conflict.claimIds.includes(claim.id)) conflict.claimIds.push(claim.id);
    } else {
      conflict = {
        id: `cfl-${randomUUID().slice(0, 8)}`,
        subject: claim.subject,
        attribute: claim.attribute,
        claimIds: same.map((c) => c.id),
        status: 'open',
        detectedAt: nowMs(),
      };
      this.conflictsById.set(conflict.id, conflict);
    }
    this.emit('CONFLICT_DETECTED', { taskId: by.taskId, agentId: by.agentId }, {
      conflictId: conflict.id, subject: conflict.subject, attribute: conflict.attribute,
      values: conflict.claimIds.map((id) => this.claimsById.get(id)?.value),
    });
    return { claim, conflict };
  }

  claims(filter: { subject?: string; attribute?: string } = {}): Claim[] {
    return [...this.claimsById.values()].filter((c) =>
      (!filter.subject || normalizeText(c.subject) === normalizeText(filter.subject))
      && (!filter.attribute || normalizeText(c.attribute) === normalizeText(filter.attribute)));
  }

  getClaim(id: string): Claim | undefined {
    return this.claimsById.get(id);
  }

  conflicts(status?: Conflict['status']): Conflict[] {
    return [...this.conflictsById.values()].filter((c) => !status || c.status === status);
  }

  /**
   * Settles a conflict: `resolved` with the value chosen and why, or
   * `unresolved` when the evidence does not decide it (then the uncertainty is
   * reported with the final answer).
   */
  resolveConflict(
    conflictId: string,
    outcome: { status: 'resolved' | 'unresolved'; value?: string; reason: string; confidence: number },
    by: { agentId: string; taskId: string },
  ): Conflict | undefined {
    const conflict = this.conflictsById.get(conflictId);
    if (!conflict) return undefined;
    conflict.status = outcome.status;
    conflict.resolution = {
      value: outcome.value ?? '', reason: outcome.reason, confidence: clamp01(outcome.confidence),
      by: by.agentId, at: nowMs(),
    };
    this.emit('CONFLICT_RESOLVED', { taskId: by.taskId, agentId: by.agentId }, {
      conflictId, status: conflict.status, value: conflict.resolution.value, reason: outcome.reason,
    });
    return conflict;
  }

  /**
   * Picks the value whose supporting sources are best (sum of source quality ×
   * claim confidence). A clear winner (ahead by `margin`) resolves the
   * conflict; otherwise it is marked unresolved, or, with `leaveOpenIfUnclear`,
   * left open so a verification can still settle it.
   */
  resolveBySourceQuality(
    conflictId: string, by: { agentId: string; taskId: string }, margin = 0.2, opts: { leaveOpenIfUnclear?: boolean } = {},
  ): Conflict | undefined {
    const conflict = this.conflictsById.get(conflictId);
    if (!conflict || conflict.status !== 'open') return conflict;
    const scores = new Map<string, { value: string; score: number }>();
    for (const id of conflict.claimIds) {
      const c = this.claimsById.get(id);
      if (!c) continue;
      const quality = c.sourceIds.length
        ? Math.max(...c.sourceIds.map((s) => this.sourcesById.get(s)?.quality ?? 0.3))
        : 0.3;
      const key = normalizeValue(c.value);
      const entry = scores.get(key) ?? { value: c.value, score: 0 };
      entry.score += quality * c.confidence;
      scores.set(key, entry);
    }
    const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
    if (ranked.length >= 2 && ranked[0].score - ranked[1].score >= margin) {
      const total = ranked.reduce((s, r) => s + r.score, 0) || 1;
      return this.resolveConflict(conflictId, {
        status: 'resolved', value: ranked[0].value,
        reason: `better-supported sources (${ranked[0].score.toFixed(2)} vs ${ranked[1].score.toFixed(2)})`,
        confidence: ranked[0].score / total,
      }, by);
    }
    if (opts.leaveOpenIfUnclear) return conflict;
    return this.resolveConflict(conflictId, {
      status: 'unresolved',
      reason: 'sources of similar quality disagree',
      confidence: ranked.length ? ranked[0].score / (ranked.reduce((s, r) => s + r.score, 0) || 1) : 0,
    }, by);
  }

  // ── Artifacts ──────────────────────────────────────────────────────────────

  addArtifact(input: Omit<WorkspaceArtifact, 'artifactId' | 'createdAt'>): WorkspaceArtifact {
    const artifact: WorkspaceArtifact = { artifactId: `art-${randomUUID().slice(0, 8)}`, createdAt: nowMs(), ...input };
    this.artifactsById.set(artifact.artifactId, artifact);
    this.emit('ARTIFACT_CREATED', { taskId: artifact.taskId, agentId: artifact.producedBy }, {
      artifactId: artifact.artifactId, name: artifact.name,
    });
    return artifact;
  }

  artifacts(): WorkspaceArtifact[] {
    return [...this.artifactsById.values()];
  }

  // ── Results ────────────────────────────────────────────────────────────────

  recordResult(result: ChildResult): void {
    const had = this.resultsByTask.has(result.taskId);
    this.resultsByTask.set(result.taskId, result);
    this.emit(had ? 'RESULT_UPDATED' : 'RESULT_AVAILABLE', { taskId: result.taskId, agentId: result.agentId }, {
      status: result.status, summary: result.summary, confidence: result.confidence,
      findings: result.findings.length, truncated: !!result.truncated,
    });
  }

  result(taskId: string): ChildResult | undefined {
    return this.resultsByTask.get(taskId);
  }

  results(): ChildResult[] {
    return [...this.resultsByTask.values()];
  }

  /** A completed result for (nearly) the same task, for REUSE. */
  findReusableResult(description: string, role?: string, threshold = 0.8): ChildResult | undefined {
    for (const r of this.resultsByTask.values()) {
      if (r.status !== 'COMPLETED') continue;
      if (role && r.role !== role) continue;
      const desc = String(r.data?.['taskDescription'] ?? '');
      if (desc && similarity(desc, description) >= threshold) return r;
    }
    return undefined;
  }

  // ── Progress, decisions, messages ──────────────────────────────────────────

  setProgress(entry: ProgressEntry): void {
    this.progressByTask.set(entry.taskId, entry);
  }

  progress(): ProgressEntry[] {
    return [...this.progressByTask.values()];
  }

  addDecision(record: SpawnDecisionRecord): void {
    this.decisions.push(record);
  }

  addMessage(message: AgentMessage): void {
    this.messages.push(message);
    if (this.messages.length > MESSAGE_LIMIT) this.messages.splice(0, this.messages.length - MESSAGE_LIMIT);
  }

  setFinalSynthesis(summary: string, confidence: number, by: string): void {
    this.finalSynthesis = { summary, confidence: clamp01(confidence), at: nowMs(), by };
  }

  /** Overall confidence: the final synthesis, or the mean of completed results. */
  confidence(): number {
    if (this.finalSynthesis) return this.finalSynthesis.confidence;
    const done = this.results().filter((r) => r.status === 'COMPLETED');
    return done.length ? done.reduce((s, r) => s + r.confidence, 0) / done.length : 0;
  }

  toJSON(): Record<string, unknown> {
    return {
      rootTaskId: this.rootTaskId,
      question: this.question,
      createdAt: this.createdAt,
      sources: this.sources(),
      findings: this.findings(),
      claims: this.claims(),
      conflicts: this.conflicts(),
      artifacts: this.artifacts(),
      results: this.results(),
      decisions: this.decisions,
      messages: this.messages,
      progress: this.progress(),
      notes: Object.fromEntries(this.notes),
      finalSynthesis: this.finalSynthesis,
      confidence: this.confidence(),
      eventCount: this.events.length,
    };
  }
}
