/**
 * tests/selfHealingHonestyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-healing Phase 5 guard: JARVIS never says "all errors are fixed".
 *
 * A repair or a check can only speak for what it observed. Reports list what
 * was verified, what failed, what is blocked and what was not checked.
 *
 *   1. No string in JARVIS's own source claims that everything works or that
 *      all errors are fixed.
 *   2. Every reply the repair run can end with, in every status and mix of
 *      results, passes the same rule (core/selfCheck.ts OVERCLAIMS), and says
 *      what was not verified when something was not.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-honesty-sh-')));
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { overclaims, tally } = await import('../core/selfCheck.js');
const { spokenResult } = await import('../core/repairRun.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

// ── 1. Source strings ────────────────────────────────────────────────────────
console.log('\n--- 1. No over-claiming string in the source ---');
const DIRS = ['core', 'monitoring', 'self_healing', 'bridge', 'control', 'security', 'memory', 'skills'];
const hits: string[] = [];
let files = 0;
function scan(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p); continue; }
    if (!/\.(ts|py)$/.test(e.name)) continue;
    files++;
    // String literals only: comments may quote what used to be said.
    const code = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|#).*$/gm, '');
    for (const m of code.matchAll(/'([^'\n]{8,})'|"([^"\n]{8,})"|`([^`]{8,})`/g)) {
      const text = m[1] ?? m[2] ?? m[3] ?? '';
      if (overclaims(text)) hits.push(`${path.relative(repo, p)}: ${text.slice(0, 100)}`);
    }
  }
}
for (const d of DIRS) if (fs.existsSync(path.join(repo, d))) scan(path.join(repo, d));
ok(`no over-claim in ${files} source files`, files > 100 && hits.length === 0, hits.join('\n       '));

// ── 2. Every repair ending ──────────────────────────────────────────────────
console.log('\n--- 2. Every repair ending ---');
const STATUSES = ['SUCCEEDED', 'WAITING_FOR_EVIDENCE', 'FAILED', 'BLOCKED', 'CANCELLED', 'NOTHING_TO_REPAIR'] as const;
const STATES = ['VERIFIED', 'FAILING', 'BLOCKED', 'NOT_VERIFIED', 'SKIPPED'] as const;
const mixes: (typeof STATES[number])[][] = [[], ...STATES.map((s) => [s]), ['VERIFIED', 'NOT_VERIFIED'], ['VERIFIED', 'BLOCKED'], ['VERIFIED', 'FAILING', 'SKIPPED'], [...STATES]];
let n = 0;
const bad: string[] = [];
const silentGaps: string[] = [];
for (const status of STATUSES) {
  for (const mix of mixes) {
    const run = {
      runId: 'run-x', status, scope: 'all', issueIds: [], startedAt: new Date().toISOString(),
      budget: { maxAttempts: 2, maxMinutes: 20, tokenCap: 1, tokensUsed: 0 }, attempts: [],
      items: mix.map((s, i) => ({ name: `item ${i}`, state: s, detail: 'detail' })), summary: '', history: [],
    };
    const text = spokenResult(run as never);
    n++;
    if (overclaims(text)) bad.push(`${status} ${mix.join('+')}: ${text}`);
    // Anything not verified is named as such, never folded into "it works".
    if (mix.some((s) => s !== 'VERIFIED') && !/needs you|still failing|confirmed when you next use it|skipped/.test(text)) silentGaps.push(`${status} ${mix.join('+')}: ${text}`);
    const counted = tally(run.items as never);
    if (overclaims(counted)) bad.push(`tally ${mix.join('+')}: ${counted}`);
  }
}
ok(`no over-claim in ${n} repair endings or their counts`, bad.length === 0, bad.join('\n       '));
ok('an ending with anything unverified says so', silentGaps.length === 0, silentGaps.join('\n       '));
ok('even all verified is a count, not a claim', tally([{ name: 'a', state: 'VERIFIED', detail: '' }, { name: 'b', state: 'VERIFIED', detail: '' }] as never) === '2 of 2 checks verified');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
