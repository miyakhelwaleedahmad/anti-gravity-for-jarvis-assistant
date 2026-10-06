/**
 * tests/approvalGateStructuredTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3 — the approval request (docs/upgrade/PERMISSION_MODEL.md):
 *
 *  1. The request shows ACTION, WHY, TARGET, EXPECTED EFFECT, RISK and
 *     REVERSIBILITY and asks "Do you approve this action?".
 *  2. Typed answers: APPROVE / YES / CONFIRM approve; anything else denies; an
 *     answer typed when nothing is displayed approves nothing.
 *  3. Spoken answers count only after JARVIS has finished asking and within
 *     10 s; its own voice saying "confirm" does not approve; an unrelated
 *     sentence denies; "yes" with nothing pending approves nothing.
 *  4. Level 4: only `APPROVE <code>` typed; voice cannot approve it.
 *  5. One request on display at a time.
 *  6. Each decision is on the task step, the goal and the audit log; secrets
 *     in a request are not shown or logged.
 *  7. The controllers' older calls still work.
 *
 * Runs the real gate, registry and orchestrator in a throwaway data folder.
 * Only the person (typed and spoken answers) and the speaker's timing are
 * simulated; nothing on the PC is touched (tool bodies are stubbed).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-approval-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_MIN_TOOL_GAP_MS'] = '0';
delete process.env['JARVIS_LEVEL2_POLICY'];
delete process.env['JARVIS_DEFAULT_PERMISSION_LEVEL'];
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { goalManager } = await import('../core/goalManager.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
let gateModule: any = {};
let requestModule: any = {};
try { gateModule = await import('../security/approvalGate.js'); } catch { /* */ }
try { requestModule = await import('../security/approvalRequest.js' as string); } catch { /* not on the old code */ }
let redactorModule: any = {};
try { redactorModule = await import('../security/redactor.js' as string); } catch { /* not on the old code */ }
const { approvalGate } = gateModule;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();
await goalManager.init();

// Everything printed, to read the approval block back.
const printed: string[] = [];
const realLog = console.log.bind(console);
console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); realLog(...args); };

// The speaker: records what JARVIS says and reports it as spoken for 200 ms.
const spokenToUser: string[] = [];
(nodeBridge as any).speakToClients = (text: string) => {
  spokenToUser.push(text);
  const started = Date.now() + 1;
  setTimeout(() => { nodeBridge.ttsStartedMs = started; }, 1);
  setTimeout(() => { nodeBridge.ttsEndedMs = Date.now(); }, 200);
};

// The CLI loop owns stdin in the real app; here the test types into it.
approvalGate?.attachConsole?.();

function pending(): any { return (approvalGate as any)?.pending ?? null; }
function lastDecision(): any { return (approvalGate as any)?.recentDecisions?.(1)?.[0]; }

/** Wait until a request is displayed (and, for voice, JARVIS has finished asking). */
async function whenAsked(voice = false, timeoutMs = 5000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = pending();
    if (p && (!voice || (Number.isFinite(p.listeningFrom) && Date.now() >= p.listeningFrom))) return p;
    await sleep(20);
  }
  return null;
}

async function typeWhenAsked(line: string): Promise<boolean> {
  const p = await whenAsked();
  return !!p && approvalGate.offerConsoleAnswer(line);
}

async function sayWhenAsked(text: string): Promise<boolean> {
  const p = await whenAsked(true);
  return !!p && approvalGate.offerVoiceAnswer(text);
}

function build(overrides: Record<string, unknown> = {}): any {
  return requestModule.buildApprovalRequest({
    tool: 'control_process', action: 'kill', target: 'notepad', request: 'end the frozen notepad process',
    reason: 'control_process kill is risk 3 in its metadata', risk: 3,
    effect: 'Ends a process; its unsaved work is lost.', reversible: 'no', source: 'cli', ...overrides,
  });
}

/** Swap a tool's body for one check, then restore. */
async function withTool<T>(name: string, body: (args: any) => Promise<string>, fn: () => Promise<T>): Promise<T> {
  const tool = toolRegistryV2.get(name)! as any;
  const saved = tool.execute;
  tool.execute = body;
  try { return await fn(); } finally { tool.execute = saved; }
}

console.log('\n=== Approval Gate (structured) Test ===\n');

console.log('--- 1. What the request shows ---');
if (requestModule.buildApprovalRequest) {
  const r = build();
  const block = requestModule.formatApprovalRequest(r, 30) as string;
  for (const field of ['ACTION:', 'WHY:', 'TARGET:', 'EXPECTED EFFECT:', 'RISK:', 'REVERSIBILITY:', 'Do you approve this action?']) {
    ok(`the block shows ${field}`, block.includes(field));
  }
  ok('ACTION is a readable title', /ACTION:\s+End process/.test(block), block.split('\n').find((l) => l.includes('ACTION:')));
  ok('WHY quotes the request', block.includes('You asked: "end the frozen notepad process"'));
  ok('EXPECTED EFFECT and REVERSIBILITY come from the metadata',
    block.includes('Ends a process; its unsaved work is lost.') && /REVERSIBILITY:\s+No/.test(block));
  ok('RISK names the level', /RISK:\s+Level 3 — high/.test(block));
  ok('each request has its own id', build().id !== build().id);
  const spoken = requestModule.spokenApprovalRequest(r) as string;
  ok('the spoken version asks the question', spoken.includes('Do you approve this action?') && spoken.includes('end process on notepad'), spoken);
} else {
  ok('approval request module exists', false);
}

console.log('\n--- 2. Typed answers ---');
if (requestModule.buildApprovalRequest) {
  for (const [answer, expected] of [['APPROVE', true], ['yes', true], [' confirm ', true], ['maybe', false], ['', false], ['no', false], ['approve it', false]] as const) {
    const asked = approvalGate.requestApproval(build());
    const taken = await typeWhenAsked(answer);
    const result = await asked;
    ok(`typing "${answer}" ${expected ? 'approves' : 'denies'}`, taken && result === expected, `taken=${taken} result=${result}`);
  }
  ok('a line typed with nothing displayed is not taken as an answer', approvalGate.offerConsoleAnswer('YES') === false);
  const later = await approvalGate.requestApproval(build(), '', '', '', 'cli', 1);
  ok('…and the next request is not approved by it (it times out)', later === false);
  ok('recorded as a timeout', lastDecision()?.by === 'timeout');
}

console.log('\n--- 3. Spoken answers ---');
if (requestModule.buildApprovalRequest) {
  // While JARVIS is still asking, "confirm" is its own voice.
  spokenToUser.length = 0;
  let asked = approvalGate.requestApproval(build({ source: 'voice' }));
  const early = await (async () => { await whenAsked(); await sleep(50); return approvalGate.offerVoiceAnswer('confirm'); })();
  ok('"confirm" heard while JARVIS is asking is not an answer', early === false && pending() !== null);
  ok('JARVIS said the request', spokenToUser.some((t) => t.includes('Do you approve this action?')), spokenToUser.join(' | '));
  ok('"confirm" after it has finished approves', (await sayWhenAsked('confirm')) && (await asked) === true);
  ok('recorded as a spoken answer', lastDecision()?.by === 'voice');

  asked = approvalGate.requestApproval(build({ source: 'voice' }));
  ok('"yes, sir" right after the request approves', (await sayWhenAsked('Yes, sir.')) && (await asked) === true);

  asked = approvalGate.requestApproval(build({ source: 'voice' }));
  ok('"no" denies', (await sayWhenAsked('no')) && (await asked) === false);

  asked = approvalGate.requestApproval(build({ source: 'voice' }));
  const p = await whenAsked(true);
  const echo = approvalGate.offerVoiceAnswer(requestModule.spokenApprovalRequest(p.request));
  ok('the request itself, heard back, is ignored', echo === false && pending() !== null);
  const other = approvalGate.offerVoiceAnswer('what time is it');
  ok('an unrelated sentence denies, and is left to run as a command', other === false && (await asked) === false);

  ok('"yes" with nothing pending approves nothing', approvalGate.offerVoiceAnswer('yes') === false);

  asked = approvalGate.requestApproval(build({ source: 'voice' }), '', '', '', 'voice', 1);
  await whenAsked(true);
  await sleep(1200);
  ok('after the window an answer is not taken', approvalGate.offerVoiceAnswer('confirm') === false && (await asked) === false);

  // JARVIS is still saying something else when it asks: the window waits for
  // that, and then for the request itself.
  {
    const speaker = (nodeBridge as any).speakToClients;
    const t0 = Date.now();
    nodeBridge.ttsEndedMs = t0 - 1000;
    nodeBridge.ttsStartedMs = t0 - 100; // a reply is playing
    (nodeBridge as any).speakToClients = (text: string) => {
      spokenToUser.push(text);
      setTimeout(() => { nodeBridge.ttsEndedMs = Date.now(); }, 2500);          // the reply ends
      setTimeout(() => { nodeBridge.ttsStartedMs = Date.now(); }, 2600);        // the request starts
      setTimeout(() => { nodeBridge.ttsEndedMs = Date.now(); }, 2800);          // and ends
    };
    asked = approvalGate.requestApproval(build({ source: 'voice' }));
    await sleep(2100);
    const during = approvalGate.offerVoiceAnswer('confirm');
    await sleep(600);
    const whileAsking = approvalGate.offerVoiceAnswer('confirm');
    ok('not listening while another reply or the request is still playing', during === false && whileAsking === false && pending() !== null);
    ok('…and listening once both have finished', (await sayWhenAsked('confirm')) && (await asked) === true);
    (nodeBridge as any).speakToClients = speaker;
  }

  // A controller's own question during a spoken request is asked by voice.
  {
    const { beginTrace, endTrace } = await import('../core/traceContext.js');
    beginTrace('voice', 'close visual studio code');
    spokenToUser.length = 0;
    asked = approvalGate.requestApproval('Close Protected App', 'Close app: code');
    const heard = await sayWhenAsked('confirm');
    ok('a controller\'s question during a spoken request is spoken and answered by voice',
      heard && (await asked) === true && spokenToUser.some((t) => /close protected app/i.test(t)), spokenToUser.join(' | '));
    endTrace();
  }
}

console.log('\n--- 4. Level 4 ---');
if (requestModule.buildApprovalRequest) {
  const strong = () => build({ tool: 'control_file', action: 'delete_folder', target: path.join(os.homedir(), 'Downloads'), risk: 4, reversible: 'no', effect: 'Deletes a folder and everything in it.' });
  let r = strong();
  ok('level 4 carries a 4-character code', r.strong === true && /^[A-Z2-9]{4}$/.test(r.code ?? ''), r.code);
  ok('the block asks for it', requestModule.formatApprovalRequest(r, 30).includes(`Type APPROVE ${r.code}`));
  let asked = approvalGate.requestApproval(r);
  ok('"APPROVE" alone denies', (await typeWhenAsked('APPROVE')) && (await asked) === false);
  r = strong();
  asked = approvalGate.requestApproval(r);
  ok('"YES" denies', (await typeWhenAsked('YES')) && (await asked) === false);
  r = strong();
  asked = approvalGate.requestApproval(r);
  ok('"APPROVE <code>" approves', (await typeWhenAsked(`approve ${r.code!.toLowerCase()}`)) && (await asked) === true);
  r = strong();
  const other = strong();
  asked = approvalGate.requestApproval(r);
  ok('another request\'s code denies', (await typeWhenAsked(`APPROVE ${other.code === r.code ? 'ZZZZ' : other.code}`)) && (await asked) === false);

  spokenToUser.length = 0;
  r = { ...strong(), source: 'voice' };
  asked = approvalGate.requestApproval(r, '', '', '', 'voice', 1);
  const took = await (async () => { await whenAsked(true); return approvalGate.offerVoiceAnswer('approve'); })();
  await sleep(50);
  ok('voice cannot approve level 4 (the word is taken, nothing approved)', took === true && pending() !== null);
  ok('JARVIS says why', spokenToUser.some((t) => /Voice cannot approve/.test(t)), spokenToUser.slice(-1).join(''));
  ok('…and it times out denied', (await asked) === false);
}

console.log('\n--- 5. One request at a time ---');
if (requestModule.buildApprovalRequest) {
  const first = build({ target: 'first' });
  const second = build({ target: 'second' });
  const a = approvalGate.requestApproval(first);
  const b = approvalGate.requestApproval(second);
  await whenAsked();
  ok('the first is displayed, the second waits', pending()?.request.id === first.id);
  approvalGate.offerConsoleAnswer('YES');
  await whenAsked();
  ok('answering it displays the second', pending()?.request.id === second.id);
  approvalGate.offerConsoleAnswer('NO');
  ok('each got its own answer', (await a) === true && (await b) === false);
}

console.log('\n--- 6. Recorded, and secrets hidden ---');
let llmCalls = 0;
modelRouter.chat = async (req: any) => {
  llmCalls++;
  if (req.tools) return { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'control_process', arguments: '{"action":"kill","target":"notepad"}' } }] } as any;
  return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' } as any;
};
modelRouter.streamChat = async function* () { llmCalls++; yield 'Done, sir.'; } as any;
(orchestrator as any).speak = () => {};
permissionSession.activateFullControl(5, 'cli');
let ran = 0;
printed.length = 0;
await withTool('control_process', async () => { ran++; return '{"success":true,"message":"Ended notepad."}'; }, async () => {
  const run = orchestrator.process('end the frozen notepad process', 'cli');
  const taken = await typeWhenAsked('APPROVE');
  await run;
  ok('through the orchestrator: asked, approved by typing, and run once', taken && ran === 1, `taken=${taken} ran=${ran}`);
});
const block = printed.join('\n');
ok('the block on screen has the user\'s request and the tool\'s effect',
  block.includes('You asked: "end the frozen notepad process"') && block.includes('Ends a process; its unsaved work is lost.'));
const decision = lastDecision();
ok('the decision names the request, the answer and who gave it',
  !!decision && decision.approved === true && decision.by === 'console' && decision.answer === 'APPROVE' && /^apr_/.test(decision.requestId));
const goals = ((goalManager as any).db?.data?.goals ?? []) as any[];
const withApproval = goals.find((g) => (g.metadata?.approvals ?? []).some((d: any) => d.requestId === decision?.requestId));
ok('the goal carries the decision', !!withApproval, `${goals.length} goal(s)`);
const auditPath = path.join(workspace, 'data', 'logs', 'security_audit.log');
const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
const auditLines = audit.split('\n').filter((l) => decision && l.includes(decision.requestId));
ok('the audit log has the request (six fields) and the decision',
  auditLines.some((l) => l.includes('APPROVAL_REQUESTED') && l.includes('"why"') && l.includes('"expectedEffect"') && l.includes('"reversibility"'))
  && auditLines.some((l) => l.includes('APPROVAL_GRANTED') && l.includes('"decidedBy":"console"')),
  `${auditLines.length} line(s)`);

// The node the approval belongs to.
const { taskGraphEngine, TaskGraphBuilder } = await import('../core/taskGraphEngine.js');
const graph: any = TaskGraphBuilder.fromToolCalls('kill notepad', [
  { id: 'a', function: { name: 'control_process', arguments: '{"action":"kill","target":"notepad"}' } } as any,
]);
const node: any = [...graph.nodes.values()][0];
await withTool('control_process', async () => '{"success":true}', async () => {
  const run = taskGraphEngine.execute(graph, async (tool: string, args: any) => (await toolRegistryV2.execute(tool, args)).output);
  await typeWhenAsked('YES');
  await run;
});
ok('the task step carries its decision', node.approvals?.length === 1 && node.approvals[0].approved === true, JSON.stringify(node.approvals ?? null).slice(0, 100));
permissionSession.deactivateFullControl('approval test');

if (redactorModule.redact) {
  const fakeKey = 'sk-' + 'test'.repeat(6) + 'Xy12';
  const r = build({ target: `curl -H "Authorization: Bearer ${'t'.repeat(24)}" --data api_key=${fakeKey}` });
  const shown = requestModule.formatApprovalRequest(r, 30) as string;
  ok('a key in the target is not shown', !shown.includes(fakeKey) && !shown.includes('t'.repeat(24)) && shown.includes('[REDACTED:'), r.target);
  const asked = approvalGate.requestApproval(r);
  await typeWhenAsked('NO');
  await asked;
  const log = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  ok('…nor written to the audit log', !log.includes(fakeKey));
} else {
  ok('redactor exists', false);
}

console.log('\n--- 7. Older callers ---');
if (approvalGate) {
  printed.length = 0;
  const asked = approvalGate.requestApproval('Close Protected App', 'Close app: code', 'HIGH_RISK');
  const taken = await typeWhenAsked('CONFIRM');
  ok('requestApproval(action, command, risk) still asks and accepts CONFIRM', taken && (await asked) === true);
  const shown = printed.join('\n');
  ok('…and shows the six fields', /ACTION:\s+Close Protected App/.test(shown) && /TARGET:\s+Close app: code/.test(shown) && /REVERSIBILITY:\s+Not stated/.test(shown));
  const why = shown.split('\n').find((l) => l.includes('WHY:')) ?? '';
  ok('a request that has ended is not shown as WHY later', !why.includes('You asked'), why.trim());
  const inner = await (async () => {
    const { runApproved } = await import('../security/approvalScope.js');
    return runApproved({ tool: 'control_app', args: {}, level: 3, grantsLevel: 0, approvedAt: Date.now(), requestId: 'apr_outer' } as any,
      () => approvalGate.requestApproval('Close Protected App', 'Close app: code'));
  })();
  ok('inside an approved call it is not asked again, and is recorded as part of it',
    inner === true && lastDecision()?.by === 'scope' && lastDecision()?.partOf === 'apr_outer');
}

try { await memoryManager.flush(); } catch { /* best effort */ }
permissionSession.shutdown?.();
console.log = realLog;
process.chdir(os.tmpdir());
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
