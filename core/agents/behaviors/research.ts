/**
 * core/agents/behaviors/research.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Research Agent and its sub-agents and workers.
 *
 *   Research Agent (specialist)
 *   ├─ GitHub Research Agent
 *   │  ├─ Repository Discovery Worker         github_search
 *   │  └─ Repository Code Analysis Worker     waits for discovery, ranks
 *   │     └─ Project <X> Deep Analysis Worker github_repo: README, files, licence
 *   ├─ Web Research Agent                     web_search
 *   ├─ Architecture Research Agent            judges fit with JARVIS as
 *   │                                         repository findings arrive (live)
 *   └─ Fact Check Worker                      settles conflicting claims
 *
 * Every agent decides with the spawn policy whether to create children; at the
 * depth limit, or for small work, it does the work itself with the same code.
 * Every model call has a rule-based fallback, reported as a limitation.
 * Outside text reaches the model only inside <untrusted_context>.
 */

import type { AgentBehavior } from '../registry.js';
import type { AgentContext, ChildHandle } from '../agentContextApi.js';
import { SpawnRejectedError } from '../agentContextApi.js';
import type { AgentOutcome, ChildResult } from '../types.js';
import {
  askJson, callJson, clamp01, keywords, languageFit, licenseScore, mean, monthsSince, relevance, untrusted,
} from './common.js';

export const RESEARCH_ROLES = {
  research: 'research_agent',
  github: 'github_research_agent',
  web: 'web_research_agent',
  architecture: 'architecture_research_agent',
  discovery: 'repo_discovery_worker',
  codeAnalysis: 'repo_code_analysis_worker',
  deepAnalysis: 'project_deep_analysis_worker',
  factCheck: 'fact_check_worker',
} as const;

export interface RepoCandidate {
  fullName: string;
  url: string;
  description: string;
  stars: number;
  language: string | null;
  license: string | null;
  topics: string[];
  pushedAt: string | null;
  archived: boolean;
  /** Source id in the workspace. */
  sourceId?: string;
}

export interface RankedRepo extends RepoCandidate {
  score: number;
  reasons: string[];
  deepAnalysed: boolean;
  integration?: string;
}

function questionOf(ctx: AgentContext): string {
  return String(ctx.input['question'] ?? ctx.rootRequest ?? ctx.task.description);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function short(fullName: string): string {
  return fullName.split('/').pop() ?? fullName;
}

/** Waits for children; one failed child (not a dependency or budget stop) is retried once. */
async function waitWithRetry(ctx: AgentContext, handles: ChildHandle[]): Promise<{ results: ChildResult[]; notes: string[] }> {
  const results = await ctx.wait(handles);
  const notes: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'FAILED' || ['DEPENDENCY_FAILED', 'BUDGET_EXCEEDED'].includes(r.error?.code ?? '')) continue;
    try {
      const again = await ctx.retry(handles[i]);
      const [r2] = await ctx.wait([again]);
      results[i] = r2;
      notes.push(`${handles[i].name} failed once (${r.error?.message ?? 'error'}) and was retried: ${r2.status.toLowerCase()}.`);
    } catch (err) {
      notes.push(`${handles[i].name} failed (${r.error?.message ?? 'error'}); no retry: ${(err as Error).message}`);
    }
  }
  return { results, notes };
}

// ─── Discovery and analysis (used by workers, or by a parent doing it itself) ─

export async function discoverRepositories(ctx: AgentContext, queries: string[], terms: string[]): Promise<{ candidates: RepoCandidate[]; errors: string[] }> {
  const found = new Map<string, RepoCandidate>();
  const errors: string[] = [];
  for (const query of queries) {
    ctx.checkpoint();
    ctx.progress(`searching GitHub: ${query}`);
    const r = await callJson(ctx, 'github_search', { query, sort: 'stars', limit: 6 });
    if (!r.ok) { errors.push(`GitHub search "${query}" failed: ${r.error}`); continue; }
    for (const raw of (r.data['items'] as Record<string, unknown>[] | undefined) ?? []) {
      const c: RepoCandidate = {
        fullName: String(raw['fullName'] ?? ''), url: String(raw['url'] ?? ''), description: String(raw['description'] ?? ''),
        stars: Number(raw['stars'] ?? 0), language: (raw['language'] as string | null) ?? null, license: (raw['license'] as string | null) ?? null,
        topics: Array.isArray(raw['topics']) ? (raw['topics'] as unknown[]).map(String) : [], pushedAt: (raw['pushedAt'] as string | null) ?? null,
        archived: !!raw['archived'],
      };
      if (!c.fullName || found.has(c.fullName)) continue;
      const source = ctx.addSource({ url: c.url, title: c.fullName, kind: 'github', quality: 0.9, metadata: { stars: c.stars } });
      c.sourceId = source.id;
      found.set(c.fullName, c);
      ctx.addFinding({
        text: `${c.fullName}: ${c.description || 'no description'} (${c.stars} stars, ${c.license ?? 'no licence'}, ${c.language ?? 'language unknown'})`,
        sourceIds: [source.id], confidence: 0.8, tags: ['repository'], data: { repo: c },
      });
      ctx.addClaim({ subject: c.fullName, attribute: 'license', value: c.license ?? 'none', sourceIds: [source.id], confidence: 0.9 });
    }
  }
  const ranked = [...found.values()]
    .filter((c) => !c.archived)
    .map((c) => ({ c, s: 0.6 * relevance(`${c.fullName} ${c.description} ${c.topics.join(' ')}`, terms) + 0.4 * Math.min(1, Math.log10(c.stars + 1) / 5) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
  return { candidates: ranked.slice(0, 6), errors };
}

export function quickScore(c: RepoCandidate, terms: string[]): RankedRepo {
  const reasons: string[] = [];
  const rel = relevance(`${c.fullName} ${c.description} ${c.topics.join(' ')}`, terms);
  const pop = Math.min(1, Math.log10(c.stars + 1) / 5);
  const months = monthsSince(c.pushedAt);
  const recency = months <= 12 ? 1 : months <= 24 ? 0.6 : Number.isFinite(months) ? 0.3 : 0.4;
  const lic = licenseScore(c.license);
  const lang = languageFit(c.language);
  reasons.push(`matches ${Math.round(rel * 100)}% of the request's terms`);
  reasons.push(`${c.stars} stars`);
  reasons.push(Number.isFinite(months) ? `last push ${Math.round(months)} month(s) ago` : 'last push unknown');
  reasons.push(`licence ${c.license ?? 'none'}${lic >= 1 ? ' (permissive)' : lic <= 0.2 ? ' (none found: cannot be reused safely)' : ''}`);
  reasons.push(lang.note);
  const score = c.archived ? 0 : 0.35 * rel + 0.2 * pop + 0.15 * recency + 0.15 * lic + 0.15 * lang.score;
  return { ...c, score: Math.round(score * 1000) / 1000, reasons, deepAnalysed: false };
}

const BROWSER_TERMS = ['chrome devtools', 'devtools protocol', 'cdp', 'puppeteer', 'playwright', 'selenium', 'webdriver', 'browser', 'tab', 'dom', 'accessibility', 'extension', 'screenshot'];

export async function deepAnalyse(ctx: AgentContext, repo: string, terms: string[]): Promise<AgentOutcome> {
  ctx.progress(`reading ${repo}`);
  const r = await callJson(ctx, 'github_repo', { repo });
  if (!r.ok) throw new Error(`could not read ${repo}: ${r.error}`);
  const d = r.data;
  const source = ctx.addSource({ url: String(d['url'] ?? `https://github.com/${repo}`), title: `${repo} (GitHub API)`, kind: 'github-api', quality: 0.95 });
  const readme = String(d['readme'] ?? '');
  const files = Array.isArray(d['files']) ? (d['files'] as unknown[]).map(String) : [];
  const text = `${readme} ${String(d['description'] ?? '')}`.toLowerCase();
  const evidence = BROWSER_TERMS.filter((t) => text.includes(t)).map((t) => `README mentions "${t}"`);
  const kinds: string[] = [];
  if (files.includes('package.json')) kinds.push('Node package');
  if (files.includes('manifest.json')) kinds.push('browser extension');
  if (files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('requirements.txt')) kinds.push('Python package');
  if (files.includes('Cargo.toml')) kinds.push('Rust crate');
  if (files.includes('go.mod')) kinds.push('Go module');
  ctx.addClaim({ subject: repo, attribute: 'license', value: String(d['license'] ?? 'none'), sourceIds: [source.id], confidence: 0.95 });

  const judged = await askJson(ctx, {
    system: 'You judge whether an open-source project could give a Node.js/TypeScript desktop assistant (JARVIS, Windows) awareness of the user\'s web browser. '
      + 'Base the judgement only on the README and file list. JSON: {"summary":"two sentences","integration":"library|extension|service|other","risks":["..."]}',
    user: `Repository ${repo}. Request terms: ${terms.join(', ')}. Top-level files: ${files.join(', ')}.\n${untrusted('github-readme', readme)}`,
  }, (v) => {
    const o = v as Record<string, unknown> | undefined;
    return o && typeof o['summary'] === 'string' && o['summary'].trim()
      ? { summary: String(o['summary']).trim(), integration: String(o['integration'] ?? 'other'), risks: Array.isArray(o['risks']) ? (o['risks'] as unknown[]).map(String).slice(0, 5) : [] }
      : undefined;
  }, () => ({
    summary: `${repo} is a ${kinds.join(' / ') || 'project of unknown type'}; ${evidence.length ? evidence.slice(0, 4).join(', ') : 'the README does not mention browser control'}.`,
    integration: kinds.includes('browser extension') ? 'extension' : kinds.includes('Node package') ? 'library' : kinds.length ? 'service' : 'other',
    risks: [readme ? '' : 'no README found', String(d['license'] ?? '') ? '' : 'no licence'].filter(Boolean),
  }));
  ctx.addFinding({
    text: `${repo}: ${judged.value.summary}`, sourceIds: [source.id], confidence: judged.viaModel ? 0.75 : 0.6,
    tags: ['deep-analysis'], data: { repo, integration: judged.value.integration, evidence, kinds, risks: judged.value.risks },
  });
  return {
    summary: judged.value.summary,
    confidence: judged.viaModel ? 0.75 : 0.6,
    limitations: dedupe([judged.note ?? '', d['readmeTruncated'] ? `${repo}: only the start of the README was read` : '']),
    data: { repo, evidence, kinds, integration: judged.value.integration, risks: judged.value.risks, license: d['license'] ?? null, language: d['language'] ?? null },
  };
}

// ─── Workers ─────────────────────────────────────────────────────────────────

export const repoDiscoveryWorker: AgentBehavior = {
  async run(ctx) {
    const terms = (ctx.input['terms'] as string[] | undefined) ?? keywords(questionOf(ctx));
    const queries = (ctx.input['queries'] as string[] | undefined) ?? [terms.join(' ')];
    const { candidates, errors } = await discoverRepositories(ctx, queries, terms);
    if (!candidates.length && errors.length) throw new Error(errors.join('; '));
    return {
      summary: candidates.length ? `Found ${candidates.length} candidate repositories: ${candidates.map((c) => c.fullName).join(', ')}.` : 'GitHub returned no matching repositories.',
      confidence: candidates.length ? 0.8 : 0.3,
      limitations: errors,
      data: { candidates, queries },
    };
  },
};

export const repoCodeAnalysisWorker: AgentBehavior = {
  async run(ctx) {
    const terms = (ctx.input['terms'] as string[] | undefined) ?? keywords(questionOf(ctx));
    const candidates = Object.values(ctx.dependencyResults)
      .flatMap((r) => ((r.data?.['candidates'] as RepoCandidate[] | undefined) ?? []));
    const fromInput = (ctx.input['candidates'] as RepoCandidate[] | undefined) ?? [];
    const all = [...candidates, ...fromInput].filter((c, i, a) => a.findIndex((x) => x.fullName === c.fullName) === i);
    if (!all.length) return { summary: 'There were no repositories to analyse.', confidence: 0.2, limitations: ['discovery found no repositories'], data: { ranked: [] } };

    ctx.progress(`ranking ${all.length} repositories`);
    const ranked = all.map((c) => quickScore(c, terms)).sort((a, b) => b.score - a.score);
    const limitations: string[] = [];

    // The leading candidate gets a deep look at its README and files. Reading a
    // repository is a capability this worker does not have, so it goes to a child.
    const deepCount = Math.max(0, Math.min(3, Number(process.env['JARVIS_AGENT_DEEP_ANALYSES'] ?? 1) || 0));
    const targets = ranked.slice(0, deepCount);
    if (targets.length) {
      const decision = ctx.decideSpawn({
        subtasks: targets.map((t) => ({ description: `Read and judge ${t.fullName}`, role: RESEARCH_ROLES.deepAnalysis, estimatedUnits: 3, capabilities: ['repo_reading'] })),
      });
      const handles: ChildHandle[] = [];
      for (const p of decision.plan) {
        const t = targets[p.index];
        if (p.action !== 'SPAWN') { limitations.push(`${t.fullName} was not read in depth: ${p.reason}`); continue; }
        try {
          handles.push(await ctx.spawn({
            childRole: RESEARCH_ROLES.deepAnalysis, name: `Project ${short(t.fullName)} Deep Analysis Worker`,
            childTask: { description: `Read and judge ${t.fullName}`, input: { repo: t.fullName, terms } },
            reason: `${t.fullName} ranks highest (${t.score}); its README and files decide the recommendation`,
          }));
        } catch (err) {
          limitations.push(`${t.fullName} was not read in depth: ${err instanceof SpawnRejectedError ? err.reasons.join('; ') : (err as Error).message}`);
        }
      }
      const { results, notes } = await waitWithRetry(ctx, handles);
      limitations.push(...notes);
      for (const res of results) {
        const repo = String(res.data?.['repo'] ?? '');
        const entry = ranked.find((r) => r.fullName === repo);
        if (!entry) continue;
        if (res.status !== 'COMPLETED') { limitations.push(`Deep analysis of ${repo} ${res.status.toLowerCase()}: ${res.error?.message ?? ''}`); continue; }
        const evidence = (res.data?.['evidence'] as string[] | undefined) ?? [];
        entry.deepAnalysed = true;
        entry.integration = String(res.data?.['integration'] ?? '');
        const bonus = Math.min(0.15, evidence.length * 0.03) + (entry.integration === 'library' ? 0.05 : 0);
        entry.score = Math.round(clamp01(entry.score + bonus) * 1000) / 1000;
        entry.reasons.push(`deep analysis: ${res.summary}`);
      }
      ranked.sort((a, b) => b.score - a.score);
    }
    return {
      summary: `Ranked ${ranked.length} repositories. Leading: ${ranked.slice(0, 3).map((r) => `${r.fullName} (${r.score})`).join(', ')}.`,
      confidence: ranked.some((r) => r.deepAnalysed) ? 0.75 : 0.6,
      limitations: dedupe(limitations),
      data: { ranked },
    };
  },
};

export const projectDeepAnalysisWorker: AgentBehavior = {
  run(ctx) {
    return deepAnalyse(ctx, String(ctx.input['repo'] ?? ''), (ctx.input['terms'] as string[] | undefined) ?? keywords(questionOf(ctx)));
  },
};

export const factCheckWorker: AgentBehavior = {
  async run(ctx) {
    const conflictId = String(ctx.input['conflictId'] ?? '');
    const conflict = ctx.workspace.conflicts().find((c) => c.id === conflictId);
    if (!conflict) return { summary: 'No such conflict.', confidence: 0.2 };
    const by = { agentId: ctx.agent.agentId, taskId: ctx.task.taskId };
    if (/^[\w.-]+\/[\w.-]+$/.test(conflict.subject) && ['license', 'language', 'stars'].includes(conflict.attribute.toLowerCase())) {
      ctx.progress(`checking ${conflict.attribute} of ${conflict.subject} at the source`);
      const r = await callJson(ctx, 'github_repo', { repo: conflict.subject, readme: false });
      if (r.ok) {
        const source = ctx.addSource({ url: String(r.data['url'] ?? ''), title: `${conflict.subject} (GitHub API, verification)`, kind: 'github-api', quality: 0.98 });
        const attr = conflict.attribute.toLowerCase();
        ctx.addClaim({ subject: conflict.subject, attribute: conflict.attribute, value: String(r.data[attr] ?? 'none'), sourceIds: [source.id], confidence: 0.98 });
        const settled = ctx.workspace.resolveBySourceQuality(conflict.id, by, 0.1);
        return { summary: `Checked ${conflict.attribute} of ${conflict.subject}: ${settled?.resolution?.value ?? 'unresolved'}.`, confidence: settled?.status === 'resolved' ? 0.9 : 0.4 };
      }
      return { summary: `Could not check ${conflict.subject}: ${r.error}`, confidence: 0.2, limitations: [r.error] };
    }
    const settled = ctx.workspace.resolveBySourceQuality(conflict.id, by);
    return { summary: `Compared the sources for ${conflict.subject} ${conflict.attribute}: ${settled?.status ?? 'unresolved'}.`, confidence: 0.4 };
  },
};

// ─── Sub-agents ──────────────────────────────────────────────────────────────

export const githubResearchAgent: AgentBehavior = {
  async run(ctx) {
    const question = questionOf(ctx);
    const terms = keywords(question);
    const q = await askJson(ctx, {
      system: 'Write GitHub repository search queries for the request (GitHub search syntax allowed, e.g. "language:typescript"). JSON: {"queries":["...","..."]} with 2 or 3 queries.',
      user: question,
      maxTokens: 300,
    }, (v) => {
      const list = (v as Record<string, unknown> | undefined)?.['queries'];
      return Array.isArray(list) && list.length ? list.map(String).filter((s) => s.trim()).slice(0, 3) : undefined;
    }, () => dedupe([terms.join(' '), `${terms.slice(0, 3).join(' ')} agent`]));
    const queries = q.value;
    const limitations = q.note ? [`Search queries: ${q.note}.`] : [];

    const decision = ctx.decideSpawn({
      subtasks: [
        { description: `Search GitHub for ${terms.join(' ')} repositories`, role: RESEARCH_ROLES.discovery, estimatedUnits: queries.length * 2, capabilities: ['github_search'] },
        { description: `Rank the discovered ${terms.join(' ')} repositories`, role: RESEARCH_ROLES.codeAnalysis, dependsOn: [0], estimatedUnits: 4, capabilities: ['code_analysis'] },
      ],
    });
    let ranked: RankedRepo[];
    if (decision.plan.every((p) => p.action === 'SPAWN')) {
      const discovery = await ctx.spawn({
        childRole: RESEARCH_ROLES.discovery, name: 'Repository Discovery Worker',
        childTask: { description: `Search GitHub for ${terms.join(' ')} repositories`, input: { queries, terms } },
        reason: 'finding candidates is independent work with its own tool (github_search)',
      });
      const analysis = await ctx.spawn({
        childRole: RESEARCH_ROLES.codeAnalysis, name: 'Repository Code Analysis Worker',
        childTask: { description: `Rank the discovered ${terms.join(' ')} repositories`, input: { terms } },
        dependencies: [discovery.taskId],
        reason: 'ranking needs the discovered repositories, so it waits for the discovery worker',
      });
      const { results, notes } = await waitWithRetry(ctx, [discovery, analysis]);
      limitations.push(...notes);
      const [rd, ra] = results;
      if (rd.status !== 'COMPLETED') limitations.push(`Discovery ${rd.status.toLowerCase()}: ${rd.error?.message ?? ''}`);
      ranked = (ra.data?.['ranked'] as RankedRepo[] | undefined) ?? [];
      limitations.push(...ra.limitations, ...rd.limitations);
    } else {
      // Small job or no room for children: the same work, done here.
      limitations.push(`Did the GitHub research itself: ${decision.reasons[0]}.`);
      const { candidates, errors } = await discoverRepositories(ctx, queries, terms);
      limitations.push(...errors);
      ranked = candidates.map((c) => quickScore(c, terms)).sort((a, b) => b.score - a.score);
    }
    return {
      summary: ranked.length ? `Top GitHub candidates: ${ranked.slice(0, 3).map((r) => r.fullName).join(', ')}.` : 'No GitHub candidates were found.',
      confidence: ranked.length ? (ranked.some((r) => r.deepAnalysed) ? 0.75 : 0.6) : 0.2,
      limitations: dedupe(limitations),
      data: { ranked, queries },
    };
  },
};

export const webResearchAgent: AgentBehavior = {
  async run(ctx) {
    const question = questionOf(ctx);
    const terms = keywords(question);
    const queries = dedupe([`${terms.join(' ')} open source`, `${terms.join(' ')} comparison`]);
    const limitations: string[] = [];
    let sources = 0;
    for (const query of queries) {
      ctx.checkpoint();
      ctx.progress(`searching the web: ${query}`);
      const r = await ctx.callTool('web_search', { query });
      const out = r.output ?? '';
      if (!r.success || /^\s*(Error|No results)/i.test(out)) {
        limitations.push(`Web search "${query}" gave nothing usable: ${(r.error ?? out).slice(0, 160)}`);
        continue;
      }
      // "n. title\nurl\nsnippet" blocks from web_search.
      for (const block of out.split(/\n\n+/)) {
        const lines = block.split('\n').map((l) => l.trim()).filter((l) => l && !/^web results:?$/i.test(l));
        const at = lines.findIndex((l) => /^https?:\/\//.test(l));
        if (at === -1) continue;
        const url = lines[at];
        // The title is the line just above the URL ("2. Some page").
        const title = (at > 0 ? lines[at - 1] : url).replace(/^\d+\.\s*/, '');
        const snippet = lines.slice(at + 1).join(' ');
        const source = ctx.addSource({ url, title, kind: 'web', quality: /github\.com|docs\.|developer\./.test(url) ? 0.7 : 0.5 });
        sources++;
        if (snippet) ctx.addFinding({ text: `${title}: ${snippet}`.slice(0, 400), sourceIds: [source.id], confidence: 0.5, tags: ['web'] });
        const repo = /github\.com\/([\w.-]+\/[\w.-]+)/.exec(url)?.[1];
        if (repo) ctx.addFinding({ text: `The web points to ${repo} for ${terms.join(' ')}`, sourceIds: [source.id], confidence: 0.5, tags: ['repository-mention'], data: { fullName: repo } });
      }
    }
    if (!sources) limitations.push('No web sources were available, so the answer rests on GitHub data.');
    return {
      summary: sources ? `Read ${sources} web result(s) about ${terms.join(' ')}.` : 'Web search was not available.',
      confidence: sources ? 0.5 : 0.1,
      limitations: dedupe(limitations),
      data: { sources },
    };
  },
};

/** Fit of a candidate with JARVIS: Node/TypeScript, Windows, a CDP browser layer already in place. */
export function architectureFit(repo: RepoCandidate, deep?: { integration?: string; evidence?: string[] }): { score: number; notes: string[] } {
  const lang = languageFit(repo.language);
  const text = `${repo.description} ${repo.topics.join(' ')}`.toLowerCase();
  const cdp = /cdp|devtools|chrome|puppeteer|playwright/.test(text) || (deep?.evidence ?? []).some((e) => /devtools|cdp|puppeteer|playwright/.test(e));
  const extension = /extension/.test(text) || deep?.integration === 'extension';
  const notes = [lang.note];
  if (cdp) notes.push('drives Chrome through the DevTools Protocol, which JARVIS already uses (perception/browserState.ts)');
  else if (extension) notes.push('works as a browser extension: needs installing in the user\'s Chrome');
  else notes.push('no sign of a Chrome/CDP integration');
  notes.push(`licence ${repo.license ?? 'none'}`);
  const score = 0.45 * lang.score + 0.3 * licenseScore(repo.license) + 0.25 * (cdp ? 1 : extension ? 0.6 : 0.3);
  return { score: Math.round(score * 1000) / 1000, notes };
}

export const architectureResearchAgent: AgentBehavior = {
  async run(ctx) {
    const watch = typeof ctx.input['watchTaskId'] === 'string' ? String(ctx.input['watchTaskId']) : undefined;
    const fit: Record<string, { score: number; notes: string[] }> = {};
    const queue: { repo?: RepoCandidate; deep?: { repo: string; integration?: string; evidence?: string[] } }[] = [];
    let wake: (() => void) | undefined;
    // Findings are judged as they arrive, not after the GitHub agent finishes.
    const off = ctx.onEvent({ types: ['FINDING_DISCOVERED'] }, (e) => {
      const tags = (e.data['tags'] as string[] | undefined) ?? [];
      const data = (e.data['data'] as Record<string, unknown> | undefined) ?? {};
      if (tags.includes('repository') && data['repo']) queue.push({ repo: data['repo'] as RepoCandidate });
      if (tags.includes('deep-analysis') && data['repo']) queue.push({ deep: data as { repo: string } });
      wake?.();
    }, { replay: true });
    const known = new Map<string, RepoCandidate>();
    let watchDone = !watch;
    const offWatch = watch
      ? ctx.onEvent({ types: ['RESULT_AVAILABLE'], taskIds: [watch] }, () => { watchDone = true; wake?.(); }, { replay: true })
      : () => {};
    try {
      while (true) {
        while (queue.length) {
          const item = queue.shift()!;
          if (item.repo) {
            known.set(item.repo.fullName, item.repo);
            if (fit[item.repo.fullName]) continue;
            const f = architectureFit(item.repo);
            fit[item.repo.fullName] = f;
            ctx.addFinding({ text: `${item.repo.fullName} fit with JARVIS: ${f.notes.join('; ')}`, confidence: 0.6, tags: ['architecture-fit'], data: { repo: item.repo.fullName, score: f.score } });
            ctx.progress(`judged ${Object.keys(fit).length} candidate(s)`);
          } else if (item.deep) {
            const base = known.get(item.deep.repo);
            if (!base) continue;
            fit[item.deep.repo] = architectureFit(base, item.deep);
          }
        }
        if (watchDone) break;
        // Waiting for more findings holds no work slot.
        await ctx.idleWait(new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length || watchDone) resolve();
        }));
        wake = undefined;
      }
    } finally {
      off();
      offWatch();
    }
    const n = Object.keys(fit).length;
    return {
      summary: n ? `Judged ${n} candidate(s) against JARVIS's architecture (Node/TypeScript, Windows, Chrome DevTools Protocol).` : 'No candidates arrived to judge.',
      confidence: n ? 0.65 : 0.2,
      limitations: n ? [] : ['no repository findings arrived'],
      data: { fit },
    };
  },
};

// ─── The Research Agent (specialist) ─────────────────────────────────────────

interface Part { role: string; task: string }

export function rulePlan(question: string): Part[] {
  const q = question.toLowerCase();
  const terms = keywords(question).join(' ') || question;
  const code = /github|repo|project|librar|framework|open[- ]source|package|sdk|tool/.test(q);
  const parts: Part[] = [];
  if (code) parts.push({ role: RESEARCH_ROLES.github, task: `Find and rank GitHub projects: ${terms}` });
  parts.push({ role: RESEARCH_ROLES.web, task: `Search the web for articles and comparisons: ${terms}` });
  if (code && /jarvis|integrat|fit|architecture|for giving|for adding|use in|my assistant/.test(q)) {
    parts.push({ role: RESEARCH_ROLES.architecture, task: `Judge each candidate's fit with JARVIS: ${terms}` });
  }
  return parts;
}

const CHILD_CAPABILITIES: Record<string, string[]> = {
  [RESEARCH_ROLES.github]: ['github_research'],
  [RESEARCH_ROLES.web]: ['web_research'],
  [RESEARCH_ROLES.architecture]: ['architecture_review'],
};

export const researchSpecialist: AgentBehavior = {
  async run(ctx) {
    const question = ctx.task.description;
    const allowed = Object.keys(CHILD_CAPABILITIES);
    const plan = await askJson(ctx, {
      system: 'You are the Research Agent of JARVIS, a voice assistant written in Node.js/TypeScript for Windows with a Chrome DevTools Protocol browser layer. '
        + 'Split the research request into parts for these sub-agents, using only the ones it needs: '
        + 'github_research_agent (finds and ranks GitHub projects), web_research_agent (articles, documentation, comparisons), '
        + 'architecture_research_agent (judges how each candidate fits JARVIS). '
        + 'JSON: {"parts":[{"role":"github_research_agent","task":"one short sentence"}]}',
      user: question,
      maxTokens: 400,
    }, (v) => {
      const parts = (v as Record<string, unknown> | undefined)?.['parts'];
      if (!Array.isArray(parts)) return undefined;
      const ok = parts.map((p) => p as Record<string, unknown>)
        .filter((p) => allowed.includes(String(p['role'])) && String(p['task'] ?? '').trim())
        .map((p) => ({ role: String(p['role']), task: String(p['task']).trim().slice(0, 200) }));
      return ok.length ? ok.filter((p, i, a) => a.findIndex((x) => x.role === p.role) === i) : undefined;
    }, () => rulePlan(question));
    const parts = plan.value;
    const limitations: string[] = plan.note ? [`Planning: ${plan.note}.`] : [];

    // The architecture judgement follows the GitHub part live, so it runs only with it.
    const ordered = [...parts].sort((a, b) => (a.role === RESEARCH_ROLES.architecture ? 1 : 0) - (b.role === RESEARCH_ROLES.architecture ? 1 : 0));
    const decision = ctx.decideSpawn({
      subtasks: ordered.map((p) => ({ description: p.task, role: p.role, estimatedUnits: p.role === RESEARCH_ROLES.architecture ? 2 : 4, capabilities: CHILD_CAPABILITIES[p.role] })),
    });
    const handles: ChildHandle[] = [];
    const byRole = new Map<string, ChildHandle>();
    const selfParts: Part[] = [];
    const existing: string[] = [];
    const names: Record<string, string> = {
      [RESEARCH_ROLES.github]: 'GitHub Research Agent', [RESEARCH_ROLES.web]: 'Web Research Agent', [RESEARCH_ROLES.architecture]: 'Architecture Research Agent',
    };
    for (const p of decision.plan) {
      const part = ordered[p.index];
      if (p.action === 'SELF') { selfParts.push(part); continue; }
      if ((p.action === 'REUSE' || p.action === 'SUBSCRIBE') && p.existingTaskId) { existing.push(p.existingTaskId); continue; }
      if (p.action !== 'SPAWN') { limitations.push(`${part.role} not used: ${p.reason}`); continue; }
      // The architecture judgement follows a GitHub sub-agent live; without one it is computed below.
      if (part.role === RESEARCH_ROLES.architecture && !byRole.has(RESEARCH_ROLES.github)) continue;
      try {
        const h = await ctx.spawn({
          childRole: part.role, name: names[part.role],
          childTask: {
            description: part.task,
            input: { question, ...(part.role === RESEARCH_ROLES.architecture ? { watchTaskId: byRole.get(RESEARCH_ROLES.github)!.taskId } : {}) },
          },
          reason: part.role === RESEARCH_ROLES.github ? 'GitHub projects are the core of the request'
            : part.role === RESEARCH_ROLES.web ? 'articles and docs add evidence GitHub metadata lacks'
            : 'each candidate must fit JARVIS (Node/TypeScript, Windows, CDP); judged live as candidates are found',
        });
        handles.push(h);
        byRole.set(part.role, h);
      } catch (err) {
        limitations.push(`${part.role} not created (${err instanceof SpawnRejectedError ? err.reasons.join('; ') : (err as Error).message}); done here instead`);
        selfParts.push(part);
      }
    }

    // Parts done here, with the same code a child would run.
    type PartResult = Pick<ChildResult, 'role' | 'status' | 'summary' | 'confidence' | 'limitations' | 'data' | 'error'>;
    const inline: PartResult[] = [];
    for (const part of selfParts) {
      if (part.role === RESEARCH_ROLES.architecture) continue;
      ctx.progress(`doing ${part.role.replace(/_/g, ' ')} work itself`);
      const behavior = part.role === RESEARCH_ROLES.github ? githubResearchAgent : webResearchAgent;
      try {
        const out = await behavior.run(ctx);
        inline.push({ role: part.role, status: 'COMPLETED', summary: out.summary, confidence: out.confidence, limitations: out.limitations ?? [], data: out.data });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        inline.push({ role: part.role, status: 'FAILED', summary: (err as Error).message, confidence: 0, limitations: [(err as Error).message] });
      }
    }

    // Work another agent already did (REUSE) or is doing (SUBSCRIBE).
    for (const id of existing) {
      if (!ctx.workspace.result(id)) {
        await ctx.idleWait(new Promise<void>((resolve) => {
          const off = ctx.onEvent({ types: ['RESULT_AVAILABLE'], taskIds: [id] }, () => { off(); resolve(); }, { replay: true });
        }));
      }
      const r = ctx.workspace.result(id);
      if (r) inline.push(r);
    }

    ctx.progress(`waiting for ${handles.length} sub-agent(s)`);
    const { results: childResults, notes } = await waitWithRetry(ctx, handles);
    limitations.push(...notes);
    const results: PartResult[] = [...childResults, ...inline];
    const resultOf = (role: string) => results.find((r) => r.role === role);

    // Conflicting claims: compare source quality; if still open, verify.
    const by = { agentId: ctx.agent.agentId, taskId: ctx.task.taskId };
    for (const c of ctx.workspace.conflicts('open')) {
      const settled = ctx.workspace.resolveBySourceQuality(c.id, by, 0.2, { leaveOpenIfUnclear: true });
      if (settled?.status === 'resolved') continue;
      try {
        const check = await ctx.spawn({
          childRole: RESEARCH_ROLES.factCheck, name: 'Fact Check Worker',
          childTask: { description: `Verify ${c.attribute} of ${c.subject}`, input: { conflictId: c.id } },
          reason: `sources disagree on ${c.subject} ${c.attribute}`,
        });
        await ctx.wait([check]);
      } catch (err) {
        limitations.push(`Could not verify ${c.subject} ${c.attribute}: ${(err as Error).message}`);
      }
      // Whatever the check found, the conflict now gets its final status.
      if (c.status === 'open') ctx.workspace.resolveBySourceQuality(c.id, by);
    }

    // Combine ranking (GitHub) and fit (architecture).
    const gh = resultOf(RESEARCH_ROLES.github);
    const arch = resultOf(RESEARCH_ROLES.architecture);
    const web = resultOf(RESEARCH_ROLES.web);
    const ranked = (gh?.data?.['ranked'] as RankedRepo[] | undefined) ?? [];
    const fit = (arch?.data?.['fit'] as Record<string, { score: number; notes: string[] }> | undefined) ?? {};
    const settledLicense = (name: string): string | undefined => ctx.workspace.conflicts().find((c) => c.subject === name && c.attribute === 'license' && c.status === 'resolved')?.resolution?.value;
    const combined = ranked.map((r) => {
      const f = fit[r.fullName] ?? architectureFit(r);
      return { ...r, license: settledLicense(r.fullName) ?? r.license, fit: f.score, fitNotes: f.notes, final: Math.round((0.6 * r.score + 0.4 * f.score) * 1000) / 1000 };
    }).sort((a, b) => b.final - a.final);
    for (const r of results) limitations.push(...r.limitations.map((l) => `${r.role}: ${l}`));

    const top = combined.slice(0, 3);
    const nextActions = top.length
      ? [`Read ${top[0].fullName}'s source and try it in a branch of JARVIS`, 'Check each licence before copying code', 'Compare with JARVIS\'s own CDP browser layer before adding a dependency']
      : ['Set GITHUB_TOKEN or SERPER_API_KEY and ask again'];
    const unresolved = ctx.workspace.conflicts().filter((c) => c.status !== 'resolved').length;
    const confidence = clamp01(mean(results.filter((r) => r.status === 'COMPLETED').map((r) => r.confidence)) * (1 - 0.1 * unresolved));

    const synth = await askJson(ctx, {
      system: 'Write JARVIS\'s final answer to the research request: the top projects in order, why each, how it would fit JARVIS, and what is uncertain. '
        + 'Use only the data given. Plain sentences, no markdown headings. JSON: {"answer":"...","nextActions":["..."]}',
      user: `Request: ${question}\nCandidates (ranked): ${JSON.stringify(top.map((t) => ({ name: t.fullName, url: t.url, score: t.final, licence: t.license, language: t.language, stars: t.stars, reasons: t.reasons.slice(0, 4), fit: t.fitNotes })))}\n`
        + `Web evidence: ${untrusted('web-results', ctx.workspace.findings({ tag: 'web' }).slice(0, 6).map((f) => f.text).join('\n'), 2_000)}\n`
        + `Limitations: ${dedupe(limitations).slice(0, 8).join(' | ')}`,
      maxTokens: 700,
    }, (v) => {
      const o = v as Record<string, unknown> | undefined;
      return o && typeof o['answer'] === 'string' && o['answer'].trim()
        ? { answer: String(o['answer']).trim(), nextActions: Array.isArray(o['nextActions']) ? (o['nextActions'] as unknown[]).map(String).slice(0, 4) : nextActions }
        : undefined;
    }, () => ({
      answer: top.length
        ? `The best matches for "${question}" are: ${top.map((t, i) => `${i + 1}. ${t.fullName} (${t.url}) — score ${t.final}; ${t.reasons.slice(0, 3).join(', ')}; fit: ${t.fitNotes.slice(0, 2).join(', ')}`).join(' ')}`
        : `I could not find GitHub projects for "${question}".`,
      nextActions,
    }));
    if (synth.note) limitations.push(`Final answer: ${synth.note}.`);
    ctx.workspace.setFinalSynthesis(synth.value.answer, confidence, ctx.agent.agentId);
    return {
      summary: synth.value.answer,
      confidence,
      limitations: dedupe(limitations),
      data: {
        ranking: combined.slice(0, 5).map((c) => ({ fullName: c.fullName, url: c.url, score: c.final, rankScore: c.score, fit: c.fit, license: c.license, language: c.language, stars: c.stars, deepAnalysed: c.deepAnalysed })),
        recommendedNextActions: synth.value.nextActions,
        plan: parts,
        planBy: plan.viaModel ? 'model' : 'rules',
        web: web ? { status: web.status, summary: web.summary } : null,
      },
    };
  },
};
