/**
 * tests/healthStatusTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The health snapshot reflects what the services really are.
 *
 * On the owner's PC the first probe after start said "LLM: unknown" (its check
 * ran in the background and the probe did not wait for it), so the system
 * read as offline; and an empty tool registry read as "online, 0 tools".
 * The model provider is a stand-in here (no network).
 *
 *   1. the first probe waits for the first LLM check: a working provider is
 *      "online", a failing one is not
 *   2. a check that hangs does not hang the probe (bounded wait)
 *   3. no tools registered: "loading", not "online"; with tools: "online"
 *   4. overall: online when the required services are; voice services that
 *      are not connected (optional) do not make it offline; a required
 *      service that is down does
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-health-status-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['JARVIS_LLM_PROVIDER'] = 'groq';
process.env['GROQ_API_KEY'] = 'test-not-a-real-key';

const { healthManager } = await import('../monitoring/healthManager.js');
const { llmStatus } = await import('../bridge/llmStatus.js');
const { groqProvider } = await import('../bridge/groqProvider.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const hm = healthManager as any;
// Memory services as healthy; this test is about the LLM, the registry and the overall rule.
hm.probeRedis = async () => ({ name: 'redis', status: 'online', detail: 'stand-in', checkedAt: Date.now() });
hm.probeVectorMemory = async () => ({ name: 'vector_memory', status: 'online', detail: 'stand-in', checkedAt: Date.now() });
const pg = groqProvider as any;
const fresh = () => { llmStatus.reset(); hm.llmCheck = null; };

console.log('\n=== Health status follows the real services ===\n');

console.log('--- 1. The first LLM check ---');
fresh();
pg.ping = async () => { await new Promise((r) => setTimeout(r, 300)); llmStatus.recordSuccess('probe'); return { modelFound: true, models: 1 }; };
let snap = await healthManager.probe();
ok('a provider that answers: "online" on the first probe (not "unknown")', snap.services.llm?.status === 'online', `${snap.services.llm?.status}: ${snap.services.llm?.detail}`);

fresh();
pg.ping = async () => { await new Promise((r) => setTimeout(r, 200)); const e = new Error('401 invalid api key'); llmStatus.recordFailure(e, 'probe'); throw e; };
snap = await healthManager.probe();
ok('a provider that refuses: not "online"', snap.services.llm?.status !== 'online' && snap.services.llm?.status !== 'unknown', `${snap.services.llm?.status}: ${snap.services.llm?.detail}`);

console.log('\n--- 2. A check that hangs ---');
fresh();
pg.ping = () => new Promise(() => { /* never answers, ignores its signal */ });
const t0 = Date.now();
snap = await healthManager.probe();
const took = Date.now() - t0;
ok('the probe returns within its bound', took < 8_000, `${took} ms`);
ok('…and says "unknown", not "online"', snap.services.llm?.status === 'unknown', String(snap.services.llm?.status));

console.log('\n--- 3. The tool registry ---');
fresh();
pg.ping = async () => { llmStatus.recordSuccess('probe'); return { modelFound: true, models: 1 }; };
const names = toolRegistryV2.names();
ok('(setup) nothing registered yet in this process', names.length === 0, String(names.length));
snap = await healthManager.probe();
ok('no tools: "loading", not "online"', snap.services.tool_registry?.status === 'loading', `${snap.services.tool_registry?.status}: ${snap.services.tool_registry?.detail}`);
ok('…so the system is not reported online', snap.overallStatus !== 'online', snap.overallStatus);
const { registerAllTools } = await import('../core/tools/index.js');
registerAllTools();
snap = await healthManager.probe();
ok('with tools registered: "online"', snap.services.tool_registry?.status === 'online', String(snap.services.tool_registry?.detail));

console.log('\n--- 4. The overall rule ---');
ok('required services up, voice not connected (optional): online', snap.overallStatus === 'online'
  && ['stt', 'tts', 'wake_word'].every((k) => snap.services[k]?.status !== 'online'), snap.overallStatus);
fresh();
pg.ping = async () => { const e = new Error('503 service unavailable'); llmStatus.recordFailure(e, 'probe'); throw e; };
snap = await healthManager.probe();
ok('the LLM (required) down: not online', snap.overallStatus !== 'online', `${snap.overallStatus}; llm=${snap.services.llm?.status}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
