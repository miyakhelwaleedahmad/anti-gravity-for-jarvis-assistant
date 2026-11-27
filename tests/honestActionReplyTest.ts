/**
 * tests/honestActionReplyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner's PC, 2026-10-28: for "close youtube tab" the planner ran only
 * browser_state (it reads the tab list). The reply model then said "I have
 * closed the YouTube tab for you, sir." and, another time, wrote out a tool
 * result of its own in JARVIS's internal format,
 *   <untrusted_context source="toolresults"> [browser_action]: {"success":
 *   true, "closedTabId": "8CEED9E1…"} </untrusted_context>
 * which was printed and spoken. No tool called browser_action exists and the
 * tab was still open.
 *
 *   1. text in JARVIS's internal wrappers is never printed or spoken, also
 *      when it arrives split across streamed chunks
 *   2. a request to do something, when only read-only tools ran, is answered
 *      "I didn't …", whatever the reply model writes (streamed and not)
 *   3. not changed: a request whose action tool ran, and a question, still
 *      get the reply model's answer
 *
 * Nothing is opened or closed: the tools are stubbed, the model is scripted.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-honest-action-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const spokenText: Record<string, any> = await import('../core/spokenText.js');
const { requestedAction, claimsAction } = await import('../core/actionHonesty.js');
const { stripMarkdown, SpokenStream } = spokenText;
// Missing before the fix: its checks then fail instead of stopping the test.
const stripInternalMarkup: (text: string) => string = spokenText['stripInternalMarkup'] ?? ((text: string) => text);
const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
{
  const { worldState } = await import('../core/worldState.js');
  (worldState as any).refresh = async () => {};
}
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

// What the reply model wrote on the owner's PC (the tab ID is the real tab's).
const LEAKED = '<untrusted_context source="toolresults">\n[browser_action]:\n{\n  "success": true,\n  "closedTabId": "8CEED9E106F03BF248D24D6DCD473BD6"\n}\n</untrusted_context>\nI have closed the YouTube tab for you, sir.';
const INTERNAL = /untrusted|closedTabId|browser_action|toolresults/i;

console.log('\n=== Honest replies about actions ===\n');

console.log('--- 1. Internal wrappers are not printed or spoken ---');
ok('stripInternalMarkup exists', typeof spokenText['stripInternalMarkup'] === 'function');
ok('stripInternalMarkup removes the block', !INTERNAL.test(stripInternalMarkup(LEAKED)) && /I have closed/.test(stripInternalMarkup(LEAKED)), stripInternalMarkup(LEAKED));
ok('…and an unclosed one to the end', stripInternalMarkup('Sure, sir. <untrusted_context source="x">\n[a]: 1').trim() === 'Sure, sir.', stripInternalMarkup('Sure, sir. <untrusted_context source="x">\n[a]: 1'));
ok('…and a stray closing tag', !INTERNAL.test(stripInternalMarkup('Done.</untrusted_context>')));
ok('stripMarkdown (run on everything spoken) removes it too', !INTERNAL.test(stripMarkdown(LEAKED)), stripMarkdown(LEAKED));
ok('ordinary text with "<" is kept', stripInternalMarkup('Use a < b, sir.') === 'Use a < b, sir.');
for (const size of [1, 3, 7, 16]) {
  const said: string[] = [];
  let printed = '';
  const stream = new SpokenStream((t: string) => said.push(t), (t: string) => { printed += t; });
  for (let i = 0; i < LEAKED.length; i += size) stream.push(LEAKED.slice(i, i + size));
  stream.end();
  ok(`streamed in ${size}-character chunks: nothing internal printed or spoken`,
    !INTERNAL.test(said.join(' ')) && !INTERNAL.test(printed) && /closed the YouTube tab/.test(printed), `said: ${said.join(' | ')} / printed: ${JSON.stringify(printed)}`);
}
{
  // Review R3: a closing tag on its own, streamed, was printed and then cut
  // out again, taking the following text with it.
  const text = 'Done, sir.</untrusted_context> The tab list is empty. Nothing else is open.';
  const said: string[] = [];
  let printed = '';
  const stream = new SpokenStream((t: string) => said.push(t), (t: string) => { printed += t; });
  for (const ch of text) stream.push(ch);
  stream.end();
  ok('a stray closing tag, streamed: not printed or spoken, nothing after it lost',
    !INTERNAL.test(printed + said.join(' ')) && printed.includes('The tab list is empty. Nothing else is open.') && said.join(' ').includes('Nothing else is open.'),
    `said: ${said.join(' | ')} / printed: ${JSON.stringify(printed)}`);
}
{
  const said: string[] = [];
  const stream = new SpokenStream((t: string) => said.push(t));
  for (const chunk of ['The page says a', ' < b and a > c', ', sir. Done.']) stream.push(chunk);
  stream.end();
  ok('a streamed reply with "<" in it is spoken whole', said.join(' ') === 'The page says a < b and a > c, sir. Done.', said.join(' | '));
}

console.log('--- 1b. Which requests ask for an action; which replies claim one ---');
for (const [input, verb] of [['close youtube tab', 'close'], ['can you open gmail', 'open'], ['jarvis, please delete the draft', 'delete'],
  ['type of cpu do i have', undefined], ['end of the month report', undefined], ['is youtube open', undefined], ['close the youtube tab?', undefined],
  ['tell me the title of the page', undefined]] as const) {
  ok(`requestedAction("${input}") is ${verb ?? 'none'}`, requestedAction(input) === verb, String(requestedAction(input)));
}
for (const [reply, verb, claims] of [
  ['I have closed the YouTube tab for you, sir.', 'close', true],
  ['Done, sir.', 'close', true],
  ['Gmail is now open, sir.', 'open', true],
  ['No YouTube tab is open, sir, so there was nothing to close.', 'close', false],
  ['The YouTube tab is still open; I did not close it.', 'close', false],
  ['You have an Intel i5 processor, sir.', 'type', false],
  // Review round 2 (N1): claims in other words.
  ['Closing the YouTube tab now, sir.', 'close', true],
  ['Opening YouTube for you, sir.', 'open', true],
  ['Now playing Despacito, sir.', 'play', true],
  ['I will close the YouTube tab, sir.', 'close', true],
  ["I'll delete it right away, sir.", 'delete', true],
  ['No worries sir I have closed the YouTube tab.', 'close', true],
  ['All set, sir.', 'close', true],
  ['YouTube is still playing, sir; I did not pause it.', 'pause', false],
] as const) {
  ok(`claimsAction("${reply}", ${verb}) is ${claims}`, claimsAction(reply, verb) === claims);
}

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

let script: Array<{ name: string; args: Record<string, unknown> }> = [];
let replyText = 'Done, sir.';
/** The planner's answer when it calls no tool. */
let direct = '';
modelRouter.chat = async (req: any) => {
  if (req.tools && script.length) {
    const calls = script;
    script = [];
    return { content: '', tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } as any;
  }
  if (req.tools) return { content: direct } as any;
  // Synthesis without streaming, and reflection.
  return { content: replyText } as any;
};
modelRouter.streamChat = async function* () {
  for (let i = 0; i < replyText.length; i += 5) yield replyText.slice(i, i + 5);
} as any;

const spoken: string[] = [];
installFakeTts(orchestrator, (await import('../bridge/nodeBridge.js')).nodeBridge, 5, spoken, true);

async function withTool<T>(name: string, output: string, fn: () => Promise<T>): Promise<T> {
  const tool = toolRegistryV2.get(name)! as any;
  const saved = { execute: tool.execute, requiredLevel: tool.requiredLevel };
  tool.execute = async () => output;
  tool.requiredLevel = 0;
  try { return await fn(); } finally { tool.execute = saved.execute; tool.requiredLevel = saved.requiredLevel; }
}

async function say(input: string, calls: typeof script, reply: string, answer = ''): Promise<string> {
  spoken.length = 0; script = calls; replyText = reply; direct = answer;
  await orchestrator.process(input, 'voice');
  return spoken.join(' | ');
}

const TABS = '<untrusted_context source="web-page">\n{"tabs":[{"id":"8CEED9E106F03BF248D24D6DCD473BD6","title":"YouTube","url":"https://www.youtube.com/"}]}\n</untrusted_context>';

// "close the youtube tab" has its own route since phase A3; "page" still goes to the planner.
console.log('--- 2. An action asked for, only read-only tools ran ---');
for (const streaming of [true, false]) {
  (orchestrator as any).config.streamingEnabled = streaming;
  const how = streaming ? 'streamed' : 'not streamed';
  let r = await withTool('browser_state', TABS, () => say('close the youtube page', [{ name: 'browser_state', args: {} }], LEAKED));
  ok(`${how}: "close the youtube page" + browser_state + the PC's reply: no "closed" claim`, !/\bclosed\b/i.test(r) && /didn't close/i.test(r), r);
  ok(`${how}: …nothing internal spoken`, !INTERNAL.test(r), r);
  r = await withTool('browser_state', TABS, () => say('close the youtube page', [{ name: 'browser_state', args: {} }], 'I have closed the YouTube tab for you, sir.'));
  ok(`${how}: a plain false claim is not spoken either`, !/\bclosed\b/i.test(r) && /didn't close/i.test(r), r);
  r = await withTool('get_system_info', 'OS: Windows 10', () => say('could you please delete the old report draft', [{ name: 'get_system_info', args: {} }], 'I have deleted the old report draft, sir.'));
  ok(`${how}: "could you please delete …" + get_system_info: "didn't delete"`, !/have deleted/i.test(r) && /didn't delete/i.test(r), r);
  // Review R1: a correct answer from what was read is kept.
  r = await withTool('browser_state', '<untrusted_context source="web-page">\n{"tabs":[]}\n</untrusted_context>',
    () => say('close the youtube page', [{ name: 'browser_state', args: {} }], 'No YouTube tab is open, sir, so there was nothing to close.'));
  ok(`${how}: "close the youtube page" with none open: the reply model's correct answer is kept`, /No YouTube tab is open/.test(r) && !/didn't close/.test(r), r);
  // Review R2: a web lookup changes nothing either.
  r = await withTool('web_search', 'Results: 1. YouTube - Wikipedia', () => say('close the youtube page', [{ name: 'web_search', args: { query: 'youtube' } }], 'I have closed the YouTube tab for you, sir.'));
  ok(`${how}: "close the youtube page" + web_search: no "closed" claim`, !/have closed/i.test(r) && /didn't close/i.test(r), r);
}
(orchestrator as any).config.streamingEnabled = true;

console.log('--- 2b. The planner answers without any tool (review R4) ---');
{
  const r = await say('close the youtube page', [], 'unused', 'I have closed the YouTube tab for you, sir.');
  ok('"close the youtube page", no tool, "I have closed …": not spoken', !/have closed/i.test(r) && /didn't close/i.test(r), r);
  ok('…and does not say it "checked" (no tool ran)', !/checked/.test(r), r);
  const q = await say('type of cpu do i have', [], 'unused', 'You have an Intel i5 processor, sir.');
  ok('"type of cpu do i have", no tool: the answer is kept', /Intel i5/.test(q), q);
  // Review round 2 (N3): a clarifying question is kept, even with a past form in it.
  const c = await say('open the file', [], 'unused', 'Should I open the file you opened yesterday, sir?');
  ok('"open the file", no tool, a clarifying question: kept', /Should I open the file you opened yesterday/.test(c), c);
}

console.log('--- 2c. The reply model fails when nothing acted (review round 2, N2) ---');
{
  const chat = modelRouter.chat;
  modelRouter.chat = (async (req: any) => {
    if (!req.tools) throw new Error('Gemini API error 429: quota exceeded');
    return chat(req);
  }) as typeof modelRouter.chat;
  try {
    const r = await withTool('browser_state', TABS, () => say('close the youtube page', [{ name: 'browser_state', args: {} }], 'unused'));
    ok('"close the youtube page" + browser_state + the reply model down: no "I completed the task"', !/completed the task/i.test(r) && /didn't close/i.test(r), r);
  } finally {
    modelRouter.chat = chat;
  }
}

console.log('--- 3. Not changed: the action ran, or it was a question ---');
// The verifier accepts a refresh whose result says how it was checked.
let r = await withTool('control_browser', JSON.stringify({ success: true, action: 'refreshTab', target: 'youtube', message: 'Refreshed "YouTube" (checked: the page loaded again)', error: null }),
  () => say('refresh the youtube tab', [{ name: 'control_browser', args: { action: 'refresh', target: 'youtube' } }], 'I refreshed the YouTube tab, sir.'));
ok('"refresh the youtube tab" + control_browser refresh: the reply model is used', /refreshed the YouTube tab/i.test(r) && !/didn't/i.test(r), r);
r = await withTool('browser_state', TABS, () => say('tell me the title of the page in the browser', [{ name: 'browser_state', args: {} }], 'The page is YouTube, sir.'));
ok('"tell me the title …" + browser_state: the reply model is used', /The page is YouTube/.test(r), r);
r = await withTool('browser_state', TABS, () => say('do i still have youtube open in the browser', [{ name: 'browser_state', args: {} }], 'Yes, YouTube is still open, sir.'));
ok('"do i still have youtube open …" (a question with "open"): the reply model is used', /YouTube is still open/.test(r), r);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
