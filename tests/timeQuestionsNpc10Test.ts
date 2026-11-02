/**
 * tests/timeQuestionsNpc10Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * N-PC10 (owner's PC, 2026-11-02): "what time is this", "can you tell me time"
 * and "tell me what time is" went to the planner, which called run_command
 * with powershell (refused: "not on the developer allowlist"). Only the exact
 * "what time is it" was answered.
 *
 *   1. the fast time answer covers common wordings, and only those
 *   2. a fast date answer
 *   3. typed end to end: the answer is spoken and no model is called
 *   4. the planner's clock line: local date, time and time zone, fresh on a cache hit
 *
 * Throwaway data folder; the model is a stand-in; speech is captured, not played.
 */

// The owner's time zone (UTC+5). The static imports below run first but read no
// clock; Node 22 picks up a TZ change at run time (review T6).
process.env['TZ'] = 'Asia/Karachi';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { installFakeTts } from './fakeTts.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(repoRoot, 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-time-npc10-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';
process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'no-chrome-profile');
process.chdir(workspace);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { matchDeterministicCommand } = await import('../core/deterministicRoutes.js');

console.log('\n=== Time and date questions (N-PC10) ===\n');

console.log('--- 1. the fast time answer ---');
/** The PC clock in Karachi, as the reply writes it (en-US, review T2). */
const clockNow = () => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' }).format(new Date());
const isTimeReply = (reply: string, before: string, after: string) => reply === `It is ${before}, sir.` || reply === `It is ${after}, sir.`;
const TIME_ASKS = [
  'what time is it', 'time', 'what is the time',                    // answered before
  'what  time is this', 'what time is this', 'what time is it now',  // the owner's PC log
  "what's the time", 'whats the time', 'what is the time now', "what's the time now", "what's the current time",
  'tell me the time', 'can you tell me time', 'can you tell me the time',
  'tell me what time is', 'tell me what time it is', 'jarvis what time is it',
  'current time', 'time now', 'time please', 'What time is it?',
  // review T3, T4: "jarvis" at the end, and more wordings
  "What's the time, Jarvis?", 'what time is it jarvis', "what's the time now jarvis",
  'what time it is', 'do you know what time it is', 'give me the time',
];
for (const ask of TIME_ASKS) {
  const before = clockNow();
  const r = matchDeterministicCommand(ask);
  ok(`"${ask}" → the time, local`, r?.type === 'time' && isTimeReply(r.reply, before, clockNow()), r ? `${r.type}: ${r.reply}` : 'planner');
}
const NOT_TIME = [
  'what time is my meeting', 'set a timer for 5 minutes', 'what time does the shop close',
  'how long until 5 pm', 'remind me at 5 pm', 'time to close youtube', 'what time zone am i in',
  'tell me the time in london', 'is it time to go', 'what time is it in london',
  // review T5: not a question about the clock, or a fragment (also possibly JARVIS's own echo)
  'what is time', 'whats time', 'what time', 'the time',
];
for (const ask of NOT_TIME) {
  const r = matchDeterministicCommand(ask);
  ok(`"${ask}" → not the time or date answer`, r?.type !== 'time' && r?.type !== 'date', r ? r.type : 'planner');
}

console.log('--- 2. the fast date answer ---');
const dateNow = () => new Intl.DateTimeFormat('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Karachi' }).format(new Date());
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Karachi' }).format(new Date());
const DATE_ASKS = [
  "what's the date", 'whats the date today', 'what is the date', 'what is the date today',
  "what is today's date", "today's date", 'what day is it', 'what day is it today', 'what day is today',
  'what is today', 'can you tell me the date',
  // review T3, T4
  "what's the date jarvis", 'current date', "what's the current date", "what's today", 'tell me what day it is',
];
for (const ask of DATE_ASKS) {
  const before = dateNow();
  const r = matchDeterministicCommand(ask);
  const reply = r?.reply ?? '';
  ok(`"${ask}" → the date`, r?.type === 'date' && (reply === `Today is ${before}, sir.` || reply === `Today is ${dateNow()}, sir.`), r ? `${r.type}: ${reply}` : 'planner');
}
const NOT_DATE = [
  'what is the date of the meeting', 'what day is the meeting', "what is today's weather", "what's today's weather",
  'what day is tomorrow', 'date', 'the date', 'what day', 'what date',
];
for (const ask of NOT_DATE) {
  const r = matchDeterministicCommand(ask);
  ok(`"${ask}" → not the date answer`, r?.type !== 'date' && r?.type !== 'time', r ? r.type : 'planner');
}

{
  // Review T2: the replies are in English whatever the PC's regional format.
  // A child process with an Arabic (Saudi) locale, which also changes the digits.
  const probe = path.join(workspace, 'locale-probe.mts');
  fs.writeFileSync(probe, `import { matchDeterministicCommand } from ${JSON.stringify(path.join(repoRoot, 'core', 'deterministicRoutes.ts'))};\n`
    + `console.log(JSON.stringify([Intl.DateTimeFormat().resolvedOptions().locale, matchDeterministicCommand('what time is it')?.reply, matchDeterministicCommand('what day is it')?.reply]));\n`);
  const env = { ...process.env, LC_ALL: 'ar_SA.UTF-8', LANG: 'ar_SA.UTF-8' };
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), probe], { env, encoding: 'utf8', timeout: 120_000 });
  const line = (child.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('["')).pop() ?? '';
  let out: string[] = [];
  try { out = JSON.parse(line); } catch { /* reported below */ }
  const [locale, timeReply, dateReply] = out;
  const ascii = (t: string | undefined) => !!t && /^[\x20-\x7e]+$/.test(t);
  if (out.length === 3 && !String(locale).startsWith('ar')) {
    // Windows takes the locale from the user's settings, not LC_ALL (review T10):
    // the check would prove nothing, so it is reported, neither passed nor failed.
    console.log(`  NOTE: locale check not proven on this platform (the child's locale is ${locale}, not Arabic)`);
  } else {
    ok('with an Arabic regional format: the time reply is still English', ascii(timeReply) && /^It is \d\d:\d\d [AP]M, sir\.$/.test(timeReply!), timeReply ?? `no output: ${(child.stderr ?? '').slice(0, 200)}`);
    ok('…and so is the date reply', ascii(dateReply) && dateReply!.includes(weekday), dateReply ?? 'no output');
  }
}

console.log('--- 3. typed end to end ---');
const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { orchestrator } = await import('../core/orchestrator.js');
{ const { worldState } = await import('../core/worldState.js'); (worldState as any).refresh = async () => {}; }
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

/** The stand-in model's answer: it cannot pass for the time or date reply. */
const STUB_REPLY = 'Five hours remain until then, sir.';
/** Every request the model gets, as one string per call. */
const modelCalls: string[] = [];
const record = (req: any) => modelCalls.push((req?.messages ?? []).map((m: any) => String(m?.content ?? '')).join('\n'));
modelRouter.chat = async (req: any) => { record(req); return { content: STUB_REPLY } as any; };
modelRouter.streamChat = async function* (req: any) { record(req); yield STUB_REPLY; } as any;
const spoken: string[] = [];
const { nodeBridge } = await import('../bridge/nodeBridge.js');
installFakeTts(orchestrator, nodeBridge, 5, spoken, true);

async function typed(input: string): Promise<string> {
  spoken.length = 0;
  modelCalls.length = 0;
  agentStateMachine.reset();
  await orchestrator.process(input, 'cli').catch((e: Error) => spoken.push(`THROWN: ${e.message}`));
  await sleep(250);
  return spoken.join(' | ');
}
for (const ask of ['what  time is this', 'can you tell me time']) {
  const said = await typed(ask);
  ok(`typed "${ask}": the time is spoken`, /^It is .+, sir\.$/.test(said), said);
  ok(`…with no model call (so no shell command)`, modelCalls.length === 0, `${modelCalls.length} call(s)`);
  ok('…and JARVIS ends idle', agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
}
{
  const said = await typed('what day is it');
  ok('typed "what day is it": the date is spoken, no model call', /^Today is .+, sir\.$/.test(said) && said.includes(weekday) && modelCalls.length === 0, `${said} | ${modelCalls.length} call(s)`);
  ok('…and JARVIS ends idle', agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
}

console.log('--- 4. the planner\'s clock line ---');
const hhmm = (tz: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date());
const ymd = (tz: string) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(new Date());
{
  const before = hhmm('Asia/Karachi');
  const said = await typed('how long until 5 pm');
  const after = hhmm('Asia/Karachi');
  const sent = modelCalls.join('\n');
  ok('a planner request is sent to the model (it has no fast answer)', modelCalls.length > 0 && said.length > 0, `${modelCalls.length} call(s): ${said}`);
  ok('…with the local date', sent.includes(ymd('Asia/Karachi')), ymd('Asia/Karachi'));
  ok('…the local time', sent.includes(before) || sent.includes(after), before);
  ok('…and the time zone (UTC+05:00)', sent.includes('UTC+05:00'));
}
{
  const { unifiedContextBuilder } = await import('../memory/unifiedContextBuilder.js');
  const first = await unifiedContextBuilder.buildContext('npc10 cache check', 'npc10-session', { includeHeavy: false });
  ok('the context line says local time, with date and offset', /local time/.test(first.systemState) && first.systemState.includes('UTC+05:00') && first.systemState.includes(ymd('Asia/Karachi')), first.systemState);
  ok('…and not the old bare UTC time', !/\[SYS t=\d\d:\d\d:\d\d /.test(first.systemState), first.systemState);
  process.env['TZ'] = 'Asia/Tokyo';
  const second = await unifiedContextBuilder.buildContext('npc10 cache check', 'npc10-session', { includeHeavy: false });
  ok('on a cache hit the clock line is made fresh (time zone changed to Tokyo, no summer time)', second.systemState.includes('UTC+09:00') && second.mergedContext.includes(second.systemState), second.systemState);
  ok('…and the cached old line is gone from the context', !second.mergedContext.includes('UTC+05:00'));
  process.env['TZ'] = 'Asia/Karachi';
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
