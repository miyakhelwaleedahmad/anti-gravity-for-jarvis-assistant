/**
 * tests/llmTimingTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PERF-03: a model request gets 3 attempts of 10 s, but the PLANNING
 * watchdog reset the state machine after 15 s, cutting the retries off.
 *
 *   1. the watchdog's default covers every attempt (32 s with the defaults,
 *      and it follows JARVIS_LLM_TIMEOUT_MS)
 *   2. a value set below that is kept, with a warning that says why
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
ok('kept', low === 20_000);
ok('…with a warning naming the budget', warnings.length === 1 && /at least 32000/.test(warnings[0]!), warnings[0]);
warnings.length = 0;
planningWatchdogMs({ JARVIS_PLANNING_WATCHDOG_MS: '40000' }, (m) => warnings.push(m));
ok('a value above the budget: no warning', warnings.length === 0);

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
ok('with a watchdog shorter than the retries, it is reset (what happened before)', stateOf(oldStyle) === 'IDLE', stateOf(oldStyle));
ok('budget with these timings is 2.9 s', llmRequestBudgetMs({ JARVIS_LLM_TIMEOUT_MS: '300' }) === 2_900);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
