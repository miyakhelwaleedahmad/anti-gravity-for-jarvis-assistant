/**
 * tests/startupRegistrationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The two tool counts in the startup log (docs/PROVIDER_HEALTH_AUDIT.md §4,
 * item 18): "40" when the built-in tools register, "66" on the dashboard once
 * the skills have loaded. Two stages, not duplication: every name is unique,
 * no skill replaces a built-in tool, and registering again adds nothing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-reg-'));
process.env['JARVIS_DATA_ROOT'] = tmp;
process.env['JARVIS_WORKSPACE_ROOT'] = tmp;

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { SkillLoader } = await import('../core/skillLoader.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Startup registration ===\n');

registerAllTools();
const builtIn = toolRegistryV2.names();
registerAllTools();
ok('registering the built-in tools again adds nothing', toolRegistryV2.names().length === builtIn.length, `${builtIn.length}`);

const skillsDir = path.resolve('skills');
const loaded = await new SkillLoader(skillsDir).loadSkills();
const all = toolRegistryV2.names();
const fromSkills = all.filter((n) => !builtIn.includes(n));
ok('skills add their own tools after the built-in ones', loaded > 0 && fromSkills.length > 0, `${builtIn.length} built-in + ${fromSkills.length} from skills = ${all.length}`);
ok('every tool name is unique', new Set(all).size === all.length);
ok('the total is the two stages added, not a duplicate count', all.length === builtIn.length + fromSkills.length);

await new SkillLoader(skillsDir).loadSkills();
ok('loading the skills again adds nothing', toolRegistryV2.names().length === all.length, `${toolRegistryV2.names().length}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
