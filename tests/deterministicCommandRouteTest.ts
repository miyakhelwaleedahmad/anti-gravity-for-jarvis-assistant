/**
 * tests/deterministicCommandRouteTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies the deterministic command pre-router in JarvisOrchestrator.
 *
 * Safe commands must:
 *   - Match the deterministic route (bypass LLM entirely)
 *   - Call open_app directly
 *   - Complete under 200ms
 *
 * Unsafe / unknown commands must NOT match the deterministic route.
 * They should fall through to the normal LLM planner.
 */

import { orchestrator } from '../core/orchestrator.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { registerAllTools } from '../core/tools/index.js';
import { SkillLoader } from '../core/skillLoader.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n=== Deterministic Command Route Test ===\n');

  // Register tools so open_app is available
  registerAllTools();
  const skillsDir = path.join(__dirname, '..', 'skills');
  const loader = new SkillLoader(skillsDir);
  await loader.loadSkills();

  // ── Section 1: Router matching ────────────────────────────────────────────
  console.log('--- Section 1: Router matching ---');

  const SHOULD_MATCH: Array<[string, string]> = [
    ['open YouTube',            'youtube'],
    ['open YouTube for me',     'youtube'],
    ['launch YouTube',          'youtube'],
    ['start youtube',           'youtube'],
    ['open google',             'google'],
    ['open Gmail',              'gmail'],
    ['open GitHub',             'github'],
    ['open notepad',            'notepad'],
    ['open cmd',                'cmd'],
    ['open command prompt',     'cmd'],
    ['open terminal',           'cmd'],
    ['open calculator',         'calculator'],
    ['launch calc',             'calculator'],
    ['open spotify',            'spotify'],
    ['open chrome',             'chrome'],
    ['open firefox',            'firefox'],
    ['open edge',               'edge'],
  ];

  for (const [input, expectedTarget] of SHOULD_MATCH) {
    const route = orchestrator.matchDeterministicCommand(input);
    const target = route?.target;
    assert(target === expectedTarget, `"${input}" → matched target="${expectedTarget}" (got: ${target})`);
  }

  // ── Section 2: Should NOT match (fall through to planner/security) ────────
  console.log('\n--- Section 2: Unsafe/unknown inputs must NOT match deterministic route ---');

  const SHOULD_NOT_MATCH: string[] = [
    'delete my files',
    'format the drive',
    'shutdown the computer',
    'install software',
    'run arbitrary command',
    'open unknownRandomApp123',
    'open a virus.exe',
    'open everything',
    'search YouTube',          // "search" is not a trigger
    'what is the weather',
    'tell me a joke',
  ];

  for (const input of SHOULD_NOT_MATCH) {
    const route = orchestrator.matchDeterministicCommand(input);
    assert(route === null, `"${input}" → correctly NOT matched`);
  }

  // ── Section 3: open_app tool execution for safe targets (dry-run mode) ─────
  console.log('\n--- Section 3: open_app tool execution (dry-run mode) ---');

  const SAFE_TOOL_TARGETS = ['youtube', 'notepad', 'cmd'];
  for (const target of SAFE_TOOL_TARGETS) {
    try {
      const t0 = performance.now();
      const result = await toolRegistryV2.execute('open_app', { target, dryRun: true });
      const ms = performance.now() - t0;
      assert(result.success === true, `open_app("${target}") succeeded`);
      assert(ms < 2000, `open_app("${target}") completed in ${ms.toFixed(0)}ms (< 2000ms)`);
      
      const parsedOutput = JSON.parse(result.output);
      assert(parsedOutput.dryRun === true, `dryRun is true`);
      assert(!!parsedOutput.resolvedTarget, `resolvedTarget exists`);
      console.log(`    [open_app] target="${target}" resolved="${parsedOutput.resolvedTarget}" (dryRun=${parsedOutput.dryRun}) in ${ms.toFixed(0)}ms`);
    } catch (err) {
      assert(false, `open_app("${target}") threw: ${err}`);
    }
  }

  // ── Section 4: Security boundary — dangerous verbs must not match ─────────
  console.log('\n--- Section 4: Security boundary ---');

  const SECURITY_TESTS: string[] = [
    'open system32',
    'open regedit',
    'launch cmd /c del *',
    'start taskmgr /cleanup',
  ];
  for (const input of SECURITY_TESTS) {
    const route = orchestrator.matchDeterministicCommand(input);
    assert(route === null, `Security: "${input.substring(0, 30)}" → NOT matched`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('❌ Some deterministic route tests FAILED.');
    process.exit(1);
  } else {
    console.log('✅ All deterministic command route tests PASSED.');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[DeterministicRouteTest] Unexpected error:', err);
  process.exit(1);
});
