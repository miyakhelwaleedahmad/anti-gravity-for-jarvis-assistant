/**
 * tests/requestTraceLogTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-07: one request can be followed in one log file.
 *
 * The structured log (data/logs/jarvis.*.jsonl) carried the request's trace
 * id, but only for task-graph events. State changes went to the console,
 * approval decisions to security_audit.log, tool calls to the registry's
 * memory and the sandbox's tool_audit.log, so a request had to be pieced
 * together from four places.
 *
 * One traced request: a state change, a tool call, a call the owner approves
 * at the console, and a command the safety policy refuses. The structured
 * log holds each under the request's trace id, and none of the arguments
 * (they can carry paths and the owner's text).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-trace-log-')));
for (const d of ['memory', 'data', path.join('data', 'logs')]) fs.mkdirSync(path.join(root, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['JARVIS_LEVEL2_POLICY'] = 'ask'; // a level-3 call asks instead of needing full control first

const { wireExecutionTracing } = await import('../monitoring/traceWiring.js');
const { beginTrace } = await import('../core/traceContext.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { registerAllTools } = await import('../core/tools/index.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tool = (name: string, risk: number): any => ({
  name,
  description: `Stand-in tool ${name}.`,
  riskLevel: risk >= 3 ? 'high' : risk === 2 ? 'medium' : 'low',
  meta: { category: 'SYSTEM', risk, reversible: 'yes', external: 'none', effect: 'Test.', output: { format: 'text', description: 'Text' } },
  inputSchema: { q: { type: 'string', description: 'q', required: false } },
  fallbacks: [],
  async execute() { return `${name} ok`; },
});
toolRegistryV2.register(tool('trace_read', 0));
toolRegistryV2.register(tool('trace_risky', 3));
registerAllTools();

wireExecutionTracing();
approvalGate.attachConsole();
const SECRET_ARG = 'private-argument-text-0193';

console.log('\n=== One request in one log file (ARCH-07) ===\n');
// The trace entries go to the file only: the console already says these
// things in its own words, and doubling them was the noise ARCH-07 is about.
const consoleLines: string[] = [];
const realLog = console.log;
console.log = (...parts: unknown[]) => { consoleLines.push(parts.map(String).join(' ')); realLog(...parts); };
const trace = beginTrace('cli', 'trace test request');
agentStateMachine.transition(AgentState.PLANNING);
const read = await toolRegistryV2.execute('trace_read', { q: SECRET_ARG });
const risky = toolRegistryV2.execute('trace_risky', { q: SECRET_ARG });
for (let i = 0; i < 250 && !(approvalGate as any).pending; i++) await sleep(20);
const answered = approvalGate.offerConsoleAnswer('approve');
const riskyResult = await risky;
const refused = await toolRegistryV2.execute('run_command', { command: `format c: ${SECRET_ARG}` });
agentStateMachine.reset();
console.log = realLog;
ok('(setup) a read ran, an approved call ran, a command off the allow-list was refused', read.success && answered && riskyResult.success && !refused.success,
  `${read.success} ${answered} ${riskyResult.success} ${refused.success}`);

await sleep(600); // the log writes through a stream
const logs = path.join(root, 'data', 'logs');
const text = fs.readdirSync(logs).filter((f) => /^jarvis.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(logs, f), 'utf8')).join('');
const entries = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const mine = entries.filter((e: any) => e.correlationId === trace);
const show = (e: any) => `${e.message}:${JSON.stringify(e.data ?? {}).slice(0, 80)}`;

ok('a state change, under the trace id', mine.some((e: any) => e.message === 'state_transition' && e.data?.from === 'IDLE' && e.data?.to === 'PLANNING'), mine.map(show).join(' | ').slice(0, 300));
ok('the tool call, with its outcome', mine.some((e: any) => e.message === 'tool_call' && e.data?.tool === 'trace_read' && e.data?.success === true));
ok('the approval asked and the owner\'s decision', mine.some((e: any) => e.data?.eventType === 'APPROVAL_REQUESTED' && e.data?.toolName === 'trace_risky')
  && mine.some((e: any) => e.data?.eventType === 'APPROVAL_GRANTED' && e.data?.decidedBy === 'console'));
ok('…and the approved call ran', mine.some((e: any) => e.message === 'tool_call' && e.data?.tool === 'trace_risky' && e.data?.success === true));
ok('the refused call, with its reason', mine.some((e: any) => e.data?.eventType === 'COMMAND_DENIED' && e.data?.toolName === 'run_command' && /Refused/i.test(String(e.data?.reason))),
  mine.filter((e: any) => e.data?.eventType).map(show).join(' | ').slice(0, 300));
ok('no argument text in the log', !text.includes(SECRET_ARG));
const echoed = consoleLines.filter((l) => /\[(State|Security|Tool)\]/.test(l));
ok('the trace entries are not printed on the console as well', echoed.length === 0, echoed.slice(0, 2).join(' | '));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
