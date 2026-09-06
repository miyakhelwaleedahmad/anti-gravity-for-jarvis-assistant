/**
 * tests/plannerDesktopToolSelectionTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification test for planner tool selection and deterministic routing.
 * Ensures desktop launch commands ALWAYS map to desktop automation (open_app)
 * and NEVER map to web_search.
 *
 * Commands tested:
 *   1. "Open WhatsApp"
 *   2. "Open YouTube"
 *   3. "Open Chrome"
 *   4. "Open Calculator"
 *   5. "Open VS Code"
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
  console.log('\n=== Planner Desktop Tool Selection Test ===\n');

  // Register tools so open_app is available
  registerAllTools();
  const skillsDir = path.join(__dirname, '..', 'skills');
  const loader = new SkillLoader(skillsDir);
  await loader.loadSkills();

  const TEST_COMMANDS: Array<{ input: string; expectedTarget: string }> = [
    { input: 'Open WhatsApp',   expectedTarget: 'whatsapp' },
    { input: 'Open YouTube',    expectedTarget: 'youtube' },
    { input: 'Open Chrome',     expectedTarget: 'chrome' },
    { input: 'Open Calculator', expectedTarget: 'calculator' },
    { input: 'Open VS Code',    expectedTarget: 'vscode' },
  ];

  console.log('--- Section 1: Deterministic Fast-Path Router ---');
  for (const { input, expectedTarget } of TEST_COMMANDS) {
    const route = orchestrator.matchDeterministicCommand(input);
    assert(route !== null, `"${input}" matched deterministic route`);
    assert(route?.type === 'open_app', `"${input}" route.type is "open_app" (got: ${route?.type})`);
    assert(route?.target === expectedTarget, `"${input}" route.target is "${expectedTarget}" (got: ${route?.target})`);
  }

  console.log('\n--- Section 2: Candidate Tool Selection Heuristic ---');
  for (const { input } of TEST_COMMANDS) {
    // Access private selectPlanningToolNames via any
    const selectedTools: string[] = (orchestrator as any).selectPlanningToolNames(input);
    assert(selectedTools.includes('open_app'), `"${input}" candidate tools includes "open_app"`);
    assert(!selectedTools.includes('web_search'), `"${input}" candidate tools NEVER includes "web_search"`);
    assert(selectedTools[0] === 'open_app', `"${input}" open_app is ranked #1 tool (got: ${selectedTools[0]})`);
  }

  console.log('\n--- Section 3: open_app Execution (Dry-Run Mode) ---');
  for (const { expectedTarget } of TEST_COMMANDS) {
    try {
      const result = await toolRegistryV2.execute('open_app', { target: expectedTarget, dryRun: true });
      assert(result.success === true, `open_app execution for "${expectedTarget}" succeeded`);
      const parsed = JSON.parse(result.output);
      assert(!!parsed.resolvedTarget, `"${expectedTarget}" resolved target exists (got: ${parsed.resolvedTarget})`);
      console.log(`    [open_app] target="${expectedTarget}" -> resolved="${parsed.resolvedTarget}"`);
    } catch (err) {
      assert(false, `open_app execution for "${expectedTarget}" threw error: ${err}`);
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('❌ Planner desktop tool selection tests FAILED.');
    process.exit(1);
  } else {
    console.log('✅ All 5 desktop command tool selection tests PASSED.');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('[PlannerDesktopTest] Unexpected error:', err);
  process.exit(1);
});
