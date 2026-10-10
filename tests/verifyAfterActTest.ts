/**
 * tests/verifyAfterActTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — observe → act → verify (core/verifiers.ts):
 *
 *  1. A real write is checked by reading it back, and the reply says so.
 *  2. A tool that reports success without doing anything fails the step with
 *     VERIFICATION_FAILED, is not retried, and the reply says it could not be
 *     confirmed.
 *  3. control_file copy / move / create / delete are checked on real files.
 *  4. A check that throws, or takes longer than 5 s, makes no claim: the step
 *     still succeeds as "unverifiable".
 *  5. save_relation used to save nothing with graph memory off; it is now
 *     stored, checked, and found by search_memory.
 *  6. Every action tool has a check or a stated reason.
 *
 * Real files in a throwaway folder; the LLM is stubbed; approvals are answered
 * by a stub of the person.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-verify-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_MIN_TOOL_GAP_MS'] = '0';
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { approvalGate } = await import('../security/approvalGate.js');
let verifiers: any = {};
try { verifiers = await import('../core/verifiers.js' as string); } catch { /* not on the old code */ }

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

// The person answers approvals with YES.
(approvalGate as any)._promptWithTimeout = async () => 'YES';
(approvalGate as any)._voiceOrTextPromptWithTimeout = async () => 'YES';

// The LLM: each planning call takes the next plan.
let plans: Array<Array<{ name: string; args: Record<string, unknown> }>> = [];
modelRouter.chat = async (req: any) => {
  if (req.tools) {
    const next = plans.shift() ?? [];
    return next.length
      ? { content: '', tool_calls: next.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } as any
      : { content: 'Done, sir.' } as any;
  }
  return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' } as any;
};
modelRouter.streamChat = async function* () { yield 'Done, sir.'; } as any;
let spoken: string[] = [];
(orchestrator as any).speak = (t: string) => { spoken.push(t); };

async function withTool<T>(name: string, body: (args: any) => Promise<string>, fn: () => Promise<T>): Promise<T> {
  const tool = toolRegistryV2.get(name)! as any;
  const saved = tool.execute;
  tool.execute = body;
  try { return await fn(); } finally { tool.execute = saved; }
}

console.log('\n=== Verify After Act Test ===\n');

// Writing files is level 2 (full control mode).
permissionSession.activateFullControl(5, 'cli');

console.log('--- 1. A real write is read back ---');
const notes = path.join(workspace, 'notes.txt');
const written = await toolRegistryV2.execute('write_file', { filePath: 'notes.txt', content: 'buy milk\n' });
ok('write_file is checked: verified', written.success && written.verification?.status === 'verified', written.verification?.evidence);
plans = [[{ name: 'write_file', args: { filePath: 'todo.txt', content: 'call mum' } }]];
spoken = [];
await orchestrator.process('write call mum into todo.txt', 'cli');
ok('the reply says it was checked', /I checked: todo\.txt holds the 8 characters written/.test(spoken.join(' ')), spoken.join(' | '));
const todo = path.join(workspace, 'todo.txt');
ok('and the file is really there', fs.existsSync(todo) && fs.readFileSync(todo, 'utf8') === 'call mum');

console.log('\n--- 2. Success reported, nothing done ---');
let runs = 0;
await withTool('write_file', async () => { runs++; return 'File written: ghost.txt'; }, async () => {
  const ghost = await toolRegistryV2.execute('write_file', { filePath: 'ghost.txt', content: 'boo' });
  ok('the step fails with VERIFICATION_FAILED', !ghost.success && ghost.error === 'VERIFICATION_FAILED' && /ghost\.txt is not there/.test(ghost.output), ghost.output);
  runs = 0;
  plans = [[{ name: 'write_file', args: { filePath: 'ghost.txt', content: 'boo' } }]];
  spoken = [];
  await orchestrator.process('write boo into ghost.txt', 'cli');
  ok('the reply says it could not be confirmed', spoken.join(' ') === 'I tried, sir, but I could not confirm it worked: ghost.txt is not there.', spoken.join(' | '));
  ok('and it was not retried', runs === 1, `${runs} run(s)`);
});
const tampered = path.join(workspace, 'tampered.txt');
await withTool('write_file', async () => { fs.writeFileSync(tampered, 'something else'); return 'File written: tampered.txt'; }, async () => {
  const r = await toolRegistryV2.execute('write_file', { filePath: 'tampered.txt', content: 'what was asked' });
  ok('a file with other contents fails the check', !r.success && r.error === 'VERIFICATION_FAILED', r.output);
});

console.log('\n--- 3. control_file on real files ---');
const src = path.join(workspace, 'a.txt');
const copy = path.join(workspace, 'b.txt');
const moved = path.join(workspace, 'c.txt');
const folder = path.join(workspace, 'archive');
const steps: Array<[string, Record<string, unknown>, string]> = [
  ['write', { action: 'write', path: src, content: 'hello' }, 'a.txt holds the 5 characters written'],
  ['copy', { action: 'copy', path: src, destination: copy }, 'the copy is there and a.txt is still there'],
  ['move', { action: 'move', path: copy, destination: moved }, 'c.txt is there and b.txt is gone'],
  ['create_folder', { action: 'create_folder', path: folder }, 'the folder archive is there'],
  ['delete', { action: 'delete', path: moved }, 'c.txt is gone'],
  ['delete_folder', { action: 'delete_folder', path: folder }, 'archive is gone'],
];
for (const [label, args, evidence] of steps) {
  const r = await toolRegistryV2.execute('control_file', args);
  ok(`${label}: verified — ${evidence}`, r.success && r.verification?.status === 'verified' && r.verification.evidence === evidence,
    r.success ? r.verification?.evidence : r.output.slice(0, 100));
}
const read = await toolRegistryV2.execute('control_file', { action: 'read', path: src });
ok('read: no claim of a check', read.success && read.verification?.status === 'unverifiable', read.verification?.evidence);
await withTool('control_file', async () => '{"success":true,"message":"Deleted a.txt"}', async () => {
  const r = await toolRegistryV2.execute('control_file', { action: 'delete', path: src });
  ok('a delete that deleted nothing fails the check', !r.success && r.error === 'VERIFICATION_FAILED' && fs.existsSync(src), r.output);
});
const off = await toolRegistryV2.execute('disable_full_control_session', {});
ok('turning full control off is checked', off.success && off.verification?.status === 'verified', off.verification?.evidence);
permissionSession.activateFullControl(5, 'cli');

console.log('\n--- 4. A check that throws or hangs makes no claim ---');
if (verifiers.verifyCall) {
  toolRegistryV2.register({
    name: 'test_throwing_check', description: 'test', riskLevel: 'low', inputSchema: {}, fallbacks: [],
    meta: { category: 'SYSTEM', risk: 1, reversible: 'yes', external: 'none', effect: 'test', output: { format: 'text', description: 'x' } },
    execute: async () => 'done', verify: async () => { throw new Error('disk unreadable'); },
  } as any);
  const thrown = await toolRegistryV2.execute('test_throwing_check', {});
  ok('a check that throws: unverifiable, the step succeeds', thrown.success && thrown.verification?.status === 'unverifiable' && /disk unreadable/.test(thrown.verification.evidence), thrown.verification?.evidence);
  toolRegistryV2.register({
    name: 'test_hanging_check', description: 'test', riskLevel: 'low', inputSchema: {}, fallbacks: [],
    meta: { category: 'SYSTEM', risk: 1, reversible: 'yes', external: 'none', effect: 'test', output: { format: 'text', description: 'x' } },
    execute: async () => 'done', verify: () => new Promise(() => {}),
  } as any);
  const t0 = Date.now();
  const hung = await toolRegistryV2.execute('test_hanging_check', {});
  const ms = Date.now() - t0;
  ok('a check that hangs is cut off at 5 s', hung.success && hung.verification?.status === 'unverifiable' && ms >= 4900 && ms < 7000, `${ms}ms`);
} else {
  ok('core/verifiers.ts exists', false);
}

console.log('\n--- 5. save_relation is stored and can be recalled ---');
const relation = await toolRegistryV2.execute('save_relation', { entity1: 'User', relation: 'works_on', entity2: 'JARVIS upgrade' });
ok('save_relation: verified in long-term memory', relation.success && relation.verification?.status === 'verified', `${relation.output} / ${relation.verification?.evidence}`);
const recalled = await toolRegistryV2.execute('search_memory', { query: 'JARVIS upgrade' });
ok('search_memory finds it', recalled.success && recalled.output.includes('User WORKS_ON JARVIS upgrade'), recalled.output.slice(0, 120));

console.log('\n--- 5b. ingest_documents is checked against the index ---');
{
  // The embedding service does not run here; embedding is stubbed, the index is real.
  const realEmbed = memoryManager.embed.bind(memoryManager);
  (memoryManager as any).embed = async () => [0.1, 0.2, 0.3];
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs', 'guide.md'), '# Guide\n\nJARVIS reads this guide to answer questions about setup.\n');
  const ingested = await toolRegistryV2.execute('ingest_documents', { path: 'docs' });
  ok('ingest_documents: verified — the index lists it', ingested.success && ingested.verification?.status === 'verified', `${ingested.output.split('\n')[0]} / ${ingested.verification?.evidence}`);
  fs.mkdirSync(path.join(workspace, 'empty'), { recursive: true });
  const empty = await toolRegistryV2.execute('ingest_documents', { path: 'empty' });
  ok('an ingest that added nothing is not reported as done', !empty.success, empty.output.slice(0, 100));
  (memoryManager as any).embed = realEmbed;
}

console.log('\n--- 6. Every action tool has a check or a reason ---');
if (verifiers.VERIFIERS) {
  const missing = toolRegistryV2.names().filter((name) => {
    const meta = toolRegistryV2.getMeta(name);
    const acts = !!meta && meta.risk >= 1 && meta.external !== 'query' && !name.startsWith('test_');
    return acts && !(toolRegistryV2.get(name) as any).verify && !verifiers.VERIFIERS[name];
  });
  ok('no action tool without one', missing.length === 0, missing.join(', '));
}

permissionSession.deactivateFullControl('verify test');
try { await memoryManager.flush(); } catch { /* best effort */ }
permissionSession.shutdown?.();
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use by a child process; the runner clears its temp folder */ }
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
