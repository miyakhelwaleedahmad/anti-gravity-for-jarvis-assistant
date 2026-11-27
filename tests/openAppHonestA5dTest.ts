/**
 * tests/openAppHonestA5dTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase A5d (audit TRA-19; owner's choices of 2026-11-03: Q1 an open that cannot
 * be checked is said as such; Q2 off Windows, Windows-only programs are refused).
 * open_app reported success 50 ms after starting the launcher, without its
 * exit; an open it cannot check counted as done ("Opening settings, sir.").
 *
 *   1. the launcher's outcome: exit 0, a non-zero exit after 50 ms, a failure to start, still running
 *   2. off Windows: Windows-only programs refused on a real open; a dry run and other programs unchanged
 *   3. the route: an open that cannot be checked says so; a failed launch is not "Opening"; a checked open is unchanged
 *
 * The launcher and the platform are stand-ins (openAppDeps), so the test is the
 * same on Windows and Linux. Chrome is a fake DevTools server. Speech is captured.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-open-a5d-'));
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

const skill = await import('../skills/automation/skill.js');
const deps = (skill as any).openAppDeps as { spawn: (...a: any[]) => any; platform: () => NodeJS.Platform } | undefined;
ok('the launcher and the platform can be stood in for (openAppDeps)', !!deps);

// The real launcher goes through child_process.spawn as it is when called, so a
// patch made after load (as voiceRouteMockTest's guard does) still applies.
if (deps) {
  const { createRequire, syncBuiltinESMExports } = await import('module');
  const cp = createRequire(import.meta.url)('child_process') as { spawn: (...a: any[]) => any };
  const realSpawn = cp.spawn;
  let seen = '';
  cp.spawn = (cmd: string) => { seen = cmd; return { on: () => undefined, unref: () => undefined }; };
  syncBuiltinESMExports();
  try { deps.spawn('a5d-live-binding-probe', [], {}); } finally { cp.spawn = realSpawn; syncBuiltinESMExports(); }
  ok('the real launcher calls child_process.spawn as patched after load', seen === 'a5d-live-binding-probe', `seen="${seen}"`);
}

/** A stand-in launcher: what it does, and what it was asked to run. */
let launch: { exitAfterMs?: number; code?: number; errorAfterMs?: number; error?: string; hang?: boolean } = { exitAfterMs: 5, code: 0 };
const launched: string[][] = [];
if (deps) {
  deps.spawn = (cmd: string, args: string[]) => {
    launched.push([cmd, ...args]);
    const proc = new EventEmitter() as EventEmitter & { unref(): void };
    proc.unref = () => undefined;
    const how = { ...launch };
    if (how.error !== undefined) setTimeout(() => proc.emit('error', new Error(how.error)), how.errorAfterMs ?? 1);
    else if (!how.hang) setTimeout(() => proc.emit('exit', how.code ?? 0, null), how.exitAfterMs ?? 5);
    return proc;
  };
}
const setPlatform = (p: NodeJS.Platform) => { if (deps) deps.platform = () => p; };
const open = async (target: string, extra: Record<string, unknown> = {}) => {
  const out = await skill.execute({ target, source: 'text', ...extra });
  try { return JSON.parse(out); } catch { return { raw: out }; }
};

console.log('\n=== Honest open_app (phase A5d) ===\n');

console.log('--- 1. the launcher\'s outcome ---');
{
  setPlatform('win32');
  launch = { exitAfterMs: 5, code: 0 };
  let r = await open('notepad');
  ok('launcher exits 0: a success', r.success === true && launched.length === 1, JSON.stringify(r));
  launch = { exitAfterMs: 300, code: 1 };
  const t0 = Date.now();
  r = await open('notepad');
  ok('launcher exits 1 after 300 ms (later than the old 50 ms): a failure with the exit code', r.success === false && /exit(ed)? (with )?code 1|code 1/i.test(String(r.error)), JSON.stringify(r));
  ok('…and the answer waited for that exit', Date.now() - t0 >= 280, `${Date.now() - t0} ms`);
  launch = { error: 'spawn cmd.exe ENOENT (test)', errorAfterMs: 120 };
  r = await open('notepad');
  ok('launcher fails to start after 120 ms: a failure with the reason', r.success === false && /ENOENT/.test(String(r.error)), JSON.stringify(r));
  launch = { hang: true };
  const t1 = Date.now();
  r = await open('notepad');
  const waited = Date.now() - t1;
  ok('launcher still running: "started", after a bounded wait', r.success === true && waited >= 1000 && waited < 6000, `${waited} ms ${JSON.stringify(r)}`);
}

console.log('--- 2. off Windows (Q2) ---');
{
  setPlatform('linux');
  launched.length = 0;
  launch = { exitAfterMs: 5, code: 0 };
  let r = await open('notepad');
  ok('"open notepad" off Windows: refused, needs Windows, nothing launched', r.success === false && /needs Windows/i.test(String(r.error)) && launched.length === 0, `${JSON.stringify(r)} launched=${launched.length}`);
  r = await open('settings');
  ok('"open settings" (ms-settings:) off Windows: refused too', r.success === false && /needs Windows/i.test(String(r.error)), JSON.stringify(r));
  r = await open('notepad', { dryRun: true });
  ok('a dry run still shows the resolution (unchanged; the protected smoke test)', r.success === true && r.resolvedTarget === 'notepad.exe' && r.dryRun === true, JSON.stringify(r));
  r = await open('vscode');
  ok('a program that is not Windows-only ("code") is still launched', r.success === true && launched.length === 1, `${JSON.stringify(r)} launched=${launched.length}`);
  setPlatform('win32');
  launched.length = 0;
  r = await open('notepad');
  ok('on Windows, "open notepad" is launched as before', r.success === true && launched.length === 1, `${JSON.stringify(r)} launched=${launched.length}`);
}

console.log('--- 3. the route (Q1) ---');
{
  const { registerAllTools } = await import('../core/tools/index.js');
  const { SkillLoader } = await import('../core/skillLoader.js');
  const { orchestrator } = await import('../core/orchestrator.js');
  { const { worldState } = await import('../core/worldState.js'); (worldState as any).refresh = async () => {}; }
  const { modelRouter } = await import('../bridge/modelRouter.js');
  const { memoryManager } = await import('../memory/memoryManager.js');
  const { agentStateMachine } = await import('../core/agentStateMachine.js');
  registerAllTools();
  await new SkillLoader(skillsDir).loadSkills();
  await memoryManager.init();
  modelRouter.chat = async () => ({ content: 'The model answered, sir.' }) as any;
  modelRouter.streamChat = async function* () { yield 'The model answered, sir.'; } as any;
  const spoken: string[] = [];
  const { nodeBridge } = await import('../bridge/nodeBridge.js');
  installFakeTts(orchestrator, nodeBridge, 5, spoken, true);
  const say = async (input: string) => {
    spoken.length = 0;
    agentStateMachine.reset();
    await orchestrator.process(input, 'cli').catch((e: Error) => spoken.push(`THROWN: ${e.message}`));
    await sleep(250);
    return spoken.join(' | ');
  };

  // A Settings page cannot be checked on any platform (on Windows: a Windows page; elsewhere: not Windows).
  setPlatform('win32');
  launch = { exitAfterMs: 5, code: 0 };
  let said = await say('open settings');
  ok('"open settings", launched but not checkable: says it could not check (Q1)', /I started settings, sir, but I can't check from here that it opened\./.test(said), said);
  ok('…not "Opening settings, sir." alone', !/^Opening settings, sir\.$/.test(said), said);
  launch = { exitAfterMs: 5, code: 1 };
  said = await say('open settings');
  ok('"open settings", the launcher failed: not "Opening…"', !/^Opening/.test(said) && !/I started/.test(said) && said.length > 0, said);

  // A checked open (YouTube in JARVIS's Chrome, a fake DevTools server) keeps its reply.
  const tabs: Array<{ id: string; type: string; title: string; url: string }> = [{ id: 'T0', type: 'page', title: 'New Tab', url: 'about:blank' }];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';
    const port = (server.address() as { port: number }).port;
    const withSockets = () => tabs.map((t) => ({ ...t, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}` }));
    if (url === '/json/version') res.end(JSON.stringify({ Browser: 'Chrome/130.0', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-a5d` }));
    else if (url === '/json/list' || url === '/json') res.end(JSON.stringify(withSockets()));
    else if (url.startsWith('/json/new')) {
      const tab = { id: `T${tabs.length}`, type: 'page', title: 'YouTube', url: decodeURIComponent(url.split('?')[1] ?? '') };
      tabs.push(tab); res.end(JSON.stringify({ ...tab, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${tab.id}` }));
    } else if (url.startsWith('/json/activate/')) res.end('Target activated');
    else if (url.startsWith('/json/close/')) { const id = url.split('/').pop(); const i = tabs.findIndex((t) => t.id === id); if (i >= 0) tabs.splice(i, 1); res.end('Target is closing'); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  server.on('upgrade', (_req, sock) => sock.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  process.env['JARVIS_CDP_PORT'] = String((server.address() as { port: number }).port);
  said = await say('open youtube');
  ok('"open youtube", shown and checked in JARVIS\'s Chrome: "Opening youtube, sir." as before', /^Opening youtube, sir\.$/.test(said), said);
  delete process.env['JARVIS_CDP_PORT'];
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
