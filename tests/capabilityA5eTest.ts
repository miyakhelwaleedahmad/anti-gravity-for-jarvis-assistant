/**
 * tests/capabilityA5eTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase A5e (audit TRA-09; owner's choices of 2026-11-06: Q1 a tool can require
 * Windows, read from the platform; Q2 the planner's fallback offers no shell and
 * no launch; Q3 the planner path's open_app reply follows what happened).
 * Every tool was registered and offered on every OS; list_capabilities said
 * nothing about where a tool runs; a request no rule matched was offered
 * run_command; and the planner path said "Opening X, sir." after a dry run.
 *
 *   1. the capability record: 12 Windows-only tools; mixed tools have none
 *   2. the planner offers only tools that can run here
 *   3. the registry refuses a tool that cannot run here, before anything runs
 *   4. list_capabilities says whether each tool can run here, and why not
 *   5. the fallback: no shell, no launch; "minimise" / "maximise" understood
 *   6. the planner path's open_app reply: dry run, not checkable, checked
 *
 * The platform is stood in for (core/capabilities.ts, openAppDeps), so the test
 * is the same on Windows and Linux. The model is a stand-in. Speech is captured.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-capability-a5e-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'no-chrome-profile');
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';
delete process.env['JARVIS_CDP_PORT'];
process.chdir(workspace);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { selectPlanningToolNames } = await import('../core/planningToolSelection.js');
const { healthLedger, LEDGER_PIPELINES } = await import('../monitoring/healthLedger.js');
registerAllTools();
await new SkillLoader(skillsDir).loadSkills();

// The platform the capability record is read against (phase A5e).
const caps = await import('../core/capabilities.js').catch(() => undefined) as any;
ok('the platform can be stood in for (core/capabilities.ts capabilityHost)', !!caps?.capabilityHost);
const setPlatform = (p: NodeJS.Platform) => { if (caps?.capabilityHost) caps.capabilityHost.platform = () => p; };

const WINDOWS_ONLY = ['control_window', 'control_keyboard', 'control_mouse', 'control_process', 'get_open_apps', 'get_active_window',
  'is_app_open', 'windows_overview', 'ui_elements', 'ui_action', 'screenshot', 'clipboard'];
const MIXED = ['control_app', 'control_system', 'open_app', 'get_pc_state', 'get_system_state', 'run_command', 'web_search'];

console.log('\n=== Capability model (phase A5e) ===\n');

console.log('--- 1. the capability record (Q1) ---');
{
  const missing = WINDOWS_ONLY.filter((n) => !((toolRegistryV2.getMeta(n) as any)?.requires ?? []).includes('windows'));
  ok('the 12 Windows-only tools require Windows', missing.length === 0, missing.join(', ') || 'all 12');
  const marked = MIXED.filter((n) => ((toolRegistryV2.getMeta(n) as any)?.requires ?? []).length > 0);
  ok('mixed and other tools require nothing', marked.length === 0, marked.join(', ') || 'none');
}

console.log('--- 2. the planner ---');
{
  setPlatform('linux');
  let offered = selectPlanningToolNames('no i am asking that we should maximize the notepad');
  ok('not Windows: "maximize the notepad" is not offered control_window', !offered.includes('control_window'), offered.join(', '));
  offered = selectPlanningToolNames('type hello in notepad');
  ok('not Windows: "type hello in notepad" gets no Windows-only tool', !offered.some((t) => WINDOWS_ONLY.includes(t)), offered.join(', '));
  ok('…and still the tools that can run (open_app)', offered.includes('open_app'), offered.join(', '));
  setPlatform('win32');
  offered = selectPlanningToolNames('no i am asking that we should maximize the notepad');
  ok('Windows: "maximize the notepad" is offered control_window, as before', offered.includes('control_window'), offered.join(', '));
  offered = selectPlanningToolNames('type hello in notepad');
  ok('Windows: "type hello in notepad" is offered ui_action and control_keyboard, as before', offered.includes('ui_action') && offered.includes('control_keyboard'), offered.join(', '));
}

console.log('--- 3. the registry ---');
{
  setPlatform('linux');
  healthLedger.clear();
  const t0 = Date.now();
  let r = await toolRegistryV2.execute('control_window', { action: 'maximize', target: 'notepad' });
  ok('not Windows: control_window is refused, with the reason', !r.success && r.error === 'RISK_REFUSED'
    && /control_window needs Windows, and this computer is not running Windows/.test(r.output), `${r.error}: ${r.output}`);
  ok('…before anything ran (at once)', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  // A call that would ask for approval: refused before the approval is asked (review E7).
  const { approvalGate } = await import('../security/approvalGate.js');
  const realAsk = approvalGate.requestApproval.bind(approvalGate);
  let asked = 0;
  (approvalGate as any).requestApproval = async (...a: unknown[]) => { asked++; return false; };
  try {
    r = await toolRegistryV2.execute('control_process', { action: 'kill', target: 'notepad' });
  } finally { (approvalGate as any).requestApproval = realAsk; }
  ok('not Windows: a call that would ask (control_process kill) is refused without asking', !r.success && /control_process needs Windows/.test(r.output) && asked === 0, `asked=${asked} ${r.output}`);
  r = await toolRegistryV2.execute('get_open_apps', {});
  ok('not Windows: a Windows-only read tool too', !r.success && /get_open_apps needs Windows/.test(r.output), r.output);
  ok('…and a refusal is not recorded as a tool fault', !healthLedger.history(LEDGER_PIPELINES.tools).some((o) => !o.ok), JSON.stringify(healthLedger.history(LEDGER_PIPELINES.tools)));
  setPlatform('win32');
  r = await toolRegistryV2.execute('get_active_window', {});
  ok('Windows: the same kind of tool is not refused for its platform', !/needs Windows, and this computer is not running Windows/.test(r.output), r.output.slice(0, 160));
  setPlatform('linux');
  r = await toolRegistryV2.execute('get_system_info', {});
  ok('not Windows: a tool that needs nothing still runs', r.success, r.output.slice(0, 80));
  healthLedger.clear();
}

console.log('--- 4. list_capabilities ---');
{
  const entry = (name: string) => toolRegistryV2.describeCapabilities().flatMap((g: any) => g.tools).find((t: any) => t.name === name) as any;
  setPlatform('linux');
  let e = entry('control_window');
  ok('not Windows: control_window is listed as not available, with the reason', e?.available === false && /needs Windows/.test(String(e?.unavailableBecause)), JSON.stringify(e));
  e = entry('open_app');
  ok('…open_app is available', e?.available === true && e?.unavailableBecause === undefined, JSON.stringify(e));
  setPlatform('win32');
  e = entry('control_window');
  ok('Windows: control_window is available', e?.available === true, JSON.stringify(e));
  const out = await toolRegistryV2.execute('list_capabilities', { category: 'COMPUTER' });
  ok('the list_capabilities tool shows it', out.success && /"available"/.test(out.output), out.output.slice(0, 120));
}

console.log('--- 5. the fallback (Q2) ---');
{
  setPlatform('win32');
  for (const q of ['you have full access up please so why you cant', 'language commands can you tell me']) {
    const offered = selectPlanningToolNames(q);
    ok(`"${q}": no shell and no launch`, !offered.includes('run_command') && !offered.includes('open_app'), offered.join(', '));
    ok('…but the capability list, to answer from', offered.includes('list_capabilities'), offered.join(', '));
  }
  let offered = selectPlanningToolNames('no minimise');
  ok('"no minimise" (British spelling): the window tools, not a shell', offered.includes('control_window') && !offered.includes('run_command'), offered.join(', '));
  offered = selectPlanningToolNames('maximise the window');
  ok('"maximise the window": control_window', offered.includes('control_window'), offered.join(', '));
  offered = selectPlanningToolNames('run npm test');
  ok('a request to run a command still gets run_command', offered.includes('run_command'), offered.join(', '));
  // Questions about recent changes reached the fallback, and with it run_command (git status); now git_overview (review E1).
  for (const q of ['what changed in my project', 'what did i change today', 'show me my changes', "what's changed in my project", 'what have i changed', 'what changes did i make', 'show my recent changes', 'any changes in my project',
    // As speech-to-text gave it on the owner's PC (2026-11-06): "change", not "changed".
    'what change in my project', 'what changes in my project', 'thank you for your assistance but what change in my project can you tell me',
    // Any request naming the project with a change word (review E15): "I do not have access to your project" came from the fallback.
    'what was changed in my project', 'what got changed in my project', 'what are the changes in my project', 'what is new in my project', 'which files changed in my project']) {
    offered = selectPlanningToolNames(q);
    ok(`"${q}": git_overview, to answer from`, offered.includes('git_overview'), offered.join(', '));
  }
  offered = selectPlanningToolNames('what changed in the weather');
  ok('…but not for any "changed" ("what changed in the weather")', !offered.includes('git_overview'), offered.join(', '));
  // Only questions about changes (review E11): a request to act on them is not given git_overview.
  for (const q of ['undo my changes', 'save my changes', 'type my changes into notepad']) {
    offered = selectPlanningToolNames(q);
    ok(`"${q}": not git_overview (an action, not a question)`, !offered.includes('git_overview'), offered.join(', '));
  }
}

console.log('--- 6. the planner path\'s open_app reply (Q3) ---');
{
  setPlatform('win32');
  const automation = await import('../skills/automation/skill.js') as any;
  const deps = automation.openAppDeps;
  const realDeps = deps ? { spawn: deps.spawn, platform: deps.platform } : undefined;
  if (deps) {
    deps.platform = () => 'win32';
    deps.spawn = () => { const p = new EventEmitter() as EventEmitter & { unref(): void }; p.unref = () => undefined; setTimeout(() => p.emit('exit', 0, null), 5); return p; };
  }
  const { orchestrator } = await import('../core/orchestrator.js');
  { const { worldState } = await import('../core/worldState.js'); (worldState as any).refresh = async () => {}; }
  const { modelRouter } = await import('../bridge/modelRouter.js');
  const { memoryManager } = await import('../memory/memoryManager.js');
  const { agentStateMachine } = await import('../core/agentStateMachine.js');
  await memoryManager.init();
  let script: Array<{ name: string; args: Record<string, unknown> }> = [];
  modelRouter.chat = async (req: any) => {
    if (req.tools && script.length) {
      const calls = script; script = [];
      return { content: '', tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } as any;
    }
    return { content: '{"failureClass":"unknown","repairStrategy":"retry_same","context":""}' } as any;
  };
  modelRouter.streamChat = async function* () { yield 'Done, sir.'; } as any;
  const spoken: string[] = [];
  const { nodeBridge } = await import('../bridge/nodeBridge.js');
  installFakeTts(orchestrator, nodeBridge, 5, spoken, true);
  const say = async (input: string, calls: typeof script) => {
    spoken.length = 0; script = calls;
    agentStateMachine.reset();
    await orchestrator.process(input, 'cli').catch((e: Error) => spoken.push(`THROWN: ${e.message}`));
    await sleep(250);
    return spoken.join(' | ');
  };

  let said = await say('how can you check that notepad is open', [{ name: 'open_app', args: { target: 'notepad', dryRun: true } }]);
  ok('a dry run: says it checked, and that nothing was opened', /I checked that notepad can be opened, sir; I did not open it\./i.test(said) && !/^Opening/i.test(said), said);
  said = await say('could you bring up the windows settings for me', [{ name: 'open_app', args: { target: 'settings' } }]);
  ok('started but not checkable: "I started settings, sir, but I can\'t check from here that it opened."', /I started settings, sir, but I can't check from here that it opened\./i.test(said), said);
  const tool = toolRegistryV2.get('open_app') as any;
  const savedVerify = tool.verify;
  tool.verify = async () => ({ status: 'verified', evidence: 'notepad is running' });
  try {
    said = await say('could you get notepad going for me', [{ name: 'open_app', args: { target: 'notepad' } }]);
  } finally { tool.verify = savedVerify; }
  ok('checked: "Opening Notepad, sir." with the check, as before', /^Opening notepad, sir\./i.test(said) && /notepad is running/.test(said), said);

  // The model calls a Windows-only tool anyway (it is not offered off Windows):
  // a refusal with the reason, run once, not "an unexpected error" (review of the first suite run).
  setPlatform('linux');
  said = await say('could you make that window bigger for me', [{ name: 'control_window', args: { action: 'maximize', target: 'notepad' } }]);
  ok('not Windows, the model calls control_window anyway: refused with the reason', /needs Windows, and this computer is not running Windows/.test(said), said);
  ok('…not "an unexpected error", and no error code spoken', !/unexpected error/i.test(said) && !/RISK[ _]REFUSED/.test(said), said);
  setPlatform('win32');
  if (deps && realDeps) { deps.spawn = realDeps.spawn; deps.platform = realDeps.platform; }
}

if (caps?.capabilityHost) caps.capabilityHost.platform = () => process.platform;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
