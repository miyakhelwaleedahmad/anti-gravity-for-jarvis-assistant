/**
 * tests/llmTimingTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PERF-03: a model request gets 3 attempts of 10 s, but the PLANNING
 * watchdog reset the state machine after 15 s, cutting the retries off.
 *
 *   1. the watchdog's default covers every attempt (32 s with the defaults,
 *      and it follows JARVIS_LLM_TIMEOUT_MS)
 *   2. a value set below that is raised to it, with a warning that says why
 *      (VOICE-002: below it, slow answers were cut off and nothing was said)
 *   3. the provider and the state machine read the same numbers
 *   4. the real state machine stays in PLANNING past the old 15 s mark while
 *      a slow request is still retrying (shortened timings)
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { planningWatchdogMs, llmRequestBudgetMs, LLM_MAX_ATTEMPTS } = await import('../config/llmTiming.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Planning watchdog and model retries (PERF-03) ===\n');

console.log('--- 1. Defaults ---');
ok('3 attempts', LLM_MAX_ATTEMPTS === 3);
ok('default watchdog = 3 × 10 s + 2 s', planningWatchdogMs({}) === 32_000, String(planningWatchdogMs({})));
ok('…and follows the request timeout (20 s → 62 s)', planningWatchdogMs({ JARVIS_LLM_TIMEOUT_MS: '20000' }) === 62_000);
ok('an empty setting means the default', planningWatchdogMs({ JARVIS_PLANNING_WATCHDOG_MS: '' }) === 32_000);
ok('never below the old 15 s', planningWatchdogMs({ JARVIS_LLM_TIMEOUT_MS: '2000' }) === 15_000);

console.log('\n--- 2. A low setting ---');
const warnings: string[] = [];
const low = planningWatchdogMs({ JARVIS_PLANNING_WATCHDOG_MS: '20000' }, (m) => warnings.push(m));
// VOICE-002: a value below the budget cut off answers that would have
// arrived, and the cut-off request was silent. It is raised to the budget.
ok('raised to the budget', low === 32_000, String(low));
ok('…with a warning naming the budget', warnings.length === 1 && /at least 32000/.test(warnings[0]!), warnings[0]);
warnings.length = 0;
planningWatchdogMs({ JARVIS_PLANNING_WATCHDOG_MS: '40000' }, (m) => warnings.push(m));
ok('a value above the budget: no warning', warnings.length === 0);
// The owner's .env: 30000 with a 20 s request timeout (3 × 20 s + 2 s = 62 s).
const owners = planningWatchdogMs({ JARVIS_PLANNING_WATCHDOG_MS: '30000', JARVIS_LLM_TIMEOUT_MS: '20000' }, (m) => warnings.push(m));
ok('30000 with a 20 s timeout: raised to 62000', owners === 62_000, String(owners));
ok('…with a warning that names 62000', warnings.length === 1 && /at least 62000/.test(warnings[0]!), warnings[0]);

console.log('\n--- 2b. A setting that is not a number of milliseconds ---');
for (const bad of ['abc', '-5', '0', '30s']) {
  warnings.length = 0;
  const got = planningWatchdogMs({ JARVIS_PLANNING_WATCHDOG_MS: bad }, (m) => warnings.push(m));
  ok(`"${bad}": not used; the default (32000) instead, with a warning`, got === 32_000 && warnings.length === 1 && /not a positive number/.test(warnings[0]!), `${got}; ${warnings[0] ?? 'no warning'}`);
}
warnings.length = 0;
planningWatchdogMs({ JARVIS_PLANNING_WATCHDOG_MS: '' }, (m) => warnings.push(m));
ok('empty: the default, no warning', warnings.length === 0);

console.log('\n--- 2b. The startup config check reports it ---');
// jarvis.ts runs configValidator.validate() at startup; it said nothing about
// the watchdog, so the owner's 30000 was only a console warning (VOICE-002).
{
  const { configValidator } = await import('../config/configValidator.js');
  const saved = { w: process.env['JARVIS_PLANNING_WATCHDOG_MS'], t: process.env['JARVIS_LLM_TIMEOUT_MS'] };
  const issuesWith = (w: string | undefined) => {
    if (w === undefined) delete process.env['JARVIS_PLANNING_WATCHDOG_MS']; else process.env['JARVIS_PLANNING_WATCHDOG_MS'] = w;
    process.env['JARVIS_LLM_TIMEOUT_MS'] = '20000';
    return configValidator.validate().issues.filter((i) => i.field === 'JARVIS_PLANNING_WATCHDOG_MS');
  };
  const owners = issuesWith('30000');
  ok("the owner's 30000 (20 s requests) is a startup WARNING", owners.length === 1 && owners[0]!.level === 'WARNING', JSON.stringify(owners));
  ok('…saying what is used and what to set', /62000/.test(owners[0]?.message ?? '') && /62000|remove/i.test(owners[0]?.fix ?? ''), owners[0]?.fix);
  ok('a bad value is reported too', issuesWith('half a minute').length === 1);
  ok('no line, or a safe value: nothing reported', issuesWith(undefined).length === 0 && issuesWith('90000').length === 0);
  if (saved.w === undefined) delete process.env['JARVIS_PLANNING_WATCHDOG_MS']; else process.env['JARVIS_PLANNING_WATCHDOG_MS'] = saved.w;
  if (saved.t === undefined) delete process.env['JARVIS_LLM_TIMEOUT_MS']; else process.env['JARVIS_LLM_TIMEOUT_MS'] = saved.t;
}

console.log('\n--- 3. One source ---');
const groq = fs.readFileSync(path.join(repo, 'bridge', 'groqProvider.ts'), 'utf8');
const sm = fs.readFileSync(path.join(repo, 'core', 'agentStateMachine.ts'), 'utf8');
ok('the provider uses LLM_MAX_ATTEMPTS and llmTimeoutMs()', !/MAX_ATTEMPTS = 3\b/.test(groq) && /LLM_MAX_ATTEMPTS/.test(groq) && /llmTimeoutMs\(\)/.test(groq));
ok('the state machine uses planningWatchdogMs()', /PLANNING_WATCHDOG_MS = planningWatchdogMs\(\)/.test(sm));

console.log('\n--- 4. The real state machine ---');
// A child process: the watchdog is read when the module loads. Timings are
// scaled down: 3 attempts × 300 ms (budget 2.9 s); the old fixed default
// would have been 15 s, so here "the old mark" is a watchdog of 500 ms.
const probe = `
import { agentStateMachine, AgentState } from ${JSON.stringify(path.join(repo, 'core', 'agentStateMachine.ts'))};
agentStateMachine.transition(AgentState.PLANNING, 'test');
setTimeout(() => { console.log('AT_1200MS', agentStateMachine.currentState); process.exit(0); }, 1200);
`;
const tsx = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const run = (extra: Record<string, string>) => spawnSync(process.execPath, [tsx, '-e', probe], {
  env: { ...process.env, JARVIS_LLM_TIMEOUT_MS: '300', ...extra }, encoding: 'utf8', timeout: 30_000,
});
const derived = run({ JARVIS_PLANNING_WATCHDOG_MS: '' });
const oldStyle = run({ JARVIS_PLANNING_WATCHDOG_MS: '500' });
const stateOf = (r: ReturnType<typeof run>) => /AT_1200MS (\w+)/.exec(`${r.stdout}`)?.[1] ?? `none: ${(r.stderr ?? '').slice(-200)}`;
ok('with the derived watchdog, still PLANNING while retries could run', stateOf(derived) === 'PLANNING', stateOf(derived));
// Before VOICE-002 this request was reset here (IDLE), mid-retry, in silence.
ok('a watchdog set shorter than the retries is raised: still PLANNING while retries could run', stateOf(oldStyle) === 'PLANNING', stateOf(oldStyle));
ok('budget with these timings is 2.9 s', llmRequestBudgetMs({ JARVIS_LLM_TIMEOUT_MS: '300' }) === 2_900);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
