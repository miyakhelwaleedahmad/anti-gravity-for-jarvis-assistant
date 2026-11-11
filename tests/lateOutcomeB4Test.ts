/**
 * tests/lateOutcomeB4Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * B4: an action that ends after JARVIS stopped waiting for it is reported as
 * "may have happened", not "failed" (ai_workflows/runs/2026-11-09_late-outcome-b4).
 *
 * Today a sandboxed tool that ignores its stop signal is reported as
 * "I couldn't reach a service I needed, sir.", and it can still act afterwards.
 * An admin command stopped part way is reported the same way.
 *
 * The real sandbox (budget 1.2 s, stop grace 0.5 s), registry, task-graph
 * engine, reflection engine, kernel, action queue, process runner and goal
 * recovery; fake tools that ignore their signal and act after JARVIS gave up.
 *
 *  1. The sandbox gave up: an unknown outcome, said as the owner's sentence;
 *     never retried and no fallback tool; an `outcome_unknown` line when it
 *     gives up and a `late_result` line when the tool ends, both with the call
 *     id and the request (or background agent) captured when the call started.
 *  2. An admin command stopped part way: an unknown outcome, said as the
 *     owner's sentence, with the measured seconds; a command that never
 *     started is a definite failure; the kernel's line is `unknown`, with the
 *     request the action started in.
 *  1.9 The `outcome_unknown` line is written before the result is returned; a
 *     write that fails or hangs is reported on its own, the outcome stays
 *     unknown, the wait is bounded (2 s), and nothing runs again.
 *  4. From the mutation check (K3, K8, K11, K16, K19, K25): the call identity
 *     cannot be changed; a tool that ends while the timeout line is still
 *     being written keeps the unknown outcome, and its late line comes after
 *     the timeout line; a thrown unknown outcome is not retried and gets no
 *     fallback; one unknown step decides a graph with other failed steps; a
 *     command cancelled after about 2 s says so (Windows).
 *  5. From the second review (V1, V2, V3, V5): a command whose request was
 *     already stopped is asked once, tried once and never run; a delayed
 *     timeout line still comes before the late line, and the result still
 *     returns within the 2 s limit; the planner's internal note is never said;
 *     the failure message keeps its own comment.
 *  3. Unchanged: a network read that times out is still retried; definite
 *     failures keep their wording; a tool that ends after its budget but before
 *     JARVIS gives up keeps its result.
 *
 * Real timers: margins of a few hundred ms.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-b4late-'));
for (const dir of ['memory', 'data', 'logs']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_TOOL_BUDGET_HIGH_MS'] = '1200';
process.env['JARVIS_TOOL_STOP_GRACE_MS'] = '500';
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';
process.chdir(workspace);

let workspaceRemoved = false;
function removeWorkspace(): void {
  if (workspaceRemoved) return;
  workspaceRemoved = true;
  try { process.chdir(repo); } catch { /* already elsewhere */ }
  try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
}
process.on('exit', removeWorkspace);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'still running' as const)]);
setTimeout(() => {
  console.error('  FAIL: the test did not finish within 240 s');
  removeWorkspace();
  process.exit(1);
}, 240_000).unref();

const { toolExecutionSandbox: sandbox } = await import('../core/toolExecutionSandbox.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { TaskGraphBuilder, taskGraphEngine } = await import('../core/taskGraphEngine.js');
const { reflectionEngine } = await import('../core/reflectionEngine.js');
const { agentMemory } = await import('../memory/agentMemory.js');
const { beginTrace, endTrace } = await import('../core/traceContext.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');
const { pcControlKernel } = await import('../control/pcControlKernel.js');
const { actionQueue } = await import('../control/actionQueue.js');
const { actionAuditLog } = await import('../control/actionAuditLog.js');
const { runProcess } = await import('../system/processRunner.js');
const goalRecovery = await import('../core/goalRecovery.js');
const { captureCallOrigin } = await import('../core/outcomeUnknown.js');
const adminModule: Record<string, unknown> = await import('../control/adminController.js');

const UNKNOWN = /TIMEOUT \(outcome unknown\)/;
const LOG = path.join(workspace, 'logs', 'jarvis-actions.jsonl');
/** The action log's lines, parsed. */
function logLines(): Array<Record<string, any>> {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const linesOf = (type: string, tool: string) => logLines().filter((l) => l.type === type && l.tool === tool);
const seconds = (ms: number) => Math.round(ms / 1000);
const plural = (n: number) => `${n} second${n === 1 ? '' : 's'}`;

interface Rec { started: number; acted: number; endedAt?: number }
const newRec = (): Rec => ({ started: 0, acted: 0 });
/** A high-risk tool that ignores its stop signal and acts `actAfterMs` after it starts. */
function slowTool(name: string, rec: Rec, actAfterMs = 2_600, extra: Record<string, unknown> = {}): any {
  return {
    name, riskLevel: 'high', description: `Stand-in slow action ${name}.`, inputSchema: {}, fallbacks: [],
    meta: { category: 'SYSTEM', risk: 1, reversible: 'no', external: 'none', effect: 'Does a slow test thing.', output: { format: 'text', description: 'Text' } },
    async execute() { rec.started++; await sleep(actAfterMs); rec.acted++; rec.endedAt = Date.now(); return `Did the slow thing ${name}.`; },
    ...extra,
  };
}
/** Builds a graph of `nodes` and marks the last one failed with `error`. */
function failedGraph(goal: string, nodes: Array<{ tool: string; args?: Record<string, unknown> }>, error: string) {
  const b = new TaskGraphBuilder(goal);
  for (const n of nodes) b.addTask({ tool: n.tool, args: n.args ?? {}, description: n.tool, maxRetries: 0 });
  const graph = b.build();
  const all = [...graph.nodes.values()];
  all.forEach((n, i) => {
    if (i < all.length - 1) { n.status = 'done'; n.result = 'ok'; n.completedAt = Date.now(); }
    else { n.status = 'failed'; n.error = error; n.retryCount = 1; n.startedAt = Date.now() - 2_000; n.completedAt = Date.now(); }
  });
  graph.status = 'failed';
  return graph;
}
const ownerSandboxSentence = (action: string, s: number) =>
  `I stopped waiting for ${action} after ${plural(s)}, sir. It may still finish, so check before asking me to try again.`;
const ownerAdminSentence = (s: number) =>
  `The command was stopped after ${plural(s)}, sir. Part of it may already have run, so please check before trying again.`;

console.log('\n=== An action that ends after JARVIS stopped waiting (B4) ===\n');

try {
  // ── 1. The sandbox gave up ─────────────────────────────────────────────
  console.log('--- 1. The sandbox gave up on a tool that ignores its signal ---');
  let firstOutput = '';
  let firstWaitMs = 0;
  {
    const rec = newRec();
    const traceA = beginTrace('cli', 'close the fake thing');
    const t0 = Date.now();
    firstOutput = await sandbox.run(slowTool('b4_slow_a', rec), {});
    firstWaitMs = Date.now() - t0;
    endTrace();
    const s = seconds(firstWaitMs);
    ok('1.1 the result says the outcome is unknown, with the time JARVIS waited', UNKNOWN.test(firstOutput) && firstOutput.includes(`after ${plural(s)}`) && /may still finish/i.test(firstOutput),
      firstOutput.slice(0, 160));
    ok('1.1 …it is not reported as a plain TIMEOUT failure', !/^Error: TIMEOUT:/.test(firstOutput), firstOutput.slice(0, 40));
    const unknownBefore = linesOf('outcome_unknown', 'b4_slow_a');
    while (rec.acted === 0) await sleep(50);
    await sleep(300);
    const unknownLines = linesOf('outcome_unknown', 'b4_slow_a');
    const lateLines = linesOf('late_result', 'b4_slow_a');
    const u = unknownLines[0];
    const l = lateLines[0];
    ok('1.4 one `outcome_unknown` line when JARVIS gave up, with a call id and the request\'s id',
      unknownBefore.length === 1 && unknownLines.length === 1 && !!u?.callId && u?.traceId === traceA && u?.userCommand === 'close the fake thing',
      JSON.stringify(u ?? {}).slice(0, 160));
    ok('1.4 one `late_result` line when the tool ended: the same call id and request, its real completion time, success',
      lateLines.length === 1 && !!l && l.callId === u?.callId && l.traceId === traceA && l.result === 'success'
        && typeof l.completedAt === 'string' && Date.parse(l.completedAt) >= Date.parse(u?.timestamp ?? '') && Math.abs(Date.parse(l.completedAt) - (rec.endedAt ?? 0)) < 1_000,
      JSON.stringify(l ?? {}).slice(0, 200));
    ok('1.4 …the timeout line is kept as it was (append-only)', JSON.stringify(unknownBefore[0] ?? null) === JSON.stringify(u ?? null) && unknownBefore.length === 1);
  }
  {
    // 1.2 What the owner hears.
    const s = seconds(firstWaitMs);
    const one = await reflectionEngine.reflect(failedGraph('close the fake thing', [{ tool: 'b4_slow_a' }], firstOutput), agentMemory);
    ok('1.2 one-step request: class `outcome_unknown`, strategy abort', one.failureClass === ('outcome_unknown' as any) && one.repairStrategy === 'abort', `${one.failureClass} / ${one.repairStrategy}`);
    ok('1.2 …said as the owner\'s sentence, with the request in quotes', one.voiceMessage === ownerSandboxSentence('"close the fake thing"', s), String(one.voiceMessage));
    const many = await reflectionEngine.reflect(failedGraph('open the page and close the fake thing', [{ tool: 'b4_read' }, { tool: 'b4_slow_a', args: { action: 'close' } }], firstOutput), agentMemory);
    ok('1.2 several steps: the exact tool and action step is named', many.voiceMessage === ownerSandboxSentence('the b4_slow_a close step', s), String(many.voiceMessage));
    ok('1.2 …never "couldn\'t reach a service"', !/reach a service/i.test(`${one.voiceMessage} ${many.voiceMessage}`));
  }
  {
    // 1.5 The tool ends while another request runs: its late line keeps the first request.
    const rec = newRec();
    const traceA = beginTrace('cli', 'request A');
    const out = await sandbox.run(slowTool('b4_slow_b', rec), {});
    endTrace();
    const traceB = beginTrace('cli', 'request B');
    while (rec.acted === 0) await sleep(50);
    await sleep(300);
    endTrace();
    const u = linesOf('outcome_unknown', 'b4_slow_b')[0];
    const l = linesOf('late_result', 'b4_slow_b')[0];
    ok('1.5 a late result during another request keeps its own request (A), never the current one (B)',
      UNKNOWN.test(out) && u?.traceId === traceA && l?.traceId === traceA && l?.traceId !== traceB && l?.userCommand === 'request A',
      `unknown ${u?.traceId}, late ${l?.traceId}, B ${traceB}`);
  }
  {
    // 1.6 Two calls in one request: each late line belongs to its own call.
    const r1 = newRec();
    const r2 = newRec();
    beginTrace('cli', 'two at once');
    await Promise.all([sandbox.run(slowTool('b4_slow_c1', r1, 2_600), {}), sandbox.run(slowTool('b4_slow_c2', r2, 3_000), {})]);
    endTrace();
    while (r1.acted === 0 || r2.acted === 0) await sleep(50);
    await sleep(300);
    const u1 = linesOf('outcome_unknown', 'b4_slow_c1')[0];
    const u2 = linesOf('outcome_unknown', 'b4_slow_c2')[0];
    const l1 = linesOf('late_result', 'b4_slow_c1')[0];
    const l2 = linesOf('late_result', 'b4_slow_c2')[0];
    ok('1.6 two calls in one request have different call ids, and each late line matches its own call',
      !!u1?.callId && !!u2?.callId && u1.callId !== u2.callId && l1?.callId === u1.callId && l2?.callId === u2.callId,
      `${u1?.callId} ${u2?.callId} | ${l1?.callId} ${l2?.callId}`);
  }
  {
    // 1.7 A background agent's call: the agent's path, not the foreground request.
    const rec = newRec();
    beginTrace('cli', 'a foreground request');
    const agent = { rootTaskId: 'root-1', taskId: 'task-1', agentId: 'agent-1', agentPath: 'Test Agent', request: 'the agent\'s words', source: 'cli' as const };
    await runAsAgent(agent, () => sandbox.run(slowTool('b4_slow_d', rec), {}));
    endTrace();
    while (rec.acted === 0) await sleep(50);
    await sleep(300);
    const u = linesOf('outcome_unknown', 'b4_slow_d')[0];
    const l = linesOf('late_result', 'b4_slow_d')[0];
    ok('1.7 a background agent\'s call: both lines carry the agent\'s path and no foreground request id',
      u?.agentPath === 'Test Agent' && l?.agentPath === 'Test Agent' && u?.traceId === undefined && l?.traceId === undefined && l?.callId === u?.callId,
      JSON.stringify(l ?? {}).slice(0, 160));
  }
  {
    // 1.8 Cancelled by its caller, but the tool ignores it: JARVIS only stopped waiting.
    const rec = newRec();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await sandbox.run(slowTool('b4_slow_e', rec), {}, ac.signal);
    ok('1.8 cancelled by its caller and still running: an unknown outcome, "stopped waiting", never "was stopped"',
      UNKNOWN.test(out) && /stopped waiting/i.test(out) && !/cancelled and stopped|was stopped/i.test(out), out.slice(0, 160));
    while (rec.acted === 0) await sleep(50);
  }
  {
    // 1.9 An audit write that fails, then one that never finishes.
    const real = actionAuditLog.logOutcomeUnknown.bind(actionAuditLog);
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); realError(...a); };
    try {
      for (const mode of ['fails', 'hangs'] as const) {
        const rec = newRec();
        (actionAuditLog as any).logOutcomeUnknown = async () => (mode === 'fails' ? false : new Promise<boolean>(() => undefined));
        errors.length = 0;
        const t0 = Date.now();
        const out = await within(sandbox.run(slowTool(`b4_slow_audit_${mode}`, rec, 4_500), {}), 10_000);
        const ms = Date.now() - t0;
        const said = errors.find((e) => /did not record that JARVIS stopped waiting/.test(e)) ?? '';
        const bound = mode === 'fails' ? 2_400 : 4_400;    // 1.7 s to give up, + the 2 s write limit when it hangs
        ok(`1.9 an audit write that ${mode}: the result is still the unknown outcome, returned within ${bound} ms`,
          typeof out === 'string' && UNKNOWN.test(out) && ms < bound, `${ms} ms: ${String(out).slice(0, 60)}`);
        ok(`1.9 …the write that ${mode} is reported on its own, and the tool ran once`,
          (mode === 'fails' ? /the write failed/ : /did not finish within 2000 ms/).test(said) && rec.started === 1, said.slice(0, 160));
        while (rec.acted === 0) await sleep(50);
      }
    } finally {
      (actionAuditLog as any).logOutcomeUnknown = real;
      console.error = realError;
    }
  }
  {
    // 1.3 Through the registry and the task-graph engine: once, no retry, no fallback.
    const main = newRec();
    const fb = newRec();
    toolRegistryV2.register(slowTool('b4_slow_fb', fb));
    toolRegistryV2.register(slowTool('b4_slow_main', main, 2_600, { fallbacks: ['b4_slow_fb'] }));
    const b = new TaskGraphBuilder('do the slow fake thing');
    b.addTask({ tool: 'b4_slow_main', args: {}, description: 'slow', maxRetries: 2 });   // a graph that skipped the retry limit
    const graph = b.build();
    beginTrace('cli', 'do the slow fake thing');
    const executor = async (tool: string, args: Record<string, unknown>, signal: AbortSignal) => {
      const r = await toolRegistryV2.execute(tool, args, signal);
      if (!r.success) throw new Error(r.error ?? r.output);
      return r.output;
    };
    await within(taskGraphEngine.execute(graph, executor), 60_000);
    endTrace();
    await sleep(3_200);                                  // any repeat would have started by now
    const node = [...graph.nodes.values()][0]!;
    ok('1.3 the step ran once: no retry by the registry or the task-graph engine', main.started === 1, `started ${main.started}`);
    ok('1.3 …and no fallback tool ran', fb.started === 0, `fallback started ${fb.started}`);
    ok('1.3 …the step is failed with the unknown-outcome text', node.status === 'failed' && UNKNOWN.test(node.error ?? ''), `${node.status}: ${(node.error ?? '').slice(0, 80)}`);
  }

  // ── 2. An admin command stopped part way ───────────────────────────────
  console.log('\n--- 2. An admin command stopped part way ---');
  {
    const build = adminModule['stoppedCommandError'] as undefined | ((r: unknown, elapsedMs: number) => string);
    const stopped = (startedRun: boolean) => ({ stdout: '', stderr: '', exitCode: undefined, cancelled: true, timedOut: false, started: startedRun });
    const t10 = build?.(stopped(true), 10_200) ?? '';
    const t1 = build?.(stopped(true), 1_300) ?? '';
    const never = build?.(stopped(false), 0) ?? '';
    const ran = build?.({ stdout: 'x', stderr: '', exitCode: 0, cancelled: false, timedOut: false, started: true }, 500);
    ok('2.1 a started command that was stopped: the unknown-outcome text with the measured seconds',
      t10 === 'TIMEOUT (outcome unknown): The command was stopped after 10 seconds; part of it may already have run.', t10 || '(no builder)');
    ok('2.1 …"1 second" in the singular', t1 === 'TIMEOUT (outcome unknown): The command was stopped after 1 second; part of it may already have run.', t1 || '(no builder)');
    ok('2.1 a command that never started: a definite failure, never "may have run"',
      never === 'The command was not started: the request was stopped before it began.' && !UNKNOWN.test(never), never || '(no builder)');
    ok('2.1 a command that ran to the end: no stop text', ran === '', JSON.stringify(ran));
    const admin = await reflectionEngine.reflect(failedGraph('run the backup command', [{ tool: 'control_system' }],
      'TIMEOUT (outcome unknown): The command was stopped after 10 seconds; part of it may already have run.'), agentMemory);
    ok('2.1 what the owner hears for a stopped command', admin.voiceMessage === ownerAdminSentence(10) && admin.repairStrategy === 'abort', String(admin.voiceMessage));
    const notStarted = await reflectionEngine.reflect(failedGraph('run the backup command', [{ tool: 'control_system' }],
      'The command was not started: the request was stopped before it began.'), agentMemory);
    ok('2.1 …and for one that never started: no "may have run", not an unknown outcome',
      notStarted.failureClass !== ('outcome_unknown' as any) && !/may (?:already have run|still finish)/i.test(notStarted.voiceMessage ?? ''), String(notStarted.voiceMessage));
  }
  {
    // 2.2 The process runner says whether the process started.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1_000);
    const t0 = Date.now();
    const r: any = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { signal: ac.signal });
    const ms = Date.now() - t0;
    const pre = new AbortController();
    pre.abort();
    const r0: any = await runProcess(process.execPath, ['-e', '0'], { signal: pre.signal });
    ok('2.2 a process stopped after 1 s: cancelled, and `started` is true (returned once it had exited)', r.cancelled === true && r.started === true && ms >= 900 && ms < 10_000, `started ${r.started}, ${ms} ms`);
    ok('2.2 a signal already aborted: nothing started (`started` false)', r0.cancelled === true && r0.started === false, `started ${r0.started}`);
  }
  {
    // 2.3 The kernel's line: `unknown`, with the request the action started in.
    const kernel: any = pcControlKernel;
    const traceE = beginTrace('cli', 'run the slow command');
    const pending = kernel.executeAction('b4StoppedCommand', 'the test command', false, async () => {
      await sleep(600);
      throw new Error('TIMEOUT (outcome unknown): The command was stopped after 1 second; part of it may already have run.');
    });
    await sleep(100);
    endTrace();
    const traceF = beginTrace('cli', 'another request');
    const res = await pending;
    endTrace();
    const line = logLines().filter((l) => l.action === 'b4StoppedCommand').pop();
    ok('2.3 a stopped command\'s kernel line is `unknown`, not `failure`', !res.success && line?.result === 'unknown', `${line?.result}`);
    ok('2.3 …with the request it started in, never the one running when it ended', line?.traceId === traceE && line?.traceId !== traceF && line?.userCommand === 'run the slow command',
      `line ${line?.traceId}, started ${traceE}, ended in ${traceF}`);
    let definiteAttempts = 0;
    const definite = await kernel.executeAction('b4NotStarted', 'the test command', false, async () => {
      definiteAttempts++;
      throw new Error('The command was not started: the request was stopped before it began.');
    });
    const dLine = logLines().filter((l) => l.action === 'b4NotStarted').pop();
    ok('2.3 a command that never started stays a definite `failure`', !definite.success && dLine?.result === 'failure', `${dLine?.result}`);
    ok('5.1 (V1) …and the action queue runs it once: its wording is final for the queue\'s retry rule', definiteAttempts === 1 && definite.error === 'The command was not started: the request was stopped before it began.',
      `${definiteAttempts} attempt(s): ${definite.error}`);
  }
  {
    // 2.4 The action queue does not repeat it.
    let calls = 0;
    await actionQueue.enqueue('b4 stopped action', async () => {
      calls++;
      throw new Error('TIMEOUT (outcome unknown): The command was stopped after 1 second; part of it may already have run.');
    }).catch(() => undefined);
    ok('2.4 the action queue runs an unknown-outcome action once (no retry)', calls === 1, `${calls} call(s)`);
  }
  if (process.platform === 'win32') {
    // 2.5 The real cmd.exe path, stopped by the action queue's 10 s timer.
    const { permissionSession } = await import('../control/permissionSession.js');
    const { approvalGate } = await import('../security/approvalGate.js');
    const realApprove = (approvalGate as any).requestApproval;
    (approvalGate as any).requestApproval = async () => true;   // no one to answer in a test (as tests/toolTimeoutTest.ts)
    permissionSession.activateFullControl(5, 'cli');
    const kernel: any = pcControlKernel;
    let res: any;
    let cancelled: any;
    let cancelMs = 0;
    try {
      res = await kernel.runShellCommand('ping -n 30 127.0.0.1');
      // K25: cancelled by its caller after about 2 s: the measured time, never a fixed 10.
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 2_000);
      const t0 = Date.now();
      cancelled = await kernel.runShellCommand('ping -n 30 127.0.0.1', ac.signal);
      cancelMs = Date.now() - t0;
    } finally {
      permissionSession.deactivateFullControl('test');
      (approvalGate as any).requestApproval = realApprove;
    }
    const cErr = String(cancelled?.error ?? '');
    // Whole seconds, measured until the process has exited: 2 or 3 (stopping it can take a moment), never a fixed 10.
    ok('4.6 (Windows, K25) a real command cancelled after about 2 s: "after 2 seconds" or "after 3 seconds", the measured time',
      !cancelled?.success && UNKNOWN.test(cErr) && /after [23] seconds/.test(cErr) && cancelMs < 5_000, `${cancelMs} ms: ${cErr.slice(0, 140)}`);
    const err = String(res.error ?? '');
    // Measured until the process has exited: 10 or 11 whole seconds.
    const stoppedAfter = Number(/after (1[01]) seconds/.exec(err)?.[1] ?? NaN);
    ok('2.5 (Windows) a real command stopped by the 10 s timer: the unknown-outcome text, "after 10 seconds" or "after 11 seconds"',
      !res.success && UNKNOWN.test(err) && (stoppedAfter === 10 || stoppedAfter === 11), err.slice(0, 160));
    const heard = await reflectionEngine.reflect(failedGraph('ping localhost', [{ tool: 'control_system' }], err), agentMemory);
    ok('2.5 (Windows) …said as the owner\'s sentence', heard.voiceMessage === ownerAdminSentence(stoppedAfter), String(heard.voiceMessage));
  } else {
    console.log(`  ℹ️  2.5 and 4.6 skipped: the real cmd.exe path runs only on Windows (platform: ${process.platform}).`);
  }

  // ── 3. Unchanged ───────────────────────────────────────────────────────
  console.log('\n--- 3. Behaviour that must stay ---');
  {
    // 3.1 A network read that times out is still retried.
    let calls = 0;
    toolRegistryV2.register({
      name: 'b4_read', riskLevel: 'low', description: 'Stand-in network read.', inputSchema: {}, fallbacks: [],
      meta: { category: 'WEB', risk: 0, reversible: 'yes', external: 'read', effect: 'Reads a test page.', output: { format: 'text', description: 'Text' } },
      async execute() { calls++; if (calls < 3) throw new Error('fetch failed: ETIMEDOUT'); return 'the page'; },
    } as any);
    const r = await toolRegistryV2.execute('b4_read', {});
    ok('3.1 a low-risk network read that times out is retried by the registry, as before', r.success && calls === 3, `${calls} call(s), success ${r.success}`);
    const g = failedGraph('read the page', [{ tool: 'b4_read' }], 'TIMEOUT: request timed out');
    const node = [...g.nodes.values()][0]!;
    node.maxRetries = 2;
    const read = await reflectionEngine.reflect(g, agentMemory);
    ok('3.1 …and a read\'s TIMEOUT is still a network error with "retry with delay"', read.failureClass === 'network_error' && read.repairStrategy === 'retry_with_delay', `${read.failureClass} / ${read.repairStrategy}`);
  }
  {
    // 3.2 Goal recovery.
    const task: any = { id: 't1', title: 'Run the slow step', sideEffects: 'none', attempts: 1, maxAttempts: 3, failures: [], status: 'running' };
    const unknownFailure = { message: 'TIMEOUT (outcome unknown): Tool "b4_slow" ran past its 15 s budget and did not stop within 5 s; JARVIS stopped waiting for it after 20 seconds. It may still finish.' };
    const d = goalRecovery.decideRecovery({ task, failure: unknownFailure, cls: goalRecovery.classifyFailure(unknownFailure), toolCalls: 1, now: Date.now() });
    const cls = goalRecovery.classifyFailure(unknownFailure);
    ok('3.2 goal runtime: classified as its own class `outcome_unknown`, counted apart from `interrupted`', cls === ('outcome_unknown' as any), String(cls));
    ok('3.2 goal runtime: an unknown outcome is never retried; it waits for review', d.taskStatus === ('needs_review' as any) && d.goal === 'block', `${d.taskStatus} / ${d.goal}: ${d.action.slice(0, 80)}`);
    const readFailure = { message: 'fetch failed: ETIMEDOUT' };
    const d2 = goalRecovery.decideRecovery({ task, failure: readFailure, cls: goalRecovery.classifyFailure(readFailure), toolCalls: 1, now: Date.now() });
    ok('3.2 …a network timeout on a read is still retried', d2.taskStatus === 'retry', `${d2.taskStatus}`);
  }
  {
    // 3.3 Definite failures keep their class and wording.
    const denied = await reflectionEngine.reflect(failedGraph('close the fake thing', [{ tool: 'b4_slow_a' }], 'The fake thing was not closed: not approved.'), agentMemory);
    ok('3.3 a refusal is not an unknown outcome and says nothing about "may still finish"',
      denied.failureClass !== ('outcome_unknown' as any) && !/may still finish|may already have run/i.test(denied.voiceMessage ?? ''), `${denied.failureClass}: ${denied.voiceMessage}`);
  }
  {
    // 3.4 A tool that ends after its budget but before JARVIS gives up keeps its result.
    const rec = newRec();
    const out = await sandbox.run(slowTool('b4_slow_f', rec, 1_450), {});
    await sleep(200);
    ok('3.4 a tool that ends after its budget but before JARVIS gives up: its real result, no unknown-outcome line',
      out === 'Did the slow thing b4_slow_f.' && linesOf('outcome_unknown', 'b4_slow_f').length === 0 && linesOf('late_result', 'b4_slow_f').length === 0, out.slice(0, 80));
  }

  // ── 4. From the mutation check ─────────────────────────────────────────
  console.log('\n--- 4. Checks added after the mutation check ---');
  {
    // K3: the identity cannot be changed once taken.
    beginTrace('cli', 'a frozen request');
    const o: any = captureCallOrigin('b4_tool');
    endTrace();
    const before = JSON.stringify(o);
    try { o.callId = 'changed'; o.traceId = 'changed'; } catch { /* a frozen object refuses it */ }
    ok('4.1 (K3) the call identity is frozen: changing it has no effect', Object.isFrozen(o) && JSON.stringify(o) === before, before.slice(0, 120));
  }
  {
    // K8, K11: the tool ends while the timeout line is still being written (a slow audit write).
    const real = actionAuditLog.logOutcomeUnknown.bind(actionAuditLog);
    (actionAuditLog as any).logOutcomeUnknown = async (e: any) => { await sleep(600); return real(e); };
    const rec = newRec();
    let out: string = 'still running';
    try {
      out = await within(sandbox.run(slowTool('b4_slow_race', rec, 1_900), {}), 10_000);   // gives up at ~1.7 s, ends at 1.9 s
    } finally {
      (actionAuditLog as any).logOutcomeUnknown = real;
    }
    while (rec.acted === 0) await sleep(50);
    await sleep(300);
    const lines = logLines();
    const iUnknown = lines.findIndex((l) => l.type === 'outcome_unknown' && l.tool === 'b4_slow_race');
    const iLate = lines.findIndex((l) => l.type === 'late_result' && l.tool === 'b4_slow_race');
    ok('4.2 (K11) the tool ends while the timeout line is being written: the result is still the unknown outcome',
      UNKNOWN.test(out), out.slice(0, 100));
    ok('4.3 (K8) …and its `late_result` line comes after the `outcome_unknown` line', iUnknown >= 0 && iLate > iUnknown, `outcome_unknown at ${iUnknown}, late_result at ${iLate}`);
  }
  {
    // K16: a tool that throws the unknown outcome (the registry's own path for tools run without the sandbox).
    let main = 0;
    let fb = 0;
    const meta = { category: 'SYSTEM', risk: 0, reversible: 'yes', external: 'none', effect: 'Does a test thing.', output: { format: 'text', description: 'Text' } };
    toolRegistryV2.register({ name: 'b4_throw_fb', riskLevel: 'low', description: 'Stand-in fallback.', inputSchema: {}, fallbacks: [], meta,
      async execute() { fb++; return 'the fallback ran'; } } as any);
    toolRegistryV2.register({ name: 'b4_throw_main', riskLevel: 'low', description: 'Stand-in that throws an unknown outcome.', inputSchema: {}, fallbacks: ['b4_throw_fb'], meta,
      async execute() { main++; throw new Error('TIMEOUT (outcome unknown): The command was stopped after 1 second; part of it may already have run.'); } } as any);
    const r = await toolRegistryV2.execute('b4_throw_main', {});
    ok('4.4 (K16) a thrown unknown outcome: one attempt, no retry, no fallback, reported as the unknown outcome',
      !r.success && main === 1 && fb === 0 && UNKNOWN.test(`${r.error ?? ''} ${r.output}`), `main ${main}, fallback ${fb}: ${String(r.error ?? r.output).slice(0, 80)}`);
  }
  {
    // K19: one unknown step among other failed steps (two network reads with retries left) decides the graph.
    const b = new TaskGraphBuilder('read two pages and close the fake thing');
    b.addTask({ tool: 'b4_read', args: {}, description: 'read 1', maxRetries: 2 });
    b.addTask({ tool: 'b4_read', args: { page: 2 }, description: 'read 2', maxRetries: 2 });
    b.addTask({ tool: 'b4_slow_a', args: { action: 'close' }, description: 'close', maxRetries: 0 });
    const graph = b.build();
    [...graph.nodes.values()].forEach((n, i) => {
      n.status = 'failed'; n.retryCount = 1; n.startedAt = Date.now() - 2_000; n.completedAt = Date.now();
      n.error = i < 2 ? 'fetch failed: ETIMEDOUT' : firstOutput;
    });
    graph.status = 'failed';
    const mixed = await reflectionEngine.reflect(graph, agentMemory);
    ok('4.5 (K19) an unknown step among two failed reads with retries left: class `outcome_unknown`, strategy abort (never re-run)',
      mixed.failureClass === ('outcome_unknown' as any) && mixed.repairStrategy === 'abort' && /I stopped waiting for the b4_slow_a close step/.test(mixed.voiceMessage ?? ''),
      `${mixed.failureClass} / ${mixed.repairStrategy}: ${String(mixed.voiceMessage).slice(0, 80)}`);
  }

  // ── 5. From the second review ──────────────────────────────────────────
  console.log('\n--- 5. Checks added after the second review ---');
  {
    // V1, end to end: a shell command whose request was already stopped. The real kernel, action
    // queue and admin controller; the approval answered by a stand-in that counts the questions.
    const { permissionSession } = await import('../control/permissionSession.js');
    const { approvalGate } = await import('../security/approvalGate.js');
    const realApprove = (approvalGate as any).requestApproval;
    let approvals = 0;
    (approvalGate as any).requestApproval = async () => { approvals++; return true; };
    permissionSession.activateFullControl(5, 'cli');
    const pre = new AbortController();
    pre.abort();
    let res: any;
    try {
      res = await (pcControlKernel as any).runShellCommand('echo b4-not-started', pre.signal);
    } finally {
      permissionSession.deactivateFullControl('test');
      (approvalGate as any).requestApproval = realApprove;
    }
    const line = logLines().filter((l) => l.action === 'runShellCommand' && l.target === 'echo b4-not-started').pop();
    ok('5.2 (V1) a command whose request was already stopped: asked once, one attempt (no retry), never started',
      approvals === 1 && !res?.success && res?.error === 'The command was not started: the request was stopped before it began.',
      `${approvals} approval(s): ${String(res?.error).slice(0, 100)}`);
    ok('5.2 (V1) …logged as a definite `failure`, not `unknown`', line?.result === 'failure' && line?.error === res?.error, `${line?.result}`);
  }
  {
    // V2: the timeout line's write takes 2.6 s (longer than the 2 s the result waits); the tool ends at 1.9 s.
    const real = actionAuditLog.logOutcomeUnknown.bind(actionAuditLog);
    (actionAuditLog as any).logOutcomeUnknown = async (e: any) => { await sleep(2_600); return real(e); };
    const rec = newRec();
    const t0 = Date.now();
    let out = 'still running';
    try {
      out = await within(sandbox.run(slowTool('b4_slow_v2', rec, 1_900), {}), 10_000);
    } finally {
      (actionAuditLog as any).logOutcomeUnknown = real;
    }
    const ms = Date.now() - t0;
    await sleep(1_500);                                  // the delayed write ends at ~4.3 s
    const lines = logLines();
    const iUnknown = lines.findIndex((l) => l.type === 'outcome_unknown' && l.tool === 'b4_slow_v2');
    const iLate = lines.findIndex((l) => l.type === 'late_result' && l.tool === 'b4_slow_v2');
    ok('5.3 (V2) a delayed timeout write: the result still comes back within the 2 s limit, as the unknown outcome',
      UNKNOWN.test(out) && ms < 4_200, `${ms} ms: ${out.slice(0, 60)}`);
    ok('5.3 (V2) …and the `outcome_unknown` line is still written before the `late_result` line', iUnknown >= 0 && iLate > iUnknown, `outcome_unknown at ${iUnknown}, late_result at ${iLate}`);
  }
  {
    // V3: after a replan, the graph's goal carries the planner's internal note; it is never said.
    const goal = 'close the backup window\n\n[SYSTEM NOTE: Previous attempt failed. control_system timed out. Please use a different approach.]';
    const r = await reflectionEngine.reflect(failedGraph(goal, [{ tool: 'b4_slow_a' }], firstOutput), agentMemory);
    ok('5.4 (V3) after a replan: the owner\'s request is quoted, never the internal [SYSTEM NOTE …]',
      r.voiceMessage === ownerSandboxSentence('"close the backup window"', seconds(firstWaitMs)) && !/SYSTEM NOTE|different approach/i.test(r.voiceMessage ?? ''), String(r.voiceMessage));
  }
  {
    // V5: the failure message keeps its own comment.
    const src = fs.readFileSync(path.join(repo, 'core', 'reflectionEngine.ts'), 'utf8');
    ok('5.5 (V5) the comment "Spoken when the task is abandoned" sits directly above buildFailureVoiceMessage',
      /Spoken when the task is abandoned[^/]*\*\/\n\s*private buildFailureVoiceMessage\(/.test(src) && !/\*\/\n\s*\/\*\*\n\s*\* An action that may have happened/.test(src));
  }
} catch (err) {
  ok('the test ran to the end', false, String((err as Error)?.stack ?? err).slice(0, 500));
} finally {
  removeWorkspace();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
