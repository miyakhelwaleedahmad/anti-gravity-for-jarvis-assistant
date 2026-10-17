/**
 * tests/runAll.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs every test file and prints one pass/fail census (JARVIS-025).
 *
 * `npm test` was `echo "Error: no test specified" && exit 1`, and the two
 * existing scripts were long `&&` chains that stop at the first failure, so
 * there was no way to see the whole picture in one command.
 *
 * This runner does NOT rewrite any existing test — each file is still executed
 * exactly as before, as its own `tsx` process, and its exit code is the verdict.
 *
 * Usage:
 *   npm test                  all tests
 *   npm test -- --ci          skips tests whose prerequisite this host lacks
 *                             (Windows/Redis/venv/network; on Windows the
 *                             Windows-only tests are not skipped)
 *   npm test -- --filter=tool only tests whose name contains "tool"
 *   npm test -- --only=a,b    exactly the tests named (an unknown name is an
 *                             error); package.json's test:* scripts use it, so
 *                             each test still gets its own data folder
 *   npm test -- --live        also the live-provider tests (pnpm test:live):
 *                             they need an API key and the network and act on
 *                             this PC, so every other run skips them
 *
 * Verdicts: pass · fail · timeout (stopped at JARVIS_TEST_TIMEOUT_MS) ·
 * blocked (the test found its environment unavailable: exit code 3 and a
 * "BLOCKED: <reason>" line; never a pass) · skipped (a prerequisite this host
 * is checked to lack, a live test not asked for, or --ci) · environment (failed
 * where a listed prerequisite was not checked here).
 */

import { spawn } from 'child_process';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as net from 'net';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { getWorkspaceRoot, isProtectedSystemPath } from '../core/workspaceRoot.js';
import { findChromium, findPwsh, pwshMissingReason } from './chromeHelper.js';

/**
 * The tests' temp folder. On Windows the user's temp folder is under AppData,
 * which JARVIS treats as a system folder, so every test that works in a temp
 * folder was refused there (on the owner's PC, 10 of them). The tests, and
 * this runner, then use a folder of their own in the home folder; JARVIS's own
 * rules are unchanged. Folders older than a day left by an earlier run (a file
 * still in use when a test ended) are removed.
 */
function useTestTempFolder(): string | undefined {
  if (!isProtectedSystemPath(os.tmpdir())) return undefined;
  const root = path.join(os.homedir(), '.jarvis-test-tmp');
  fs.mkdirSync(root, { recursive: true });
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3_600_000) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* still in use */ }
  }
  // os.tmpdir() reads these on every call, here and in each test process.
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = root;
  return root;
}

/**
 * Tests that need something this repository cannot provide on its own.
 * They are not failures of the code — they are missing prerequisites — so `--ci`
 * skips them rather than letting a CI run go permanently red.
 */
const ENVIRONMENT_DEPENDENT: Record<string, string> = {
  // It asserts the overall status is "online", which needs a live LLM health
  // check and Redis, not only Windows (Windows CI: "offline" without keys).
  dashboardHealthSystemTest: 'Windows PowerShell, a reachable LLM API and Redis',
  processControlSafetyTest: 'Windows process table',
  windowControlTest: 'Windows window manager',
  sttReliabilityTest: 'Python virtualenv (.venv)',
  // Overall "online" also needs the live LLM health check (not stubbed).
  dashboardAccuracyTest: 'a running Redis and a reachable LLM API',
  startupPerformanceTest: 'JARVIS_BRIDGE_TOKEN',
  finalIntegrationSuiteTest: 'a reachable LLM API',
  successfulExecutionLifecycleAuditTest: 'a reachable LLM API',
};

/**
 * The prerequisites above that Windows itself provides. On a Windows host these
 * tests run in every mode and a failure counts as real: excusing it there would
 * hide exactly the failures a Windows run exists to find.
 */
const PROVIDED_BY_WINDOWS = new Set(['processControlSafetyTest', 'windowControlTest']);

/** Tests that need something only some hosts have: checked on this host. */
const HOST_DEPENDENT: Record<string, () => string | undefined> = {
  browserObservationTest: () => (findChromium() ? undefined : 'Chromium or Chrome (JARVIS_TEST_CHROME)'),
  browserControlAgentTest: () => (findChromium() ? undefined : 'Chromium or Chrome (JARVIS_TEST_CHROME)'),
  errorRecoveryTest: () => (findChromium() ? undefined : 'Chromium or Chrome (JARVIS_TEST_CHROME)'),
  scenarioIntegrationTest: () => (findChromium() ? undefined : 'Chromium or Chrome (JARVIS_TEST_CHROME)'),
  desktopControlTest: () => (findChromium() ? undefined : 'Chromium or Chrome (JARVIS_TEST_CHROME)'),
  windowsScriptsTest: () => (findPwsh() ? undefined : `PowerShell 7, pwsh (JARVIS_TEST_PWSH). ${pwshMissingReason()}`),
};

/**
 * Prerequisites checked on this host before the run (owner's PC: Redis was
 * running, yet a dashboardAccuracyTest failure was excused as "needs a running
 * Redis"). When the prerequisite is here, a failure counts as real.
 */
const presentHere = new Set<string>();

function portAnswers(host: string, port: number, ms = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (up: boolean) => { socket.destroy(); resolve(up); };
    socket.setTimeout(ms, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function checkPrerequisites(): Promise<void> {
  // Keys usually live in .env, which the tests load themselves; read it here
  // only to see which are set (process.env is not changed).
  let fromFile: Record<string, string> = {};
  try { fromFile = dotenv.parse(fs.readFileSync(path.join(getWorkspaceRoot(), '.env'))); } catch { /* no .env */ }
  const has = (k: string) => !!(process.env[k] || fromFile[k]);
  const redisUp = await portAnswers(process.env['REDIS_HOST'] || fromFile['REDIS_HOST'] || '127.0.0.1', Number(process.env['REDIS_PORT'] || fromFile['REDIS_PORT'] || 6379));
  const llmKey = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'].some(has);
  if (redisUp && llmKey) presentHere.add('dashboardAccuracyTest');
  if (fs.existsSync(path.join(getWorkspaceRoot(), '.venv'))) presentHere.add('sttReliabilityTest');
  if (has('JARVIS_BRIDGE_TOKEN')) presentHere.add('startupPerformanceTest');
  if (process.platform === 'win32' && redisUp && llmKey) presentHere.add('dashboardHealthSystemTest');
}

/** What `name` needs that this host is missing, or undefined if nothing is. */
function missingPrerequisite(name: string): string | undefined {
  if (process.platform === 'win32' && PROVIDED_BY_WINDOWS.has(name)) return undefined;
  if (presentHere.has(name)) return undefined;
  // Live provider tests run only when asked (TEST-01): they need keys, cost
  // requests and depend on the network, so they are never on by default.
  if (ENVIRONMENT_DEPENDENT[name] === 'a reachable LLM API' && process.env['JARVIS_LIVE_TESTS'] === '1') return undefined;
  if (name === 'dashboardHealthSystemTest' && process.platform === 'win32' && process.env['JARVIS_LIVE_TESTS'] === '1') return undefined;
  return ENVIRONMENT_DEPENDENT[name] ?? HOST_DEPENDENT[name]?.();
}

/**
 * tsx's CLI from this project's own dependencies. Each test is started as
 * `node <tsx cli> <file>` rather than `npx tsx <file>`: on Windows `npx` is the
 * `npx.cmd` shim, which spawn() cannot start without a shell, so the runner
 * died there before running a single test.
 */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/** Not a test — a helper imported by other tests. */
const NOT_A_TEST = new Set(['toolAuditHelper', 'runAll', 'chromeHelper', 'fakeTts', 'replyChecks', 'livePreflight', 'ttsBridgeClient']);

const TIMEOUT_MS = Number(process.env['JARVIS_TEST_TIMEOUT_MS'] ?? 120_000);
/**
 * Tests that do a lot of real work get their own limit (REL-101). Measured on
 * the owner's PC: finalIntegrationSuiteTest 104 s (twelve live commands),
 * windowsScriptsTest 88.6 s (real PowerShell scripts), both close to 120 s.
 * Each limit is about 2.5x its measured time; the rest keep TIMEOUT_MS.
 */
const SLOW_TEST_LIMIT_MS: Record<string, number> = {
  finalIntegrationSuiteTest: 270_000,
  windowsScriptsTest: 240_000,
};
const timeLimitFor = (name: string): number => Math.max(TIMEOUT_MS, SLOW_TEST_LIMIT_MS[name] ?? 0);
/** The exit code a test uses for "my environment is not available" (with a BLOCKED: line). */
const BLOCKED_EXIT = 3;

/** Tests that call the real LLM provider (and act on this PC): run only with --live. */
function isLiveProviderTest(name: string): boolean {
  return ENVIRONMENT_DEPENDENT[name] === 'a reachable LLM API';
}
const LIVE_HINT = 'live provider test: run it with pnpm test:live (needs an API key and the network; acts on this PC)';

interface Result {
  name: string;
  status: 'pass' | 'fail' | 'timeout' | 'blocked' | 'skipped';
  ms: number;
  reason?: string;
  /** For a failure: its FAIL lines and last lines, so a CI log shows what broke. */
  detail?: string[];
}

/**
 * Each test gets its own empty data folder (JARVIS_DATA_ROOT, and the vector
 * store), removed afterwards. Tests used to write into the real
 * memory/jarvis_memory.json, data/runtime/goals.json, the saved permission
 * session and the audit logs.
 */
function makeDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-data-'));
  for (const dir of ['memory', path.join('data', 'logs'), 'logs']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

function removeDataRoot(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* a file still open on Windows */ }
}

function runOne(file: string, name: string): Promise<Result> {
  return new Promise((resolve) => {
    const started = Date.now();
    const dataRoot = makeDataRoot();
    const child = spawn(process.execPath, [TSX_CLI, file], {
      cwd: getWorkspaceRoot(),
      env: { ...process.env, JARVIS_DATA_ROOT: dataRoot, JARVIS_VECTOR_STORE_DIR: path.join(dataRoot, 'data', 'vector') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { output += d.toString(); });

    const limitMs = timeLimitFor(name);
    const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);

    // Without a listener, a process that cannot be started raises an unhandled
    // 'error' event that kills the runner instead of failing this one test.
    child.on('error', (err) => {
      clearTimeout(timer);
      removeDataRoot(dataRoot);
      resolve({ name, status: 'fail', ms: Date.now() - started, reason: `could not start: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      removeDataRoot(dataRoot);
      const ms = Date.now() - started;
      if (signal === 'SIGKILL') {
        // Whether the checks finished (a results line) tells a test that hung
        // after its last check (a connection or child process still open)
        // from one still working when it was stopped.
        const lines = output.split('\n').filter((l) => l.trim());
        const results = lines.filter((l) => /=== .*(passed|Results)|BENCHMARK SUMMARY/.test(l)).slice(-1)[0];
        const detail = [
          `  stopped at its time limit, ${limitMs >= 1000 ? `${Math.round(limitMs / 1000)} s` : `${limitMs} ms`}`,
          results ? `  the checks finished (${results.trim().slice(0, 120)}) but the process did not exit` : '  stopped while still running its checks; its last lines:',
          ...lines.filter((l) => /^\s*(FAIL|✗|❌)/.test(l)).slice(0, 20),
          ...lines.slice(-10),
        ].map((l) => l.slice(0, 300));
        resolve({ name, status: 'timeout', ms, detail });
      } else if (code === 0) {
        resolve({ name, status: 'pass', ms });
      } else if (code === BLOCKED_EXIT && /^BLOCKED: /m.test(output)) {
        resolve({ name, status: 'blocked', ms, reason: /^BLOCKED: (.*)$/m.exec(output)![1]!.trim().slice(0, 200) });
      } else {
        const lines = output.split('\n');
        const lastMeaningful = lines
          .filter((l) => /FAIL|Error|error:/i.test(l))
          .slice(-1)[0];
        // The failing checks and the end of the output; the rest of a test's
        // output is not kept, which left CI failures impossible to read.
        const failLines = lines.filter((l) => /^\s*(FAIL|✗|❌)/.test(l)).slice(0, 40);
        // JARVIS_TEST_FULL_OUTPUT=1 (set in CI): the failed checks, then the
        // last 400 lines of the output, for failures that cannot be rerun
        // locally (the failed checks can come before those 400 lines).
        const full = process.env['JARVIS_TEST_FULL_OUTPUT'] === '1';
        const detail = full
          ? [...failLines, '  … last lines:', ...lines.filter((l) => l.trim()).slice(-400)].map((l) => l.slice(0, 300))
          : [...failLines, '  …', ...lines.filter((l) => l.trim()).slice(-15)].map((l) => l.slice(0, 300));
        resolve({ name, status: 'fail', ms, detail, ...(lastMeaningful ? { reason: lastMeaningful.trim().slice(0, 160) } : {}) });
      }
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ciMode = args.includes('--ci');
  const filterArg = args.find((a) => a.startsWith('--filter='));
  const filter = filterArg ? filterArg.split('=')[1] ?? '' : '';
  // Set before anything reads it: the tests run as children of this process.
  if (args.includes('--live')) process.env['JARVIS_LIVE_TESTS'] = '1';
  const liveOn = process.env['JARVIS_LIVE_TESTS'] === '1';
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((n) => n.trim()).filter(Boolean)) : undefined;
  await checkPrerequisites();
  const tempFolder = useTestTempFolder();
  if (tempFolder) console.log(`Temp folder for the tests: ${tempFolder} (this PC's temp folder is one JARVIS refuses as a system folder; on Windows it is under AppData).`);

  const testsDir = path.join(getWorkspaceRoot(), 'tests');
  const files = fs
    .readdirSync(testsDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: path.join(testsDir, f), name: path.basename(f, '.ts') }))
    .filter(({ name }) => !NOT_A_TEST.has(name))
    .filter(({ name }) => !filter || name.toLowerCase().includes(filter.toLowerCase()))
    .filter(({ name }) => !only || only.has(name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (only) {
    const unknown = [...only].filter((name) => !files.some((f) => f.name === name));
    if (unknown.length > 0) {
      console.error(`No test file named: ${unknown.join(', ')} (in tests/).`);
      process.exit(1);
    }
  }

  console.log(`\n=== JARVIS test suite — ${files.length} file(s)${ciMode ? ' (CI mode)' : ''} ===\n`);

  const results: Result[] = [];
  for (const { file, name } of files) {
    const needs = missingPrerequisite(name);
    if (isLiveProviderTest(name) && !liveOn) {
      results.push({ name, status: 'skipped', ms: 0, reason: LIVE_HINT });
      console.log(`  SKIP  ${name.padEnd(44)} ${LIVE_HINT}`);
      continue;
    }
    // A prerequisite checked on this host and found missing: running the test
    // would only show that again (windowsScriptsTest without PowerShell 7).
    const hostMissing = HOST_DEPENDENT[name]?.();
    if (hostMissing && !(process.platform === 'win32' && PROVIDED_BY_WINDOWS.has(name))) {
      results.push({ name, status: 'skipped', ms: 0, reason: `needs ${hostMissing}` });
      console.log(`  SKIP  ${name.padEnd(44)} needs ${hostMissing} (not found on this host)`);
      continue;
    }
    if (ciMode && needs) {
      results.push({ name, status: 'skipped', ms: 0, reason: `needs ${needs}` });
      console.log(`  SKIP  ${name.padEnd(44)} needs ${needs}`);
      continue;
    }
    const result = await runOne(file, name);
    results.push(result);
    const label = result.status.toUpperCase().padEnd(7);
    const note = result.status === 'blocked' ? `  (${result.reason})` : result.status === 'fail' && needs ? `  (expected here: needs ${needs})` : '';
    console.log(`  ${label} ${name.padEnd(44)} ${result.ms}ms${note}`);
  }

  const passed = results.filter((r) => r.status === 'pass');
  const skipped = results.filter((r) => r.status === 'skipped');
  const blocked = results.filter((r) => r.status === 'blocked');
  const failed = results.filter((r) => r.status === 'fail' || r.status === 'timeout');
  const envFailures = failed.filter((r) => missingPrerequisite(r.name));
  const realFailures = failed.filter((r) => !missingPrerequisite(r.name));
  const timedOut = realFailures.filter((r) => r.status === 'timeout');

  console.log(`\n=== ${passed.length} passed · ${realFailures.length - timedOut.length} failed · ${timedOut.length} timed out · ${blocked.length} blocked · ${envFailures.length} environment · ${skipped.length} skipped ===`);

  const why = new Map<string, string[]>();
  for (const r of skipped) why.set(r.reason ?? 'skipped', [...(why.get(r.reason ?? 'skipped') ?? []), r.name]);
  if (skipped.length) {
    console.log('\nSkipped (not run, so not passed):');
    for (const [reason, names] of why) console.log(`  - ${names.join(', ')}: ${reason}`);
  }
  if (blocked.length) {
    console.log('\nBlocked, not verified (the environment the test needs was not available):');
    for (const r of blocked) console.log(`  - ${r.name}: ${r.reason}`);
  }

  if (envFailures.length) {
    console.log('\nFailed for a missing prerequisite, not a defect:');
    for (const r of envFailures) console.log(`  - ${r.name} (needs ${missingPrerequisite(r.name)})`);
  }

  if (realFailures.length) {
    console.log('\nReal failures:');
    for (const r of realFailures) {
      console.log(`  - ${r.name}${r.reason ? `: ${r.reason}` : ''}`);
      for (const l of r.detail ?? []) console.log(`      ${l}`);
    }
    process.exit(1);
  }
  if (blocked.length) {
    console.log('\nNo failures, but the blocked tests above were not verified.');
    process.exit(1);
  }

  console.log('\nNo unexpected failures.');
  process.exit(0);
}

await main();
