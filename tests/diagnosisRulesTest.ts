/**
 * tests/diagnosisRulesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 13 — the diagnosis rules (core/diagnosis.ts) and what JARVIS says
 * about them (core/voiceSummaries.ts), for the cases the end-to-end scenarios
 * do not reach. The inputs are readings as `observeApp()` returns them; the
 * scenarios (scenarioIntegrationTest) take real ones.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-diag-')));
process.on('exit', () => fs.rmSync(projects, { recursive: true, force: true }));
for (const [name, scripts] of [['web', { dev: 'vite' }], ['api', { start: 'node server.js' }], ['lib', { test: 'node test.js' }]] as const) {
  fs.mkdirSync(path.join(projects, name));
  fs.writeFileSync(path.join(projects, name, 'package.json'), JSON.stringify({ name, scripts }));
}
process.env['JARVIS_PROJECT_DIRS'] = projects;

const { diagnoseApp, tellingLine, startableProjects } = await import('../core/diagnosis.js');
const voice = await import('../core/voiceSummaries.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sentences = (text: string) => (text.match(/[.!?](\s|$)/g) ?? []).length;
const server = (over: Record<string, unknown>) => ({ port: 3000, project: path.join(projects, 'web'), name: 'web', script: 'dev', pid: 4242, state: 'answers', status: 200, ...over }) as any;
const empty = { servers: [], tabs: [], ports: [], browser: true };

console.log('\n=== Diagnosis Rules Test ===\n');

console.log('--- What it reports without repairing ---');
let d = diagnoseApp({ ...empty, servers: [server({ state: 'http_error', status: 500, line: 'TypeError: cannot read x' })] });
ok('HTTP 500 from a server JARVIS started: reported with its line, no repair, "needs a fix in the code"',
  d.faults.length === 1 && d.faults[0]!.repairs.length === 0 && /HTTP 500/.test(d.faults[0]!.text) && d.faults[0]!.line === 'TypeError: cannot read x'
  && /fix in the code; I changed nothing/.test(voice.diagnosisSummary(d)), voice.diagnosisSummary(d));

d = diagnoseApp({ ...empty, servers: [server({ state: 'taken', status: 500, exit: { code: 1, signal: null, at: '', by: 'itself' } })] });
ok('its port taken by a program JARVIS did not start: reported, nothing stopped or started', d.faults.length === 1 && d.faults[0]!.repairs.length === 0
  && /program I did not start/.test(d.faults[0]!.text), d.faults[0]?.text);

d = diagnoseApp({ ...empty, tabs: [{ id: 't1', title: '127.0.0.1', url: 'http://127.0.0.1:5173/', port: 5173, error: 'ERR_CONNECTION_REFUSED' }] });
let said = voice.diagnosisSummary(d);
ok('a tab with an error for a port JARVIS never served: no guess, a question naming the projects it can start',
  d.faults[0]!.repairs.length === 0 && /connection refused/.test(d.faults[0]!.text) && /Which project should I start: (web or api|api or web)\?/.test(said) && sentences(said) <= 3, said);
ok('…a project without a server script is not offered', !/lib/.test(said) && ['["web","api"]', '["api","web"]'].includes(JSON.stringify(startableProjects())), JSON.stringify(startableProjects()));

d = diagnoseApp({ ...empty, tabs: [{ id: 't2', title: 'example.org', url: 'https://example.org/', error: 'ERR_NAME_NOT_RESOLVED' }] });
said = voice.diagnosisSummary(d);
ok('a site on the internet that cannot be reached: "address not found", check the connection', /address not found/.test(said) && /internet connection/.test(said), said);

d = diagnoseApp({ ...empty, servers: [server({})], tabs: [{ id: 't3', title: 'Web app', url: 'http://127.0.0.1:3000/', port: 3000, status: 200 }] });
said = voice.diagnosisSummary(d);
ok('nothing wrong: "I see no fault", with what answers, and a question', d.faults.length === 0 && /^I see no fault, sir: port 3000, web, answers 200\. What looks wrong\?$/.test(said), said);

d = diagnoseApp(empty);
ok('nothing known at all: it asks which application, naming what it can start', /I do not know which application you mean, sir\. I can start (web or api|api or web); which one\?/.test(d.question ?? ''), d.question);

d = diagnoseApp({ ...empty, servers: [server({})], tabs: [{ id: 't4', title: 'Checkout', url: 'http://127.0.0.1:3000/pay', port: 3000, status: 502 }] });
ok('the server answers but a page got HTTP 502: reported, no reload (that would send the request again)',
  d.faults.length === 1 && d.faults[0]!.repairs.length === 0 && /HTTP 502/.test(d.faults[0]!.text), d.faults[0]?.text);

console.log('\n--- What it repairs ---');
d = diagnoseApp({ ...empty,
  servers: [server({ state: 'stopped', status: undefined, exit: { code: null, signal: 'SIGKILL', at: '', by: 'itself' } })],
  tabs: [{ id: 't5', title: '127.0.0.1', url: 'http://127.0.0.1:3000/', port: 3000, error: 'ERR_CONNECTION_REFUSED' },
    { id: 't6', title: 'Docs', url: 'http://127.0.0.1:3000/docs', port: 3000, status: 200 }] });
ok('stopped from outside: said with the signal; start it, then reload only the tab that showed the error',
  /stopped from outside \(signal SIGKILL\)/.test(d.faults[0]!.text)
  && JSON.stringify(d.faults[0]!.repairs.map((r) => [r.tool, r.args['action'], r.args['tab'] ?? r.args['port']])) === '[["dev","start_server",3000],["browser_navigate","reload","t5"]]',
  JSON.stringify(d.faults[0]!.repairs.map((r) => r.args)));

d = diagnoseApp({ ...empty, servers: [server({ state: 'not_answering', status: undefined })] });
ok('runs but does not answer: stop it (by its pid), then start it', JSON.stringify(d.faults[0]!.repairs.map((r) => [r.tool, r.args['action'], r.args['pid'] ?? r.args['port']])) === '[["dev","stop_server",4242],["dev","start_server",3000]]');

console.log('\n--- What JARVIS says after a repair ---');
const before = { faults: [{ text: 'the web server on port 3000 stopped by itself (exit code 1)', line: 'Error: boom', repairs: [{}] }] };
said = voice.repairSummary(before, ['started it again'], { says: 'start the web server on port 3000 again', reason: 'that failed: the server stopped at once (exit code 1)' }, null);
ok('a repair that failed: what it tried and why it stopped, in words that can be said',
  /I started it again, then wanted to start the web server on port 3000 again, but that failed, the server stopped at once, exit code 1\.$/.test(said) && sentences(said) <= 3, said);
said = voice.repairSummary(before, ['started it again'], null, { faults: [{ text: 'the web server on port 3000 answers with HTTP 500' }] });
ok('the second look still finds a fault: said, not "it answers now"', /but the web server on port 3000 answers with HTTP 500\.$/.test(said) && !/answers now/.test(said), said);
said = voice.repairSummary(before, ['started it again'], null, { faults: [], tabs: [] });
ok('the second look finds nothing: "it answers now"; at most three sentences', /I started it again; it answers now\.$/.test(said) && sentences(said) <= 3, said);

console.log('\n--- Words that can be said ---');
ok('the last error line, not the package manager\'s own or a stack frame',
  tellingLine(['> web@1.0.0 dev', 'ready on http://localhost:3000', 'Error: EADDRINUSE: address already in use', '    at Server.listen (net.js:1:1)', 'npm error code 1']) === 'Error: EADDRINUSE: address already in use');
ok('no error line: none (a "ready" line says nothing about a failure)', tellingLine(['> web@1.0.0 dev', 'ready on http://localhost:3000']) === undefined);
const secretWords = 'log in with ' + 'password' + ': ' + 'hunter2-' + 'abcdef';
said = voice.continueOffer(secretWords, 'it was not approved');
ok('an earlier request is said without a credential in it', !said.includes('hunter2') && /a hidden value/.test(said) && sentences(said) === 3, said);
ok('no symbols or sentence breaks from a log line', voice.sayable('Error: x. (code=1) [REDACTED:secret]') === 'Error, x, code 1, a hidden value', voice.sayable('Error: x. (code=1) [REDACTED:secret]'));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
