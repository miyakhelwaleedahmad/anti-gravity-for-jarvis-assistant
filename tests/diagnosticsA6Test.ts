/**
 * tests/diagnosticsA6Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase A6 (audit TRA-13, TRA-15, and B4's "action log fields"; owner's choices
 * of 2026-11-06: Q1 every check that ran goes into the logs; Q2 the action log's
 * fixed rollbackAvailable / confirmationRequired are dropped).
 * The action log (data/logs/jarvis-actions.jsonl) named the action, not the
 * request, had no trace id, wrote "success" before the effect was checked and
 * carried fixed fields; neither log recorded a passed check; and the test
 * helper left Chrome's child processes running on Windows.
 *
 *   1. an action log line carries the request and its trace id, and no fixed fields
 *   2. every check that ran is in the trace and the action log, with the same trace id
 *   3. the test helper ends Chrome's whole process tree on Windows
 *
 * The desktop controller and permission are stood in for, so the test is the
 * same on Windows and Linux.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-diagnostics-a6-'));
for (const dir of ['memory', 'data', 'logs']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { logger } = await import('../monitoring/structuredLogger.js');
const { wireExecutionTracing } = await import('../monitoring/traceWiring.js');
const { beginTrace, endTrace } = await import('../core/traceContext.js');
const { pcControlKernel } = await import('../control/pcControlKernel.js');
const { appController } = await import('../control/appController.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');

// The trace, captured where it is written (as tests/executionTraceTest.ts does).
const traced: Array<{ message: string; data?: any; correlationId?: string }> = [];
const internals = logger as unknown as { _log: (...a: any[]) => void };
const realLog = internals._log.bind(logger);
internals._log = (level: string, module: string, message: string, data?: any, correlationId?: string, error?: unknown) => {
  traced.push({ message, data, correlationId });
  realLog(level, module, message, data, correlationId, error);
};
wireExecutionTracing();

const actionLogPath = path.join(workspace, 'logs', 'jarvis-actions.jsonl');
const actionLines = (): any[] => {
  try { return fs.readFileSync(actionLogPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

// The desktop, stood in for (as tests/kernelOutcomeA5cTest.ts does).
(permissionSession as any).checkPermission = () => true;
const NOTEPAD = { name: 'notepad', pid: 7, windowTitle: 'notes.txt - Notepad', hwnd: '0x1A2B' };
(appController as any).deps = {
  windows: async () => ({ activeWindow: { title: '', processName: '', pid: 0 }, openApps: [NOTEPAD] }),
  allWindows: async () => [{ hwnd: NOTEPAD.hwnd, title: NOTEPAD.windowTitle, process: NOTEPAD.name, pid: NOTEPAD.pid }],
  automate: async (args: string[]) => `Focused window ${args[args.length - 1]}`,
  approve: async () => true,
};

console.log('\n=== Diagnostics (phase A6) ===\n');

console.log('--- 1. the action log line ---');
{
  const request = 'please bring notepad to the front';
  const trace = beginTrace('cli', request);
  const r = await pcControlKernel.focusApp('notepad');
  endTrace();
  ok('(setup) the stood-in action ran', r.success, JSON.stringify(r).slice(0, 120));
  const line = actionLines().filter((l) => l.action === 'focusApp').pop();
  ok('the line carries the request\'s trace id', line?.traceId === trace, `${line?.traceId} vs ${trace}`);
  ok('…and the owner\'s request, not the action name', line?.userCommand === request, String(line?.userCommand));
  ok('it does not claim the effect was checked: verified "pending"', line?.result === 'success' && line?.verified === 'pending', JSON.stringify(line));
  ok('the risk level is the one the kernel computed (level 1, not read-only: "high")', line?.riskLevel === 'high', String(line?.riskLevel));
  ok('no fixed rollbackAvailable / confirmationRequired (Q2)', line && !('rollbackAvailable' in line) && !('confirmationRequired' in line), JSON.stringify(line));

  const outside = await pcControlKernel.focusApp('notepad');
  const plain = actionLines().filter((l) => l.action === 'focusApp').pop();
  ok('outside a request: no trace id, and the action name as the command', outside.success && plain && !('traceId' in plain) && plain.userCommand === 'focusApp', JSON.stringify(plain));

  beginTrace('cli', `focus notepad, my key is sk-${'a'.repeat(40)} and ${'x'.repeat(300)}`);
  await pcControlKernel.focusApp('notepad');
  endTrace();
  const secret = actionLines().filter((l) => l.action === 'focusApp').pop();
  ok('a request with a key: the key is not written', secret && !String(secret.userCommand).includes('a'.repeat(40)), String(secret?.userCommand).slice(0, 80));
  ok('…and a long request is cut short', secret && String(secret.userCommand).length <= 200, `${String(secret?.userCommand).length} chars`);

  // Review round 1 (F1): inside a background agent, its own words, named, without the foreground's trace id.
  const { runAsAgent } = await import('../core/agents/agentScope.js');
  const fg = beginTrace('cli', 'FOREGROUND: what time is it');
  await runAsAgent({ rootTaskId: 'r1', taskId: 't1', agentId: 'a1', agentPath: 'Research Agent', request: 'BACKGROUND GOAL: tidy windows', source: 'cli' },
    () => pcControlKernel.focusApp('notepad'));
  endTrace();
  const agentLine = actionLines().filter((l) => l.action === 'focusApp').pop();
  ok("inside an agent: the agent's words and its name, not the foreground's trace id (F1)", agentLine?.userCommand === 'BACKGROUND GOAL: tidy windows'
    && agentLine?.agentPath === 'Research Agent' && agentLine?.traceId !== fg && !('traceId' in agentLine), JSON.stringify(agentLine));

  // F2: a read is never checked, so it does not say a check is pending.
  const file = path.join(workspace, 'notes.txt');
  fs.writeFileSync(file, 'hello');
  beginTrace('cli', 'read my notes');
  const read = await pcControlKernel.readFile(file);
  endTrace();
  const readLine = actionLines().filter((l) => l.action === 'readFile').pop();
  ok('a read: no "verified: pending" (it is never checked) (F2)', read.success && readLine && !('verified' in readLine) && readLine.riskLevel === 'safe', JSON.stringify(readLine));

  // F3 (b), F6: the failure line carries the request too, and "allowed" says whether it was allowed.
  const realDeps = (appController as any).deps;
  (appController as any).deps = { ...realDeps, windows: async () => ({ activeWindow: { title: '', processName: '', pid: 0 }, openApps: [] }), allWindows: async () => [] };
  const ft = beginTrace('cli', 'bring the calculator to the front');
  const nope = await pcControlKernel.focusApp('calculator');
  endTrace();
  const failLine = actionLines().filter((l) => l.action === 'focusApp').pop();
  ok('a failure line: the trace id, the request, the computed risk level, no "pending" (F3)', !nope.success && failLine?.result === 'failure' && failLine?.traceId === ft
    && failLine?.userCommand === 'bring the calculator to the front' && failLine?.riskLevel === 'high' && !('verified' in failLine), JSON.stringify(failLine));
  ok('…allowed (permission was given; the action itself failed) (F6)', failLine?.allowed === true, JSON.stringify(failLine));
  (permissionSession as any).checkPermission = () => false;
  await pcControlKernel.focusApp('notepad');
  (permissionSession as any).checkPermission = () => true;
  (appController as any).deps = realDeps;
  const refused = actionLines().filter((l) => l.action === 'focusApp').pop();
  ok('a permission refusal: blocked, not allowed (F6)', refused?.result === 'blocked' && refused?.allowed === false, JSON.stringify(refused));

  // Review round 2 (F11): JARVIS's own refusals are blocked; the OS refusing an allowed action is a failure.
  const lastFor = async (err: string) => {
    (appController as any).deps = { ...realDeps, automate: async () => { throw new Error(err); } };
    await pcControlKernel.focusApp('notepad');
    (appController as any).deps = realDeps;
    return actionLines().filter((l) => l.action === 'focusApp').pop();
  };
  for (const [err, blocked] of [
    ["EACCES: permission denied, open 'C:\\x'", false], ['Access is denied.', false],
    ['Permission Level 2 required for keyboard action', true], ['Action cancelled by user.', true],
    ['Not closed: the window "Notes" was not approved.', true],
    ['Access Denied: Path "C:\\x" is not allowed outside approved directories for action "read".', true],
    // Review round 3 (F15, F17): JARVIS's other refusal wordings, and a "cancelled" that is not a refusal.
    ['Dangerous shortcut requires explicit confirmation and was denied: alt+f4', true],
    ['Execution Blocked: Terminating critical system process "lsass" is forbidden.', true],
    ['Blocked by safety policy: JARVIS does not stop or restart the security service "WinDefend".', true],
    ['Refused by safety policy: "a&b" contains characters Command Prompt would run as a command.', true],
    ['Close cancelled: closing windows matching "notes" was not approved.', true],
    ['Chrome cancelled the download', false],
  ] as const) {
    const l = await lastFor(err);
    ok(`"${err}": ${blocked ? 'blocked, not allowed' : 'a failure of an allowed action'} (F11)`,
      l?.result === (blocked ? 'blocked' : 'failure') && l?.allowed === !blocked, `${l?.result} allowed=${l?.allowed} ${String(l?.error).slice(0, 60)}`);
  }
}

console.log('--- 2. every check that ran, in both logs (Q1) ---');
{
  const probe = (name: string, verify?: () => Promise<{ status: string; evidence: string }>) => toolRegistryV2.register({
    name, description: 'A6 test probe.', riskLevel: 'low', inputSchema: {}, fallbacks: [],
    meta: { category: 'SYSTEM', risk: 0, reversible: 'yes', external: 'none', effect: 'test probe', output: { format: 'text', description: 'done' } },
    ...(verify ? { verify } : {}),
    async execute() { return 'done'; },
  } as any);
  probe('a6_probe_ok', async () => ({ status: 'verified', evidence: 'the probe saw it' }));
  probe('a6_probe_bad', async () => ({ status: 'failed', evidence: 'nothing changed' }));
  probe('a6_probe_none');
  probe('a6_probe_unknown', async () => ({ status: 'unverifiable', evidence: 'nothing to look at' }));

  traced.length = 0;
  const trace = beginTrace('cli', 'run the probes');
  const good = await toolRegistryV2.execute('a6_probe_ok', {});
  const bad = await toolRegistryV2.execute('a6_probe_bad', {});
  await toolRegistryV2.execute('a6_probe_none', {});
  await toolRegistryV2.execute('a6_probe_unknown', {});
  endTrace();
  await sleep(200);
  ok('(setup) one check passed, one failed', good.success && !bad.success && bad.error === 'VERIFICATION_FAILED', `${good.success} ${bad.error}`);

  const inTrace = (tool: string) => traced.find((e) => e.message === 'verification' && e.data?.tool === tool);
  const inActions = (tool: string) => actionLines().find((l) => l.type === 'verification' && l.tool === tool);
  ok('the trace has the passed check, with the request\'s trace id', inTrace('a6_probe_ok')?.data?.status === 'verified' && inTrace('a6_probe_ok')?.correlationId === trace, JSON.stringify(inTrace('a6_probe_ok')));
  ok('the trace has the failed check, with its evidence', inTrace('a6_probe_bad')?.data?.status === 'failed' && /nothing changed/.test(String(inTrace('a6_probe_bad')?.data?.evidence)), JSON.stringify(inTrace('a6_probe_bad')));
  ok('the action log has the passed check, with the same trace id', inActions('a6_probe_ok')?.status === 'verified' && inActions('a6_probe_ok')?.traceId === trace, JSON.stringify(inActions('a6_probe_ok')));
  ok('the action log has the failed check, with its evidence: the logs agree after a VERIFICATION_FAILED', inActions('a6_probe_bad')?.status === 'failed' && inActions('a6_probe_bad')?.traceId === trace && /nothing changed/.test(String(inActions('a6_probe_bad')?.evidence)), JSON.stringify(inActions('a6_probe_bad')));
  ok('a call with no check writes no check line', !inTrace('a6_probe_none') && !inActions('a6_probe_none'));
  // F3 (c): a kernel action and its check, both in the action log with the same trace id.
  const { SkillLoader } = await import('../core/skillLoader.js');
  if (!toolRegistryV2.get('control_app')) await new SkillLoader(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills')).loadSkills();
  const tool = toolRegistryV2.get('control_app') as any;
  const savedVerify = tool.verify;
  tool.verify = async () => ({ status: 'failed', evidence: 'notepad is not in front (test)' });
  const e2e = beginTrace('cli', 'focus notepad');
  let res: any;
  try { res = await toolRegistryV2.execute('control_app', { action: 'focus', target: 'notepad' }); } finally { tool.verify = savedVerify; endTrace(); }
  await sleep(200);
  const act = actionLines().filter((l) => l.action === 'focusApp' && l.traceId === e2e).pop();
  const chk = actionLines().filter((l) => l.type === 'verification' && l.tool === 'control_app' && l.traceId === e2e).pop();
  // Review round 2 (F10): an agent's check is the agent's, not the foreground request's.
  const { runAsAgent: asAgent } = await import('../core/agents/agentScope.js');
  tool.verify = async () => ({ status: 'failed', evidence: 'agent check failed (test)' });
  const fgr = beginTrace('cli', 'FOREGROUND: something else');
  try {
    await asAgent({ rootTaskId: 'r2', taskId: 't2', agentId: 'a2', agentPath: 'Desk Agent', request: 'BG task', source: 'cli' },
      () => toolRegistryV2.execute('control_app', { action: 'focus', target: 'notepad' }));
  } finally { tool.verify = savedVerify; endTrace(); }
  await sleep(200);
  const agentChk = actionLines().filter((l) => l.type === 'verification' && /agent check failed/.test(String(l.evidence))).pop();
  ok("an agent's check line: the agent's name, not the foreground's trace id (F10)", agentChk?.agentPath === 'Desk Agent' && !('traceId' in (agentChk ?? {})) && agentChk?.traceId !== fgr, JSON.stringify(agentChk));
  ok("end to end: the kernel's action line and the failed check, same trace id (F3)", res?.error === 'VERIFICATION_FAILED' && act?.verified === 'pending' && chk?.status === 'failed',
    `${res?.error} | ${JSON.stringify(act)} | ${JSON.stringify(chk)}`);
  ok('a check that could not be done ("unverifiable") writes no check line either: only checks that ran (Q1)', !inTrace('a6_probe_unknown') && !inActions('a6_probe_unknown'), JSON.stringify(inActions('a6_probe_unknown') ?? inTrace('a6_probe_unknown') ?? null));
}

console.log('--- 3. the test helper\'s Chrome (TRA-15) ---');
{
  const helper = await import('./chromeHelper.js') as any;
  const cmd = helper.treeKillCommand as ((pid: number, platform: NodeJS.Platform) => string[] | undefined) | undefined;
  ok('the helper says how it ends Chrome (treeKillCommand)', typeof cmd === 'function');
  if (cmd) {
    ok('Windows: the whole process tree, by force', JSON.stringify(cmd(4242, 'win32')) === JSON.stringify(['taskkill', '/PID', '4242', '/T', '/F']), JSON.stringify(cmd(4242, 'win32')));
    ok('elsewhere: the process itself, as before (its children end with it)', cmd(4242, 'linux') === undefined && cmd(4242, 'darwin') === undefined);
  }
  // F3 (a): what stop() runs.
  const end = helper.endChrome as ((proc: any, platform?: NodeJS.Platform, run?: (c: string, a: string[]) => { status: number | null }) => void) | undefined;
  ok("the helper's ending can be stood in for (endChrome)", typeof end === 'function');
  if (end) {
    let killed = 0; const ran: string[][] = [];
    const proc = { pid: 4242, exitCode: null, signalCode: null, kill: () => { killed++; } };
    end(proc, 'win32', (c, a) => { ran.push([c, ...a]); return { status: 0 }; });
    ok('Windows: taskkill on the tree, and no parent-only kill', ran.length === 1 && ran[0]!.join(' ') === 'taskkill /PID 4242 /T /F' && killed === 0, `${JSON.stringify(ran)} killed=${killed}`);
    end(proc, 'win32', () => ({ status: 1 }));
    ok('Windows, taskkill failed: the process is still ended', killed === 1, `killed=${killed}`);
    ran.length = 0;
    end(proc, 'linux', (c, a) => { ran.push([c, ...a]); return { status: 0 }; });
    ok('elsewhere: the process is ended, no taskkill', killed === 2 && ran.length === 0, `killed=${killed} ran=${ran.length}`);
    // Review round 2 (F12): an exited Chrome's id may belong to another program by now: no taskkill.
    ran.length = 0;
    end({ pid: 4242, exitCode: 0, signalCode: null, kill: () => { killed++; } }, 'win32', (c, a) => { ran.push([c, ...a]); return { status: 0 }; });
    end({ pid: 4243, exitCode: null, signalCode: 'SIGTERM', kill: () => { killed++; } }, 'win32', (c, a) => { ran.push([c, ...a]); return { status: 0 }; });
    ok('Windows, Chrome already exited: no taskkill on its old process id (F12)', ran.length === 0, JSON.stringify(ran));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
