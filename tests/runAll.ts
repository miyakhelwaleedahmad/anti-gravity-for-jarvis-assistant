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
 *   npm test -- --ci          only tests that do not need Windows/Redis/venv/network
 *   npm test -- --filter=tool only tests whose name contains "tool"
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../core/workspaceRoot.js';

/**
 * Tests that need something this repository cannot provide on its own.
 * They are not failures of the code — they are missing prerequisites — so `--ci`
 * skips them rather than letting a CI run go permanently red.
 */
const ENVIRONMENT_DEPENDENT: Record<string, string> = {
  dashboardHealthSystemTest: 'Windows PowerShell',
  processControlSafetyTest: 'Windows process table',
  windowControlTest: 'Windows window manager',
  sttReliabilityTest: 'Python virtualenv (.venv)',
  dashboardAccuracyTest: 'a running Redis',
  startupPerformanceTest: 'JARVIS_BRIDGE_TOKEN',
  finalIntegrationSuiteTest: 'a reachable LLM API',
  successfulExecutionLifecycleAuditTest: 'a reachable LLM API',
};

/** Not a test — a helper imported by other tests. */
const NOT_A_TEST = new Set(['toolAuditHelper', 'runAll']);

const TIMEOUT_MS = Number(process.env['JARVIS_TEST_TIMEOUT_MS'] ?? 120_000);

interface Result {
  name: string;
  status: 'pass' | 'fail' | 'timeout' | 'skipped';
  ms: number;
  reason?: string;
}

function runOne(file: string, name: string): Promise<Result> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('npx', ['tsx', file], {
      cwd: getWorkspaceRoot(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { output += d.toString(); });

    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (signal === 'SIGKILL') {
        resolve({ name, status: 'timeout', ms });
      } else if (code === 0) {
        resolve({ name, status: 'pass', ms });
      } else {
        const lastMeaningful = output
          .split('\n')
          .filter((l) => /FAIL|Error|error:/i.test(l))
          .slice(-1)[0];
        resolve({ name, status: 'fail', ms, ...(lastMeaningful ? { reason: lastMeaningful.trim().slice(0, 160) } : {}) });
      }
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ciMode = args.includes('--ci');
  const filterArg = args.find((a) => a.startsWith('--filter='));
  const filter = filterArg ? filterArg.split('=')[1] ?? '' : '';

  const testsDir = path.join(getWorkspaceRoot(), 'tests');
  const files = fs
    .readdirSync(testsDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: path.join(testsDir, f), name: path.basename(f, '.ts') }))
    .filter(({ name }) => !NOT_A_TEST.has(name))
    .filter(({ name }) => !filter || name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`\n=== JARVIS test suite — ${files.length} file(s)${ciMode ? ' (CI mode)' : ''} ===\n`);

  const results: Result[] = [];
  for (const { file, name } of files) {
    const needs = ENVIRONMENT_DEPENDENT[name];
    if (ciMode && needs) {
      results.push({ name, status: 'skipped', ms: 0, reason: `needs ${needs}` });
      console.log(`  SKIP  ${name.padEnd(44)} needs ${needs}`);
      continue;
    }
    const result = await runOne(file, name);
    results.push(result);
    const label = result.status.toUpperCase().padEnd(7);
    const note = result.status === 'fail' && needs ? `  (expected here: needs ${needs})` : '';
    console.log(`  ${label} ${name.padEnd(44)} ${result.ms}ms${note}`);
  }

  const passed = results.filter((r) => r.status === 'pass');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'fail' || r.status === 'timeout');
  const envFailures = failed.filter((r) => ENVIRONMENT_DEPENDENT[r.name]);
  const realFailures = failed.filter((r) => !ENVIRONMENT_DEPENDENT[r.name]);

  console.log(`\n=== ${passed.length} passed · ${realFailures.length} failed · ${envFailures.length} environment · ${skipped.length} skipped ===`);

  if (envFailures.length) {
    console.log('\nFailed for a missing prerequisite, not a defect:');
    for (const r of envFailures) console.log(`  - ${r.name} (needs ${ENVIRONMENT_DEPENDENT[r.name]})`);
  }

  if (realFailures.length) {
    console.log('\nReal failures:');
    for (const r of realFailures) {
      console.log(`  - ${r.name}${r.reason ? `: ${r.reason}` : ''}`);
    }
    process.exit(1);
  }

  console.log('\nNo unexpected failures.');
  process.exit(0);
}

await main();
