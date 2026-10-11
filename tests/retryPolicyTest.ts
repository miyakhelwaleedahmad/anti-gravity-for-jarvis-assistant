/**
 * tests/retryPolicyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * REL-06: the registry retried any tool that threw, up to 2 more times. That
 * effectful calls were not repeated was an accident of where they ran (the
 * sandbox turns errors into text); a low-risk tool that changes something
 * and then throws was run three times.
 *
 *   1. a call that changes something (open an app) and throws runs once
 *   2. a read (risk 0) or a query out (a web search) is still retried
 *   3. a tool may opt in with its own retryPolicy
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-retry-'));
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_MIN_TOOL_GAP_MS'] = '0';

const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const runs: Record<string, number> = {};
function flaky(name: string, meta: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  toolRegistryV2.register({
    name,
    description: `Stand-in ${name}.`,
    riskLevel: 'low',
    meta: { category: 'SYSTEM', reversible: 'yes', effect: 'Test.', output: { format: 'text', description: 'Text' }, ...meta },
    inputSchema: {},
    fallbacks: [],
    ...extra,
    async execute() {
      runs[name] = (runs[name] ?? 0) + 1;
      throw new Error('connection reset (simulated)');
    },
  } as any);
}

flaky('test_open_thing', { risk: 1, external: 'none' });
flaky('test_read_state', { risk: 0, external: 'none' });
flaky('test_web_query', { risk: 1, external: 'query' });
flaky('test_idempotent_change', { risk: 1, external: 'none' }, { retryPolicy: { maxRetries: 1, baseDelayMs: 10 } });

console.log('\n=== Which calls are retried by themselves (REL-06) ===\n');
await toolRegistryV2.execute('test_open_thing', {});
ok('a call that changes something runs once', runs['test_open_thing'] === 1, `${runs['test_open_thing']} run(s)`);
await toolRegistryV2.execute('test_read_state', {});
ok('a read is retried (1 + 2)', runs['test_read_state'] === 3, `${runs['test_read_state']} run(s)`);
await toolRegistryV2.execute('test_web_query', {});
ok('a web query is retried (1 + 2)', runs['test_web_query'] === 3, `${runs['test_web_query']} run(s)`);
await toolRegistryV2.execute('test_idempotent_change', {});
ok('a tool that declares its own retryPolicy keeps it (1 + 1)', runs['test_idempotent_change'] === 2, `${runs['test_idempotent_change']} run(s)`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
