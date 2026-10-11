/**
 * tests/memoryForgetTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-05 / OPS-03: where a remembered fact came from, and forgetting it.
 *
 *   - a fact records its origin: the owner's words, JARVIS's inference, or
 *     gathered from outside; facts stored before the field existed get it
 *     from their source, unchanged on disk
 *   - planning sees gathered facts labelled "from research, unverified"
 *   - forget_memory (risk 2, asks first): removes the fact from the fact store
 *     on disk and from the search index; when the index cannot be reached, it
 *     says so and the after-action check fails instead of claiming success
 *   - too many matches are refused, a denied approval removes nothing
 *
 * The search index (vector service) is a stand-in.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-forget-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
// Level 2 asks each time (the default needs full control mode for the session).
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
process.chdir(workspace);

const { memoryManager, factOrigin } = await import('../memory/memoryManager.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { approvalGate } = await import('../security/approvalGate.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await memoryManager.init();
registerAllTools();

// The search index: deletes are recorded; `indexUp` false makes it unreachable.
let indexUp = true;
const indexDeletes: string[] = [];
(memoryManager as any).vectorRequest = async (action: string, payload: any) => {
  if (!indexUp) throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
  if (action === 'delete') { indexDeletes.push(payload.text); return { remaining: 0 }; }
  if (action === 'search') return { results: [] };
  return {};
};
let approve = true;
const approvals: any[] = [];
(approvalGate as any).requestApproval = async (r: any) => { approvals.push(r); return approve; };

const facts = () => memoryManager.getLongTermFacts(10_000);
const memoryFile = () => { for (const f of [path.join(workspace, 'memory', 'jarvis_memory.json'), path.join(workspace, 'data', 'memory', 'jarvis_memory.json')]) if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); return ''; };

console.log('\n=== Memory origin and forgetting (SEC-05, OPS-03) ===\n');

console.log('--- 1. Origin ---');
await memoryManager.rememberFact('The owner prefers tea over coffee', 'conversation', 6);
await memoryManager.rememberFact('Research says framework X is the fastest', 'agents', 5);
await memoryManager.rememberFact('A lesson: retry the build after npm install', 'lesson', 5);
const byText = (t: string) => facts().find((f) => f.fact.includes(t))!;
ok('the owner\'s words: origin user', byText('tea over coffee')?.origin === 'user');
ok('an agent\'s research: origin external', byText('framework X')?.origin === 'external');
ok('a lesson JARVIS drew: origin agent', byText('retry the build')?.origin === 'agent');
// A fact stored before the field existed.
(memoryManager as any).db.data.longTerm.push({ id: 'legacy-1', fact: 'Old research note about vector databases', source: 'agents', timestamp: Date.now(), importance: 5, lastAccessed: Date.now(), accessCount: 0, confidence: 0.8, version: 1 });
const legacy = byText('Old research note');
ok('an older fact without the field gets it from its source, and is left as it was', factOrigin(legacy) === 'external' && legacy.origin === undefined);

console.log('\n--- 2. Planning sees the origin ---');
const ctx = await memoryManager.retrieveForPlanning('framework fastest research note tea coffee', 8);
ok('gathered facts are labelled "from research, unverified"', /from research, unverified\] Research says framework X/.test(ctx), ctx.split('\n').find((l) => l.includes('framework')) ?? ctx.slice(0, 120));
ok('the owner\'s facts are labelled "from you"', /from you\] The owner prefers tea/.test(ctx));

console.log('\n--- 3. forget_memory ---');
ok('forget_memory is risk 2: it asks first, and agents (limit 1) cannot use it', toolRegistryV2.riskOf('forget_memory', { fact: 'tea' }) === 2);
approve = false;
let r = await toolRegistryV2.execute('forget_memory', { fact: 'tea over coffee' });
ok('denied: nothing is removed', !r.success && !!byText('tea over coffee') && approvals.length === 1, r.error ?? r.output.slice(0, 80));
approve = true;
r = await toolRegistryV2.execute('forget_memory', { fact: 'tea over coffee' });
await sleep(50);
ok('approved: the fact is gone from the fact store', r.success && !byText('tea over coffee'), r.output.slice(0, 120));
ok('…from the file on disk (which still holds the other facts)', memoryFile().includes('framework X') && !memoryFile().includes('tea over coffee'), `${memoryFile().length} bytes`);
ok('…and from the search index', indexDeletes.includes('The owner prefers tea over coffee'));
ok('…and the check after the action confirms both', r.verification?.status === 'verified', r.verification?.evidence);

for (let i = 0; i < 7; i++) await memoryManager.rememberFact(`Project note ${i}: deadline moved`, 'conversation', 5);
r = await toolRegistryV2.execute('forget_memory', { fact: 'deadline moved' });
ok('too many matches (7): nothing removed, asks for more specific words', !r.success && /7 facts match/.test(r.output) && facts().filter((f) => f.fact.includes('deadline moved')).length === 7, r.output.slice(0, 100));

console.log('\n--- 4. When the search index cannot be reached ---');
indexUp = false;
r = await toolRegistryV2.execute('forget_memory', { id: 'legacy-1' });
ok('the fact store entry is removed', !byText('Old research note'));
ok('…the answer says the search index was not updated', /search index was not updated/.test(r.output), r.output.slice(0, 160));
ok('…and the call is not reported as a success', !r.success && r.verification?.status === 'failed', `${r.success} / ${r.verification?.status}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
