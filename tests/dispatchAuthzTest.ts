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

console.log('\n--- Authorization runs before schema validation (SEC-02) ---');
{
  // A privileged tool with a required argument, so a missing argument would
  // produce a schema error if validation ran first.
  const schemaState = { bodyRan: false };
  toolRegistryV2.register({
    name: 'test_schema_tool',
    description: 'Privileged tool with a required argument.',
    riskLevel: 'high',
    requiredLevel: 2,
    inputSchema: { path: { type: 'string', description: 'required path', required: true } },
    fallbacks: [],
    async execute() {
      schemaState.bodyRan = true;
      return 'ran';
    },
  });

  permissionSession.deactivateFullControl('sec02_setup');

  // Unauthorized + invalid arguments: must be denied, and must not leak schema.
  const denied = await toolRegistryV2.execute('test_schema_tool', {});
  ok('unauthorized call with missing args returns PERMISSION_DENIED', denied.error === 'PERMISSION_DENIED', denied.error ?? '');
  ok('the denial does not reveal the argument schema',
     !/missing required argument|invalid arguments|"path"/i.test(`${denied.output} ${denied.error}`),
     denied.output.slice(0, 70));
  ok('the tool body never ran', schemaState.bodyRan === false);

  // The exact case found during validation: control_file at L0 with no `path`
  // used to answer `Missing required argument: "path"`.
  const realTool = await toolRegistryV2.execute('control_file', {});
  ok('control_file at L0 with no args returns PERMISSION_DENIED', realTool.error === 'PERMISSION_DENIED', realTool.error ?? '');

  permissionSession.activateFullControl(30, 'cli');
  try {
    // Authorized + invalid arguments: schema validation must still run.
    const invalid = await toolRegistryV2.execute('test_schema_tool', {});
    ok('authorized call with missing args still gets the schema error',
       invalid.success === false && invalid.error !== 'PERMISSION_DENIED' && /path/i.test(invalid.error ?? ''),
       invalid.error ?? '');
    ok('schema rejection still stops the body', schemaState.bodyRan === false);

    // Authorized + valid arguments: normal execution.
    const valid = await toolRegistryV2.execute('test_schema_tool', { path: 'notes.txt' });
    ok('authorized call with valid args succeeds', valid.success === true && valid.output === 'ran', valid.error ?? '');
    ok('the tool body ran', schemaState.bodyRan === true);
  } finally {
    permissionSession.deactivateFullControl('sec02_teardown');
  }

  // Tools without a floor are unaffected: schema errors still surface at L0.
  const openApp = await toolRegistryV2.execute('open_app', {});
  ok('floor-less tool at L0 still reports its schema error (not PERMISSION_DENIED)',
     openApp.error !== 'PERMISSION_DENIED' && openApp.success === false, openApp.error ?? '');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
