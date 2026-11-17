/**
 * tests/usageLedgerTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1A (MM-1A-05): model usage records survive a restart.
 *
 * Before Phase 1A every record lived in an in-memory list of 500 and was lost
 * when JARVIS stopped.
 *
 *   1. one model call → one line in <data root>/data/usage/model_usage.jsonl,
 *      holding only the usage fields (no message, prompt or reply)
 *   2. a restart (a new process on the same data root) sees the earlier records
 *   3. an error text with a credential in it is stored redacted
 *   4. rotation at the size limit keeps at most 10 old files
 *   5. malformed lines are skipped
 *   6. JARVIS_USAGE_LEDGER=off writes nothing
 *   7. a ledger that cannot be written does not fail the call
 * Scripted provider; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-usage-ledger-'));
process.env['JARVIS_DATA_ROOT'] = root;
delete process.env['JARVIS_USAGE_LEDGER'];
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];

const { ModelRouter } = await import('../bridge/modelRouter.js');
const { usageLog, usageSummary } = await import('../bridge/modelCategories.js');
const ledgerModule = await import('../bridge/usageLedger.js').catch(() => null) as null | Record<string, any>;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const file = path.join(root, 'data', 'usage', 'model_usage.jsonl');
const lines = (f = file) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const FAKE_KEY = 'sk-ant-' + 'api03-' + 'Q'.repeat(40);

let fail = false;
const provider = {
  isConfigured: () => true,
  async chat(req: any) {
    if (fail) throw new Error(`upstream said: invalid key ${FAKE_KEY} (401)`);
    return { content: `secret reply about ${req.messages.at(-1).content}`, usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } };
  },
};
const r = new ModelRouter('stub');
r.registerProvider('stub', provider as never);
(r as any).failoverOrder = () => ['stub'];

console.log('\n=== Usage records survive a restart (Phase 1A) ===\n');
ok('the ledger module exists', !!ledgerModule);

console.log('--- 1. One call, one line ---');
await r.chat({ model: 'm-ledger', messages: [{ role: 'user', content: 'the private question' }], category: 'planning' });
const first = lines();
ok('one line was written', first.length === 1, `${first.length} line(s) at ${file}`);
const rec = first[0] ? JSON.parse(first[0]) : {};
ok('it is the usage record', rec.provider === 'stub' && rec.model === 'm-ledger' && rec.category === 'planning' && rec.promptTokens === 7 && rec.completionTokens === 3, first[0] ?? '');
const allowed = new Set(['at', 'category', 'provider', 'model', 'correlationId', 'latencyMs', 'ok', 'fallbackUsed', 'streamed', 'promptTokens', 'completionTokens', 'estimatedCostUsd', 'error', 'agentRole']);
ok('only usage fields are stored', Object.keys(rec).every((k) => allowed.has(k)), Object.keys(rec).join(','));
ok('no message, prompt or reply text is stored', !/private question|secret reply/.test(first.join('\n')));

console.log('\n--- 2. A restart ---');
const probe = `
import { usageLog, usageSummary } from ${JSON.stringify(path.join(repo, 'bridge', 'modelCategories.ts'))};
const log = usageLog();
console.log('RESTART', JSON.stringify({ n: log.length, last: log.at(-1), summary: usageSummary() }));
`;
const tsx = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawnSync(process.execPath, [tsx, '-e', probe], { env: { ...process.env, JARVIS_DATA_ROOT: root }, encoding: 'utf8', timeout: 60_000 });
const out = /RESTART (.*)$/m.exec(child.stdout ?? '')?.[1];
const seen = out ? JSON.parse(out) : undefined;
ok('a new process on the same data root sees the earlier record', seen?.n >= 1 && seen?.last?.model === 'm-ledger', out ?? (child.stderr ?? '').slice(-300));
ok('…and counts it in the summary', seen?.summary?.planning?.calls >= 1, JSON.stringify(seen?.summary ?? {}));

console.log('\n--- 3. Errors are stored redacted ---');
fail = true;
await r.chat({ model: 'm-ledger', messages: [{ role: 'user', content: 'x' }], category: 'planning' }).catch(() => {});
fail = false;
const afterErr = lines().join('\n');
ok('the failed call is recorded', /"ok":false/.test(afterErr));
ok('…without the credential', !afterErr.includes(FAKE_KEY));
ok('in memory too', usageLog().at(-1)?.ok === false && !String(usageLog().at(-1)?.error).includes(FAKE_KEY));

console.log('\n--- 4. Rotation ---');
if (ledgerModule?.['UsageLedger']) {
  const dir = path.join(root, 'rotation');
  const small = new ledgerModule['UsageLedger'](path.join(dir, 'model_usage.jsonl'), { rotateBytes: 1024, keepRotated: 10 });
  for (let i = 0; i < 400; i++) small.append({ at: new Date().toISOString(), category: 'planning', provider: 'p', model: `m${i}`, latencyMs: 1, ok: true, fallbackUsed: false, streamed: false, promptTokens: 1, completionTokens: 1 });
  const rotated = fs.readdirSync(dir).filter((f) => /^model_usage-\d+(-\d+)?\.jsonl$/.test(f));
  ok('old records move to rotated files', rotated.length > 0, `${rotated.length} rotated`);
  ok('…at most 10 are kept', rotated.length <= 10, `${rotated.length}`);
  ok('the current file stays under the limit', fs.statSync(path.join(dir, 'model_usage.jsonl')).size <= 1024 + 400);
  ok('the newest records are read back in order', small.readRecent(3).map((x: any) => x.model).join(',') === 'm397,m398,m399', small.readRecent(3).map((x: any) => x.model).join(','));
} else ok('UsageLedger can be given a size limit for this test', false, 'bridge/usageLedger.ts not found');

console.log('\n--- 5. Malformed lines ---');
if (ledgerModule?.['UsageLedger']) {
  const f = path.join(root, 'malformed', 'model_usage.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"at":"2026-11-15T00:00:00Z","category":"planning","provider":"p","model":"good1","latencyMs":1,"ok":true,"fallbackUsed":false,"streamed":false,"promptTokens":null,"completionTokens":null}\nnot json\n{"half":\n{"at":"2026-11-15T00:00:01Z","category":"planning","provider":"p","model":"good2","latencyMs":1,"ok":true,"fallbackUsed":false,"streamed":false,"promptTokens":null,"completionTokens":null}\n');
  const read = new ledgerModule['UsageLedger'](f).readRecent(10);
  ok('they are skipped; the good records are kept', read.map((x: any) => x.model).join(',') === 'good1,good2', read.map((x: any) => x.model).join(','));
} else ok('malformed lines can be checked', false, 'bridge/usageLedger.ts not found');

console.log('\n--- 6. Turned off ---');
{
  const before = lines().length;
  process.env['JARVIS_USAGE_LEDGER'] = 'off';
  await r.chat({ model: 'm-off', messages: [{ role: 'user', content: 'x' }], category: 'planning' });
  delete process.env['JARVIS_USAGE_LEDGER'];
  ok('JARVIS_USAGE_LEDGER=off writes nothing', lines().length === before, `${before} → ${lines().length}`);
  ok('…the call is still recorded in memory', usageLog().at(-1)?.model === 'm-off');
}

console.log('\n--- 7. A ledger that cannot be written ---');
if (ledgerModule?.['UsageLedger']) {
  const blocker = path.join(root, 'blocked');
  fs.writeFileSync(blocker, 'a file where the folder should be');
  const broken = new ledgerModule['UsageLedger'](path.join(blocker, 'usage', 'model_usage.jsonl'));
  let threw = false;
  try { broken.append({ at: new Date().toISOString(), category: 'planning', provider: 'p', model: 'm', latencyMs: 1, ok: true, fallbackUsed: false, streamed: false, promptTokens: null, completionTokens: null }); } catch { threw = true; }
  ok('append does not throw', !threw);
} else ok('an unwritable ledger can be checked', false, 'bridge/usageLedger.ts not found');
{
  // Through the router: the data root's usage folder is a file.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-usage-blocked-'));
  fs.mkdirSync(path.join(root2, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root2, 'data', 'usage'), 'not a folder');
  process.env['JARVIS_DATA_ROOT'] = root2;
  const res = await r.chat({ model: 'm-blocked', messages: [{ role: 'user', content: 'x' }], category: 'planning' }).then((v) => v.content, (e) => `ERR ${(e as Error).message}`);
  process.env['JARVIS_DATA_ROOT'] = root;
  ok('the model call still succeeds', !res.startsWith('ERR'), res.slice(0, 80));
  try { fs.rmSync(root2, { recursive: true, force: true }); } catch { /* best effort */ }
}
void usageSummary;

console.log('\n--- 8. Rotation, then a restart (L4) ---');
if (ledgerModule?.['UsageLedger']) {
  const f = path.join(root, 'rotation-restart', 'model_usage.jsonl');
  const writer = new ledgerModule['UsageLedger'](f, { rotateBytes: 1024, keepRotated: 10 });
  for (let i = 0; i < 60; i++) writer.append({ at: new Date().toISOString(), category: 'planning', provider: 'p', model: `r${i}`, latencyMs: 1, ok: true, fallbackUsed: false, streamed: false, promptTokens: 1, completionTokens: 1 });
  // A new ledger on the same file, as after a restart, just after a rotation.
  const reader = new ledgerModule['UsageLedger'](f, { rotateBytes: 1024, keepRotated: 10 });
  const back = reader.readRecent(40).map((x: any) => x.model);
  ok('after a rotation, a restart still sees the newest records from the rotated files', back.length === 40 && back[39] === 'r59' && back[0] === 'r20', `${back.length} record(s): ${back[0]} … ${back[39]}`);
  const rotatedCount = fs.readdirSync(path.dirname(f)).filter((n) => n !== 'model_usage.jsonl').length;
  ok('…(the test really rotated)', rotatedCount > 0, `${rotatedCount} rotated file(s)`);
} else ok('rotation then restart can be checked', false, 'bridge/usageLedger.ts not found');

console.log('\n--- 9. A rotation that fails does not lose the record (L4) ---');
if (ledgerModule?.['UsageLedger']) {
  const { createRequire, syncBuiltinESMExports } = await import('module');
  const fsCjs = createRequire(import.meta.url)('fs') as typeof fs;
  const f = path.join(root, 'rotation-race', 'model_usage.jsonl');
  const w = new ledgerModule['UsageLedger'](f, { rotateBytes: 200, keepRotated: 10 });
  for (let i = 0; i < 3; i++) w.append({ at: new Date().toISOString(), category: 'planning', provider: 'p', model: `x${i}`, latencyMs: 1, ok: true, fallbackUsed: false, streamed: false, promptTokens: 1, completionTokens: 1 });
  const realRename = fsCjs.renameSync;
  // Another JARVIS process rotated the file a moment earlier: our rename finds nothing.
  fsCjs.renameSync = ((..._args: unknown[]) => { throw Object.assign(new Error('ENOENT: no such file or directory, rename'), { code: 'ENOENT' }); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    w.append({ at: new Date().toISOString(), category: 'planning', provider: 'p', model: 'kept-after-race', latencyMs: 1, ok: true, fallbackUsed: false, streamed: false, promptTokens: 1, completionTokens: 1 });
  } finally {
    fsCjs.renameSync = realRename;
    syncBuiltinESMExports();
  }
  ok('the record is still written when the rotation fails', fs.readFileSync(f, 'utf8').includes('kept-after-race'));
} else ok('a failed rotation can be checked', false, 'bridge/usageLedger.ts not found');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* still in use on Windows */ }
process.exit(failed > 0 ? 1 : 0);
