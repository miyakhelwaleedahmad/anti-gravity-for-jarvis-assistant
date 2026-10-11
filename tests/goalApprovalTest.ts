/**
 * tests/goalApprovalTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-13: goal_create was level 1, so a permanent or recurring goal (work in
 * the background, on a schedule, long after the request) was recorded without
 * the owner being asked. Its agents' actions are checked one by one, but the
 * decision to keep doing something was nobody's.
 *
 *   1. a one-off goal is recorded at once, as before
 *   2. a recurring goal (named, or from a repeating schedule), a permanent goal,
 *      or one allowed to use the desktop asks the owner once, even without full
 *      control mode
 *   3. the owner's no: nothing is recorded; yes: it is
 *   4. it is level 2, so an agent limited to level 1 cannot create one
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goal-approval-'));
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
delete process.env['JARVIS_LEVEL2_POLICY'];

const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { goalTools } = await import('../core/goalTools.js');
const { goalManager } = await import('../core/goalManager.js');
const { assessRisk, decide } = await import('../security/riskEngine.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { permissionSession } = await import('../control/permissionSession.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

for (const t of goalTools) toolRegistryV2.register(t);
await goalManager.init();
permissionSession.deactivateFullControl('goal test');

const asked: any[] = [];
let answer = false;
(approvalGate as any).ask = async (request: any) => { asked.push(request); return answer; };

const outcome = (args: Record<string, unknown>) => decide(
  assessRisk({ tool: 'goal_create', args, baseRisk: toolRegistryV2.riskOf('goal_create', args) }),
  { sessionLevel: permissionSession.getCurrentLevel(), policy: 'session' },
).outcome;
const goals = () => goalManager.listGoals({ kinds: ['temporary', 'permanent', 'recurring'] }).length;

console.log('\n=== Background goals need the owner\'s yes (SEC-13) ===\n');

console.log('--- 1/2. Which goals ask ---');
ok('a one-off goal: runs', outcome({ objective: 'summarise this report' }) === 'allow');
ok('kind recurring: asks', outcome({ objective: 'check the news', kind: 'recurring', schedule: 'daily at 9' }) === 'approve');
ok('a repeating schedule, no kind: asks', outcome({ objective: 'check the news', schedule: 'every 2 hours' }) === 'approve');
ok('kind permanent: asks', outcome({ objective: 'keep my inbox tidy', kind: 'permanent' }) === 'approve');
ok('a one-off goal allowed to use the desktop: asks', outcome({ objective: 'fill the form', allow_desktop: true }) === 'approve');
ok('…all without full control mode', permissionSession.getCurrentLevel() < 2);
const a = assessRisk({ tool: 'goal_create', args: { objective: 'check the news', schedule: 'every 2 hours' }, baseRisk: 1 });
ok('the question names the kind, the objective and the schedule', /^recurring: check the news \(every 2 hours\)$/.test(a.target ?? ''), a.target);

console.log('\n--- 3. The owner answers ---');
const before = goals();
asked.length = 0; answer = false;
const denied = await toolRegistryV2.execute('goal_create', { objective: 'post on my behalf', kind: 'recurring', schedule: 'every 1 hours' });
ok('asked once', asked.length === 1, `${asked.length} question(s)`);
ok('no: refused, nothing recorded', !denied.success && denied.error === 'APPROVAL_DENIED' && goals() === before, `${denied.error}, ${goals() - before} new`);

asked.length = 0; answer = true;
const approved = await toolRegistryV2.execute('goal_create', { objective: 'check the news', kind: 'recurring', schedule: 'daily at 9' });
ok('yes: recorded', approved.success && goals() === before + 1, approved.output.slice(0, 80));

asked.length = 0;
const oneOff = await toolRegistryV2.execute('goal_create', { objective: 'summarise the meeting notes' });
ok('a one-off goal is recorded without a question', oneOff.success && asked.length === 0, `${asked.length} question(s)`);

console.log('\n--- 4. Its level ---');
const level = assessRisk({ tool: 'goal_create', args: { objective: 'keep watching', kind: 'permanent' }, baseRisk: 1 }).level;
ok('a permanent goal is level 2 (an agent limited to level 1 cannot create one)', level === 2, `level ${level}`);

try { await (goalManager as any).flush?.(); } catch { /* best effort */ }
permissionSession.shutdown?.();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
