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
 * A stand-in "PowerShell" (a Node script) replaces powershell.exe, so this runs
 * anywhere.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PersistentPSSession, PSBusyError } from '../perception/windowsState.js';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reads commands from stdin and answers them strictly in order, like PowerShell.
const fakePs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fakeps-')), 'fake-ps.mjs');
fs.writeFileSync(fakePs, `
let pending = '';
let chain = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  pending += d;
  let m;
  while ((m = pending.match(/^([\\s\\S]*?)Write-Output '__JARVIS_END__:(\\d+)'\\n/))) {
    pending = pending.slice(m[0].length);
    const command = m[1].trim(), id = m[2];
    chain = chain.then(async () => {
      if (command.includes('HANG')) return new Promise(() => {});
      await new Promise((r) => setTimeout(r, command.includes('SLOW') ? 600 : 20));
      process.stdout.write('RESULT ' + command + '\\n__JARVIS_END__:' + id + '\\n');
    });
  }
});
`);

console.log('\n=== Windows State Session Test ===\n');

const session = new PersistentPSSession(process.execPath, [fakePs], 2_000, 300, 1_500);
session.start();
await sleep(200);

console.log('--- Normal query ---');
ok('answers with its own output', (await session.query('Q:first')) === 'RESULT Q:first');

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
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
