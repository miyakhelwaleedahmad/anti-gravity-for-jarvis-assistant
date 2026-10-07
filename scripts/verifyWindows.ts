/**
 * scripts/verifyWindows.ts — `pnpm verify:windows` (P14)
 * ─────────────────────────────────────────────────────────────────────────────
 * The checks that need the owner's Windows PC, run there in CMD. Each step
 * uses JARVIS's own tools through the registry, so the risk engine and the
 * approval gate decide as in daily use:
 *
 *   1. one typed approval turns on full control mode (P3's console approval,
 *      in a real CMD window), so the level-2 steps below do not each ask;
 *      then how long Windows PowerShell takes to start on this PC, which each
 *      reading and check below starts (it explains a slow run);
 *   2. readings: GPU, displays, audio, cameras, installed apps, services,
 *      listening ports, windows, and the disks by drive letter (P6);
 *   3. a screenshot (deleted again); the clipboard read, written, put back;
 *   4. Notepad: opened, its text field filled and read back, closed — and
 *      "Don't save" pressed if it asks;
 *   5. Calculator: 1 + 2 = pressed, 3 read, closed;
 *   6. a small test server started and stopped (P10's taskkill path);
 *   7. full control mode turned off.
 *
 * Only windows this pack opened are touched. The report is written to
 * data\logs\verify-windows.json (not in git), redacted.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'win32') {
  console.log('pnpm verify:windows checks JARVIS on the Windows PC itself: run it there, in CMD.');
  process.exit(2);
}

// The test server lives in the temp folder, which joins the project folders for this run only.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-verify-'));
const serverDir = path.join(scratch, 'verify-server');
fs.mkdirSync(serverDir);
fs.writeFileSync(path.join(serverDir, 'package.json'), JSON.stringify({ name: 'verify-server', private: true, scripts: { dev: 'node server.js' } }, null, 2));
fs.writeFileSync(path.join(serverDir, 'server.js'),
  "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready on http://localhost:' + process.env.PORT));\n");
process.env['JARVIS_PROJECT_DIRS'] = [process.env['JARVIS_PROJECT_DIRS'], scratch].filter(Boolean).join(';');

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

console.log(`
JARVIS — Windows check (P14)

This opens Notepad and Calculator, types a test line into the Notepad it
opened, presses 1 + 2 = in Calculator, takes a screenshot (deleted again),
puts a test text on the clipboard and then puts your text back, and starts a
small test server on this PC. It reads, but does not change: services,
installed apps, devices, ports.

Before you start:
  - save and close any Notepad and Calculator windows;
  - if the clipboard holds a picture or files, copy them again afterwards.

On a slow PC this takes several minutes. JARVIS asks once for approval: type
approve only when the approval box appears (anything typed before it shows
is not taken as the answer).
`);
if ((await ask('Press Enter to start, or type q and Enter to quit: ')).trim().toLowerCase() === 'q') process.exit(0);
console.log('Loading JARVIS…');

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { redact } = await import('../security/redactor.js');
const { probeWindows, windowState } = await import('../perception/windowsProbe.js');
const { keepLooking } = await import('../core/verifiers.js');
const { readClipboard, writeClipboard, CLIPBOARD_WRITE_LIMIT } = await import('../control/desktopControl.js');
const { removeScreenshot } = await import('../core/tools/windowsTools.js');
const { permissionSession } = await import('../control/permissionSession.js');
registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Result { id: string; name: string; status: Status; evidence: string; ms: number }
const results: Result[] = [];

function need(condition: unknown, why: string): asserts condition {
  if (!condition) throw new Error(why);
}

async function check(id: string, name: string, fn: () => Promise<{ status?: Status; evidence: string }>): Promise<boolean> {
  const t0 = Date.now();
  let status: Status = 'FAIL';
  let evidence = '';
  try {
    const r = await fn();
    status = r.status ?? 'PASS';
    evidence = r.evidence;
  } catch (err) {
    evidence = err instanceof Error ? err.message : String(err);
  }
  const entry: Result = { id, name, status, evidence: redact(evidence).replace(/\s+/g, ' ').slice(0, 400), ms: Date.now() - t0 };
  results.push(entry);
  console.log(`  ${status.padEnd(4)}  ${name}${entry.evidence ? ` — ${entry.evidence}` : ''} (${(entry.ms / 1000).toFixed(1)} s)`);
  return status === 'PASS';
}

async function call(tool: string, args: Record<string, unknown>) {
  const result = await toolRegistryV2.execute(tool, args);
  let body: any = null;
  try { body = JSON.parse(result.output); } catch { /* text */ }
  return { ...result, body };
}

const why = (r: { error?: string; output: string; body: any }) => String(r.body?.error ?? r.error ?? r.output).slice(0, 200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function windowHandles(): Promise<Set<string>> {
  return new Set((await probeWindows('windows') as Array<{ hwnd: string }>).map((w) => w.hwnd));
}

/** A visible window that was not open before, whose title or program matches. */
async function newWindow(before: Set<string>, match: RegExp, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const found = (await probeWindows('windows') as Array<{ hwnd: string; title: string; process: string }>)
      .find((w) => !before.has(w.hwnd) && (match.test(w.title) || match.test(w.process)));
    if (found) return found;
    await sleep(400);
  }
  return undefined;
}

/** The window is gone, asked of Windows by its handle — at least twice, since one look can be slow. */
async function gone(hwnd: string, ms: number): Promise<boolean> {
  return keepLooking(async () => !(await windowState(hwnd)).exists, ms);
}

/** The window's elements, listed again until `wanted` is among them: a slow PC draws an app's controls late. */
async function elementsWith(hwnd: string, wanted: (e: any) => boolean, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    const list = await call('ui_elements', { window: hwnd });
    if ((list.success && (list.body?.elements ?? []).some(wanted)) || Date.now() >= until) return list;
    await sleep(1_000);
  }
}

/** Close a window this pack opened; press "Don't save" if it asks. */
async function closeOwnWindow(hwnd: string): Promise<string> {
  const close = await call('control_window', { action: 'close', target: hwnd });
  if (await gone(hwnd, 5_000)) return 'closed';
  const front = await call('ui_elements', {});
  const dontSave = (front.body?.elements ?? []).find((e: any) => e.type === 'Button' && /^don.?t save$|^no$/i.test(String(e.name)));
  need(dontSave, `it did not close (${close.success ? 'it is asking something JARVIS did not recognise' : why(close)}); nothing was pressed`);
  const press = await call('ui_action', { action: 'invoke', ref: dontSave.ref });
  need(press.success, `"Don't save" was not pressed: ${why(press)}`);
  need(await gone(hwnd, 20_000), 'the window is still open after "Don\'t save"');
  return 'closed without saving';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const answers = (port: number) => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok).catch(() => false);

console.log('\n--- Approval in this window (P3) ---');
console.log('  When the approval box appears, type  approve  and press Enter.');
const fullControl = await check('approval.console', 'A typed approval turns on full control mode', async () => {
  // 30 minutes: a slow PC needs several for the steps below; it is turned off at the end.
  const r = await call('enable_full_control_session', { source: 'cli', durationMinutes: 30 });
  need(r.success, `not turned on: ${why(r)}`);
  need(permissionSession.getCurrentLevel() >= 2, 'the session level did not become 2');
  return { evidence: 'approved in the console; full control mode is on for 30 minutes' };
});

console.log('\n--- PowerShell on this PC ---');
await check('powershell.start', 'Windows PowerShell started and finished once', async () => {
  // A fixed command, nothing typed: the time every reading and check below pays first.
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 120_000, windowsHide: true, shell: false },
      (err) => (err ? reject(new Error(`it did not start: ${err.message}`)) : resolve()));
  });
  return { evidence: 'each reading and check below starts one' };
});

console.log('\n--- Readings ---');
const section = async (name: string) => {
  const r = await call('windows_overview', { section: name });
  need(r.success && r.body?.success !== false, `no reading: ${why(r)}`);
  return r.body;
};
await check('read.gpu', 'Graphics card', async () => {
  const b = await section('gpu');
  need(b.gpu?.length, 'no graphics card listed');
  return { evidence: b.gpu.map((g: any) => `${g.name}${g.memoryGB ? ` (${g.memoryGB} GB)` : ''}`).join('; ') };
});
await check('read.displays', 'Displays', async () => {
  const b = await section('displays');
  need(b.displays?.length, 'no display listed');
  return { evidence: b.displays.map((d: any) => `${d.width}×${d.height}${d.primary ? ' (main)' : ''}`).join('; ') };
});
await check('read.audio', 'Audio devices, speakers and microphones', async () => {
  const b = await section('audio');
  const endpoints = b.endpoints ?? [];
  need((b.devices?.length ?? 0) + endpoints.length > 0, 'no audio device listed');
  const mics = endpoints.filter((e: any) => e.role === 'microphone').length;
  const speakers = endpoints.filter((e: any) => e.role === 'speaker').length;
  return { evidence: `${b.devices?.length ?? 0} sound devices; ${speakers} speaker and ${mics} microphone endpoints` };
});
await check('read.cameras', 'Cameras', async () => {
  const b = await section('cameras');
  return { evidence: b.cameras?.length ? b.cameras.map((c: any) => c.name).join('; ') : 'the reading worked; no camera is connected' };
});
await check('read.apps', 'Installed apps', async () => {
  const b = await section('apps');
  need(b.installed > 0, 'no installed app listed');
  return { evidence: `${b.installed} installed` };
});
await check('read.services', 'Windows services', async () => {
  const b = await section('services');
  need(b.count >= 10, `only ${b.count} services listed`);
  const running = (b.services ?? []).filter((s: any) => s.status === 'Running').length;
  return { evidence: `${b.count} services; ${running} of the first ${b.services.length} are running` };
});
await check('read.ports', 'Listening ports with their program', async () => {
  const b = await section('ports');
  const named = (b.ports ?? []).filter((p: any) => p.process).length;
  return { evidence: `${b.count} listening ports; ${named} of those shown have their program named` };
});
await check('read.windows', 'Windows with their program', async () => {
  const b = await section('windows');
  need(b.windows?.length, 'no window listed');
  return { evidence: `${b.count} windows, e.g. ${String(b.windows[0].process)}` };
});
await check('read.disks', 'Disks by drive letter (P6)', async () => {
  const r = await call('system_overview', {});
  const disks = (r.body?.disks ?? []).filter((d: any) => /^[A-Z]:\\?$/i.test(String(d.mount)));
  need(disks.length, `no drive letter in the reading: ${why(r)}`);
  return { evidence: disks.map((d: any) => `${d.mount} ${d.freeGB} of ${d.totalGB} GB free`).join('; ') };
});

console.log('\n--- Screen and clipboard ---');
await check('desktop.screenshot', 'A screenshot saved as a PNG (deleted again)', async () => {
  const r = await call('screenshot', { mode: 'screen' });
  need(r.success && r.verification?.status === 'verified', `no picture: ${why(r)}`);
  removeScreenshot(r.body.file);
  return { evidence: `${r.body.width}×${r.body.height}, ${Math.round(r.body.bytes / 1024)} KB` };
});
await check('desktop.clipboard', 'The clipboard written, read back and put back', async () => {
  if (!fullControl) return { status: 'SKIP', evidence: 'needs full control mode' };
  // Kept here, not shown or stored, to put back afterwards.
  const backup = await readClipboard(CLIPBOARD_WRITE_LIMIT).catch(() => undefined);
  const marker = `JARVIS check ${Date.now()}`;
  try {
    const w = await call('clipboard', { action: 'write', text: marker });
    need(w.success && w.verification?.status === 'verified', `not written: ${why(w)}`);
    const r = await call('clipboard', { action: 'read' });
    need(r.success && String(r.body?.text ?? '').includes(marker), 'the clipboard does not hold the test text');
  } finally {
    if (backup?.text) await writeClipboard(backup.text).catch(() => undefined);
  }
  return { evidence: `written and read back${backup?.text ? '; your text is back' : ''}` };
});

console.log('\n--- Apps through UI Automation ---');
await check('apps.notepad', 'Notepad: opened, text field filled and read back, closed', async () => {
  if (!fullControl) return { status: 'SKIP', evidence: 'needs full control mode' };
  const before = await windowHandles();
  const open = await call('open_app', { target: 'notepad' });
  need(open.success, `not opened: ${why(open)}`);
  const win = await newWindow(before, /notepad/i, 60_000);
  need(win?.hwnd, 'no new Notepad window appeared (Windows 11 may have opened a tab in a Notepad window that was already open: close Notepad and run again)');
  const isField = (e: any) => (e.type === 'Document' || e.type === 'Edit') && (e.patterns ?? []).includes('Value');
  const list = await elementsWith(win.hwnd, isField, 30_000);
  need(list.success, `its elements could not be read: ${why(list)}`);
  const field = (list.body.elements ?? []).find(isField);
  need(field, `no text field with a value among its ${list.body.elements?.length ?? 0} elements`);
  const text = `JARVIS check ${new Date().toISOString()}`;
  const set = await call('ui_action', { action: 'set_value', ref: field.ref, text });
  need(set.success && set.verification?.status === 'verified', `the text was not set: ${why(set)}`);
  const closed = await closeOwnWindow(win.hwnd);
  return { evidence: `typed and read back ${text.length} characters; ${closed}` };
});
await check('apps.calculator', 'Calculator: 1 + 2 = 3, then closed', async () => {
  if (!fullControl) return { status: 'SKIP', evidence: 'needs full control mode' };
  const before = await windowHandles();
  const open = await call('open_app', { target: 'calculator' });
  need(open.success, `not opened: ${why(open)}`);
  const win = await newWindow(before, /calculator|calc/i, 60_000);
  need(win?.hwnd, 'no new Calculator window appeared');
  let list = await elementsWith(win.hwnd, (e) => e.automationId === 'num1Button', 30_000);
  need(list.success, `its elements could not be read: ${why(list)}`);
  for (const id of ['clearButton', 'num1Button', 'plusButton', 'num2Button', 'equalButton']) {
    const button = (list.body.elements ?? []).find((e: any) => e.automationId === id);
    if (!button && id === 'clearButton') continue;
    need(button, `the ${id} button is not among its ${list.body.elements?.length ?? 0} elements`);
    const press = await call('ui_action', { action: 'invoke', ref: button.ref });
    need(press.success, `${id} was not pressed: ${why(press)}`);
  }
  list = await call('ui_elements', { window: win.hwnd });
  const display = (list.body?.elements ?? []).find((e: any) => e.automationId === 'CalculatorResults');
  need(display && /\b3\b/.test(String(display.name)), `the display shows "${display?.name ?? 'nothing JARVIS found'}"`);
  const closed = await closeOwnWindow(win.hwnd);
  return { evidence: `"${display.name}"; ${closed}` };
});

console.log('\n--- A development server (P10) ---');
await check('dev.server', 'A test server started and stopped again', async () => {
  if (!fullControl) return { status: 'SKIP', evidence: 'needs full control mode' };
  const port = await freePort();
  const start = await call('dev', { action: 'start_server', project: serverDir, script: 'dev', port });
  need(start.success, `not started: ${why(start)}`);
  need(await answers(port), `nothing answers on port ${port}`);
  const stop = await call('dev', { action: 'stop_server', pid: start.body?.pid });
  need(stop.success, `not stopped: ${why(stop)}`);
  need(!(await answers(port)), `port ${port} still answers`);
  return { evidence: `port ${port} answered, then closed (process ${start.body?.pid})` };
});

if (fullControl) await call('disable_full_control_session', {}).catch(() => undefined);

const summary = {
  passed: results.filter((r) => r.status === 'PASS').length,
  failed: results.filter((r) => r.status === 'FAIL').length,
  skipped: results.filter((r) => r.status === 'SKIP').length,
};
const report = {
  pack: 'verify:windows (P14)',
  at: new Date().toISOString(),
  windows: `${os.type()} ${os.release()}`,
  node: process.version,
  summary,
  checks: results,
  notChecked: ['microphone and speakers with JARVIS\'s voice (P12): say "what is open in my browser" and check the answer by ear'],
};
const logs = path.join(repo, 'data', 'logs');
fs.mkdirSync(logs, { recursive: true });
const file = path.join(logs, 'verify-windows.json');
fs.writeFileSync(file, JSON.stringify(report, null, 2));
fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`);
console.log(`Report: ${file}`);
console.log('Send that file back to finish phase P14.');
process.exit(summary.failed > 0 ? 1 : 0);
