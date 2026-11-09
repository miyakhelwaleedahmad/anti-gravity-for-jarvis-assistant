/**
 * tests/approvalBudgetR31Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * B4 R3-1: a question a tool asks while it runs is not part of the tool's
 * time budget. On the owner's PC, "close the browser" was answered inside the
 * advertised window and refused, because the 15 s budget had run out while
 * JARVIS was still asking (ai_workflows/runs/2026-11-08_approval-budget-b4-r31).
 *
 * The real sandbox, approval gate and registry; a shortened budget (1.5 s,
 * stop grace 0.5 s, as tests/toolTimeoutTest.ts); typed answers through the
 * gate's console hand-off; fake tools that ask, then act (the worst case: they
 * never check their signal after the answer).
 *
 *  1. Inside the window: an answer after the budget (1.8 s) and after the
 *     budget plus grace (2.4 s) acts exactly once, as a success.
 *  2. End to end: "close the browser" (control_browser) answered after 1.8 s
 *     closes JARVIS's Chrome (a fake one), once.
 *  3. Expired, missing and duplicate answers: never acted on, or acted on once.
 *  4. Cancellation: a cancelled call's question is withdrawn at once (the
 *     pending request removed, the gate's turn released, a later "yes"
 *     approves nothing), a call cancelled before it asks is not asked, a
 *     budget used up before the question is not asked, and the budget is not
 *     resumed after a cancellation.
 *  5. The remaining budget: time used before the question is deducted; after
 *     the answer only what was left is available, never the full budget; a
 *     tool that asks nothing keeps today's timeout; a parallel call's budget
 *     still runs while another call's question is open.
 *  6. Unchanged: the registry's own approval (before the run) and a nested
 *     question covered by it.
 *  7. A spoken question: cancelled while JARVIS is still asking, the voice
 *     wait stops and the question is withdrawn.
 *  8. The first review's findings (review.md): a "yes" typed for a withdrawn
 *     question does not approve the next one (F2); work left behind by an
 *     ended call is no longer part of it (F3); the budget clock ignores
 *     system-clock changes (F5); a withdrawn spoken question is not said
 *     (F7); a cancellation followed at once by a "yes", and a question asked
 *     with no budget left (F8). Real timers: margins of about ±0.15 s.
 *  9. The second review's findings: an invalid JARVIS_APPROVAL_GRACE_MS
 *     falls back to 1500 ms and never reaches a deadline (S1, checked in
 *     child processes so that the setting is read as at start-up), and a
 *     value above 60 000 ms falls back to 1500 ms so that no timer overflows
 *     (T2); the grace after a withdrawal is measured on the monotonic clock
 *     and held to 0..grace, whatever the system clock does (S2, with
 *     controlled clocks). The temporary workspace is removed at the end, also
 *     after a failure or an unexpected exit (S6, T6). The test does not read
 *     JARVIS_APPROVAL_GRACE_MS from the shell: the default 1500 ms applies (T5).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r31-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'chrome-profile');
process.env['JARVIS_TOOL_BUDGET_HIGH_MS'] = '1500';
process.env['JARVIS_TOOL_STOP_GRACE_MS'] = '500';
delete process.env['JARVIS_CDP_PORT'];
delete process.env['JARVIS_APPROVAL_TIMEOUT_S'];
delete process.env['JARVIS_APPROVAL_GRACE_MS'];       // the default 1500 ms grace, whatever the shell has (T5)
process.chdir(workspace);
/** Removes the temporary workspace once (S6, T6): from `finally`, the watchdog, and any exit. */
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
/** `p`, or 'still open' after `ms`: a fault that leaves a question open fails a check instead of hanging the test. */
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'still open' as const)]);
/** The whole test has 300 s (it takes about 2 min); past that it fails, and its workspace still goes (S6). */
setTimeout(() => {
  console.error('  FAIL: the test did not finish within 300 s (a question was left open)');
  removeWorkspace();
  process.exit(1);
}, 300_000).unref();
/** Sleeps, or ends early when `signal` aborts (a tool that respects its budget). True when it slept to the end. */
const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal.aborted) return resolve(false);
  const t = setTimeout(() => resolve(true), ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(false); }, { once: true });
});

const { toolExecutionSandbox: sandbox, currentToolCall } = await import('../core/toolExecutionSandbox.js');
const { approvalGate, approvalGraceMs } = await import('../security/approvalGate.js');
const { buildApprovalRequest } = await import('../security/approvalRequest.js');
const { runApproved } = await import('../security/approvalScope.js');
approvalGate.attachConsole();

const lastDecision = () => approvalGate.recentDecisions(1)[0];
/** Waits for a question to be on display (up to `ms`); its id, or undefined. */
async function questionShown(ms = 3_000): Promise<string | undefined> {
  for (let i = 0; i < ms / 10; i++) {
    const p = approvalGate.pendingRequest();
    if (p) return p.id;
    await sleep(10);
  }
  return undefined;
}
/** Answers the next question `afterMs` after it appears, as typed in the console. */
async function answerNext(answer: string, afterMs: number): Promise<{ id?: string; taken: boolean; at: number }> {
  const id = await questionShown();
  if (!id) return { taken: false, at: Date.now() };
  await sleep(afterMs);
  return { id, taken: approvalGate.offerConsoleAnswer(answer), at: Date.now() };
}

interface Record_ { acted: number; asked: number; abortedAt?: number; answeredAt?: number; abortedAtAnswer?: boolean; startedAt?: number }
/**
 * A fake high-risk tool: works `before` ms, asks a question inside its run,
 * then (when approved) works `after` ms and acts. It never checks its signal
 * after the answer; `respectBudget` makes its work stop on the signal.
 */
function askingTool(name: string, rec: Record_, o: { before?: number; after?: number; respectBudget?: boolean; afterDenial?: number } = {}): any {
  return {
    name, riskLevel: 'high',
    async execute(_args: Record<string, unknown>, signal: AbortSignal) {
      rec.startedAt = Date.now();
      signal.addEventListener('abort', () => { rec.abortedAt ??= Date.now(); }, { once: true });
      if (o.before) { if (o.respectBudget) await abortableSleep(o.before, signal); else await sleep(o.before); }
      rec.asked++;
      const approved = await approvalGate.requestApproval(`Close ${name}`, `Close the fake thing ${name}`);
      rec.answeredAt = Date.now();
      rec.abortedAtAnswer = signal.aborted;
      if (!approved) {
        if (o.afterDenial) await sleep(o.afterDenial);
        return `The fake thing ${name} was not closed: not approved.`;
      }
      if (o.after) {
        const done = o.respectBudget ? await abortableSleep(o.after, signal) : (await sleep(o.after), true);
        if (!done) return `Error: the fake thing ${name} was stopped by its budget before it acted.`;
      }
      rec.acted++;
      return `Closed the fake thing ${name}.`;
    },
  };
}
const newRec = (): Record_ => ({ acted: 0, asked: 0 });
/**
 * Between cases: a question still open (on code without the fix, a cancelled
 * call's question stays) is denied, and the sandbox's slots are waited for, so
 * one case cannot make the next fail.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (approvalGate.pendingRequest()) approvalGate.offerConsoleAnswer('no');
    if (!approvalGate.pendingRequest() && sandbox.getActiveCounts().high === 0) return;
    await sleep(20);
  }
}

/** Waits until the grace after the gate's last withdrawal (1.5 s, F2) is over; at once if there was none. */
async function pastWithdrawalGrace(): Promise<void> {
  const withdrawnAt: number = (approvalGate as any).withdrawnAt;
  while (performance.now() - withdrawnAt < 1_600) await sleep(20);
}

console.log('\n=== Approval wait outside the tool budget (B4 R3-1) ===\n');

const cleanups: Array<() => Promise<void>> = [];
try {
  // ── 1. Inside the window ────────────────────────────────────────────────
  console.log('--- 1. An answer inside the window, after the budget ---');
  for (const answerMs of [1_800, 2_400]) {
    await settle();
    const rec = newRec();
    const call = sandbox.run(askingTool(`one-${answerMs}`, rec), {});
    const answer = await answerNext('yes', answerMs);
    const out = await call;
    await sleep(100);
    const label = answerMs === 1_800 ? 'after the 1.5 s budget' : 'after the budget and its 0.5 s grace (JARVIS used to report TIMEOUT)';
    ok(`"yes" at ${answerMs / 1000} s, ${label}: the action runs once, as a success`,
      answer.taken && rec.acted === 1 && /^Closed the fake thing/.test(out), `acted ${rec.acted}: ${out.slice(0, 90)}`);
    ok('…the budget did not run out while the owner was answering', rec.abortedAtAnswer === false && rec.abortedAt === undefined, `aborted at answer: ${rec.abortedAtAnswer}`);
    ok('…the decision is the owner\'s typed yes', lastDecision()?.approved === true && lastDecision()?.by === 'console', JSON.stringify(lastDecision()?.by));
  }

  // ── 2. End to end: "close the browser" ──────────────────────────────────
  console.log('\n--- 2. "close the browser", answered after 1.8 s ---');
  await settle();
  {
    const chrome = await fakeChrome();
    cleanups.push(() => chrome.stop());
    const profile = process.env['JARVIS_CHROME_PROFILE']!;
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${chrome.port}\n${chrome.socketPath}\n`);
    const { registerAllTools } = await import('../core/tools/index.js');
    const { SkillLoader } = await import('../core/skillLoader.js');
    const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
    const { permissionSession } = await import('../control/permissionSession.js');
    registerAllTools();
    await new SkillLoader(path.join(repo, 'skills')).loadSkills();
    permissionSession.activateFullControl(5, 'cli');
    // Every question (the registry's, if any, and the browser controller's) is answered 1.8 s after it appears.
    let stop = false;
    const asked: string[] = [];
    const answerer = (async () => {
      while (!stop) {
        const p = approvalGate.pendingRequest();
        if (p && !asked.includes(p.id)) { asked.push(p.id); await sleep(1_800); approvalGate.offerConsoleAnswer('yes'); }
        await sleep(20);
      }
    })();
    const result = await toolRegistryV2.execute('control_browser', { action: 'close_browser' });
    stop = true; await answerer;
    permissionSession.deactivateFullControl('test');
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    ok('the owner\'s yes after 1.8 s closes JARVIS\'s Chrome: Browser.close sent once', chrome.closeRequests === 1, `${chrome.closeRequests} close request(s), ${asked.length} question(s)`);
    ok('…reported as closed, not "the request had already ended"',
      result.success && /Closed JARVIS's Chrome/.test(result.output) && !/already ended/.test(result.output), result.output.slice(0, 140));
  }

  // ── 3. Expired, missing, duplicate ──────────────────────────────────────
  console.log('\n--- 3. Expired, missing and duplicate answers ---');
  await settle();
  {
    process.env['JARVIS_APPROVAL_TIMEOUT_S'] = '10';   // the gate's shortest typed window
    const rec = newRec();
    const t0 = Date.now();
    const out = await sandbox.run(askingTool('expired', rec), {});
    delete process.env['JARVIS_APPROVAL_TIMEOUT_S'];
    const ms = Date.now() - t0;
    ok('no answer before the gate\'s deadline (10 s): denied, never acted', rec.acted === 0 && /not approved/.test(out) && lastDecision()?.by === 'timeout', `${ms} ms: ${out.slice(0, 80)}`);
    ok('…the call waited for the gate\'s deadline, not the 1.5 s budget (no TIMEOUT while asking)', !/TIMEOUT/.test(out) && ms >= 9_500, `${ms} ms`);
    const late = approvalGate.offerConsoleAnswer('yes');
    await sleep(200);
    ok('…a "yes" after the deadline approves nothing', late === false && rec.acted === 0);
  }
  await settle();
  {
    const gate = approvalGate as any;
    gate.consoleAttached = false;                      // no console and no voice to answer on
    const rec = newRec();
    const out = await sandbox.run(askingTool('missing', rec), {});
    gate.consoleAttached = true;
    ok('no way to answer: denied, never acted', rec.acted === 0 && /not approved/.test(out) && lastDecision()?.by === 'unavailable', `${lastDecision()?.by}: ${out.slice(0, 60)}`);
  }
  await settle();
  {
    const rec = newRec();
    const call = sandbox.run(askingTool('twice', rec), {});
    const first = await answerNext('yes', 300);
    const second = approvalGate.offerConsoleAnswer('yes');
    await call; await sleep(200);
    ok('"yes" twice: the action runs once; the second answer is not taken', first.taken && second === false && rec.acted === 1, `acted ${rec.acted}`);
  }

  // ── 4. Cancellation ─────────────────────────────────────────────────────
  console.log('\n--- 4. Cancellation ---');
  await settle();
  {
    const rec = newRec();
    const ac = new AbortController();
    const call = sandbox.run(askingTool('cancelled', rec), {}, ac.signal);
    const id = await questionShown();
    await sleep(300);
    const cancelledAt = Date.now();
    ac.abort();
    let gone = 0;
    for (let i = 0; i < 50 && approvalGate.pendingRequest()?.id === id; i++) { await sleep(10); gone = i; }
    const withdrawnMs = Date.now() - cancelledAt;
    ok('cancelled while its question is open: the question is withdrawn at once (the pending request removed)',
      !!id && approvalGate.pendingRequest()?.id !== id && withdrawnMs < 200, `${withdrawnMs} ms (${gone})`);
    const out = await call;
    ok('…recorded as cancelled, a denial', lastDecision()?.approved === false && lastDecision()?.by === 'cancelled', JSON.stringify(lastDecision()?.by));
    ok('…the call ends promptly with the refusal, never acted', rec.acted === 0 && /not approved/.test(out) && Date.now() - cancelledAt < 450, `${Date.now() - cancelledAt} ms: ${out.slice(0, 60)}`);
    const stale = approvalGate.offerConsoleAnswer('yes');
    await sleep(100);
    ok('…a "yes" typed afterwards approves nothing (no stale approval)', stale === false && rec.acted === 0);
    // The gate's turn is released: the next question appears at once, not after the cancelled one's deadline.
    const next = newRec();
    const t1 = Date.now();
    const nextCall = sandbox.run(askingTool('after-cancel', next), {});
    const nextId = await questionShown(2_000);
    const shownMs = Date.now() - t1;
    await sleep(1_600);                                 // typed answers count 1.5 s after a withdrawal (review F2)
    approvalGate.offerConsoleAnswer('no');
    await nextCall;
    ok('…the gate\'s turn is released: the next question is shown at once', !!nextId && shownMs < 300, `${shownMs} ms`);
  }
  await settle();
  {
    // The owner's yes and the cancellation in the same instant (the yes first): it approves nothing.
    const rec = newRec();
    const ac = new AbortController();
    const call = sandbox.run(askingTool('same-instant', rec), {}, ac.signal);
    await questionShown();
    const taken = approvalGate.offerConsoleAnswer('yes');
    ac.abort();
    const out = await call;
    await sleep(100);
    ok('a yes and the cancellation in the same instant: recorded as cancelled, never acted',
      taken && rec.acted === 0 && /not approved/.test(out) && lastDecision()?.by === 'cancelled', `${lastDecision()?.by}: ${out.slice(0, 60)}`);
  }
  await settle();
  {
    // Cancelled during its question with 0.3 s of budget left, then slow to wind down: no budget restarts.
    const rec = newRec();
    const ac = new AbortController();
    const call = sandbox.run(askingTool('no-resume', rec, { before: 1_200, afterDenial: 1_000 }), {}, ac.signal);
    await questionShown();
    await sleep(200);
    ac.abort();
    const out = await call;
    ok('cancelled with budget left: the budget is not resumed (the call ends as cancelled, not as over its budget)',
      /was cancelled/.test(out) && !/ran past/.test(out) && rec.acted === 0, out.slice(0, 120));
  }
  await settle();
  {
    const rec = newRec();
    const ac = new AbortController();
    const call = sandbox.run(askingTool('cancel-before', rec, { before: 300 }), {}, ac.signal);
    await sleep(100);
    ac.abort();
    const out = await call;
    await sleep(100);
    ok('cancelled before it asks: the owner is not asked, recorded as cancelled, never acted',
      rec.asked === 1 && approvalGate.pendingRequest() === undefined && lastDecision()?.by === 'cancelled' && rec.acted === 0, `${lastDecision()?.by}: ${out.slice(0, 60)}`);
  }
  await settle();
  {
    const rec = newRec();
    const shown: string[] = [];
    const watcher = (async () => { for (let i = 0; i < 220; i++) { const p = approvalGate.pendingRequest(); if (p) shown.push(p.id); await sleep(10); } })();
    const out = await sandbox.run(askingTool('budget-gone', rec, { before: 1_700 }), {});
    await watcher;
    ok('the budget used up before the question: the owner is not asked, never acted',
      shown.length === 0 && lastDecision()?.by === 'cancelled' && rec.acted === 0, `${shown.length} shown, ${lastDecision()?.by}: ${out.slice(0, 60)}`);
  }

  // ── 5. The remaining budget ─────────────────────────────────────────────
  console.log('\n--- 5. Only the remaining budget after the answer ---');
  await settle();
  {
    // 0.6 s before the question + 0.6 s after = 1.2 s of the 1.5 s budget: fits, 0.3 s to spare.
    const rec = newRec();
    const call = sandbox.run(askingTool('fits', rec, { before: 600, after: 600, respectBudget: true }), {});
    await answerNext('yes', 2_000);
    const out = await call;
    ok('0.6 s + a 2 s question + 0.6 s: fits the 1.5 s budget, acted once', rec.acted === 1 && rec.abortedAt === undefined && /^Closed/.test(out), out.slice(0, 80));
  }
  await settle();
  {
    // 0.6 s before + 1.5 s after: the budget ends 0.9 s after the answer (1.5 − 0.6), not 1.5 s after it.
    const rec = newRec();
    const call = sandbox.run(askingTool('over', rec, { before: 600, after: 1_500, respectBudget: true }), {});
    await answerNext('yes', 2_000);
    const out = await call;
    const afterAnswer = rec.abortedAt !== undefined && rec.answeredAt !== undefined ? rec.abortedAt - rec.answeredAt : NaN;
    ok('after the answer, only the 0.9 s that was left: the budget ends 0.9 s after it (±0.15 s)',
      afterAnswer >= 750 && afterAnswer <= 1_050, `${afterAnswer} ms after the answer`);
    ok('…never the full 1.5 s again, and never during the question', !(afterAnswer >= 1_350) && rec.abortedAtAnswer === false, `aborted at answer: ${rec.abortedAtAnswer}`);
    ok('…the tool stopped by its budget, not acted', rec.acted === 0 && /stopped by its budget/.test(out), out.slice(0, 80));
  }
  await settle();
  {
    const rec = newRec();
    const tool: any = { name: 'no-question', riskLevel: 'high', async execute(_a: unknown, signal: AbortSignal) {
      rec.startedAt = Date.now();
      signal.addEventListener('abort', () => { rec.abortedAt ??= Date.now(); }, { once: true });
      return (await abortableSleep(3_000, signal)) ? 'done' : 'Error: stopped';
    } };
    await sandbox.run(tool, {});
    const ms = (rec.abortedAt ?? 0) - (rec.startedAt ?? 0);
    ok('a tool that asks nothing: its budget ends at 1.5 s, as before (±0.15 s)', ms >= 1_350 && ms <= 1_650, `${ms} ms`);
  }
  await settle();
  {
    // Call A has an open question; call B (no question) still times out on its own budget.
    const a = newRec();
    const b = newRec();
    const callA = sandbox.run(askingTool('parallel-a', a), {});
    await questionShown();
    const toolB: any = { name: 'parallel-b', riskLevel: 'high', async execute(_x: unknown, signal: AbortSignal) {
      b.startedAt = Date.now();
      signal.addEventListener('abort', () => { b.abortedAt ??= Date.now(); }, { once: true });
      return (await abortableSleep(3_000, signal)) ? 'done' : 'Error: stopped';
    } };
    await sandbox.run(toolB, {});
    const bMs = (b.abortedAt ?? 0) - (b.startedAt ?? 0);
    approvalGate.offerConsoleAnswer('yes');
    await callA;
    ok('two calls at once: the one without a question keeps its 1.5 s budget while the other\'s question is open', bMs >= 1_350 && bMs <= 1_650 && a.acted === 1, `${bMs} ms, A acted ${a.acted}`);
  }

  // ── 5b. Questions waiting their turn, and two at once ──────────────────
  console.log('\n--- 5b. A question waiting its turn, and two questions in one call ---');
  await settle();
  {
    // A's question is on display; B's waits its turn. B's budget is paused while it waits (that is the owner too).
    const a = newRec();
    const b = newRec();
    const callA = sandbox.run(askingTool('turn-a', a), {});
    const idA = await questionShown();
    const callB = sandbox.run(askingTool('turn-b', b), {});
    await sleep(2_000);                                 // longer than B's 1.5 s budget
    approvalGate.offerConsoleAnswer('yes');             // A
    for (let i = 0; i < 100 && (approvalGate.pendingRequest()?.id ?? idA) === idA; i++) await sleep(10);
    await sleep(300);
    approvalGate.offerConsoleAnswer('yes');             // B, now on display
    const [outA, outB] = await Promise.all([callA, callB]);
    ok('a question waiting its turn behind another: its call\'s budget is paused meanwhile, and both act once',
      a.acted === 1 && b.acted === 1 && b.abortedAtAnswer === false && /^Closed/.test(outB), `A ${outA.slice(0, 30)} | B ${outB.slice(0, 60)}`);
  }
  await settle();
  {
    // B is cancelled while it waits its turn: it stops waiting at once, is never shown, and A's question stays.
    const a = newRec();
    const b = newRec();
    const callA = sandbox.run(askingTool('wait-a', a), {});
    const idA = await questionShown();
    const ac = new AbortController();
    const printed: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); realLog(...args); };
    const callB = sandbox.run(askingTool('wait-b', b), {}, ac.signal);
    await sleep(300);
    const cancelledAt = Date.now();
    ac.abort();
    const outB = await callB;
    const endedMs = Date.now() - cancelledAt;
    // A third call asks after B was cancelled: it still waits for A's question.
    const c = newRec();
    const callC = sandbox.run(askingTool('wait-c', c), {});
    await sleep(300);
    const shownWhileA = approvalGate.pendingRequest()?.id;
    console.log = realLog;
    ok('…its question box is never shown', !printed.some((l) => /Close wait-b/.test(l)), `${printed.filter((l) => /wait-b/.test(l)).length} line(s)`);
    ok('…a third question asked meanwhile still waits for the one on display', shownWhileA === idA, String(shownWhileA === idA));
    ok('cancelled while waiting its turn: it stops waiting at once, recorded as cancelled, never acted',
      endedMs < 200 && b.acted === 0 && /not approved/.test(outB) && lastDecision()?.by === 'cancelled', `${endedMs} ms: ${outB.slice(0, 60)}`);
    ok('…the question on display is still the other call\'s', approvalGate.pendingRequest()?.id === idA);
    approvalGate.offerConsoleAnswer('yes');
    await callA;
    const idC = await questionShown();
    const shownNext = approvalGate.pendingRequest();
    ok('…after it is answered, the next question is the third call\'s, never the cancelled one\'s',
      !!idC && a.acted === 1 && b.acted === 0 && !/wait-b/.test(JSON.stringify(approvalGate.pendingRequest() ?? {})), JSON.stringify(shownNext ?? {}).slice(0, 80));
    approvalGate.offerConsoleAnswer('no');
    await callC;
  }
  await settle();
  {
    // One call asks two questions at once with 0.3 s of budget left: the clock stays paused until the last is answered.
    const rec = newRec();
    let abortedAtSecond: boolean | undefined;
    const tool: any = { name: 'two-questions', riskLevel: 'high', async execute(_a: unknown, signal: AbortSignal) {
      signal.addEventListener('abort', () => { rec.abortedAt ??= Date.now(); }, { once: true });
      await sleep(1_200);
      const [one, two] = await Promise.all([
        approvalGate.requestApproval('Close the first thing', 'Close the first fake thing'),
        approvalGate.requestApproval('Close the second thing', 'Close the second fake thing').then((v) => { abortedAtSecond = signal.aborted; return v; }),
      ]);
      if (one && two) rec.acted++;
      return one && two ? 'both done' : 'not approved';
    } };
    const call = sandbox.run(tool, {});
    const first = await questionShown();
    await sleep(300);
    approvalGate.offerConsoleAnswer('yes');
    for (let i = 0; i < 100 && (approvalGate.pendingRequest()?.id ?? first) === first; i++) await sleep(10);
    await sleep(1_000);                                 // longer than the 0.3 s left
    approvalGate.offerConsoleAnswer('yes');
    const out = await call;
    ok('two questions open in one call: the budget stays paused until the last is answered', out === 'both done' && rec.acted === 1 && abortedAtSecond === false && rec.abortedAt === undefined, `${out}; aborted at second: ${abortedAtSecond}`);
  }

  await settle();
  {
    // 0.4 s, a question (1 s), 0.4 s, a second question (1 s), then work: only 0.7 s of running time is left.
    const rec = newRec();
    let secondAnsweredAt = 0;
    const tool: any = { name: 'one-after-another', riskLevel: 'high', async execute(_a: unknown, signal: AbortSignal) {
      signal.addEventListener('abort', () => { rec.abortedAt ??= Date.now(); }, { once: true });
      await sleep(400);
      await approvalGate.requestApproval('Close the first one', 'Close the first one of two');
      await sleep(400);
      await approvalGate.requestApproval('Close the second one', 'Close the second one of two');
      secondAnsweredAt = Date.now();
      return (await abortableSleep(3_000, signal)) ? 'done' : 'Error: stopped by its budget';
    } };
    const call = sandbox.run(tool, {});
    await answerNext('yes', 1_000);
    await sleep(50);
    await answerNext('yes', 1_000);
    const out = await call;
    const left = (rec.abortedAt ?? 0) - secondAnsweredAt;
    ok('two questions one after the other: each deducts only running time; 0.7 s is left after the second (±0.15 s)',
      left >= 550 && left <= 850 && /stopped/.test(out), `${left} ms after the second answer`);
  }

  // ── 6. Unchanged: the registry's approval and a nested question ─────────
  console.log('\n--- 6. The registry\'s approval and a nested question (unchanged) ---');
  await settle();
  {
    const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
    let runs = 0;
    let budgetAtStart: boolean | undefined;
    toolRegistryV2.register({
      name: 'test_r31_registry_asks', description: 'Stand-in level-3 tool: the registry asks before it runs.', riskLevel: 'high',
      meta: { category: 'SYSTEM', risk: 3, reversible: 'no', external: 'none', effect: 'Does a test thing.', output: { format: 'text', description: 'Text' } },
      inputSchema: {}, fallbacks: [],
      async execute(_args: Record<string, unknown>, signal?: AbortSignal) { budgetAtStart = !signal?.aborted; runs++; return 'did it'; },
    } as any);
    const { permissionSession } = await import('../control/permissionSession.js');
    permissionSession.activateFullControl(5, 'cli');   // a level-3 call needs full control, then the owner's yes
    const call = toolRegistryV2.execute('test_r31_registry_asks', {});
    const answer = await answerNext('yes', 1_800);
    const r = await call;
    permissionSession.deactivateFullControl('test');
    ok('the registry\'s own approval, answered after 1.8 s: asked before the run, the tool runs once with its budget untouched',
      answer.taken && r.success && runs === 1 && budgetAtStart === true, `${runs} run(s): ${r.output.slice(0, 60)}`);
  }
  await settle();
  {
    const rec = newRec();
    const shown: string[] = [];
    const watcher = (async () => { for (let i = 0; i < 60; i++) { const p = approvalGate.pendingRequest(); if (p) shown.push(p.id); await sleep(10); } })();
    const nested = buildApprovalRequest({ tool: 'test_nested', action: 'close', target: 'the nested thing', risk: 2, reason: 'test', source: 'cli' });
    const tool: any = { name: 'nested', riskLevel: 'high', async execute() {
      const approved = await approvalGate.requestApproval(nested);
      if (approved) rec.acted++;
      return approved ? 'done' : 'not approved';
    } };
    // The approved call as the registry builds it from its request (core/toolRegistryV2.ts).
    const call = { tool: 'test_nested', ...(nested.action ? { action: nested.action } : {}), target: nested.target, args: {}, level: 2, grantsLevel: 0, approvedAt: Date.now(), requestId: 'r31' };
    const out = await runApproved(call as never, () => sandbox.run(tool, {}));
    await watcher;
    ok('a nested question the registry\'s approval covers: not asked again, answered by scope, acted once',
      out === 'done' && rec.acted === 1 && shown.length === 0 && lastDecision()?.by === 'scope', `${lastDecision()?.by}`);
  }

  // ── 7. A spoken question cancelled while JARVIS is still asking ─────────
  console.log('\n--- 7. A spoken question, cancelled while JARVIS is asking ---');
  await settle();
  {
    const { nodeBridge } = await import('../bridge/nodeBridge.js');
    const realSpeak = (nodeBridge as any).speakToClients;
    // A speaker that takes 1.5 s to say the question.
    (nodeBridge as any).speakToClients = () => { nodeBridge.ttsStartedMs = Date.now(); setTimeout(() => { nodeBridge.ttsEndedMs = Date.now(); }, 1_500); };
    const rec = newRec();
    const tool: any = { name: 'spoken', riskLevel: 'high', async execute() {
      const approved = await approvalGate.requestApproval(buildApprovalRequest({ tool: 'test_spoken', action: 'close', target: 'the spoken thing', risk: 2, reason: 'test', source: 'voice' }));
      if (approved) rec.acted++;
      return approved ? 'done' : 'not approved';
    } };
    const ac = new AbortController();
    const call = sandbox.run(tool, {}, ac.signal);
    const id = await questionShown();
    await sleep(400);                                   // JARVIS is still saying the question
    const cancelledAt = Date.now();
    ac.abort();
    const out = await call;
    const endedMs = Date.now() - cancelledAt;
    await sleep(1_500);                                 // the question would now be listening
    const heard = approvalGate.offerVoiceAnswer('approve');
    (nodeBridge as any).speakToClients = realSpeak;
    ok('cancelled while JARVIS is saying the question: the voice wait stops and the call ends at once',
      !!id && out === 'not approved' && endedMs < 300, `${endedMs} ms: ${out}`);
    ok('…recorded as cancelled; a spoken "approve" afterwards approves nothing', lastDecision()?.by === 'cancelled' && heard === false && rec.acted === 0, `${lastDecision()?.by}, heard ${heard}`);
  }

  // ── 8. The first review's findings ─────────────────────────────────────
  console.log('\n--- 8. Review follow-ups: F2, F3, F5, F7, F8 ---');
  await settle();
  {
    // F2, the reviewer's P4: "Close A" (inside a tool) is on display, "Delete B" (asked outside a tool) waits its turn.
    // A is withdrawn; B appears at once; a "yes" typed 30 ms later was meant for A.
    const a = newRec();
    const ac = new AbortController();
    const callA = sandbox.run(askingTool('withdrawn-a', a), {}, ac.signal);
    await questionShown();
    const decisionsBefore = approvalGate.recentDecisions(50).length;
    const callB = approvalGate.requestApproval('Delete B', 'Delete the fake thing B');
    await sleep(100);
    const withdrawnAt = Date.now();
    ac.abort();
    await sleep(30);
    const shownB = approvalGate.pendingRequest();
    const staleTaken = approvalGate.offerConsoleAnswer('yes');
    await sleep(50);
    const stillOpen = approvalGate.pendingRequest()?.id === shownB?.id;
    const bDecided = approvalGate.recentDecisions(50).slice(decisionsBefore).some((d) => d.action === 'Delete B');
    const outA = await callA;
    ok('F2: 30 ms after "Close A" is withdrawn, "Delete B" is on display', shownB?.action === 'Delete B', String(shownB?.action));
    ok('F2: a "yes" typed then (meant for the withdrawn question) does not approve "Delete B": it stays open, undecided',
      stillOpen && !bDecided && a.acted === 0 && /not approved/.test(outA), `swallowed ${staleTaken}, open ${stillOpen}, decided ${bDecided}`);
    const expiresIn = ((approvalGate as any).pending?.expiresAt ?? 0) - withdrawnAt;
    ok('F2: the deadline moves by the same grace (the 30 s window is not shortened)', expiresIn >= 31_300 && expiresIn <= 31_700, `${expiresIn} ms after the withdrawal`);
    while (Date.now() - withdrawnAt < 1_600) await sleep(20);
    const fresh = approvalGate.offerConsoleAnswer('yes');
    const approvedB = await callB;
    ok('F2: a fresh "yes" after the grace approves "Delete B", by the console',
      fresh && approvedB === true && lastDecision()?.action === 'Delete B' && lastDecision()?.by === 'console', `${approvedB}, ${lastDecision()?.by}`);
  }
  await settle();
  await sleep(1_600);                                   // past any grace from an earlier withdrawal
  {
    // F2: with no withdrawal, a typed answer counts at once, as before.
    const q = approvalGate.requestApproval('Close C', 'Close the fake thing C');
    await questionShown();
    await sleep(20);
    const taken = approvalGate.offerConsoleAnswer('yes');
    ok('F2: no question withdrawn: a "yes" 20 ms after the question appears approves it, as before',
      taken && (await q) === true && lastDecision()?.by === 'console', `${lastDecision()?.by}`);
  }
  await settle();
  {
    // F3, the reviewer's P9: background work started by a tool asks after the call has ended,
    // and the caller's signal is aborted after the call ended.
    const ac = new AbortController();
    let inCall: boolean | undefined;
    let background: Promise<boolean> | undefined;
    const tool: any = { name: 'leaves-work', riskLevel: 'high', async execute() {
      setTimeout(() => { inCall = currentToolCall() !== undefined; background = approvalGate.requestApproval('Background step', 'Do the background thing'); }, 200);
      return 'returned';
    } };
    const out = await sandbox.run(tool, {}, ac.signal);
    ac.abort();                                          // e.g. the request is interrupted after the call returned
    const id = await questionShown();
    ok('F3: work left behind by an ended call is no longer part of it', out === 'returned' && inCall === false, `inCall ${inCall}`);
    ok('F3: its question is shown, not withdrawn by the ended call\'s signal', !!id && approvalGate.pendingRequest()?.action === 'Background step');
    approvalGate.offerConsoleAnswer('yes');
    const approved = await background;
    ok('F3: …and the owner\'s answer decides it (a yes approves, by the console)', approved === true && lastDecision()?.by === 'console', `${approved}, ${lastDecision()?.by}`);
  }
  await settle();
  {
    // F3: background work still running inside an active call stays part of it: its question pauses
    // the call's budget and is withdrawn when the call is cancelled.
    const ac = new AbortController();
    let inCall: boolean | undefined;
    let background: Promise<boolean> | undefined;
    let abortedAt: number | undefined;
    const tool: any = { name: 'active-bg', riskLevel: 'high', async execute(_a: unknown, signal: AbortSignal) {
      signal.addEventListener('abort', () => { abortedAt ??= Date.now(); }, { once: true });
      setTimeout(() => { inCall = currentToolCall() !== undefined; background = approvalGate.requestApproval('Active step', 'Do the active thing'); }, 100);
      await abortableSleep(5_000, signal);
      return 'ended';
    } };
    const call = sandbox.run(tool, {}, ac.signal);
    await questionShown();
    await sleep(2_000);                                  // longer than the 1.5 s budget: paused by the question
    const pausedOk = abortedAt === undefined;
    ac.abort();
    const answer = await background;
    await call;
    ok('F3: background work inside an active call is part of it: its question pauses the budget',
      inCall === true && pausedOk, `inCall ${inCall}, aborted during question ${!pausedOk}`);
    ok('F3: …and is withdrawn as cancelled when the call is cancelled', answer === false && lastDecision()?.by === 'cancelled', `${lastDecision()?.by}`);
  }
  for (const jump of [-10_000, 10_000]) {
    await settle();
    // The question must not appear inside the grace after an earlier withdrawal (F2), or its
    // "yes" is not taken (review T1): wait until that grace is over.
    await pastWithdrawalGrace();
    // F5: the system clock jumps by `jump` ms before the question. 0.3 s used, a 0.5 s question,
    // then the budget must end 1.2 s after the answer (±0.15 s): never more than the budget, never 0.
    const realNow = Date.now;
    let used = NaN;
    let afterAnswer = NaN;
    let approved: boolean | undefined;
    let by: string | undefined;
    try {
      let answeredAt = 0;
      let abortedAt = 0;
      const tool: any = { name: `clock${jump}`, riskLevel: 'high', async execute(_a: unknown, signal: AbortSignal) {
        signal.addEventListener('abort', () => { abortedAt = performance.now(); }, { once: true });
        const start = performance.now();
        await sleep(300);
        Date.now = () => realNow() + jump;
        used = performance.now() - start;
        approved = await approvalGate.requestApproval(`Clock ${jump}`, 'Close the clock thing');
        by = lastDecision()?.by;
        answeredAt = performance.now();
        await abortableSleep(3_000, signal);
        return 'done';
      } };
      const call = sandbox.run(tool, {});
      await answerNext('yes', 500);
      await within(call, 5_000);
      afterAnswer = abortedAt - answeredAt;
    } finally {
      Date.now = realNow;
    }
    const expected = 1_500 - used;
    ok(`F5: the system clock moves ${jump > 0 ? 'forward' : 'back'} 10 s before a question: the owner's typed yes approves it`,
      approved === true && by === 'console', `approved ${approved}, by ${by}`);
    ok(`F5 (${jump > 0 ? 'forward' : 'back'}): …only the ${Math.round(expected)} ms left runs after the answer (±0.15 s)`,
      approved === true && Math.abs(afterAnswer - expected) <= 150 && afterAnswer <= 1_500, `${Math.round(afterAnswer)} ms after the answer`);
  }
  await settle();
  {
    // F8: cancellation, then a "yes" in the same instant (the reviewer's P5).
    const rec = newRec();
    const ac = new AbortController();
    const call = sandbox.run(askingTool('abort-then-yes', rec), {}, ac.signal);
    await questionShown();
    ac.abort();
    const taken = approvalGate.offerConsoleAnswer('yes');
    const out = await call;
    await sleep(100);
    ok('F8: cancelled, then a "yes" in the same instant: the yes is not taken, recorded as cancelled, never acted',
      taken === false && rec.acted === 0 && /not approved/.test(out) && lastDecision()?.by === 'cancelled', `taken ${taken}, ${lastDecision()?.by}`);
  }
  await settle();
  {
    // F8: the budget runs out while the tool is busy (the event loop blocked, so the timer has not fired yet)
    // and it asks at that moment: no budget is left, so the owner is not asked and nothing acts.
    const rec = newRec();
    const shown: string[] = [];
    const watcher = (async () => { for (let i = 0; i < 150; i++) { const p = approvalGate.pendingRequest(); if (p) { shown.push(p.id); approvalGate.offerConsoleAnswer('yes'); } await sleep(10); } })();
    const tool: any = { name: 'no-budget-left', riskLevel: 'high', async execute() {
      const end = performance.now() + 1_600;
      while (performance.now() < end) { /* busy past the 1.5 s budget */ }
      rec.asked++;
      const approved = await approvalGate.requestApproval('Close no-budget-left', 'Close the fake thing no-budget-left');
      if (approved) rec.acted++;
      return approved ? 'acted' : 'not approved';
    } };
    const out = await sandbox.run(tool, {});
    await watcher;
    ok('F8: no budget left when the question is asked: not asked, recorded as cancelled, never acted',
      rec.asked === 1 && shown.length === 0 && rec.acted === 0 && lastDecision()?.by === 'cancelled', `${shown.length} shown, ${lastDecision()?.by}: ${out.slice(0, 60)}`);
  }
  await settle();
  {
    // F7: the call is stopped while the box is printed (before the bridge is reached): the question is not said.
    const { nodeBridge } = await import('../bridge/nodeBridge.js');
    const realSpeak = (nodeBridge as any).speakToClients;
    const said: string[] = [];
    (nodeBridge as any).speakToClients = (text: string) => { said.push(text); };
    const ac = new AbortController();
    const realLog = console.log;
    console.log = (...args: unknown[]) => { if (args.some((x) => String(x).includes('the unsaid thing'))) ac.abort(); realLog(...args); };
    let out = '';
    try {
      const tool: any = { name: 'unsaid', riskLevel: 'high', async execute() {
        const approved = await approvalGate.requestApproval(buildApprovalRequest({ tool: 'test_unsaid', action: 'close', target: 'the unsaid thing', risk: 2, reason: 'test', source: 'voice' }));
        return approved ? 'done' : 'not approved';
      } };
      out = await sandbox.run(tool, {}, ac.signal);
    } finally {
      console.log = realLog;
      (nodeBridge as any).speakToClients = realSpeak;
    }
    ok('F7: a spoken question withdrawn before JARVIS reaches the speaker is not said; recorded as cancelled',
      out === 'not approved' && !said.some((t) => /unsaid/.test(t)) && lastDecision()?.by === 'cancelled', `${said.length} said, ${lastDecision()?.by}`);
  }

  // ── 9. The second review's findings ────────────────────────────────────
  console.log('\n--- 9. Review round 2 follow-ups: S1, S2 ---');
  await settle();
  {
    // S1: the setting is read defensively.
    const cases: Array<[string | undefined, number]> = [
      ['abc', 1500], ['-5', 1500], ['NaN', 1500], ['Infinity', 1500], ['-Infinity', 1500],
      [undefined, 1500], ['', 1500], ['  ', 1500], ['2500', 2500], ['0', 0],
      ['60000', 60_000], ['60001', 1500], ['1e7', 1500], ['2147483647', 1500], ['1e308', 1500],
    ];
    const wrong = cases.filter(([v, want]) => approvalGraceMs(v) !== want).map(([v, want]) => `${JSON.stringify(v)}→${approvalGraceMs(v)} (want ${want})`);
    ok('S1/T2: JARVIS_APPROVAL_GRACE_MS: missing, empty, non-numeric, negative, NaN, ±Infinity and anything above 60 000 give 1500 ms; 0, 2500 and exactly 60 000 are kept', wrong.length === 0, wrong.join(', ') || `${cases.length} values`);
  }
  {
    // S1 end to end: a gate started with each setting (a child process, as at start-up).
    const child = path.join(workspace, 's1-child.mts');
    fs.writeFileSync(child, `
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { approvalGate } = await import(process.argv[2]);
const { buildApprovalRequest } = await import(process.argv[3]);
approvalGate.attachConsole();
const r: Record<string, unknown> = {};
if (process.argv[4] === 'withdrawal') {
  // T2: a real withdrawal (a tool call cancelled while its question is open), then the next question.
  const { toolExecutionSandbox } = await import(process.argv[5]);
  const ac = new AbortController();
  const call = toolExecutionSandbox.run({ name: 't2', riskLevel: 'high', async execute() { return String(await approvalGate.requestApproval('T2 withdrawn', 'The T2 withdrawn thing')); } }, {}, ac.signal);
  await sleep(100);
  ac.abort();
  await call;
  const next = approvalGate.requestApproval('T2 next', 'The T2 next thing');
  await sleep(100);
  const p = (approvalGate as any).pending;
  r.open = approvalGate.pendingRequest()?.action === 'T2 next';
  r.typedIn = p ? p.consoleFrom - Date.now() : 'none';
  r.expiresIn = p ? p.expiresAt - Date.now() : 'none';
  r.staleTaken = approvalGate.offerConsoleAnswer('yes');
  r.stillOpen = approvalGate.pendingRequest()?.action === 'T2 next';
  r.decided = await Promise.race([next.then(() => true), sleep(50).then(() => false)]);
  console.log('S1RESULT ' + JSON.stringify(r));
  process.exit(0);
}
const plain = approvalGate.requestApproval('S1 plain', 'The S1 plain thing');
await sleep(100);
const p = (approvalGate as any).pending;
r.open = !!approvalGate.pendingRequest();
r.expiresIn = p ? p.expiresAt - Date.now() : 'none';
r.yesTaken = approvalGate.offerConsoleAnswer('yes');
r.approved = await plain;
void approvalGate.requestApproval(buildApprovalRequest({ tool: 'test_s1_goal', action: 'close', target: 'the S1 goal thing', risk: 2, reason: 'test', source: 'cli', goal: { goalId: 'g-s1', goalTaskId: 't-s1', title: 'S1' } }));
await sleep(100);
const g = (approvalGate as any).pending;
r.goalTypedIn = g ? g.consoleFrom - Date.now() : 'none';
r.goalExpiresIn = g ? g.expiresAt - Date.now() : 'none';
console.log('S1RESULT ' + JSON.stringify(r));
process.exit(0);
`);
    const gateUrl = pathToFileURL(path.join(repo, 'security', 'approvalGate.ts')).href;
    const requestUrl = pathToFileURL(path.join(repo, 'security', 'approvalRequest.ts')).href;
    const sandboxUrl = pathToFileURL(path.join(repo, 'core', 'toolExecutionSandbox.ts')).href;
    const runChild = (value: string | undefined, mode = 'goal') => new Promise<Record<string, any>>((resolve) => {
      const root = fs.mkdtempSync(path.join(workspace, 's1-'));
      for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, JARVIS_WORKSPACE_ROOT: root, JARVIS_DATA_ROOT: root };
      if (value === undefined) delete env['JARVIS_APPROVAL_GRACE_MS']; else env['JARVIS_APPROVAL_GRACE_MS'] = value;
      execFile(process.execPath, [path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), child, gateUrl, requestUrl, mode, sandboxUrl],
        { env, cwd: root, timeout: 60_000 }, (_err, stdout) => {
          const line = String(stdout).split('\n').find((l) => l.startsWith('S1RESULT '));
          resolve(line ? JSON.parse(line.slice('S1RESULT '.length)) : { error: String(stdout).slice(-300) });
        });
    });
    const values: Array<string | undefined> = ['abc', '-5', 'NaN', 'Infinity', undefined, '2500'];
    const bigValues = ['60000', '60001', '1e7', '2147483647'];
    const [results, bigResults] = await Promise.all([
      Promise.all(values.map((v) => runChild(v))),
      Promise.all(bigValues.map((v) => runChild(v, 'withdrawal'))),
    ]);
    const between = (x: unknown, lo: number, hi: number) => typeof x === 'number' && x >= lo && x <= hi;
    values.forEach((v, i) => {
      const r = results[i]!;
      const grace = v === '2500' ? 2_500 : 1_500;
      ok(`S1: started with JARVIS_APPROVAL_GRACE_MS=${v === undefined ? '(missing)' : v}: a question stays open with its 30 s deadline, a yes approves it, a goal question's grace is ${grace} ms`,
        r.open === true && between(r.expiresIn, 29_700, 30_000) && r.yesTaken === true && r.approved === true
          && between(r.goalTypedIn, grace - 300, grace) && between(r.goalExpiresIn, 29_700, 30_000),
        JSON.stringify(r).slice(0, 160));
    });
    bigValues.forEach((v, i) => {
      const r = bigResults[i]!;
      const grace = v === '60000' ? 60_000 : 1_500;
      // 100 ms after the next question appears: typed answers count after the rest of the grace,
      // the deadline is 30 s + that rest, and a yes typed then is not taken (no timer overflow, no instant denial).
      ok(`T2: started with JARVIS_APPROVAL_GRACE_MS=${v}, a question after a withdrawal: grace ${grace} ms, deadline 30 s + the grace, open, a "yes" at once not taken`,
        r.open === true && between(r.typedIn, grace - 400, grace) && between(r.expiresIn, 30_000 + grace - 400, 30_000 + grace)
          && r.staleTaken === true && r.stillOpen === true && r.decided === false,
        JSON.stringify(r).slice(0, 160));
    });
  }
  /** A question inside a tool call, withdrawn by cancelling the call. The monotonic time of the withdrawal. */
  async function withdrawOne(name: string): Promise<number> {
    const ac = new AbortController();
    const call = sandbox.run(askingTool(name, newRec()), {}, ac.signal);
    await questionShown();
    ac.abort();
    const at = performance.now();
    await call;
    return at;
  }
  const pendingTimes = () => {
    const p = (approvalGate as any).pending;
    const now = Date.now();
    return p ? { typedIn: p.consoleFrom - now, expiresIn: p.expiresAt - now } : { typedIn: NaN, expiresIn: NaN };
  };
  for (const jump of [-3_600_000, 3_600_000]) {
    await settle();
    // S2: the system clock moves by an hour just after a withdrawal; the next question keeps exactly the 1.5 s grace.
    const dir = jump < 0 ? 'back' : 'forward';
    const realNow = Date.now;
    try {
      const withdrawnAt = await withdrawOne(`s2-${dir}`);
      Date.now = () => realNow() + jump;
      const q = approvalGate.requestApproval(`S2 ${dir}`, `The S2 ${dir} thing`);
      await questionShown();
      const t = pendingTimes();
      const stale = approvalGate.offerConsoleAnswer('yes');
      const stillOpen = approvalGate.pendingRequest()?.action === `S2 ${dir}`;
      ok(`S2: the system clock moves ${dir} an hour after a withdrawal: the next question's typed answers count after at most 1.5 s, its deadline is 30 s + at most 1.5 s`,
        t.typedIn > 1_000 && t.typedIn <= 1_500 && t.expiresIn > 31_000 && t.expiresIn <= 31_500, `typed in ${t.typedIn} ms, deadline in ${t.expiresIn} ms`);
      ok(`S2 (${dir}): …a "yes" typed at once is not taken (the 1.5 s protection holds)`, stale === true && stillOpen, `swallowed ${stale}, open ${stillOpen}`);
      while (performance.now() - withdrawnAt < 1_600) await sleep(20);
      const fresh = approvalGate.offerConsoleAnswer('yes');
      const approved = await within(q, 3_000);
      ok(`S2 (${dir}): …a "yes" 1.6 s after the withdrawal approves it (not held longer)`, fresh && approved === true && lastDecision()?.by === 'console', `${approved}, ${lastDecision()?.by}`);
    } finally {
      Date.now = realNow;
    }
  }
  await settle();
  {
    // S2: a controlled monotonic clock that goes back an hour: the grace is still held to 1.5 s.
    const realPerf = performance.now.bind(performance);
    const own = Object.getOwnPropertyDescriptor(performance, 'now');
    let t = { typedIn: NaN, expiresIn: NaN };
    const withdrawnAt = await withdrawOne('s2-perf');
    let q: Promise<boolean> | undefined;
    try {
      Object.defineProperty(performance, 'now', { value: () => realPerf() - 3_600_000, configurable: true, writable: true });
      q = approvalGate.requestApproval('S2 perf', 'The S2 perf thing');
      await questionShown();
      t = pendingTimes();
    } finally {
      if (own) Object.defineProperty(performance, 'now', own); else delete (performance as any).now;
    }
    ok('S2: even a clock that goes back cannot lengthen the grace beyond 1.5 s (typed answers, deadline)',
      t.typedIn >= 0 && t.typedIn <= 1_500 && t.expiresIn <= 31_500, `typed in ${t.typedIn} ms, deadline in ${t.expiresIn} ms`);
    while (realPerf() - withdrawnAt < 1_600) await sleep(20);
    approvalGate.offerConsoleAnswer('yes');
    ok('S2: …and a yes after it approves the question', (await within(q!, 3_000)) === true && lastDecision()?.by === 'console', `${lastDecision()?.by}`);
  }
  await settle();
  {
    // S2, spoken: the system clock goes back an hour after a withdrawal; a spoken question is said,
    // a typed "yes" at once is not taken, and a spoken "approve" after JARVIS finishes asking approves it.
    const { nodeBridge } = await import('../bridge/nodeBridge.js');
    const realSpeak = (nodeBridge as any).speakToClients;
    const realNow = Date.now;
    const before = { started: nodeBridge.ttsStartedMs, ended: nodeBridge.ttsEndedMs };
    try {
      await withdrawOne('s2-spoken');
      Date.now = () => realNow() - 3_600_000;
      // The bridge's speech times are taken after the clock change, as they would be on the PC.
      nodeBridge.ttsStartedMs = Date.now() - 2; nodeBridge.ttsEndedMs = Date.now() - 1;
      (nodeBridge as any).speakToClients = () => { nodeBridge.ttsStartedMs = Date.now(); setTimeout(() => { nodeBridge.ttsEndedMs = Date.now(); }, 200); };
      const askedAt = Date.now();
      const rec = newRec();
      const q = approvalGate.requestApproval(buildApprovalRequest({ tool: 'test_s2_spoken', action: 'close', target: 'the S2 spoken thing', risk: 2, reason: 'test', source: 'voice' }));
      await questionShown();
      const stale = approvalGate.offerConsoleAnswer('yes');
      let p: any;
      for (let i = 0; i < 300; i++) { p = (approvalGate as any).pending; if (!p || p.listeningFrom !== Number.POSITIVE_INFINITY) break; await sleep(10); }
      const listensAfter = p ? p.listeningFrom - askedAt : NaN;
      const window = p ? p.expiresAt - p.listeningFrom : NaN;
      while (p && Date.now() < p.listeningFrom + 50) await sleep(20);
      const heard = approvalGate.offerVoiceAnswer('approve');
      const approved = await within(q, 3_000);
      if (approved) rec.acted++;
      ok('S2 (spoken): a typed "yes" at once is not taken; JARVIS listens once it has said the question (not an hour later)',
        stale === true && listensAfter >= 0 && listensAfter < 2_000, `listens ${listensAfter} ms after asking`);
      ok('S2 (spoken): …the spoken window is 20 s + at most 1.5 s, and a spoken "approve" approves it, by voice',
        window >= 20_000 && window <= 21_500 && heard === true && approved === true && lastDecision()?.by === 'voice', `window ${window} ms, ${lastDecision()?.by}`);
    } finally {
      Date.now = realNow;
      (nodeBridge as any).speakToClients = realSpeak;
      nodeBridge.ttsStartedMs = before.started; nodeBridge.ttsEndedMs = before.ended;
    }
  }
} catch (err) {
  ok('the test ran to the end', false, String((err as Error)?.stack ?? err).slice(0, 500));
} finally {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  // S6: the temporary workspace goes, also after a failure (as tests/toolTimeoutTest.ts).
  removeWorkspace();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// ── A fake Chrome: DevTools HTTP endpoints and the browser WebSocket (as tests/jarvisChromeTest.ts) ──
interface FakeChrome { port: number; socketPath: string; closeRequests: number; stop(): Promise<void> }
async function fakeChrome(): Promise<FakeChrome> {
  const { WebSocketServer } = await import('ws');
  const chrome: FakeChrome = { port: 0, socketPath: `/devtools/browser/${randomUUID()}`, closeRequests: 0, stop: async () => undefined };
  const pages = [{ id: 'BLANK', type: 'page', title: 'about:blank', url: 'about:blank', webSocketDebuggerUrl: '' }];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/json/version') return res.end(JSON.stringify({ Browser: 'FakeChrome/1', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${chrome.port}${chrome.socketPath}` }));
    if (u.pathname === '/json/list' || u.pathname === '/json') return res.end(JSON.stringify(pages));
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const c of wss.clients) c.terminate();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  };
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== chrome.socketPath) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'Browser.close') { chrome.closeRequests++; ws.send(JSON.stringify({ id: msg.id, result: {} })); setTimeout(() => void stop(), 50); }
        else ws.send(JSON.stringify({ id: msg.id, result: {} }));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  chrome.port = (server.address() as net.AddressInfo).port;
  chrome.stop = stop;
  return chrome;
}
