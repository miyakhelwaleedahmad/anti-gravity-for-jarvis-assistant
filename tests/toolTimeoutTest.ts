/**
 * tests/toolTimeoutTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * REL-01: a tool that does not end must not hold every later risky action.
 *
 *   - runProcess() stops a process and the child it started (a process tree)
 *     on abort and on its own timeout, and says which
 *   - through the registry: a high-risk tool running a process that never ends
 *     is stopped at its budget, returns a timeout (not a success), and is not
 *     retried; a quick medium-risk call queued behind it finishes soon after,
 *     not when the first one would have ended
 *   - a tool that ignores its signal: the call ends after the stop grace, the
 *     next queued call runs, and the sandbox slot stays taken until it ends
 *   - Windows only: control_system shell with a long command is stopped with
 *     its process tree (taskkill /T)
 *
 * Every process here is a node one-liner started by the test, and is killed
 * at the end whatever happens.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tool-timeout-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_TOOL_BUDGET_HIGH_MS'] = '800';
process.env['JARVIS_TOOL_STOP_GRACE_MS'] = '700';

const { runProcess, killTree } = await import('../system/processRunner.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { toolExecutionSandbox } = await import('../core/toolExecutionSandbox.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  // A killed process whose parent is gone waits as a zombie until init reaps
  // it (not every container's init does): it runs nothing.
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};
const started: number[] = [];

// A parent that starts a child, prints both pids, and both never end.
const TREE = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(process.pid+' '+c.pid);setInterval(()=>{},1000);`;
async function pidsOf(file: string): Promise<number[]> {
  for (let i = 0; i < 100; i++) {
    const t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (/^\d+ \d+$/.test(t)) return t.split(' ').map(Number);
    await sleep(50);
  }
  return [];
}
const treeScript = (out: string) => TREE.replace("console.log(process.pid+' '+c.pid)", `require('fs').writeFileSync(${JSON.stringify(out)},process.pid+' '+c.pid)`);

console.log('\n=== Tool timeouts (REL-01) ===\n');
try {
  console.log('--- 1. runProcess stops the whole tree ---');
  {
    const out = path.join(workspace, 'tree1.txt');
    const ac = new AbortController();
    const t0 = Date.now();
    const run = runProcess(process.execPath, ['-e', treeScript(out)], { signal: ac.signal });
    const pids = await pidsOf(out);
    started.push(...pids);
    ok('(setup) parent and child are running', pids.length === 2 && pids.every(alive), pids.join(' '));
    ac.abort();
    const r = await run;
    await sleep(300);
    ok('abort: it resolves, marked cancelled', r.cancelled && !r.timedOut, `${Date.now() - t0} ms`);
    ok('…and the parent and its child are both gone', pids.length === 2 && pids.every((p) => !alive(p)), pids.map((p) => `${p}:${alive(p)}`).join(' '));
  }
  {
    const out = path.join(workspace, 'tree2.txt');
    const t0 = Date.now();
    const r = await runProcess(process.execPath, ['-e', treeScript(out)], { timeoutMs: 600 });
    const pids = await pidsOf(out);
    started.push(...pids);
    await sleep(300);
    ok('timeout: marked timedOut, within a few seconds', r.timedOut && Date.now() - t0 < 5_000, `${Date.now() - t0} ms`);
    ok('…and the tree is gone', pids.length === 2 && pids.every((p) => !alive(p)));
  }
  {
    const r = await runProcess(process.execPath, ['-e', 'process.stdout.write("hi")']);
    ok('a process that ends is untouched: its output, exit code 0', r.stdout === 'hi' && r.exitCode === 0 && !r.cancelled && !r.timedOut);
  }

  console.log('\n--- 2. Through the registry: a never-ending high-risk tool and a quick call behind it ---');
  let slowRuns = 0;
  const slowOut = path.join(workspace, 'slow.txt');
  toolRegistryV2.register({
    name: 'test_never_ends',
    description: 'Stand-in high-risk tool whose process never ends.',
    riskLevel: 'high',
    meta: { category: 'SYSTEM', risk: 1, reversible: 'no', external: 'none', effect: 'Runs a process.', output: { format: 'text', description: 'Text' } },
    inputSchema: {},
    fallbacks: [],
    async execute(_args: Record<string, unknown>, signal?: AbortSignal) {
      slowRuns++;
      const r = await runProcess(process.execPath, ['-e', treeScript(slowOut)], { signal });
      if (r.cancelled || r.timedOut) throw new Error('TIMEOUT: the process was stopped');
      return 'finished';
    },
  } as any);
  toolRegistryV2.register({
    name: 'test_quick_medium',
    description: 'Stand-in quick medium-risk tool.',
    riskLevel: 'medium',
    meta: { category: 'SYSTEM', risk: 1, reversible: 'yes', external: 'none', effect: 'Returns at once.', output: { format: 'text', description: 'Text' } },
    inputSchema: {},
    fallbacks: [],
    async execute() { return 'quick done'; },
  } as any);

  const t0 = Date.now();
  const slow = toolRegistryV2.execute('test_never_ends', {});
  await sleep(50);
  const quick = toolRegistryV2.execute('test_quick_medium', {});
  const quickResult = await quick;
  const quickMs = Date.now() - t0;
  const slowResult = await slow;
  const pids = await pidsOf(slowOut);
  started.push(...pids);
  await sleep(300);
  ok('the never-ending tool ends as a failure that says it timed out', !slowResult.success && /TIMEOUT/.test(slowResult.output), slowResult.output.slice(0, 120));
  ok('…its process tree is gone', pids.length === 2 && pids.every((p) => !alive(p)), pids.join(' '));
  ok('…and it ran once (a stopped effectful call is not retried)', slowRuns === 1, `${slowRuns} run(s)`);
  ok('the quick call queued behind it finished within budget + a little, not after 40 s', quickResult.success && quickMs < 4_000, `${quickMs} ms`);

  console.log('\n--- 3. A tool that ignores its signal ---');
  let release: () => void = () => undefined;
  toolRegistryV2.register({
    name: 'test_ignores_signal',
    description: 'Stand-in tool that ignores its abort signal.',
    riskLevel: 'high',
    meta: { category: 'SYSTEM', risk: 1, reversible: 'no', external: 'none', effect: 'Waits.', output: { format: 'text', description: 'Text' } },
    inputSchema: {},
    fallbacks: [],
    async execute() { await new Promise<void>((r) => { release = r; }); return 'late'; },
  } as any);
  const t1 = Date.now();
  const stuck = toolRegistryV2.execute('test_ignores_signal', {});
  const after = toolRegistryV2.execute('test_quick_medium', {});
  const stuckResult = await stuck;
  const afterResult = await after;
  ok('the call ends after budget + grace, as a timeout that says it did not stop', !stuckResult.success && /did not stop/.test(stuckResult.output) && Date.now() - t1 < 4_000,
    `${Date.now() - t1} ms: ${stuckResult.output.slice(0, 100)}`);
  ok('the next queued call runs', afterResult.success);
  ok('the sandbox still counts the stuck tool until it really ends', toolExecutionSandbox.getActiveCounts().high === 1, JSON.stringify(toolExecutionSandbox.getActiveCounts()));
  release();
  await sleep(50);
  ok('…and frees the slot when it does', toolExecutionSandbox.getActiveCounts().high === 0, JSON.stringify(toolExecutionSandbox.getActiveCounts()));

  console.log('\n--- 4. Windows: control_system shell is stopped with its tree ---');
  if (process.platform !== 'win32') {
    console.log('  (skipped here: needs cmd.exe; runs on Windows)');
  } else {
    const { permissionSession } = await import('../control/permissionSession.js');
    const { approvalGate } = await import('../security/approvalGate.js');
    (approvalGate as any).requestApproval = async () => true;
    permissionSession.activateFullControl(5, 'cli');
    const { pcControlKernel } = await import('../control/pcControlKernel.js');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1_000);
    const t2 = Date.now();
    // ping -n 30 ends by itself after ~30 s, so nothing is left behind even if stopping fails.
    const res: any = await pcControlKernel.runShellCommand('ping -n 30 127.0.0.1', ac.signal);
    ok('a 30-second command is stopped after ~1 s, reported as not a success', !res.success && Date.now() - t2 < 8_000, `${Date.now() - t2} ms: ${String(res.error ?? res.message).slice(0, 120)}`);
    permissionSession.deactivateFullControl('test');
  }
} finally {
  for (const p of started) await killTree(p);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
