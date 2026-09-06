/**
 * tests/systemStateRouteTest.ts
 * Verifies that system-state awareness commands are routed deterministically
 * without calling the LLM, and that the skill tools exist in the registry.
 */
import { registerAllTools } from '../core/tools/index.js';
import { SkillLoader } from '../core/skillLoader.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { JarvisOrchestrator } from '../core/orchestrator.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== System State Route Test ===\n');

// Setup
registerAllTools();
const skillsDir = path.resolve(__dirname, '..', 'skills');
const loader = new SkillLoader(skillsDir);
await loader.loadSkills();

const orchestrator = new JarvisOrchestrator();

// ── Test 1: Skill tools are registered ──────────────────────────────────────
console.log('--- Section 1: Skill tool registration ---');
const expectedTools = [
  'get_system_state', 'get_browser_tabs', 'get_active_window',
  'is_app_open', 'is_tab_open', 'get_jarvis_service_status',
  'enable_full_control_session', 'disable_full_control_session',
  'get_permission_status', 'control_app', 'control_window',
  'control_browser', 'control_file', 'control_process', 'control_system',
];
for (const tool of expectedTools) {
  ok(`Tool "${tool}" is registered`, toolRegistryV2.has(tool));
}

// ── Test 2: Deterministic routes for awareness commands ─────────────────────
console.log('\n--- Section 2: Awareness command deterministic routing ---');

type RouteCheck = { input: string; expectedType: string; expectedTarget?: string };
const awarenessRoutes: RouteCheck[] = [
  { input: 'what is open',            expectedType: 'get_system_state' },
  { input: 'what is open in chrome',  expectedType: 'get_browser_tabs' },
  { input: 'is youtube open',         expectedType: 'is_tab_open', expectedTarget: 'youtube' },
  { input: 'close youtube',           expectedType: 'close_browser_tab', expectedTarget: 'youtube' },
  { input: 'close current tab',       expectedType: 'close_current_tab' },
  { input: 'close notepad',           expectedType: 'close_app', expectedTarget: 'notepad' },
  { input: 'close current window',    expectedType: 'close_current_window' },
  { input: 'enable full control mode',expectedType: 'enable_full_control_session' },
];

for (const check of awarenessRoutes) {
  const route = orchestrator.matchDeterministicCommand(check.input);
  ok(
    `"${check.input}" → matched type="${check.expectedType}"`,
    route !== null && route.type === check.expectedType
  );
  if (check.expectedTarget && route) {
    ok(
      `"${check.input}" → target="${check.expectedTarget}"`,
      route.target === check.expectedTarget
    );
  }
}

// ── Test 3: Unsafe inputs still NOT matched ─────────────────────────────────
console.log('\n--- Section 3: Unsafe commands NOT matched deterministically ---');
const unsafeInputs = [
  'delete all my files',
  'format the disk',
  'run command rm -rf',
  'shutdown windows',
  'kill explorer',
];
for (const input of unsafeInputs) {
  const route = orchestrator.matchDeterministicCommand(input);
  ok(`"${input}" → correctly NOT matched`, route === null);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
