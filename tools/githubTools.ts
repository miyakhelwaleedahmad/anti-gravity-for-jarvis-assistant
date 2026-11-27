/**
 * tools/githubTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only GitHub research tools for the Research and GitHub agents:
 *
 *   github_search  public repositories matching a query (REST search API)
 *   github_repo    one repository: metadata, licence, topics, recent activity,
 *                  top-level files and the start of its README
 *
 * Nothing is written to GitHub. Without GITHUB_TOKEN the API allows about 10
 * searches and 60 other requests per hour per IP; with a token, more. The
 * token is only sent to api.github.com and never appears in a result (the
 * registry also redacts credentials from every tool output).
 */

import type { AgentTool } from '../core/toolRegistryV2.js';

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
const README_LIMIT = 6_000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function headers(accept = 'application/vnd.github+json'): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'JARVIS-assistant',
  };
  const token = process.env['GITHUB_TOKEN']?.trim();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

async function get(path: string, signal: AbortSignal | undefined, accept?: string): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('GitHub did not answer in 15 s')), TIMEOUT_MS);
  const onAbort = () => ac.abort(signal?.reason);
  if (signal?.aborted) ac.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(`${API}${path}`, { headers: headers(accept), signal: ac.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** A failed response as a JSON result the registry counts as a failure. */
function failure(res: Response, what: string): string {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if ((res.status === 403 || res.status === 429) && remaining === '0') {
    const at = Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : 'later';
    return JSON.stringify({ success: false, error: `GitHub rate limit reached for ${what}; it resets at ${at}. Set GITHUB_TOKEN for a higher limit.` });
  }
  if (res.status === 404) return JSON.stringify({ success: false, error: `${what}: not found on GitHub` });
  return JSON.stringify({ success: false, error: `${what}: GitHub answered ${res.status} ${res.statusText}` });
}

function rateInfo(res: Response): { remaining: number | null; resetAt: string | null } {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return {
    remaining: remaining === null ? null : Number(remaining),
    resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
  };
}

interface RepoSummary {
  fullName: string;
  url: string;
  description: string;
  stars: number;
  forks: number;
  language: string | null;
  license: string | null;
  topics: string[];
  pushedAt: string | null;
  archived: boolean;
  openIssues: number;
}

function summarise(r: Record<string, any>): RepoSummary {
  return {
    fullName: String(r['full_name'] ?? ''),
    url: String(r['html_url'] ?? ''),
    description: String(r['description'] ?? ''),
    stars: Number(r['stargazers_count'] ?? 0),
    forks: Number(r['forks_count'] ?? 0),
    language: r['language'] ?? null,
    license: r['license']?.['spdx_id'] && r['license']['spdx_id'] !== 'NOASSERTION' ? String(r['license']['spdx_id']) : (r['license']?.['name'] ?? null),
    topics: Array.isArray(r['topics']) ? r['topics'].map(String) : [],
    pushedAt: r['pushed_at'] ?? null,
    archived: !!r['archived'],
    openIssues: Number(r['open_issues_count'] ?? 0),
  };
}

export const githubSearchTool: AgentTool = {
  name: 'github_search',
  description:
    'Searches public GitHub repositories (read-only). Use to find open-source projects by topic, e.g. "browser automation agent". '
    + 'Parameters: query (GitHub search syntax allowed, e.g. "browser agent language:typescript"), sort ("stars" | "updated" | "best-match"), limit (1-10). '
    + 'Returns JSON with each repository\'s name, URL, description, stars, language, licence, topics and last push.',
  riskLevel: 'low',
  cacheable: true,
  inputSchema: {
    query: { type: 'string', description: 'Search query (GitHub syntax)', required: true },
    sort: { type: 'string', description: 'stars, updated or best-match', required: false, enum: ['stars', 'updated', 'best-match'] },
    limit: { type: 'number', description: 'How many repositories (1-10)', required: false },
  },
  fallbacks: [],
  async execute(args, signal) {
    const query = String(args['query'] ?? '').trim();
    if (!query) return JSON.stringify({ success: false, error: 'github_search needs a query' });
    const sort = ['stars', 'updated'].includes(String(args['sort'])) ? String(args['sort']) : '';
    const limit = Math.max(1, Math.min(10, Math.round(Number(args['limit'] ?? 5)) || 5));
    const params = new URLSearchParams({ q: query, per_page: String(limit) });
    if (sort) { params.set('sort', sort); params.set('order', 'desc'); }
    const res = await get(`/search/repositories?${params}`, signal);
    if (!res.ok) return failure(res, `search "${query}"`);
    const body = await res.json() as { total_count?: number; items?: Record<string, any>[] };
    return JSON.stringify({
      success: true,
      query,
      total: body.total_count ?? 0,
      items: (body.items ?? []).slice(0, limit).map(summarise),
      rateLimit: rateInfo(res),
    });
  },
};

export const githubRepoTool: AgentTool = {
  name: 'github_repo',
  description:
    'Reads one public GitHub repository (read-only): description, stars, licence, language, topics, last push, archived flag, '
    + 'top-level files and the start of the README. Parameter: repo ("owner/name"). Use after github_search to look closer at a project.',
  riskLevel: 'low',
  cacheable: true,
  inputSchema: {
    repo: { type: 'string', description: 'owner/name', required: true },
    readme: { type: 'boolean', description: 'Include the start of the README (default true)', required: false },
  },
  fallbacks: [],
  async execute(args, signal) {
    const repo = String(args['repo'] ?? '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    if (!REPO_PATTERN.test(repo)) return JSON.stringify({ success: false, error: `"${repo}" is not owner/name` });
    const res = await get(`/repos/${repo}`, signal);
    if (!res.ok) return failure(res, repo);
    const meta = summarise(await res.json() as Record<string, any>);
    let files: string[] = [];
    const contents = await get(`/repos/${repo}/contents/`, signal);
    if (contents.ok) {
      const list = await contents.json() as { name?: string; type?: string }[];
      if (Array.isArray(list)) files = list.map((f) => `${f.name}${f.type === 'dir' ? '/' : ''}`).slice(0, 60);
    }
    let readme = '';
    if (args['readme'] !== false) {
      const r = await get(`/repos/${repo}/readme`, signal, 'application/vnd.github.raw');
      if (r.ok) readme = (await r.text()).slice(0, README_LIMIT);
    }
    return JSON.stringify({ success: true, ...meta, files, readme, readmeTruncated: readme.length >= README_LIMIT, rateLimit: rateInfo(res) });
  },
};
