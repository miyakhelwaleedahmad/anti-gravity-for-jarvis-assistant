/**
 * tests/saveRelationTimeBudgetTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review INDEPENDENT_REVIEW_SAVE_RELATION_CONFIRM.md M-2 (LR2_L5_PLAN.md
 * §12.2; owner approval 2026-11-17 for core/toolRegistryV2.ts): a question a
 * low-risk tool asks the owner does not count against the tool's time, and a
 * stopped call withdraws it.
 *
 *   - a "yes" given after 26 s (past the registry's 25 s limit for low-risk
 *     calls) is stored
 *   - when the caller stops the call while the question is on display, the
 *     question is withdrawn: recorded "cancelled", not approved, nothing stored
 *   - a low-risk tool that declares it asks the owner runs inside a sandbox
 *     call; an ordinary low-risk tool still does not (control)
 * The real registry and approval gate; the owner answers at the prompt. The
 * prompt stand-in ignores save_relation's own 20 s answer window, so the 26 s
 * case shows that the call's time limit no longer ends the question; in use,
 * the owner has 20 s to answer.
 * Stand-in memory store; no network. Takes about 30 s.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-save-budget-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
delete process.env['JARVIS_TOOL_BUDGET_LOW_MS'];
process.env['JARVIS_TOOL_STOP_GRACE_MS'] = '1000';

const { memoryManager } = await import('../memory/memoryManager.js');
const stored: string[] = [];
(memoryManager as unknown as { rememberFact: (fact: string) => Promise<void> }).rememberFact = async (fact: string) => { stored.push(fact); };

// The owner answers "yes" at the prompt after `delayMs`, whatever happens meanwhile.
const { approvalGate } = await import('../security/approvalGate.js');
let delayMs = 0;
let shownAt = 0;
(approvalGate as any)._promptWithTimeout = async () => { shownAt = Date.now(); await new Promise((r) => setTimeout(r, delayMs)); return 'yes'; };
(approvalGate as any)._voiceOrTextPromptWithTimeout = (approvalGate as any)._promptWithTimeout;

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { currentToolCall } = await import('../core/toolExecutionSandbox.js');
const { beginTrace, endTrace } = await import('../core/traceContext.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
registerAllTools();
const lastDecision = () => approvalGate.recentDecisions(1)[0] as { approved?: boolean; by?: string } | undefined;

console.log('\n=== A question does not count against the tool\'s time (M-2) ===\n');

console.log('--- Which low-risk tools run inside a sandbox call ---');
{
  let insideAsker: boolean | undefined;
  let insidePlain: boolean | undefined;
  const asker = toolRegistryV2.getMeta('save_relation');
  ok('(setup) save_relation is a low-risk tool', !!asker);
  toolRegistryV2.register({ name: 'test_plain_low', description: 'test', riskLevel: 'low', inputSchema: {}, fallbacks: [], async execute() { insidePlain = !!currentToolCall(); return 'ok'; } } as never);
  toolRegistryV2.register({ name: 'test_asking_low', description: 'test', riskLevel: 'low', asksOwner: true, inputSchema: {}, fallbacks: [], async execute() { insideAsker = !!currentToolCall(); return 'ok'; } } as never);
  await toolRegistryV2.execute('test_plain_low', {});
  await toolRegistryV2.execute('test_asking_low', {});
  ok('a low-risk tool that asks the owner runs inside a sandbox call (its budget can pause)', insideAsker === true, String(insideAsker));
  ok('an ordinary low-risk tool runs as before, outside the sandbox (control)', insidePlain === false, String(insidePlain));
}

console.log('\n--- A "yes" after 26 s is stored ---');
{
  stored.length = 0;
  delayMs = 26_000;
  beginTrace('cli', 'Remember that my exam is on Friday');
  const t0 = Date.now();
  let r: { success: boolean; output: string };
  try { r = await toolRegistryV2.execute('save_relation', { entity1: 'User', relation: 'HAS_EXAM_ON', entity2: 'Friday' }); } finally { endTrace(); }
  ok('the owner\'s "yes" after 26 s stores the fact', stored.length === 1 && r.success, `${stored.length} stored after ${Math.round((Date.now() - t0) / 1000)} s; ${r.output.slice(0, 120)}`);
  const d = lastDecision();
  ok('…and the record matches what happened (approved, stored)', d?.approved === true && stored.length === 1, JSON.stringify(d ? { approved: d.approved, by: d.by } : null));
}

console.log('\n--- A stopped call withdraws its question ---');
{
  stored.length = 0;
  delayMs = 1_500;
  const ac = new AbortController();
  beginTrace('cli', 'Remember that my exam is on Friday');
  const pending = toolRegistryV2.execute('save_relation', { entity1: 'User', relation: 'HAS_EXAM_ON', entity2: 'Friday at ten' }, ac.signal);
  const started = Date.now();
  while (!shownAt || shownAt < started) await new Promise((r) => setTimeout(r, 20));
  setTimeout(() => ac.abort(), 300);
  try { await pending; } finally { endTrace(); }
  await new Promise((r) => setTimeout(r, 1_500));
  const d = lastDecision();
  ok('nothing is stored', stored.length === 0, `${stored.length} stored`);
  ok('the question is recorded as cancelled, not approved', d?.approved === false && d?.by === 'cancelled', JSON.stringify(d ? { approved: d.approved, by: d.by } : null));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
