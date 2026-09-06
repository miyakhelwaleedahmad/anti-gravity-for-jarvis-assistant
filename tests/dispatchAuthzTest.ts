/**
 * tests/dispatchAuthzTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS-005 — authorization must be enforced at the single dispatch point, not
 * only positionally inside `control/*`.
 *
 * Also guards the three flows that a naive `riskLevel -> level` mapping would
 * have broken:
 *   - `enable_full_control_session` is riskLevel 'high' but GRANTS level 2;
 *     requiring level 2 to run it deadlocks elevation permanently.
 *   - `open_app` is 'medium' and must stay usable at the default level 0.
 *   - `run_command` is 'high' and serves allow-listed commands at level 0.
 */

import * as path from 'path';
import { toolRegistryV2, type AgentTool } from '../core/toolRegistryV2.js';
import { registerAllTools } from '../core/tools/index.js';
import { SkillLoader } from '../core/skillLoader.js';
import { permissionSession } from '../control/permissionSession.js';
import { getWorkspaceRoot } from '../core/workspaceRoot.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`);
    failed++;
  }
}

console.log('\n=== Dispatch Authorization Test ===\n');

registerAllTools();
await new SkillLoader(path.join(getWorkspaceRoot(), 'skills')).loadSkills();

permissionSession.deactivateFullControl('test_setup');
ok('baseline session level is 0', permissionSession.getCurrentLevel() === 0, `L${permissionSession.getCurrentLevel()}`);

// ── A synthetic tool that never touches control/* — the exact gap P1-04 names ──
const state = { sideEffectRan: false };
const rogue: AgentTool = {
  name: 'test_rogue_tool',
  description: 'A tool that performs a privileged action without any controller.',
  riskLevel: 'high',
  requiredLevel: 2,
  inputSchema: {},
  fallbacks: [],
  async execute() {
    state.sideEffectRan = true;
    return 'privileged side effect performed';
  },
};
toolRegistryV2.register(rogue);

console.log('\n--- A tool with no controller of its own is still gated ---');
{
  const res = await toolRegistryV2.execute('test_rogue_tool', {});
  ok('denied at dispatch', res.success === false, res.error ?? '');
  ok('error is PERMISSION_DENIED', res.error === 'PERMISSION_DENIED');
  ok('the tool body never ran', state.sideEffectRan === false);
}

console.log('\n--- Denial is not served from cache, and survives repetition ---');
{
  const res = await toolRegistryV2.execute('test_rogue_tool', {});
  ok('second call also denied', res.success === false && res.error === 'PERMISSION_DENIED');
  ok('still no side effect', state.sideEffectRan === false);
}

console.log('\n--- The same tool succeeds once the session is elevated ---');
{
  permissionSession.activateFullControl(30, 'cli');
  ok('session is now level 2', permissionSession.getCurrentLevel() === 2, `L${permissionSession.getCurrentLevel()}`);
  const res = await toolRegistryV2.execute('test_rogue_tool', {});
  ok('allowed at dispatch after elevation', res.success === true, res.error ?? '');
  ok('the tool body ran', state.sideEffectRan === true);
  permissionSession.deactivateFullControl('test_teardown');
}

console.log('\n--- Regression guards: level-0 flows must still work ---');
{
  ok('session is back to level 0', permissionSession.getCurrentLevel() === 0);

  const enableTool = toolRegistryV2.get('enable_full_control_session');
  ok('enable_full_control_session is registered', enableTool !== undefined);
  ok(
    'elevation path is NOT gated behind the level it grants (no deadlock)',
    enableTool?.requiredLevel === undefined || enableTool.requiredLevel === 0,
    `requiredLevel=${enableTool?.requiredLevel}`,
  );

  const openApp = toolRegistryV2.get('open_app');
  ok('open_app is registered', openApp !== undefined);
  ok(
    'open_app remains usable at the default level',
    openApp?.requiredLevel === undefined || openApp.requiredLevel === 0,
    `requiredLevel=${openApp?.requiredLevel}`,
  );

  const runCmd = toolRegistryV2.get('run_command');
  ok(
    'run_command remains usable at the default level',
    runCmd?.requiredLevel === undefined || runCmd.requiredLevel === 0,
    `requiredLevel=${runCmd?.requiredLevel}`,
  );
}

console.log('\n--- Declared floors never exceed what the controller enforces ---');
{
  // floor = min(level the controller ever requires); a higher floor would refuse
  // operations that work today.
  const expected: Record<string, number> = {
    control_file: 2,
    control_keyboard: 2,
    control_mouse: 2,
    control_app: 1,
    control_window: 1,
  };
  for (const [name, level] of Object.entries(expected)) {
    const t = toolRegistryV2.get(name);
    ok(`${name} declares floor L${level}`, t?.requiredLevel === level, `got ${t?.requiredLevel}`);
  }
  // These have genuine level-0 operations and must not carry a floor.
  for (const name of ['control_browser', 'control_process', 'control_system']) {
    const t = toolRegistryV2.get(name);
    ok(
      `${name} carries no floor (has level-0 operations)`,
      t?.requiredLevel === undefined || t.requiredLevel === 0,
      `got ${t?.requiredLevel}`,
    );
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
