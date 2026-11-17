/**
 * tests/memoryTrustTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Low-finding closure L2 (LOW_CLOSURE_PLAN.md; owner approval 2026-11-16):
 * an agent result that needed verification reaches long-term memory only when
 * the Verification agent verified it. Issues, inconclusive, unverified, or a
 * verification that did not finish: nothing is stored. A result that did not
 * need verification is stored as before.
 * A stand-in memory sink; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-trust-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
delete process.env['JARVIS_AGENT_MEMORY'];
delete process.env['JARVIS_AGENT_VERIFY'];

const { memoryManager } = await import('../memory/memoryManager.js');
const { promoteToMemory } = await import('../core/agents/jarvisAgents.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const stored: string[] = [];
(memoryManager as unknown as { rememberFact: (fact: string) => Promise<void> }).rememberFact = async (fact: string) => { stored.push(fact); };

const result = (role: string) => ({
  rootTaskId: 'r1', status: 'COMPLETED', answer: 'fast-tool is the best fit for the job.', confidence: 0.8,
  findings: [{ text: 'fast-tool is MIT licensed', confidence: 0.9, sourceIds: [], tags: [] }], sources: [], conflicts: [], limitations: [],
  specialist: { role, status: 'COMPLETED' },
}) as never;
const verification = (verdict: string) => ({ verdict, checks: [], issues: [], checkedBy: 'qa', at: 0 }) as never;
async function count(fn: () => Promise<number>): Promise<number> { stored.length = 0; await fn(); return stored.length; }

console.log('\n=== Only verified results become long-term memory ===\n');
ok('verified research result: stored', await count(() => promoteToMemory(result('research_agent'), 'best tool', verification('verified'))) > 0);
ok('verifier found issues: not stored', await count(() => promoteToMemory(result('research_agent'), 'best tool', verification('issues'))) === 0);
ok('verification inconclusive: not stored', await count(() => promoteToMemory(result('research_agent'), 'best tool', verification('inconclusive'))) === 0);
ok('result unverified: not stored', await count(() => promoteToMemory(result('research_agent'), 'best tool', verification('unverified'))) === 0);
ok('verification needed but it did not finish: not stored', await count(() => promoteToMemory(result('research_agent'), 'best tool', undefined)) === 0);
ok('a result that was never verified: not stored (owner, 2026-11-17, L-5 option S)', await count(() => promoteToMemory(result('memory_agent'), 'what do you remember', undefined)) === 0);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
