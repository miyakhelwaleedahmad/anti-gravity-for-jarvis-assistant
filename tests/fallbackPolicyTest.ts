/**
 * tests/fallbackPolicyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-09: a fallback tool runs with the primary's arguments after only the
 * primary's checks (permission, risk, approval). A fallback riskier than its
 * primary would have run with none of its own.
 *
 *   1. registering a fallback riskier than its primary throws, whichever is
 *      registered first; so does one with a higher permission floor
 *   2. an equally risky fallback still runs when the primary fails
 *   3. at run time, a fallback whose risk for these arguments is above the
 *      level the call was cleared at is not used
 *   4. JARVIS's own fallbacks (search, weather, documents) still register
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fallback-'));
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const runs: Record<string, number> = {};
function tool(name: string, opts: { risk: number; actions?: Record<string, number>; fallbacks?: string[]; requiredLevel?: number; fails?: boolean }): any {
  return {
    name,
    description: `Stand-in tool ${name}.`,
    riskLevel: opts.risk >= 3 ? 'high' : opts.risk === 2 ? 'medium' : 'low',
    ...(opts.requiredLevel !== undefined ? { requiredLevel: opts.requiredLevel } : {}),
    meta: {
      category: 'SYSTEM', risk: opts.risk, reversible: 'yes', external: 'none', effect: 'Test.', output: { format: 'text', description: 'Text' },
      ...(opts.actions ? { actions: Object.fromEntries(Object.entries(opts.actions).map(([a, r]) => [a, { risk: r, effect: a }])) } : {}),
    },
    inputSchema: { action: { type: 'string', description: 'action', required: false }, q: { type: 'string', description: 'q', required: false } },
    fallbacks: opts.fallbacks ?? [],
    async execute() {
      runs[name] = (runs[name] ?? 0) + 1;
      return opts.fails ? 'Error: primary failed' : `${name} ok`;
    },
  };
}
function throwsOn(fn: () => void): string {
  try { fn(); return ''; } catch (err) { return err instanceof Error ? err.message : String(err); }
}

console.log('\n=== Fallback policy (SEC-09) ===\n');

console.log('--- 1. Riskier fallbacks are refused at registration ---');
toolRegistryV2.register(tool('test_fb_shell', { risk: 3, requiredLevel: 2 }));
let err = throwsOn(() => toolRegistryV2.register(tool('test_lookup_a', { risk: 1, fallbacks: ['test_fb_shell'] })));
ok('a level-1 tool naming an already registered level-3 fallback: refused', /cannot fall back to "test_fb_shell"/.test(err), err.slice(0, 90));
ok('…and not registered', !toolRegistryV2.get('test_lookup_a'));

toolRegistryV2.register(tool('test_lookup_b', { risk: 1, fallbacks: ['test_fb_later'] }));
err = throwsOn(() => toolRegistryV2.register(tool('test_fb_later', { risk: 3 })));
ok('a level-3 fallback registered after its level-1 primary: refused', /cannot fall back to "test_fb_later"/.test(err), err.slice(0, 90));
ok('…and not registered', !toolRegistryV2.get('test_fb_later'));

toolRegistryV2.register(tool('test_fb_floor', { risk: 1, requiredLevel: 2 }));
err = throwsOn(() => toolRegistryV2.register(tool('test_lookup_c', { risk: 1, fallbacks: ['test_fb_floor'] })));
ok('a fallback with a higher permission floor: refused', /permission level 2 vs 0/.test(err), err.slice(0, 120));

console.log('\n--- 2. An equally risky fallback still works ---');
toolRegistryV2.register(tool('test_fb_same', { risk: 1 }));
err = throwsOn(() => toolRegistryV2.register(tool('test_lookup_d', { risk: 1, fallbacks: ['test_fb_same'], fails: true })));
ok('registers', err === '', err);
const viaFallback = await toolRegistryV2.execute('test_lookup_d', { q: 'x' });
ok('runs when the primary fails', viaFallback.success && viaFallback.fromFallback === 'test_fb_same' && runs['test_fb_same'] === 1, JSON.stringify({ s: viaFallback.success, fb: viaFallback.fromFallback }));
const recorded = toolRegistryV2.getHistory(20).filter((h) => h.tool === 'test_lookup_d' || h.tool === 'test_fb_same').map((h) => `${h.tool}:${h.success}`);
ok('…and the call history records the fallback under its own name, after the failed primary (SEC-09)', recorded.join(',') === 'test_lookup_d:false,test_fb_same:true', recorded.join(','));

console.log('\n--- 3. Riskier for these arguments: not used ---');
// Highest risks match (3 and 3), so both register; but for action "read" the
// primary is level 1 and the fallback stays level 3.
toolRegistryV2.register(tool('test_fb_wipe', { risk: 3 }));
err = throwsOn(() => toolRegistryV2.register(tool('test_files', { risk: 3, actions: { read: 1, wipe: 3 }, fallbacks: ['test_fb_wipe'], fails: true })));
ok('same highest risk: registers', err === '', err);
const read = await toolRegistryV2.execute('test_files', { action: 'read' });
ok('a level-1 call does not fall back to a level-3 tool', !read.success && !read.fromFallback && (runs['test_fb_wipe'] ?? 0) === 0, `${read.output.slice(0, 60)} | fallback runs ${runs['test_fb_wipe'] ?? 0}`);
ok('…the primary\'s own failure is reported', /primary failed/.test(read.output), read.output.slice(0, 80));

console.log('\n--- 4. JARVIS\'s own fallbacks ---');
const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();
for (const [primary, fallback] of [['deep_search', 'web_search'], ['get_weather', 'web_search'], ['search_documents', 'search_memory']]) {
  const t = toolRegistryV2.get(primary!) as any;
  ok(`${primary} → ${fallback} is registered`, !!t && t.fallbacks.includes(fallback) && !!toolRegistryV2.get(fallback!));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
