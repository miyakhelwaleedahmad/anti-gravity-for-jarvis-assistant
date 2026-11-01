/**
 * tests/routingA3Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase A3 (routing). On the owner's PC "close youtube tab" and "close the
 * youtube tab" went to the planner, which only read the tabs (2026-10-28);
 * "enable full controll mode" was not offered the full-control tool at all
 * (2026-10-27); the fast route for "enable full control mode" asked for
 * approval twice (2026-10-31).
 *
 *   1. "close [the] <name> tab" routes to closing that tab; shell text, "all",
 *      "this", "current" and long names do not
 *   2. near-misses of "enable full control mode" route to it (the approval is
 *      still asked); "disable …" and other modes never do
 *   3. the planner is offered the full-control tools for the near-misses
 *   4. enabling asks once; when it is not approved, the reply says so
 *   5. "close notepad and chrome" is offered the app tool and the browser tools
 *   6. the voice normaliser keeps "github.com"; routes are unchanged
 *
 * Nothing is opened or closed: full control is turned on in a throwaway data
 * folder and off again; no browser is started.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-routing-a3-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const { matchDeterministicCommand } = await import('../core/deterministicRoutes.js');
const { normalizeVoiceInput } = await import('../core/voiceInput.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { orchestrator } = await import('../core/orchestrator.js');
{
  const { worldState } = await import('../core/worldState.js');
  (worldState as any).refresh = async () => {};
}
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { permissionSession } = await import('../control/permissionSession.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const route = (input: string) => matchDeterministicCommand(input);
const show = (r: ReturnType<typeof route>) => (r ? `${r.type}${r.target ? ` ${r.target}` : ''}` : 'none');

console.log('\n=== Routing (phase A3) ===\n');

console.log('--- 1. "close [the] <name> tab" ---');
for (const [input, target] of [
  ['close youtube tab', 'youtube'], ['close the youtube tab', 'youtube'], ['Jarvis close the YouTube tab', 'youtube'],
  ['close the YouTube tab for me', 'youtube'], ['please close the gmail tab', 'gmail'], ['close the stack overflow tab', 'stack overflow'],
  ['close youtube', 'youtube'], ['close the github.com tab', 'github.com'], ['close the GitHub.com tab', 'github.com'], [`close the ${'a'.repeat(64)} tab`, 'a'.repeat(64)], ['close the www.google.com tab', 'www.google.com'], ['close the my.site tab', 'my.site'],
] as const) {
  const r = route(input);
  ok(`"${input}" → close_browser_tab ${target}`, r?.type === 'close_browser_tab' && r.target === target, show(r));
}
for (const input of [
  'close all tabs', 'close every tab', 'close the other tabs', 'close this tab', 'close the current tab', 'close tab', 'close that tab',
  'close the youtube tab; del *', 'close the cmd /c del * tab', 'close the a b c d tab', 'close the youtube tab and notepad',
  'close the new tab', 'close the browser tab',
  // Review R1: a filler word is not a tab's name ("the" is in many titles).
  'close the tab', 'close my tab', 'close your tab', 'close it tab', 'close one tab', 'close the first tab',
  'close the second tab', 'close the next tab', 'close the previous tab', 'close the left tab', 'close the old tab',
  'close the youtube.tab',
  // Review round 2, N1: a piece of every URL is not a tab's name either.
  `close the ${'a'.repeat(65)} tab`,
  'close the www tab', 'close the http tab', 'close the https tab', 'close the .com tab', 'close the com tab', 'close the org tab', 'close the net tab',
]) {
  const r = route(input);
  ok(`"${input}" is not a named-tab route`, r?.type !== 'close_browser_tab', show(r));
}
ok('"close the github.com tab" is not looked up as "githubcom" (review R2)', route('close the github.com tab')?.target !== 'githubcom', show(route('close the github.com tab')));
ok('"close current tab" keeps its own route', route('close current tab')?.type === 'close_current_tab', show(route('close current tab')));

console.log('--- 2. Near-misses of "enable full control mode" ---');
for (const input of [
  'enable full control mode', 'enable full controll mode', 'enable fool control mode', 'enable full control', 'enable full contol mode',
  'turn on full control mode', 'activate full control mode', 'switch on full control', 'please enable full control mode',
  'unable full control mode', 'Jarvis enable full controll mode',
]) {
  const r = route(input);
  ok(`"${input}" → enable_full_control_session`, r?.type === 'enable_full_control_session', show(r));
}
for (const input of [
  'disable full control mode', 'turn off full control mode', 'stop full control mode', 'enable full screen mode',
  'is full control mode on', 'what is full control mode', 'enable control mode', 'enable full control mode and delete my files',
]) {
  const r = route(input);
  ok(`"${input}" does not enable full control`, r?.type !== 'enable_full_control_session', show(r));
}

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

console.log('--- 3. The planner is offered the full-control tools ---');
for (const input of ['enable full controll mode', 'enable fool control mode', 'please turn on full contol mode now']) {
  const tools: string[] = (orchestrator as any).selectPlanningToolNames(normalizeVoiceInput(input));
  ok(`"${input}" offers enable_full_control_session`, tools.includes('enable_full_control_session'), tools.join(','));
}

console.log('--- 4. Enabling asks once; a refusal says why ---');
modelRouter.chat = async () => ({ content: '' }) as any;
modelRouter.streamChat = async function* () { yield 'Done, sir.'; } as any;
const spoken: string[] = [];
installFakeTts(orchestrator, (await import('../bridge/nodeBridge.js')).nodeBridge, 5, spoken, true);
approvalGate.attachConsole?.();
async function enableAnswering(answer: string): Promise<{ asked: number; reply: string }> {
  let asked = 0;
  let stop = false;
  const answering = (async () => {
    let last: unknown = null;
    while (!stop) {
      const p = (approvalGate as any).pending;
      if (p && p !== last) { last = p; asked++; approvalGate.offerConsoleAnswer(answer); }
      await sleep(10);
    }
  })();
  spoken.length = 0;
  await orchestrator.process('enable full control mode', 'cli');
  stop = true;
  await answering;
  return { asked, reply: spoken.join(' | ') };
}
permissionSession.deactivateFullControl('test');
let e = await enableAnswering('yes');
ok('"enable full control mode" asks for approval once', e.asked === 1, `${e.asked} question(s)`);
ok('…and turns full control on', permissionSession.isFullControlActive() && /enabled/i.test(e.reply), e.reply);
permissionSession.deactivateFullControl('test');
e = await enableAnswering('no');
ok('not approved: full control stays off', !permissionSession.isFullControlActive());
ok('…and the reply says it was not approved, not just "Failed"', /did not approve/i.test(e.reply) && !/^Failed to enable/.test(e.reply), e.reply);

// Review R5: the skill skips its own question only inside the registry's
// approval of this very call; any other approval in scope still asks.
{
  const { runApproved } = await import('../security/approvalScope.js');
  const skill = await import('../skills/enable_full_control_session/skill.js');
  async function skillAsks(call: Record<string, unknown> | null, args: Record<string, unknown>): Promise<number> {
    let asked = 0;
    let stop = false;
    const answering = (async () => {
      let last: unknown = null;
      while (!stop) {
        const p = (approvalGate as any).pending;
        if (p && p !== last) { last = p; asked++; approvalGate.offerConsoleAnswer('no'); }
        await sleep(10);
      }
    })();
    const run = () => skill.execute(args);
    await (call ? runApproved({ level: 3, grantsLevel: 0, approvedAt: Date.now(), ...call } as any, run) : run());
    stop = true;
    await answering;
    return asked;
  }
  permissionSession.deactivateFullControl('test');
  ok('skill called directly (no approval in scope) asks', await skillAsks(null, { durationMinutes: 15 }) === 1);
  ok('inside an approval of another tool, the skill still asks',
    await skillAsks({ tool: 'control_app', args: { action: 'close', target: 'notepad' } }, { durationMinutes: 15 }) === 1);
  ok('inside an approval of this tool with other arguments, the skill still asks',
    await skillAsks({ tool: 'enable_full_control_session', args: { durationMinutes: 60 } }, { durationMinutes: 15 }) === 1);
  ok('…and full control stays off', !permissionSession.isFullControlActive());
}

console.log('--- 5. Mixed close requests ---');
for (const input of ['close notepad and chrome', 'close chrome and notepad', 'close notepad and the browser']) {
  const tools: string[] = (orchestrator as any).selectPlanningToolNames(input);
  ok(`"${input}" offers control_app and control_browser`, tools.includes('control_app') && tools.includes('control_browser'), tools.join(','));
}
{
  const tools: string[] = (orchestrator as any).selectPlanningToolNames('close chrome');
  ok('"close chrome" alone still offers no app tool (phase A2, D3)', tools.includes('control_browser') && !tools.includes('control_app'), tools.join(','));
}

console.log('--- 6. Domain names keep their dot ---');
for (const [input, expected] of [
  ['open github.com', 'open github.com'], ['open www.google.com', 'open www.google.com'], ['Open GitHub.com, please.', 'open github.com'],
  ['open youtube.', 'open youtube'], ['jarvis... open notepad', 'open notepad'], ['version 2.5 is out', 'version 2.5 is out'],
] as const) {
  ok(`normaliser: "${input}" → "${expected}"`, normalizeVoiceInput(input) === expected, JSON.stringify(normalizeVoiceInput(input)));
}
ok('"open github.com" has no route (it goes to the planner, with its dot)', route('open github.com') === null, show(route('open github.com')));
ok('"open github" still routes to github', route('open github')?.type === 'open_app' && route('open github')?.target === 'github', show(route('open github')));

permissionSession.deactivateFullControl('test');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
