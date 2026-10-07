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

// The test server's project: a folder of its own under data\ (git-ignored),
// which joins the project folders for this run only, and is removed at the
// end. Not the temp folder: on Windows that is under AppData, which JARVIS
// never takes as a project folder (the owner's second run was refused).
fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
const scratch = fs.mkdtempSync(path.join(repo, 'data', 'verify-windows-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a file still in use */ } });
const serverDir = path.join(scratch, 'verify-server');
fs.mkdirSync(serverDir);
fs.writeFileSync(path.join(serverDir, 'package.json'), JSON.stringify({ name: 'verify-server', private: true, scripts: { dev: 'node server.js' } }, null, 2));
fs.writeFileSync(path.join(serverDir, 'server.js'),
  "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready on http://localhost:' + process.env.PORT));\n");
process.env['JARVIS_PROJECT_DIRS'] = [process.env['JARVIS_PROJECT_DIRS'], scratch].filter(Boolean).join(';');

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { redact, redactDeep } = await import('../security/redactor.js');
const { probeWindows, runPsFile, windowState } = await import('../perception/windowsProbe.js');
const { keepLooking } = await import('../core/verifiers.js');
const { readClipboard, writeClipboard, CLIPBOARD_WRITE_LIMIT } = await import('../control/desktopControl.js');
const { removeScreenshot } = await import('../core/tools/windowsTools.js');
const { permissionSession } = await import('../control/permissionSession.js');
registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Result { id: string; name: string; status: Status; evidence: string; ms: number; details?: Record<string, unknown> }
const results: Result[] = [];

function need(condition: unknown, why: string): asserts condition {
  if (!condition) throw new Error(why);
}

/** `details`: what a check saw on the way, kept in the report whether it passes or fails. */
async function check(id: string, name: string, fn: (details: Record<string, unknown>) => Promise<{ status?: Status; evidence: string }>): Promise<boolean> {
  const t0 = Date.now();
  let status: Status = 'FAIL';
  let evidence = '';
  const details: Record<string, unknown> = {};
  try {
    const r = await fn(details);
    status = r.status ?? 'PASS';
    evidence = r.evidence;
  } catch (err) {
    evidence = err instanceof Error ? err.message : String(err);
  }
  const entry: Result = {
    id, name, status, evidence: redact(evidence).replace(/\s+/g, ' ').slice(0, 400), ms: Date.now() - t0,
    ...(Object.keys(details).length ? { details: redactDeep(details) } : {}),
  };
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

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The elements of a list, in short, for the report (no values). */
function elementSummary(list: { body?: any }, max = 30) {
  return (list.body?.elements ?? []).slice(0, max).map((e: any) => ({
    type: e.type, className: e.className, automationId: e.automationId,
    name: String(e.name ?? '').slice(0, 40), patterns: e.patterns, depth: e.depth,
  }));
}

/**
 * The text of every Calculator display element, read straight from uia.ps1:
 * not through ui_elements, which would replace the references the presses use.
 */
async function calculatorDisplays(hwnd: string): Promise<string[]> {
  const decimal = BigInt(hwnd).toString();
  const r = await runPsFile('uia', { JARVIS_UIA_ACTION: 'list', JARVIS_UIA_HWND: decimal }, 60_000);
  if (!r.ok) return [`(not read: ${String(r.error ?? 'no reason').slice(0, 80)})`];
  return (Array.isArray(r['elements']) ? r['elements'] as any[] : [])
    .filter((e) => e.automationId === 'CalculatorResults')
    .map((e) => `${String(e.name ?? '')}${e.offscreen ? ' (offscreen)' : ''}`);
}

/** Close a window this pack opened; press "Don't save" if it asks. */
async function closeOwnWindow(hwnd: string, record: Record<string, unknown> = {}): Promise<string> {
  // `record` gets what each step returned (Step B evidence); the steps are as before.
  let t0 = Date.now();
  const close = await call('control_window', { action: 'close', target: hwnd });
  record['close'] = {
    success: close.success, ms: Date.now() - t0, error: close.error ?? null,
    message: String(close.body?.message ?? close.output ?? '').slice(0, 200),
    kernelSuccess: close.body?.success ?? null, kernelError: close.body?.error ?? null, kernelMs: close.body?.durationMs ?? null,
    check: close.verification ?? null,
  };
  const closedNow = await gone(hwnd, 5_000);
  record['goneAfterClose'] = closedNow;
  if (closedNow) return 'closed';
  record['stateAfterClose'] = await windowState(hwnd).catch((e) => `unknown: ${messageOf(e)}`);
  const front = await call('ui_elements', {});
  // The program in front and whether it is this window; not its title.
  record['inFront'] = front.success
    ? { process: front.body?.window?.process ?? null, isThisWindow: sameHwnd(front.body?.window?.hwnd, hwnd), elements: front.body?.elements?.length ?? 0, problems: front.body?.problems ?? [] }
    : { error: why(front) };
  const dontSave = (front.body?.elements ?? []).find((e: any) => e.type === 'Button' && /^don.?t save$|^no$/i.test(String(e.name)));
  need(dontSave, `it did not close (${close.success ? 'it is asking something JARVIS did not recognise' : why(close)}); nothing was pressed`);
  t0 = Date.now();
  const press = await call('ui_action', { action: 'invoke', ref: dontSave.ref });
  record['dontSave'] = { pressed: press.success, did: press.body?.did ?? null, error: press.success ? undefined : why(press), ms: Date.now() - t0 };
  need(press.success, `"Don't save" was not pressed: ${why(press)}`);
  const closedLater = await gone(hwnd, 20_000);
  record['goneAfterDontSave'] = closedLater;
  need(closedLater, 'the window is still open after "Don\'t save"');
  return 'closed without saving';
}

/** The same window handle, written in hex or decimal. */
function sameHwnd(a: unknown, b: unknown): boolean {
  try { return BigInt(String(a)) === BigInt(String(b)); } catch { return false; }
}

/** Calculator's top-level windows (by title or its own program), without other windows' titles. */
async function calculatorWindows(): Promise<unknown> {
  try {
    return (await probeWindows('windows') as Array<{ hwnd: string; title: string; process: string }>)
      .filter((w) => /calculator/i.test(w.title) || /^(calculator|calculatorapp)$/i.test(w.process))
      .map((w) => ({ hwnd: w.hwnd, title: w.title, process: w.process }));
  } catch (err) {
    return `not read: ${messageOf(err)}`;
  }
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
await check('apps.notepad', 'Notepad: opened, text field filled and read back, closed', async (details) => {
  if (!fullControl) return { status: 'SKIP', evidence: 'needs full control mode' };
  const before = await windowHandles();
  const open = await call('open_app', { target: 'notepad' });
  need(open.success, `not opened: ${why(open)}`);
  const win = await newWindow(before, /notepad/i, 60_000);
  need(win?.hwnd, 'no new Notepad window appeared (Windows 11 may have opened a tab in a Notepad window that was already open: close Notepad and run again)');
  details['window'] = { title: win.title, process: win.process };
  let closed = '';
  try {
    // A text field: one with the Value pattern, or a classic multi-line text
    // box (Notepad's), which UI Automation offers only the Text pattern for.
    const isField = (e: any) => (e.type === 'Document' || e.type === 'Edit')
      && ((e.patterns ?? []).includes('Value')
        || ((e.patterns ?? []).includes('Text') && /^(Edit|RichEdit(\d+[AW])?)$/i.test(String(e.className ?? ''))));
    const list = await elementsWith(win.hwnd, isField, 30_000);
    details['elements'] = elementSummary(list);
    details['classicControlHelpers'] = list.body?.classicControlHelpers ?? null;
    details['problems'] = list.body?.problems ?? [];
    need(list.success, `its elements could not be read: ${why(list)}`);
    const field = (list.body.elements ?? []).find(isField);
    need(field, `no text field among its ${list.body.elements?.length ?? 0} elements`);
    details['field'] = { type: field.type, className: field.className, patterns: field.patterns };
    const text = `JARVIS check ${new Date().toISOString()}`;
    const set = await call('ui_action', { action: 'set_value', ref: field.ref, text });
    details['set'] = { how: set.body?.how, same: set.body?.same, length: set.body?.length, check: set.verification?.status ?? null, error: set.success ? undefined : why(set) };
    need(set.success && set.verification?.status === 'verified', `the text was not set: ${why(set)}`);
    const closing: Record<string, unknown> = {};
    details['closing'] = closing;
    closed = await closeOwnWindow(win.hwnd, closing);
    return { evidence: `typed and read back ${text.length} characters (${set.body?.how === 'settext' ? 'multi-line text box' : 'value pattern'}); ${closed}` };
  } catch (err) {
    // Close what this check opened, also when it failed.
    if (!closed) {
      const cleanup: Record<string, unknown> = {};
      details['cleanup'] = cleanup;
      cleanup['result'] = await closeOwnWindow(win.hwnd, cleanup).catch((e) => `not closed: ${messageOf(e)}`);
    }
    throw err;
  }
});
await check('apps.calculator', 'Calculator: 1 + 2 = 3, then closed', async (details) => {
  if (!fullControl) return { status: 'SKIP', evidence: 'needs full control mode' };
  const before = await windowHandles();
  const open = await call('open_app', { target: 'calculator' });
  need(open.success, `not opened: ${why(open)}`);
  const win = await newWindow(before, /calculator|calc/i, 60_000);
  need(win?.hwnd, 'no new Calculator window appeared');
  details['window'] = { title: win.title, process: win.process };
  details['windowsAtStart'] = await calculatorWindows();
  let closed = '';
  try {
    // Step B evidence: every 2 s for up to 60 s, what UI Automation sees in
    // the window (elements, problems reading it) and whether it is in front,
    // until the buttons appear.
    const timeline: Array<Record<string, unknown>> = [];
    details['timeline'] = timeline;
    const shownAt = Date.now();
    let buttonsAt: number | null = null;
    let list: any;
    for (;;) {
      list = await call('ui_elements', { window: win.hwnd });
      const elements = list.body?.elements ?? [];
      const inFront = await windowState(win.hwnd).then((s) => s.foreground).catch(() => null);
      timeline.push({
        atMs: Date.now() - shownAt, read: list.success, elements: elements.length, inFront,
        problems: (list.body?.problems ?? []).length, ...(list.success ? {} : { error: why(list) }),
      });
      if (elements.some((e: any) => e.automationId === 'num1Button')) { buttonsAt = Date.now() - shownAt; break; }
      if (Date.now() - shownAt >= 60_000) break;
      await sleep(2_000);
    }
    details['buttonsSeenAfterMs'] = buttonsAt;
    details['classicControlHelpers'] = list.body?.classicControlHelpers ?? null;
    details['problems'] = list.body?.problems ?? [];
    console.log(`        buttons: ${buttonsAt === null ? 'not seen within 60 s' : `seen after ${(buttonsAt / 1000).toFixed(1)} s`}; elements: ${list.body?.elements?.length ?? 0}`);
    need(list.success, `its elements could not be read: ${why(list)}`);
    // Evidence for what Calculator does with each press (Step A): which window
    // is in front, every display element and its text after each press, and
    // what each press returned. The presses use the references of this one
    // listing, as before.
    details['elementCount'] = list.body.elements?.length ?? 0;
    details['inFrontBefore'] = await windowState(win.hwnd).then((s) => s.foreground).catch((e) => `unknown: ${messageOf(e)}`);
    details['displaysBefore'] = (list.body.elements ?? []).filter((e: any) => e.automationId === 'CalculatorResults')
      .map((e: any) => ({ name: e.name, depth: e.depth, offscreen: e.offscreen }));
    const presses: Array<Record<string, unknown>> = [];
    details['presses'] = presses;
    for (const id of ['clearButton', 'num1Button', 'plusButton', 'num2Button', 'equalButton']) {
      const button = (list.body.elements ?? []).find((e: any) => e.automationId === id);
      if (!button && id === 'clearButton') continue;
      need(button, `the ${id} button is not among its ${list.body.elements?.length ?? 0} elements`);
      const press = await call('ui_action', { action: 'invoke', ref: button.ref });
      const displays = await calculatorDisplays(win.hwnd).catch((e) => [`(not read: ${messageOf(e)})`]);
      presses.push({
        button: id, name: button.name, pressed: press.success, did: press.body?.did ?? null,
        windowOpen: press.body?.windowOpen ?? null, error: press.success ? undefined : why(press), displaysAfter: displays,
      });
      console.log(`        ${id}: ${press.success ? String(press.body?.did ?? 'done') : 'NOT pressed'}; display: ${displays.join(' | ') || '(no display element)'}`);
      need(press.success, `${id} was not pressed: ${why(press)}`);
    }
    details['inFrontAfter'] = await windowState(win.hwnd).then((s) => s.foreground).catch((e) => `unknown: ${messageOf(e)}`);
    list = await call('ui_elements', { window: win.hwnd });
    const display = (list.body?.elements ?? []).find((e: any) => e.automationId === 'CalculatorResults');
    need(display && /\b3\b/.test(String(display.name)), `the display shows "${display?.name ?? 'nothing JARVIS found'}"`);
    const closing: Record<string, unknown> = {};
    details['closing'] = closing;
    closed = await closeOwnWindow(win.hwnd, closing);
    return { evidence: `"${display.name}"; ${closed}` };
  } catch (err) {
    details['windowsAtEnd'] = await calculatorWindows();
    // Close what this check opened, also when it failed.
    if (!closed) {
      const cleanup: Record<string, unknown> = {};
      details['cleanup'] = cleanup;
      cleanup['result'] = await closeOwnWindow(win.hwnd, cleanup).catch((e) => `not closed: ${messageOf(e)}`);
    }
    throw err;
  }
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
