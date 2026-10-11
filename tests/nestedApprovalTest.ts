/**
 * tests/nestedApprovalTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-08: an approval covers the call the user approved, not everything that
 * call goes on to do.
 *
 * Before the fix, any approval asked while an approved call ran was answered
 * yes without asking: a tool that called another tool through the registry,
 * or a controller asking about a different file or command, rode on the first
 * approval.
 *
 *   1. another tool called from inside an approved call asks for its own
 *      approval; denied, it does not run
 *   2. inside it, the outer call's level grant does not apply
 *   3. a controller question about something else is asked
 *   4. a controller question naming what was approved is not asked again,
 *      once per call
 *   5. the registry's question for the same tool and target is not asked
 *      again; for another target it is
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-nested-approval-'));
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { currentApproval } = await import('../security/approvalScope.js');
const { permissionSession } = await import('../control/permissionSession.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

// Every question that reaches the owner, and the owner's answers in order.
const asked: Array<{ action: string; target: string; tool?: string }> = [];
let answers: boolean[] = [];
(approvalGate as any).ask = async (request: any) => {
  asked.push({ action: request.action, target: request.target, tool: request.tool });
  return answers.shift() ?? false;
};

function register(name: string, risk: number, execute: (args: any) => Promise<string>): void {
  toolRegistryV2.register({
    name,
    description: `Stand-in level-${risk} tool.`,
    riskLevel: risk >= 3 ? 'high' : risk === 2 ? 'medium' : 'low',
    ...(risk >= 2 ? { requiredLevel: 2 } : {}),
    meta: { category: 'SYSTEM', risk, reversible: 'no', external: 'none', effect: 'Test effect.', output: { format: 'text', description: 'Text' } },
    inputSchema: {
      target: { type: 'string', description: 'target', required: false },
      command: { type: 'string', description: 'command', required: false },
    },
    fallbacks: [],
    execute,
  } as any);
}

let innerRuns = 0;
let innerSawApproval: unknown = 'not run';
register('test_inner_destructive', 3, async () => { innerRuns++; innerSawApproval = currentApproval(); return 'inner ran'; });

// The outer call starts the inner one and returns: tools above level 1 run one
// at a time, so awaiting it inside would wait on the outer call's own slot.
let nested: Promise<any> = Promise.resolve(null);
register('test_outer_calls_tool', 3, async () => {
  nested = toolRegistryV2.execute('test_inner_destructive', { target: 'everything' });
  return 'outer ran';
});

const controllerAnswers: boolean[] = [];
let controllerQuestions: Array<[string, string]> = [];
register('test_outer_controller', 3, async () => {
  for (const [title, target] of controllerQuestions) controllerAnswers.push(await approvalGate.requestApproval(title, target));
  return 'controller ran';
});

let level2Inside: boolean | null = null;
register('test_level2_outer', 2, async () => {
  await toolRegistryV2.execute('test_level2_probe', {});
  return 'ok';
});
register('test_level2_probe', 0, async () => { level2Inside = permissionSession.checkPermission(2, 'Type text'); return 'probe'; });

// The registry's question for a call, asked again from inside that call.
let sameQuestion: boolean | null = null;
let otherQuestion: boolean | null = null;
register('test_asks_registry_question', 3, async () => {
  const { buildApprovalRequest } = await import('../security/approvalRequest.js');
  const outerCall = currentApproval()!;
  sameQuestion = await approvalGate.requestApproval(buildApprovalRequest({ tool: outerCall.tool, target: outerCall.target ?? '', risk: 3 }));
  otherQuestion = await approvalGate.requestApproval(buildApprovalRequest({ tool: outerCall.tool, target: 'C:\\Windows', risk: 3 }));
  return 'done';
});

console.log('\n=== Nested approvals (SEC-08) ===\n');
permissionSession.activateFullControl(5, 'cli');

console.log('--- 1. Another tool called from inside an approved call ---');
asked.length = 0; answers = [true, false];
const outer = await toolRegistryV2.execute('test_outer_calls_tool', { target: 'notes.txt' });
const nestedResult = await nested;
ok('the outer call was approved and ran', outer.success, outer.error ?? '');
ok('the inner tool was asked about separately', asked.length === 2 && asked[1]!.tool === 'test_inner_destructive', JSON.stringify(asked.map((a) => a.tool)));
ok('…the owner said no, and it did not run', innerRuns === 0 && nestedResult?.error === 'APPROVAL_DENIED', `${innerRuns} run(s), ${nestedResult?.error}`);

asked.length = 0; answers = [true, true];
await toolRegistryV2.execute('test_outer_calls_tool', { target: 'notes.txt' });
await nested;
ok('approved on its own, it runs', innerRuns === 1 && asked.length === 2, `${innerRuns} run(s), ${asked.length} question(s)`);
ok('…under its own approval, not the outer one', (innerSawApproval as any)?.tool === 'test_inner_destructive', JSON.stringify((innerSawApproval as any)?.tool));

console.log('\n--- 2. The outer grant does not reach a nested tool ---');
permissionSession.deactivateFullControl('nested test');
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
asked.length = 0; answers = [true];
const l2 = await toolRegistryV2.execute('test_level2_outer', {});
ok('a level-2 call approved one by one ran', l2.success, l2.error ?? '');
ok('inside it, a different tool does not get level 2', level2Inside === false, String(level2Inside));
delete process.env['JARVIS_LEVEL2_POLICY'];
permissionSession.activateFullControl(5, 'cli');

console.log('\n--- 3/4. A controller\'s own questions ---');
asked.length = 0; answers = [true, false]; controllerAnswers.length = 0;
controllerQuestions = [['Delete File', `Permanently delete: ${path.join(workspace, 'other.txt')}`]];
await toolRegistryV2.execute('test_outer_controller', { target: path.join(workspace, 'notes.txt') });
ok('a question about another file is asked', asked.length === 2 && /other\.txt/.test(asked[1]!.target), JSON.stringify(asked.map((a) => a.target)));
ok('…and the owner\'s no stands', controllerAnswers[0] === false);

asked.length = 0; answers = [true]; controllerAnswers.length = 0;
controllerQuestions = [['Run Shell Command', 'Command: dir C:\\Users']];
await toolRegistryV2.execute('test_outer_controller', { command: 'dir C:\\Users' });
ok('a question naming the approved command is not asked again', asked.length === 1 && controllerAnswers[0] === true, `${asked.length} question(s)`);

asked.length = 0; answers = [true]; controllerAnswers.length = 0;
controllerQuestions = [['Terminate Process', 'Kill process: notepad.exe (PID: 4242)']];
await toolRegistryV2.execute('test_outer_controller', { target: 'notepad' });
ok('a process found by part of its approved name is not asked again', asked.length === 1 && controllerAnswers[0] === true, `${asked.length} question(s)`);

asked.length = 0; answers = [true, false]; controllerAnswers.length = 0;
controllerQuestions = [['Run Shell Command', 'Command: dir'], ['Run Shell Command', 'Command: dir']];
await toolRegistryV2.execute('test_outer_controller', { command: 'dir' });
ok('only once per approved call: a second question is asked', asked.length === 2 && controllerAnswers[0] === true && controllerAnswers[1] === false, `${asked.length} question(s), answers ${controllerAnswers}`);

asked.length = 0; answers = [true, false]; controllerAnswers.length = 0;
controllerQuestions = [['Delete File', 'Permanently delete: C:\\Windows\\kill.txt']];
await toolRegistryV2.execute('test_outer_controller', { action: 'kill', target: 'notepad' });
ok('the action name ("kill") is not taken as an approved target', asked.length === 2, `${asked.length} question(s)`);

console.log('\n--- 5. The registry\'s own question, asked again ---');
asked.length = 0; answers = [true, false];
await toolRegistryV2.execute('test_asks_registry_question', { target: 'report.txt' });
ok('the same tool and target is not asked again', sameQuestion === true);
ok('the same tool with another target is asked', otherQuestion === false && asked.length === 2, `${asked.length} question(s)`);

permissionSession.deactivateFullControl('nested test');
ok('no approval is left in scope', currentApproval() === undefined);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
