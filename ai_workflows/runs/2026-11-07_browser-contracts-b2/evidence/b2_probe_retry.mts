// B2 diagnosis probe (read-only): which browser failures does the action queue treat as final?
import { readFileSync } from 'node:fs';
const src = readFileSync('control/actionQueue.ts', 'utf8');
const m = /const FINAL_FAILURE = (\/.*\/i);/.exec(src)!;
const FINAL = eval(m[1]) as RegExp;
const { CdpUnavailableError } = await import('./perception/cdpClient.ts');
delete process.env['JARVIS_CDP_PORT'];
const own = new CdpUnavailableError(9333).message;
process.env['JARVIS_CDP_PORT'] = '9333';
const set = new CdpUnavailableError(9333).message;
delete process.env['JARVIS_CDP_PORT'];
const cases: [string, string][] = [
  ['CdpUnavailableError, JARVIS\'s own Chrome not running', own],
  ['CdpUnavailableError, JARVIS_CDP_PORT set', set],
  ['socket closed mid-call', 'DevTools: the tab closed the connection'],
  ['socket error mid-call', 'DevTools: the connection failed'],
  ['send on a closed socket', 'The tab connection is closed.'],
  ['CDP command timeout', 'Runtime.evaluate took longer than 5000 ms.'],
  ['page busy', 'The page did not answer within 5000 ms; it may be busy or frozen.'],
  ['tab tools, Chrome not running', "JARVIS's own Chrome is not running, so no tab was changed (it starts when JARVIS opens a page)."],
];
for (const [name, msg] of cases) console.log(`${FINAL.test(msg) ? 'FINAL (no retry)' : 'RETRIED once   '} | ${name} | ${msg.slice(0, 110)}`);
