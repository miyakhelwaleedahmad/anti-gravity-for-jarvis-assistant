/**
 * tests/toolNameListsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-06: the orchestrator's special tool lists had drifted from the real
 * tools (13 of 28 and 29 of 36 names did not exist). Every name the lists
 * hold must be a registered tool; a rename now fails here instead of quietly
 * changing which plans skip reflection or synthesis.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tool-names-'));
process.env['JARVIS_DATA_ROOT'] = root;

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { LOW_RISK_TOOLS, SIMPLE_REPLY_TOOLS } = await import('../core/toolNameLists.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();

console.log('\n=== Tool names the orchestrator lists (ARCH-06) ===\n');
for (const [label, list] of [['LOW_RISK_TOOLS', LOW_RISK_TOOLS], ['SIMPLE_REPLY_TOOLS', SIMPLE_REPLY_TOOLS]] as const) {
  const missing = list.filter((n) => !toolRegistryV2.get(n));
  ok(`${label}: every name is a registered tool`, missing.length === 0, missing.join(', ') || `${list.length} names`);
}
const source = fs.readFileSync(path.join(repo, 'core', 'orchestrator.ts'), 'utf8');
ok('the orchestrator keeps no inline copy of the lists', !/const LOW_RISK_TOOLS = new Set\(\[/.test(source) && !/const simpleTools = \[/.test(source));
// The orchestrator's tool selection adds names only when they are registered.
const asked = [...source.matchAll(/addIfRegistered\(([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!));
const unknown = [...new Set(asked)].filter((n) => !toolRegistryV2.get(n));
ok('every name the tool selection asks for is a registered tool', unknown.length === 0, unknown.join(', ') || `${new Set(asked).size} names`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
