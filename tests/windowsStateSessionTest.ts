/**
 * tests/windowsStateSessionTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The persistent PowerShell session behind perception/windowsState.ts.
 *
 * PowerShell runs stdin commands one after another. When a query timed out
 * (seen on Windows at startup: "PS query timed out after 6000ms/4000ms"), the
 * old session cleared its state, but the slow command kept running; its late
 * output was then handed to the NEXT query, and every new query queued behind
 * it — one slow poll became a run of timeouts and stale answers.
 *
 * Each query now has its own end marker; late output is discarded; while a
 * slow query is still running new queries are refused (PSBusyError) instead of
 * piling up; a query stuck past the limit restarts the session.
 *
 * And each query is sent as one line. `-Command -` reads stdin like the
 * interactive prompt: a statement over several lines (the window query) waits
 * for a blank line, so on the owner's PC every query timed out after 15 s and
 * the dashboard poll took 6.3 s.
 *
 * A stand-in "PowerShell" (a Node script that follows the prompt's rules)
 * replaces powershell.exe, so this runs anywhere. The last section uses a real
 * PowerShell when there is one (Windows PowerShell on Windows, else pwsh or
 * JARVIS_TEST_PWSH).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PersistentPSSession, PSBusyError, INLINE_SCRIPT } from '../perception/windowsState.js';
import { findPwsh } from './chromeHelper.js';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reads stdin as the PowerShell prompt does: a complete one-line statement
// runs when its line ends; a statement over several lines runs only after a
// blank line. Commands run strictly in order. A command arrives either as text
// before the end line (the old framing) or base64-encoded on one line.
const fakePs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fakeps-')), 'fake-ps.mjs');
fs.writeFileSync(fakePs, `
let partial = '';
let statement = [];
let depth = 0;
let chain = Promise.resolve();
const count = (s, c) => s.split(c).length - 1;
function run(text) {
  const end = text.match(/Write-Output '__JARVIS_END__:(\\d+)'/);
  const encoded = text.match(/FromBase64String\\('([A-Za-z0-9+/=]*)'\\)/);
  const output = end ? text.slice(0, end.index) : text;
  const command = encoded ? Buffer.from(encoded[1], 'base64').toString('utf8').trim() : output.trim();
  chain = chain.then(async () => {
    if (command.includes('HANG')) return new Promise(() => {});
    await new Promise((r) => setTimeout(r, command.includes('SLOW') ? 600 : 20));
    if (command) process.stdout.write('RESULT ' + command + '\\n');
    if (end) process.stdout.write('__JARVIS_END__:' + end[1] + '\\n');
  });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  partial += d;
  let nl;
  while ((nl = partial.indexOf('\\n')) >= 0) {
    const line = partial.slice(0, nl);
    partial = partial.slice(nl + 1);
    if (statement.length === 0 && line.trim() === '') continue;
    if (statement.length > 0 && line.trim() === '' && depth <= 0) { run(statement.join('\\n')); statement = []; continue; }
    statement.push(line);
    depth += count(line, '{') - count(line, '}');
    if (statement.length === 1 && depth <= 0) { run(line); statement = []; depth = 0; }
  }
});
`);

console.log('\n=== Windows State Session Test ===\n');

const session = new PersistentPSSession(process.execPath, [fakePs], 2_000, 300, 1_500);
session.start();
await sleep(200);

console.log('--- Normal query ---');
ok('answers with its own output', (await session.query('Q:first')) === 'RESULT Q:first');

console.log('\n--- A query over several lines (the window query is one) ---');
const multi = 'try {\n  Q:multi\n} catch {\n  Q:fallback\n}';
let t = Date.now();
let answer = '';
try { answer = await session.query(multi); } catch (e) { answer = (e as Error).message; }
ok('answers at once, not when the next query arrives', answer === `RESULT ${multi}`, `${Date.now() - t} ms: ${answer.slice(0, 60)}`);
ok('…and the next query is not left waiting behind it', (await session.query('Q:after-multi')) === 'RESULT Q:after-multi');

console.log('\n--- Polls at the same time ---');
const together = await Promise.all(['Q:a', 'Q:b', 'Q:c'].map((q) => session.queryWhenFree(q, 2_000).catch((e: Error) => `ERR ${e.message}`)));
ok('each caller waiting for the session gets its own answer', together.join('|') === 'RESULT Q:a|RESULT Q:b|RESULT Q:c', together.join(' | '));

console.log('\n--- A slow query times out ---');
let err: Error | null = null;
try { await session.query('Q:SLOW-one'); } catch (e) { err = e as Error; }
ok('it times out', !!err?.message.includes('timed out'), err?.message);

err = null;
try { await session.query('Q:second'); } catch (e) { err = e as Error; }
ok('the next query is refused while it still runs (not queued behind it)', err instanceof PSBusyError, err?.message);

await sleep(700); // the slow command finishes; its output must be thrown away
ok('after it finishes, the next query gets ITS OWN answer, not the late one', (await session.query('Q:third')) === 'RESULT Q:third');

console.log('\n--- A query that never finishes restarts the session ---');
err = null;
try { await session.query('Q:HANG'); } catch (e) { err = e as Error; }
ok('it times out', !!err?.message.includes('timed out'));
try { await session.query('Q:x'); } catch (e) { err = e as Error; }
ok('then queries are refused as busy', err instanceof PSBusyError);
await sleep(1_600); // past the 1.5 s stale limit
try { await session.query('Q:y'); } catch (e) { err = e as Error; }
await sleep(2_500); // restart delay
ok('the stuck session was replaced', session.isAlive());
ok('and answers again', (await session.query('Q:after-restart')) === 'RESULT Q:after-restart');

session.stop();

console.log('\n--- A real PowerShell ---');
// Windows PowerShell 5.1 is what JARVIS runs; elsewhere PowerShell 7 reads
// stdin the same way.
const realPs = process.platform === 'win32' ? 'powershell' : findPwsh();
if (!realPs) {
  console.log('  (no PowerShell on this machine: set JARVIS_TEST_PWSH to run this section)');
} else {
  const real = new PersistentPSSession(realPs, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']);
  real.start();
  const timed = async (command: string): Promise<{ out: string; ms: number }> => {
    const t0 = Date.now();
    try { return { out: await real.query(command), ms: Date.now() - t0 }; } catch (e) { return { out: `ERR ${(e as Error).message}`, ms: Date.now() - t0 }; }
  };
  // On Windows it reads the windows; elsewhere the Win32 calls fail and the
  // query's own catch answers. Either way it must answer, as JSON.
  const cold = await timed(INLINE_SCRIPT);
  let parsed: any = null;
  try { parsed = JSON.parse(cold.out); } catch { /* reported below */ }
  ok('the window query answers (first query: starts PowerShell, compiles its helper)', Array.isArray(parsed?.openApps) || (parsed?.openApps && typeof parsed.openApps === 'object'), `${cold.ms} ms: ${cold.out.slice(0, 80)}`);
  const warm = await timed(INLINE_SCRIPT);
  ok('again on the running session: under 4000 ms', !warm.out.startsWith('ERR') && warm.ms < 4_000, `${warm.ms} ms`);
  const multiLine = await timed("if ($true) {\n  'two'\n  'lines'\n}");
  ok('a command over several lines', multiLine.out.split(/\r?\n/).join(',') === 'two,lines', `${multiLine.ms} ms: ${multiLine.out}`);
  const thrown = await timed("throw 'deliberate'");
  ok('a command that throws still ends (no timeout)', !thrown.out.startsWith('ERR'), `${thrown.ms} ms`);
  const unparsable = await timed('if ( {');
  ok('one that does not parse still ends', !unparsable.out.startsWith('ERR'), `${unparsable.ms} ms`);
  ok('…and the session answers after both', (await timed("'still here'")).out === 'still here');
  real.stop();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
