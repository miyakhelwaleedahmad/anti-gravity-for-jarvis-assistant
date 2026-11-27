/**
 * tests/delegationRoutingTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal Runtime phase 4: which requests go to the agents, which become goals,
 * which stay with the orchestrator (core/delegationRouting.ts), and the
 * orchestrator's routes for them. No model, no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-routing-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
process.env['JARVIS_DATA_ROOT'] = tmp;

const { delegationFit, parseGoalRequest, withoutBackgroundPhrase, goalIntent } = await import('../core/delegationRouting.js');
const { orchestrator } = await import('../core/orchestrator.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Delegation routing ===\n');

console.log('--- What goes to the agents ---');
const delegated: [string, boolean, string?][] = [
  ['what time is it', false],
  ['how are you doing today', false],
  ['open youtube and search for python tutorials', false],
  ['play this video', false],
  ['search for the latest AI news on YouTube', false],
  ['research the latest developments in AI agents and summarize your findings', true, 'research_agent'],
  ['compare React and Vue for a small dashboard and give me a report', true, 'research_agent'],
  ['analyze these sales numbers: 10, 12, 15 and tell me the trend', true, 'data_agent'],
  ['check what changed in git; then run the tests; then tell me what failed', true],
  ['find the latest AI news in the background', true, 'research_agent'],
  ['look up the weather', false],
];
for (const [text, want, specialist] of delegated) {
  const fit = delegationFit(text);
  ok(`"${text}" → ${want ? 'agents' : 'not delegated'}`, fit.delegate === want && (!specialist || fit.specialist === specialist), `${fit.reason}; ${fit.specialist}`);
}
ok('acting on the screen is never background work', delegationFit('open chrome in the background please').foreground && !delegationFit('open chrome in the background please').delegate);
ok('the background phrase is taken off the task', withoutBackgroundPhrase('Research the latest AI news in the background.') === 'Research the latest AI news');
ok('"while I work" too', withoutBackgroundPhrase('compare three note apps while I work') === 'compare three note apps');

console.log('\n--- What becomes a goal ---');
let g = parseGoalRequest('Make it a goal to compare three note-taking apps');
ok('"make it a goal to …" → a temporary goal', g?.kind === 'temporary' && g.objective === 'compare three note-taking apps');
g = parseGoalRequest('set a long-term goal: keep the JARVIS test suite green');
ok('"set a long-term goal: …" → a permanent goal', g?.kind === 'permanent');
g = parseGoalRequest('keep improving the JARVIS test coverage');
ok('"keep improving …" → a permanent goal', g?.kind === 'permanent' && /improving the JARVIS test coverage/.test(g.objective));
g = parseGoalRequest('every morning at 8, check my project for failing tests');
ok('"every morning at 8, …" → recurring at 08:00', g?.kind === 'recurring' && g.schedule?.type === 'daily' && (g.schedule as { time: string }).time === '08:00', JSON.stringify(g?.schedule));
g = parseGoalRequest('every morning, summarise the AI news');
ok('"every morning, …" → recurring at 09:00', g?.kind === 'recurring' && (g.schedule as { time: string }).time === '09:00');
g = parseGoalRequest('every 2 hours, check the backend health');
ok('"every 2 hours, …" → recurring every 2 hours', g?.schedule?.type === 'interval' && (g.schedule as { everyMs: number }).everyMs === 7_200_000);
g = parseGoalRequest('weekdays at 9am: summarise AI news');
ok('"weekdays at 9am: …" → weekdays', JSON.stringify((g?.schedule as { weekdays?: number[] })?.weekdays) === '[1,2,3,4,5]');
ok('an ordinary request is not a goal', parseGoalRequest('what is the weather like') === undefined && parseGoalRequest('open notepad') === undefined);
ok('goal words offer the goal tools to the planner', goalIntent('remind me every day to drink water') && !goalIntent('open notepad'));

console.log('\n--- The orchestrator\'s routes ---');
const route = (t: string) => orchestrator.matchDeterministicCommand(t);
ok('"goal status" → goal_status', route('goal status')?.type === 'goal_status');
ok('"what are your goals" → goal_status', route('what are your goals')?.type === 'goal_status');
const pause = route('pause the goal about AI news');
ok('"pause the goal about AI news" → goal_control pause', pause?.type === 'goal_control' && pause.target === 'pause|ai news', pause?.target);
ok('"approve goal" → confirm the latest', route('approve goal')?.target === 'confirm|latest');
const create = route('every morning at 9, research the latest AI agent news');
ok('a scheduled request → goal_create', create?.type === 'goal_create' && JSON.parse(create.target!).kind === 'recurring');
const bg = route('Research the latest developments in AI agents in the background');
ok('"… in the background" → the Research agent, phrase removed', bg?.type === 'delegate' && bg.specialist === 'research_agent' && bg.target === 'Research the latest developments in AI agents', JSON.stringify(bg));
const fg = route('play music in the background');
ok('"play music in the background" is not sent to an agent', fg?.type !== 'delegate', JSON.stringify(fg));
ok('"open youtube" still opens YouTube', route('open youtube')?.type === 'open_app');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
