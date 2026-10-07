/**
 * tests/windowsToolsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 14 — what can be checked of the Windows tools off Windows:
 *
 *  1. The parsers, on ConvertTo-Json output (tests/fixtures/windowsProbe.json).
 *  2. Nothing typed reaches PowerShell as code: the scripts read only their
 *     documented environment variables and run nothing they are given; the
 *     TypeScript side passes values only as JARVIS_* variables, checked.
 *  3. Off Windows every tool says so and does nothing.
 *  4. The risk rules for ui_action (references, terminals, passwords, what a
 *     button says, what a dialog asks), the clipboard and screenshots.
 *  5. The after-action checks keep saying "checked on Windows only" here.
 *  6. The planner is offered the new tools for matching requests.
 *  7. `pnpm verify:windows` refuses to run off Windows.
 *
 * The real checks are the owner's: pnpm verify:windows on the Windows PC.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p14-')));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';

const probe = await import('../perception/windowsProbe.js');
const refs = await import('../control/uiRefs.js');
const { assessRisk } = await import('../security/riskEngine.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { verifyCall, appWindowMatcher } = await import('../core/verifiers.js');
const { narrow } = await import('../core/tools/windowsTools.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const fixtures = JSON.parse(fs.readFileSync(path.join(repo, 'tests', 'fixtures', 'windowsProbe.json'), 'utf8'));

registerAllTools();
const level = (tool: string, args: Record<string, unknown>) => assessRisk({ tool, args, baseRisk: toolRegistryV2.riskOf(tool, args) });

console.log('\n=== Windows Tools Test ===\n');

console.log('--- 1. Parsers ---');
let gpu = probe.parseGpu(fixtures.gpu);
ok('GPU: name, driver, memory, resolution; a 4 GB reading is marked as Windows\'s 32-bit limit', gpu.length === 1 && gpu[0]!.name === 'NVIDIA GeForce RTX 3060'
  && gpu[0]!.memoryGB === 4 && /at most 4 GB/.test(gpu[0]!.memoryNote ?? '') && gpu[0]!.width === 1920 && gpu[0]!.refreshHz === 144, JSON.stringify(gpu[0]));
gpu = probe.parseGpu(fixtures.gpu2);
ok('GPU: two adapters; zeros are left out, not reported', gpu.length === 2 && gpu[0]!.memoryGB === 1 && gpu[0]!.width === undefined && !gpu[0]!.memoryNote && gpu[1]!.memoryGB === undefined);
const displays = probe.parseDisplays(fixtures.displays);
ok('displays: two, the main one marked', displays.length === 2 && displays[0]!.primary && displays[1]!.x === 1920 && displays[0]!.name === '\\\\.\\DISPLAY1', JSON.stringify(displays));
const audio = probe.parseAudio(fixtures.audio);
ok('audio: the device and its endpoints, speakers and microphones told apart', audio.devices.length === 1
  && audio.endpoints.map((e) => e.role).join(',') === 'speaker,microphone,speaker', JSON.stringify(audio.endpoints));
ok('cameras: one; none is an empty list', probe.parseCameras(fixtures.cameras).length === 1 && probe.parseCameras(fixtures.cameras0).length === 0);
const apps = probe.parseApps(fixtures.apps);
ok('installed apps: name, version, publisher, total', apps.total === 2 && apps.items[1]!.name === 'Node.js' && apps.items[0]!.publisher === 'Google LLC');
const services = probe.parseServices(fixtures.services);
ok('services: name, display name, status and start type as words', services.length === 2 && services[0]!.status === 'Running' && services[1]!.start === 'Manual');
const ports = probe.parsePorts(fixtures.ports);
ok('ports: IPv4 and IPv6 listeners of one process joined, sorted by port', ports.length === 3 && ports[0]!.port === 135
  && ports[1]!.port === 5173 && ports[1]!.addresses.join(' ') === '0.0.0.0 ::' && ports[2]!.process === 'chrome', JSON.stringify(ports));
const windows = probe.parseWindows(fixtures.windows);
ok('windows: the handle as 0x… hex, as the window tools take it', windows.length === 2 && windows[0]!.hwnd === '0x1401E4' && windows[1]!.title === 'Calculator', JSON.stringify(windows));
const joined = probe.joinWindowsAndPorts(windows, ports);
ok('process ↔ window ↔ port: the terminal\'s process listens on 5173', joined[0]!.ports.join() === '5173' && joined[1]!.ports.length === 0);
ok('one object instead of a list (ConvertTo-Json of a single item) is read as a list of one',
  probe.parseCameras({ ok: true, items: { name: 'Cam', kind: 'Camera', status: 'OK' } } as any).length === 1);
const shortList = narrow('services', services, 'audio');
ok('the model gets at most 80 entries, or those matching a filter', shortList['count'] === 1 && (shortList['services'] as unknown[]).length === 1
  && narrow('x', Array.from({ length: 100 }, (_, i) => ({ i })), '')['more'] === '20 more not shown; ask with a filter.');

console.log('\n--- 2. Nothing typed becomes PowerShell code ---');
const scripts = ['perception/windows_probe.ps1', 'control/desktop.ps1', 'control/uia.ps1'].map((f) => [f, fs.readFileSync(path.join(repo, f), 'utf8')] as const);
for (const [file, text] of scripts) {
  const code = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  const runsGivenText = /Invoke-Expression|\biex\b|\[scriptblock\]::Create|Start-Process|\.InvokeScript|Invoke-Command|&\s*\$/i.test(code);
  const envNames = [...code.matchAll(/\$env:([A-Za-z_]+)/g)].map((m) => m[1]!);
  ok(`${file}: runs nothing it is given, and reads only JARVIS_* variables`, !runsGivenText && envNames.length > 0 && envNames.every((n) => /^JARVIS_[A-Z_]+$/.test(n)), envNames.join(' '));
}
const probeScript = scripts[0]![1];
ok('the probe takes its section from a fixed list (switch -Exact, unknown → an error)', /switch -Exact \(\$section\)/.test(probeScript) && /'unknown section'/.test(probeScript));
ok('uia.ps1 checks the window handle and the reference before using them', /\$hwndText -notmatch '\^\\d\{1,19\}\$'/.test(scripts[2]![1]) && /\$ref -notmatch/.test(scripts[2]![1]));
const tsSources = ['perception/windowsProbe.ts', 'control/uiAutomation.ts', 'control/desktopControl.ts'].map((f) => fs.readFileSync(path.join(repo, f), 'utf8')).join('\n');
ok('TypeScript starts powershell.exe only with -File and a fixed path, no shell', /execFile\('powershell\.exe', \['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_FILES\[file\]\]/.test(tsSources)
  && /shell: false/.test(tsSources) && !/-Command/.test(tsSources));
ok('text for a field or the clipboard goes in a temporary file, never in a variable', /JARVIS_UIA_TEXT_FILE/.test(tsSources) && /JARVIS_DESKTOP_FILE: file/.test(tsSources) && !/JARVIS_[A-Z_]*: text\b/.test(tsSources));
const refusal = await probe.runPsFile('probe', { JARVIS_PROBE_SECTION: 'gpu\nRemove-Item C:\\' }, 1000).then(() => 'ran', (e: Error) => e.message);
ok('a value with a line break is refused before PowerShell starts', /is not a value JARVIS passes/.test(refusal), refusal);
const otherFile = await probe.runPsFile('../../evil' as any, {}, 1000).then(() => 'ran', (e: Error) => e.message);
ok('only JARVIS\'s own .ps1 files can be run', /only its own PowerShell files/.test(otherFile), otherFile);
const otherName = await probe.runPsFile('probe', { PATH: 'x' }, 1000).then(() => 'ran', (e: Error) => e.message);
ok('only JARVIS_* variables are passed', /PATH is not a value/.test(otherName), otherName);

console.log('\n--- 3. Off Windows ---');
if (process.platform !== 'win32') {
  for (const [tool, args] of [['windows_overview', { section: 'gpu' }], ['ui_elements', {}], ['screenshot', {}], ['clipboard', { action: 'read' }]] as const) {
    const r = await toolRegistryV2.execute(tool, args as Record<string, unknown>);
    ok(`${tool}: says it needs Windows, and fails`, !r.success && /needs Windows/.test(r.output), r.output.slice(0, 120));
  }
  const pack = spawnSync(process.execPath, [createRequire(import.meta.url).resolve('tsx/cli'), path.join(repo, 'scripts', 'verifyWindows.ts')], { encoding: 'utf8', timeout: 60_000 });
  ok('pnpm verify:windows says where to run it, and exits with 2', pack.status === 2 && /run it there, in CMD/.test(pack.stdout), `${pack.status}: ${pack.stdout.trim()}`);
} else {
  ok('(on Windows: the pack runs these for real)', true);
}

console.log('\n--- 4. Risk rules ---');
const window = { hwnd: '657426', title: 'Confirm File Delete', process: 'explorer' };
const el = (name: string, type = 'Button', extra: Record<string, unknown> = {}) => ({
  id: `42.1.${Math.floor(Math.random() * 1e6)}`, name, type, automationId: '', className: '', enabled: true, focused: false,
  password: false, offscreen: false, patterns: ['Invoke'], value: '', depth: 2, ...extra,
});
const dialog = refs.rememberUi(window, [el('Are you sure you want to permanently delete this file?', 'Text'), el('Yes'), el('No')]);
const app = refs.rememberUi({ hwnd: '777', title: 'Shop - Checkout', process: 'msedge' }, [el('OK'), el('Buy now'), el('Delete account'), el('Search', 'Edit', { patterns: ['Value'] }), el('Password', 'Edit', { password: true, patterns: ['Value'] }), el('Install'), el('Cancel')]);
const setup = refs.rememberUi({ hwnd: '888', title: 'Setup - Tool', process: 'setup' }, [el('Ready to install', 'Text'), el('Next')]);
const terminal = refs.rememberUi({ hwnd: '999', title: 'Command Prompt', process: 'cmd' }, [el('Text Area', 'Edit', { patterns: ['Value'] })]);
const r = (action: string, ref: string, text?: string) => level('ui_action', { action, ref, ...(text ? { text } : {}) });
ok('an element JARVIS has not looked at: refused', /has not looked at that element/.test(r('invoke', 'u999999').refused ?? ''));
ok('focus: level 1', r('focus', app[0]!.ref).level === 1);
ok('typing into a field: level 2', r('set_value', app[3]!.ref, 'shoes').level === 2);
ok('typing into a password field: refused', /does not type passwords/.test(r('set_value', app[4]!.ref, 'x').refused ?? ''));
ok('pressing OK: level 2', r('invoke', app[0]!.ref).level === 2 && !r('invoke', app[0]!.ref).refused);
ok('pressing Cancel: level 2', r('invoke', app[6]!.ref).level === 2);
ok('"Delete account": level 3 (its label)', r('invoke', app[2]!.ref).level === 3);
ok('"Buy now": level 4 (it pays)', r('invoke', app[1]!.ref).level === 4);
ok('"Install": level 3', r('invoke', app[5]!.ref).level === 3);
ok('"Yes" in a dialog that asks to delete permanently: level 3', r('invoke', dialog[1]!.ref).level === 3, r('invoke', dialog[1]!.ref).reasons.join('; '));
ok('"No" in the same dialog: level 2', r('invoke', dialog[2]!.ref).level === 2);
ok('"Next" in an installer that is ready to install: level 3', r('invoke', setup[1]!.ref).level === 3);
ok('anything in a terminal window: refused (commands go through run_command)', /terminal window/.test(r('set_value', terminal[0]!.ref, 'dir').refused ?? '')
  && /terminal window/.test(r('invoke', terminal[0]!.ref).refused ?? ''));
ok('the approval names the element and its window', r('invoke', dialog[1]!.ref).target === 'Button "Yes" in Confirm File Delete (explorer)', r('invoke', dialog[1]!.ref).target);
const again = refs.rememberUi(window, [el('Yes')]);
ok('a new look at a window replaces its old references', !refs.lookupUiRef(dialog[1]!.ref) && !!refs.lookupUiRef(again[0]!.ref));
ok('references expire after 10 minutes', !refs.lookupUiRef(again[0]!.ref, Date.now() + refs.UI_REF_MAX_AGE_MS + 1));
ok('clipboard: read level 1, write level 2', level('clipboard', { action: 'read' }).level === 1 && level('clipboard', { action: 'write', text: 'x' }).level === 2);
ok('screenshot level 1; windows_overview and ui_elements level 0', level('screenshot', {}).level === 1
  && level('windows_overview', { section: 'gpu' }).level === 0 && level('ui_elements', {}).level === 0);

console.log('\n--- 5. After-action checks ---');
if (process.platform !== 'win32') {
  const checks = await Promise.all([
    verifyCall('control_window', { action: 'close', target: '0x1' }, '{"message":"Closed window 0x1"}'),
    verifyCall('control_app', { action: 'open', target: 'calculator' }, '{}'),
    verifyCall('open_app', { target: 'notepad' }, '{}'),
  ]);
  ok('off Windows: window and app actions are "checked on Windows only", never passed', checks.every((c) => c?.status === 'unverifiable' && /Windows only/.test(c.evidence)));
}
ok('an app is recognised by its window, not only its program: Calculator, VS Code, Notepad',
  appWindowMatcher('calculator').test('Calculator') && appWindowMatcher('vscode').test('Code') && appWindowMatcher('vscode').test('app.ts - Visual Studio Code')
  && appWindowMatcher('notepad').test('Notepad') && !appWindowMatcher('notepad').test('Calculator') && appWindowMatcher('a.b(c)').test('a.b(c)'));

console.log('\n--- 6. The planner is offered the new tools ---');
const { orchestrator } = await import('../core/orchestrator.js');
const offered = (q: string): string[] => (orchestrator as any).selectPlanningToolNames(q);
ok('"what graphics card do I have" → windows_overview', offered('what graphics card do I have').includes('windows_overview'));
ok('"which program is listening on port 8080" → windows_overview', offered('which program is listening on port 8080').includes('windows_overview'));
ok('"click the OK button in the dialog" → ui_elements and ui_action', ['ui_elements', 'ui_action'].every((t) => offered('click the OK button in the dialog').includes(t)));
ok('"take a screenshot" → screenshot; in a browser tab → browser_screenshot', offered('take a screenshot').includes('screenshot')
  && offered('take a screenshot of this tab').includes('browser_screenshot') && !offered('take a screenshot of this tab').includes('screenshot'));
ok('"what is on my clipboard" → clipboard', offered('what is on my clipboard').includes('clipboard'));
ok('"open chrome" still offers open_app first', offered('open chrome')[0] === 'open_app');

console.log('\n--- 7. Checks on a slow PC: at least two looks ---');
{
  // Each look at the desktop starts a fresh PowerShell; on the owner's 2010
  // iMac one look took longer than the whole time the check allowed, so a
  // window that closed while the first look ran was never seen.
  const verifiers = await import('../core/verifiers.js') as any;
  const keepLooking = verifiers.keepLooking as undefined | ((look: () => Promise<boolean>, ms: number, minLooks?: number, pauseMs?: number) => Promise<boolean>);
  ok('a helper asks the desktop again after a slow look', typeof keepLooking === 'function');
  if (keepLooking) {
    const slowLook = (answers: boolean[]) => {
      let i = 0;
      const look = async () => { await new Promise((r) => setTimeout(r, 60)); return answers[Math.min(i++, answers.length - 1)]!; };
      return { look, count: () => i };
    };
    // One look (60 ms) takes longer than the time allowed (20 ms); the window
    // is gone by the second look.
    let s1 = slowLook([false, true]);
    ok('a look slower than the time allowed is followed by a second look, which sees the change',
      (await keepLooking(s1.look, 20, 2, 0)) === true && s1.count() === 2, `looks=${s1.count()}`);
    s1 = slowLook([false, false, false]);
    ok('…and it stops after two looks when nothing changes', (await keepLooking(s1.look, 20, 2, 0)) === false && s1.count() === 2, `looks=${s1.count()}`);
    // A fast desktop: many looks within the time allowed, as before.
    let fast = 0;
    const answer = await keepLooking(async () => ++fast >= 5, 1_000, 2, 1);
    ok('on a fast PC it keeps looking within the time allowed', answer === true && fast === 5, `looks=${fast}`);
  }
}

process.chdir(os.tmpdir());
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
