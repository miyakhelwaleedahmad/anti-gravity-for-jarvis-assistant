/**
 * tests/kernelOutcomeA5cTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase A5c (audit TRA-10, and B1's item: "a controller that reports a failure
 * without throwing … reported as a failure through the kernel, with a test").
 * The kernel counted any returned value as success; controllers returned
 * failures as text ("Permission denied.", "No running window found…", an
 * {"error"} JSON, an empty list). Owner, 2026-11-03: Q1 a tab that is not open
 * is a failure (nothing closed); Q2/Q3 a list that could not be read is a
 * failure with the reason.
 *
 *   1. app and window actions that did not happen
 *   2. browser: tab list unreadable; a tab that is not open (Q1)
 *   3. system and process lists PowerShell could not read (Q2)
 *   4. window list / PC state not read (Q3, A5a's reason)
 *   5. file read refused or failed
 *   6. the kernel itself: a JSON {success:false} or {error} is a failure; plain text and data stay successes
 *   7. through the tool the planner calls, and in the audit log
 *   8. unchanged: actions that did happen are successes
 *
 * Every dependency is a stand-in (windows, PowerShell, Chrome, permission), so
 * the test is the same on Windows and Linux.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-kernel-a5c-'));
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

const { pcControlKernel } = await import('../control/pcControlKernel.js');
const { appController } = await import('../control/appController.js');
const { windowController } = await import('../control/windowController.js');
const { browserController } = await import('../control/browserController.js');
const { systemController } = await import('../control/systemController.js');
const { processController } = await import('../control/processController.js');
const { fileController } = await import('../control/fileController.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { actionAuditLog } = await import('../control/actionAuditLog.js');
const { psSession, freshWindowList } = await import('../perception/windowsState.js');

// Permission: allowed unless a check says otherwise.
let allow = true;
(permissionSession as any).checkPermission = () => allow;
// PowerShell's window list, stood in for: it does not answer (A5a's "unavailable").
psSession.stop();
(psSession as any).isAlive = () => true;
(psSession as any).query = async () => { throw new Error('PowerShell did not answer (test)'); };
(psSession as any).queryWhenFree = (psSession as any).query;
freshWindowList.read = async () => { throw new Error('a fresh PowerShell failed too (test)'); };
// The audit log: kept, not written.
const audit: Array<{ action: string; result: string; error?: string }> = [];
(actionAuditLog as any).log = async (e: any) => { audit.push({ action: e.action, result: e.result, error: e.error }); };

const NOTEPAD = { name: 'notepad', pid: 7, windowTitle: 'notes.txt - Notepad', hwnd: '0x1A2B' };
const windowsWith = (apps: any[]) => async () => ({ activeWindow: { title: '', processName: '', pid: 0 }, openApps: apps });
const automated: string[][] = [];
const deskDeps = (apps: any[], automate?: (args: string[]) => Promise<string>) => ({
  windows: windowsWith(apps),
  allWindows: async () => apps.map((a) => ({ hwnd: a.hwnd, title: a.windowTitle, process: a.name, pid: a.pid })),
  automate: automate ?? (async (args: string[]) => { automated.push(args); return `Focused window ${args[args.length - 1]}`; }),
  approve: async () => true,
});
const failure = (r: any, why: RegExp) => r.success === false && why.test(String(r.error ?? ''));

console.log('\n=== Kernel outcomes (phase A5c) ===\n');

console.log('--- 1. app and window actions that did not happen ---');
{
  (appController as any).deps = deskDeps([]);
  let r = await pcControlKernel.focusApp('notepad');
  ok('focus app, no such window: a failure with the reason', failure(r, /No running window found for app "notepad"/), JSON.stringify(r).slice(0, 160));
  allow = false;
  r = await pcControlKernel.focusApp('notepad');
  ok('focus app, permission refused: a failure', failure(r, /Permission denied/), JSON.stringify(r).slice(0, 160));
  r = await pcControlKernel.focusWindow('notepad');
  ok('focus window, permission refused: a failure', failure(r, /Permission denied/), JSON.stringify(r).slice(0, 160));
  allow = true;
  (windowController as any).deps = deskDeps([]);
  r = await pcControlKernel.focusWindow('notepad');
  ok('focus window, no such window: a failure with the reason (it was caught and returned as text)', r.success === false && String(r.error ?? '').length > 0 && !r.message, JSON.stringify(r).slice(0, 160));
  (windowController as any).deps = deskDeps([NOTEPAD], async () => { throw new Error('WinAutomate script failed (exit 1): no such window (test)'); });
  r = await pcControlKernel.focusWindow('notepad');
  ok('focus window, Windows refused it: a failure with the reason (not the error as a success message)', failure(r, /WinAutomate script failed/), JSON.stringify(r).slice(0, 160));
}

console.log('--- 2. browser ---');
let listReads = 0;
{
  // JARVIS's Chrome not running: the tab list cannot be read.
  (browserController as any).deps = { chrome: { running: async () => undefined }, approve: async () => true };
  let r = await pcControlKernel.getChromeTabs();
  ok('list tabs, Chrome not running: a failure with the reason', failure(r, /Chrome is not running|not running/i), JSON.stringify(r).slice(0, 160));
  allow = false;
  r = await pcControlKernel.getChromeTabs();
  ok('list tabs, permission refused: a failure', failure(r, /Permission denied/), JSON.stringify(r).slice(0, 160));
  allow = true;
  // A Chrome with one tab that is not the one asked for (Q1).
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list' || req.url === '/json') listReads++;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/json/version') res.end(JSON.stringify({ Browser: 'Chrome/130.0', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake-a5c' }));
    else if (req.url === '/json/list' || req.url === '/json') res.end(JSON.stringify([{ id: 'T0', type: 'page', title: 'Inbox - Gmail', url: 'https://mail.google.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/T0' }]));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  (browserController as any).deps = { chrome: { running: async () => ({ port, browserPath: '/devtools/browser/fake-a5c' }) }, approve: async () => true };
  listReads = 0;
  r = await pcControlKernel.closeBrowserTab('youtube');
  ok('close a tab that is not open: a failure, nothing closed (Q1)', failure(r, /is not open/), JSON.stringify(r).slice(0, 160));
  ok('…and it is not retried (the tab list read once: C4)', listReads === 1, `${listReads} read(s)`);
  r = await pcControlKernel.getChromeTabs();
  ok('(unchanged) list tabs, Chrome running: a success with the tab', r.success === true && /Gmail/.test(r.message), JSON.stringify(r).slice(0, 160));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('--- 3. system and process lists PowerShell could not read (Q2) ---');
{
  const brokenPs = { powershell: async () => ({ exitCode: 1, stdout: '', stderr: 'Get-Volume failed (test)' }) };
  (systemController as any).deps = brokenPs;
  let r = await pcControlKernel.getDiskStatus();
  ok('disk status, PowerShell failed: a failure with the reason, not an empty success', failure(r, /Get-Volume failed|PowerShell/), JSON.stringify(r).slice(0, 160));
  r = await pcControlKernel.getStartupTasks();
  ok('startup tasks, PowerShell failed: a failure', failure(r, /failed|PowerShell/), JSON.stringify(r).slice(0, 160));
  (systemController as any).deps = { powershell: async () => { throw new Error('spawn powershell ENOENT (test)'); } };
  r = await pcControlKernel.getDiskStatus();
  ok('disk status, PowerShell missing: a failure, not {"error"} as a success', failure(r, /ENOENT/), JSON.stringify(r).slice(0, 160));
  (processController as any).deps = { ...(processController as any).deps, powershell: async () => ({ exitCode: 1, stdout: '', stderr: 'Get-Process failed (test)' }) };
  r = await pcControlKernel.listProcesses();
  ok('process list, PowerShell failed: a failure, not []', failure(r, /Get-Process failed|could not/i) && r.message !== '[]', JSON.stringify(r).slice(0, 160));
}

console.log('--- 4. window list / PC state not read (Q3) ---');
{
  (windowController as any).deps = { ...deskDeps([]), windows: async () => ({ activeWindow: { title: '', processName: '', pid: 0 }, openApps: [], unavailable: 'PowerShell did not answer (test)' }) };
  let r = await pcControlKernel.getOpenWindows();
  ok('list open windows, the list was not read: a failure with the reason, not []', failure(r, /PowerShell did not answer/), JSON.stringify(r).slice(0, 160));
  r = await pcControlKernel.getPcState();
  ok('PC state, the window list was not read: a failure with the reason', failure(r, /could not be read|PowerShell did not answer/), JSON.stringify(r).slice(0, 160));
  // Review C5: focus and close by name, and the app list, say "not read", never "no such window".
  const unread = { activeWindow: { title: '', processName: '', pid: 0 }, openApps: [], unavailable: 'PowerShell did not answer (test)' };
  let reads = 0;
  (appController as any).deps = { ...deskDeps([]), windows: async () => { reads++; return unread; } };
  r = await pcControlKernel.focusApp('notepad');
  ok('focus app, the list was not read: says so, not "No running window found" (C5)', failure(r, /could not be read/) && !/No running window/.test(String(r.error)), JSON.stringify(r).slice(0, 160));
  ok('…and it is not retried (one read, the reason kept: C4)', reads === 1, `${reads} read(s)`);
  r = await pcControlKernel.closeApp('notepad');
  ok('close app, the list was not read: says so (C5)', failure(r, /could not be read/), JSON.stringify(r).slice(0, 160));
  r = await pcControlKernel.listApps();
  ok('list apps, the list was not read: says so, not "no apps" (C5)', failure(r, /could not be read/), JSON.stringify(r).slice(0, 160));
  reads = 0;
  (windowController as any).deps = { ...deskDeps([]), windows: async () => { reads++; return unread; } };
  r = await pcControlKernel.closeWindow('notepad');
  ok('close window by name, the list was not read: says so (C5)', failure(r, /could not be read/), JSON.stringify(r).slice(0, 160));
  reads = 0;
  r = await pcControlKernel.minimizeWindow('notepad');
  ok('minimize window, the list was not read: says so, read once (C4)', failure(r, /could not be read/) && reads === 1, `${reads} read(s) ${JSON.stringify(r).slice(0, 120)}`);
}

console.log('--- 5. file read ---');
{
  const notes = path.join(workspace, 'data', 'notes.txt');
  fs.writeFileSync(notes, 'buy milk');
  let r = await pcControlKernel.readFile(path.join(workspace, 'data', 'missing.txt'));
  ok('read a file that does not exist: a failure, not "Error reading file" as a success', failure(r, /ENOENT|no such file/i), JSON.stringify(r).slice(0, 160));
  const secret = path.join(workspace, 'data', '.env');
  fs.writeFileSync(secret, 'TOKEN=abc123');
  r = await pcControlKernel.readFile(secret);
  ok('read a secret file: a failure (refused), its text in no result', failure(r, /does not read/) && !JSON.stringify(r).includes('abc123'), JSON.stringify(r).slice(0, 160));
  r = await pcControlKernel.readFile(notes);
  ok('(unchanged) read a normal file: a success with its text', r.success === true && r.message === 'buy milk', JSON.stringify(r).slice(0, 160));
  // Review C3: a file's own JSON is data, not a controller's report.
  const rpc = path.join(workspace, 'data', 'reply.json');
  fs.writeFileSync(rpc, JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } }));
  r = await pcControlKernel.readFile(rpc);
  ok('read a JSON file with its own "error" field: a success with its contents (C3)', r.success === true && /Method not found/.test(r.message), JSON.stringify(r).slice(0, 160));
}

console.log('--- 6. the kernel itself ---');
{
  const original = systemController.getSystemStatus.bind(systemController);
  (systemController as any).getSystemStatus = async () => JSON.stringify({ error: 'the system could not be read (test)' });
  let r = await pcControlKernel.getSystemResources();
  ok('a returned {"error"} object: a failure with that reason', failure(r, /could not be read \(test\)/), JSON.stringify(r).slice(0, 160));
  (systemController as any).getSystemStatus = async () => JSON.stringify({ success: false, error: 'refused (test)' });
  r = await pcControlKernel.getSystemResources();
  ok('a returned {"success": false}: a failure with its reason', failure(r, /refused \(test\)/), JSON.stringify(r).slice(0, 160));
  (systemController as any).getSystemStatus = async () => JSON.stringify([{ error: 'inside a list is data' }]);
  r = await pcControlKernel.getSystemResources();
  ok('a list is data, not a failure', r.success === true, JSON.stringify(r).slice(0, 160));
  (systemController as any).getSystemStatus = async () => [{ error: 'a list returned as itself, not as text' }];
  r = await pcControlKernel.getSystemResources();
  ok('…also when a list is returned as itself, not as text', r.success === true, JSON.stringify(r).slice(0, 160));
  (systemController as any).getSystemStatus = async () => 'Error is a word in this sentence.';
  r = await pcControlKernel.getSystemResources();
  ok('plain text stays a success (no guessing from words)', r.success === true, JSON.stringify(r).slice(0, 160));
  (systemController as any).getSystemStatus = original;
  r = await pcControlKernel.getSystemResources();
  ok('(unchanged) the real system status: a success', r.success === true && /platform/.test(r.message), r.message.slice(0, 80));
}

console.log('--- 7. through the planner\'s tool, and in the audit log ---');
{
  const { registerAllTools } = await import('../core/tools/index.js');
  const { SkillLoader } = await import('../core/skillLoader.js');
  const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
  registerAllTools();
  await new SkillLoader(skillsDir).loadSkills();
  (appController as any).deps = deskDeps([]);
  audit.length = 0;
  const r = await toolRegistryV2.execute('control_app', { action: 'focus', target: 'notepad' });
  ok('control_app focus, no window: the tool fails (the planner is told so)', r.success === false, `${r.success} ${(r.error ?? r.output).slice(0, 120)}`);
  ok('…and the audit log records a failure, not "success"', audit.some((a) => a.action === 'focusApp' && a.result === 'failure'), JSON.stringify(audit));
  // Review C2: get_pc_state is the tool the planner calls; the window list is not read (stand-in PowerShell).
  const pc = await toolRegistryV2.execute('get_pc_state', {});
  ok('get_pc_state, the window list not read: the tool fails with the reason, not an empty success (C2)', pc.success === false && /could not be read/.test(`${pc.error ?? ''} ${pc.output}`), `${pc.success} ${(pc.error ?? pc.output).slice(0, 140)}`);
}

console.log('--- 8. unchanged: actions that happened ---');
{
  automated.length = 0;
  (appController as any).deps = deskDeps([NOTEPAD]);
  const r = await pcControlKernel.focusApp('notepad');
  ok('focus app, the window exists: a success', r.success === true && automated.length === 1, JSON.stringify(r).slice(0, 160));
  (windowController as any).deps = deskDeps([NOTEPAD]);
  const w = await pcControlKernel.focusWindow('notepad');
  ok('focus window, Windows did it: a success', w.success === true, JSON.stringify(w).slice(0, 160));
  (systemController as any).deps = { powershell: async () => ({ exitCode: 0, stdout: '[{"DriveLetter":"C"}]', stderr: '' }) };
  const d = await pcControlKernel.getDiskStatus();
  ok('disk status, PowerShell answered: a success with the answer', d.success === true && /DriveLetter/.test(d.message), JSON.stringify(d).slice(0, 160));
  (processController as any).deps = { ...(processController as any).deps, powershell: async () => ({ exitCode: 0, stdout: '[{"ProcessName":"notepad","Id":7}]', stderr: '' }) };
  const p = await pcControlKernel.listProcesses();
  ok('process list, PowerShell answered: a success with the list', p.success === true && /notepad/.test(p.message), JSON.stringify(p).slice(0, 160));
  (windowController as any).deps = deskDeps([NOTEPAD]);
  const l = await pcControlKernel.getOpenWindows();
  ok('list open windows, the list was read: a success with it', l.success === true && /Notepad/.test(l.message), JSON.stringify(l).slice(0, 160));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
