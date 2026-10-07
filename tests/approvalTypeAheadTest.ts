/**
 * tests/approvalTypeAheadTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A line typed before an approval request is shown is not an answer to it.
 *
 * Without the CLI loop (pnpm verify:windows, other scripts), the approval gate
 * reads the console itself. A line typed while JARVIS was still busy waits in
 * the console and used to be read as the answer the moment the request
 * appeared: on the owner's PC an extra Enter pressed while JARVIS loaded
 * denied the request before it could be read (verify:windows, 2026-10-07),
 * and a "yes" typed early would have approved a request nobody had seen.
 *
 *  1. An Enter typed early does not deny; the answer typed after it counts.
 *  2. A "yes" typed early does not approve; the "no" typed after it denies.
 *  3. With nothing typed early, the answer typed after the request counts,
 *     and no note about early lines is shown.
 *  4. Early lines are dropped for typed answers during a spoken request too.
 *
 * The console is a stand-in TTY stream; the gate, its request and its
 * decision log are the real ones, in a throwaway data folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-typeahead-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

// The console: a stream the test types into, that says it is a terminal.
const keyboard = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => unknown };
keyboard.isTTY = true;
keyboard.setRawMode = () => keyboard;
Object.defineProperty(process, 'stdin', { value: keyboard, configurable: true });

// What the gate prints.
const printed: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (chunk: unknown, ...rest: unknown[]) => {
  printed.push(String(chunk));
  return (realWrite as any)(chunk, ...rest);
};

const { approvalGate } = await import('../security/approvalGate.js');
const { buildApprovalRequest } = await import('../security/approvalRequest.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastDecision = (): any => approvalGate.recentDecisions(1)[0];

function build(source: 'cli' | 'voice' = 'cli'): any {
  return buildApprovalRequest({
    tool: 'control_process', action: 'kill', target: 'notepad', request: 'end the frozen notepad process',
    reason: 'control_process kill is risk 3 in its metadata', risk: 3,
    effect: 'Ends a process; its unsaved work is lost.', reversible: 'no', source,
  });
}

/** Wait until the gate shows its "Your decision:" prompt. */
async function promptShown(from: number, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (printed.slice(from).some((t) => t.includes('Your decision:'))) return true;
    await sleep(10);
  }
  return false;
}

const NOTE = /typed before this request was shown/;

/** Throw away whatever is still waiting on the stand-in keyboard, so each section starts clean. */
function clearKeyboard(): void {
  while (keyboard.read() !== null) { /* drop */ }
}

console.log('\n=== Approval Type-Ahead Test ===\n');

console.log('--- 1. An Enter typed while JARVIS was busy does not deny ---');
{
  clearKeyboard();
  keyboard.write('\r\n'); // pressed while JARVIS was loading
  const from = printed.length;
  const asked = approvalGate.requestApproval(build());
  const shown = await promptShown(from);
  ok('the prompt is shown', shown);
  keyboard.write('approve\r\n');
  const result = await asked;
  ok('the early Enter is not the answer: the "approve" typed after the request approves', result === true, `result=${result}`);
  ok('the decision records "approve" as the answer', lastDecision()?.answer === 'approve' && lastDecision()?.by === 'console', JSON.stringify(lastDecision()));
  ok('JARVIS says the early line was not an answer', printed.slice(from).some((t) => NOTE.test(t)));
}

console.log('\n--- 2. A "yes" typed early does not approve ---');
{
  clearKeyboard();
  keyboard.write('yes\r\n');
  const from = printed.length;
  const asked = approvalGate.requestApproval(build());
  await promptShown(from);
  keyboard.write('no\r\n');
  const result = await asked;
  ok('the early "yes" does not approve; the "no" typed after the request denies', result === false, `result=${result}`);
  ok('the decision records "no", not "yes"', lastDecision()?.answer === 'no', JSON.stringify(lastDecision()?.answer));
}

console.log('\n--- 3. Nothing typed early: the answer counts, no note ---');
{
  clearKeyboard();
  const from = printed.length;
  const asked = approvalGate.requestApproval(build());
  await promptShown(from);
  keyboard.write('YES\r\n');
  const result = await asked;
  ok('a "YES" typed after the request approves', result === true, `result=${result}`);
  ok('no note about early lines', !printed.slice(from).some((t) => NOTE.test(t)));
}

console.log('\n--- 4. A spoken request: early typed lines are dropped too ---');
{
  // No speaker answers in this test: the gate stops waiting for speech after
  // its own short wait, then listens; typed answers count at once.
  (nodeBridge as any).speakToClients = () => {};
  clearKeyboard();
  keyboard.write('yes\r\n');
  const from = printed.length;
  const asked = approvalGate.requestApproval(build('voice'), '', '', '', 'voice', 5);
  await promptShown(from);
  keyboard.write('no\r\n');
  const result = await asked;
  ok('during a spoken request an early "yes" does not approve; "no" denies', result === false && lastDecision()?.answer === 'no',
    `result=${result} answer=${JSON.stringify(lastDecision()?.answer)}`);
}

(process.stdout as any).write = realWrite;
process.chdir(os.tmpdir());
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
