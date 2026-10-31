/**
 * tests/skillImportTimeoutTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A skill's code is loaded on its first call, with a time limit. On a busy PC
 * the browser skill took longer than the limit; the loader then marked it
 * degraded and every later call failed at once, for the rest of the session,
 * although the load itself went on and finished (owner's PC, 2026-10-28:
 * "close youtube" → "import timeout after 5000ms", tab never closed).
 *
 *   1. a slow load: the call that hits the limit fails with a short reason
 *      the voice can say; the skill is not degraded; the next call waits for
 *      the same load and runs
 *   1b. two calls at once share one load
 *   2. a module that throws while loading is still degraded (Phase 5)
 *   3. a module without execute() is still degraded (Phase 5)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skill-import-'));
process.env['JARVIS_DATA_ROOT'] = root;
// ES modules, like the repository's own skills (top-level await in "slow").
fs.writeFileSync(path.join(root, 'package.json'), '{ "type": "module" }\n');

const { SkillLoader } = await import('../core/skillLoader.js');
const { trustSkills } = await import('../core/skillTrust.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const LIMIT_MS = 400;
const LOAD_MS = 700;

function skill(name: string, body: string): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'description.json'), JSON.stringify({ id: `test_import_${name}`, name: `Test ${name}`, description: `Test skill ${name}.`, riskLevel: 'low' }, null, 2));
  fs.writeFileSync(path.join(dir, 'skill.ts'), body);
}

skill('slow', `await new Promise((r) => setTimeout(r, ${LOAD_MS}));\nexport async function execute() { return 'slow skill ran'; }\n`);
// Within the limit, asked twice at once: one load, both calls run.
skill('twice', `globalThis.__twiceLoads = (globalThis.__twiceLoads ?? 0) + 1;\nawait new Promise((r) => setTimeout(r, ${LIMIT_MS / 2}));\nexport async function execute() { return 'twice ran'; }\n`);
skill('broken', `throw new Error('broken on purpose');\nexport async function execute() { return 'never'; }\n`);
skill('noexec', `export const nothing = 1;\n`);
const skills = path.join(root, 'skills');
trustSkills(skills, ['slow', 'twice', 'broken', 'noexec']);

const loader = new SkillLoader(skills);
(loader as unknown as { IMPORT_TIMEOUT_MS: number }).IMPORT_TIMEOUT_MS = LIMIT_MS;
await loader.loadSkills();
const degraded = () => loader.getHealthSummary().degraded;

console.log('\n=== Skill import time limit ===\n');

console.log('--- 1. A slow load does not disable the skill ---');
const t0 = Date.now();
const first = await toolRegistryV2.execute('test_import_slow', {});
const firstMs = Date.now() - t0;
ok('the call that hits the limit fails', !first.success, first.output.slice(0, 80));
ok('…after about the limit, not the whole load', firstMs >= LIMIT_MS - 50 && firstMs < LOAD_MS, `${firstMs} ms`);
ok('…with a short reason the voice can say ("still loading")', /still loading/i.test(first.error ?? '') && (first.error ?? '').length <= 120, first.error ?? '(no reason)');
ok('the skill is not marked degraded', !degraded().includes('Test slow'), degraded().join(','));
const second = await toolRegistryV2.execute('test_import_slow', {});
const totalMs = Date.now() - t0;
ok('the next call waits for the same load and runs', second.success && second.output === 'slow skill ran', second.output.slice(0, 80));
// Old code: refused at once as degraded. The margin allows for a slow PC.
ok('…without starting the time limit over from nothing', totalMs < LOAD_MS + LIMIT_MS + 1000, `${totalMs} ms from the first call`);
const third = await toolRegistryV2.execute('test_import_slow', {});
ok('later calls run at once', third.success && third.durationMs < 100, `${third.durationMs} ms`);

console.log('--- 1b. Two calls at once share one load ---');
const [a, b] = await Promise.all([toolRegistryV2.execute('test_import_twice', {}), toolRegistryV2.execute('test_import_twice', {})]);
ok('both run', a.success && b.success && a.output === 'twice ran' && b.output === 'twice ran', `${a.output} / ${b.output}`);
ok('the module was loaded once', (globalThis as Record<string, unknown>)['__twiceLoads'] === 1, String((globalThis as Record<string, unknown>)['__twiceLoads']));

console.log('--- 2. A module that throws while loading is degraded ---');
const broken = await toolRegistryV2.execute('test_import_broken', {});
ok('the call fails', !broken.success, broken.output.slice(0, 80));
ok('the skill is marked degraded', degraded().includes('Test broken'), degraded().join(','));
const brokenAgain = await toolRegistryV2.execute('test_import_broken', {});
ok('the next call fails at once with "degraded"', !brokenAgain.success && /degraded/.test(brokenAgain.output), brokenAgain.output.slice(0, 80));

console.log('--- 3. A module without execute() is degraded ---');
const noexec = await toolRegistryV2.execute('test_import_noexec', {});
ok('the call fails', !noexec.success, noexec.output.slice(0, 80));
ok('the skill is marked degraded', degraded().includes('Test noexec'), degraded().join(','));

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
