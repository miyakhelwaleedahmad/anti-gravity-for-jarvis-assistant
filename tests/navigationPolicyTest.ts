/**
 * tests/navigationPolicyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-04 / SEC-17: where a browser may be sent, decided in code.
 *
 *   - local and private-network addresses are recognised (127/8, 10/8,
 *     172.16/12, 192.168/16, 169.254/16, localhost, *.local, ::1, fc00::/7)
 *   - opening one the request did not name is level 2 (asks); named, or a dev
 *     server JARVIS started, keeps its normal level
 *   - an agent opening a site its task does not name is level 2, above an
 *     agent's limit of 1: refused, so an agent cannot carry data to a new site
 *   - a public address that redirects the tab to a local address is not
 *     followed (real Chromium, the public name mapped to the local test server)
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { findChromium, startChromium } from './chromeHelper.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-nav-policy-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const { isPrivateAddress, navigationLevel } = await import('../security/browserPolicy.js');
const { assessRisk } = await import('../security/riskEngine.js');
const { beginTrace } = await import('../core/traceContext.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const nav = (url: string) => assessRisk({ tool: 'browser_navigate', args: { action: 'go', url }, baseRisk: 1 }).level;

console.log('\n=== Navigation policy (SEC-04, SEC-17) ===\n');

console.log('--- 1. Local and private addresses ---');
const local = ['http://127.0.0.1:8000/docs', 'localhost:3000', 'http://10.0.0.1/', 'http://172.20.1.1/', 'http://192.168.1.1/admin', 'http://169.254.169.254/latest', 'http://printer.local/', 'http://[::1]:9000/', 'http://[fd00::1]/'];
const publicOnes = ['https://example.com/', 'http://172.32.0.1/', 'https://192.169.1.1/', 'https://news.ycombinator.com'];
ok('recognised as local/private', local.every(isPrivateAddress), local.filter((u) => !isPrivateAddress(u)).join(' '));
ok('public addresses are not', publicOnes.every((u) => !isPrivateAddress(u)), publicOnes.filter(isPrivateAddress).join(' '));

console.log('\n--- 2. The level of opening them ---');
beginTrace('cli', 'summarise this article for me');
ok('a local admin page the request did not name: level 2 (asks)', nav('http://127.0.0.1:8000/docs') === 2);
ok('the router page, unnamed: level 2', nav('http://192.168.1.1/') === 2);
beginTrace('cli', 'open localhost:3000 in the browser');
ok('a local address the user named ("localhost:3000"): its normal level', nav('http://localhost:3000/') === 1);
beginTrace('cli', 'open 192.168.1.1 so I can check my router');
ok('the router, when the user names it: its normal level', nav('http://192.168.1.1/') === 1);
ok('a JARVIS-started dev server counts as named (trusted local)', navigationLevel('http://127.0.0.1:4321/', 'open my app', false, () => true).level === 0);
beginTrace('cli', 'open example.com');
ok('a public site from the foreground: its normal level', nav('https://example.com/') === 1);

console.log('\n--- 3. Agents ---');
const asAgent = <T>(request: string, fn: () => Promise<T>) => runAsAgent({ rootTaskId: 'r', taskId: 't', agentId: 'a', agentPath: 'Browser Agent', request, source: 'cli' }, fn);
ok('an agent opening a site its task names: its normal level', await asAgent('read the docs on playwright.dev', async () => nav('https://playwright.dev/docs')) === 1);
ok('an agent opening a site its task does not name (a link from a page it read): level 2, over its limit', await asAgent('read the docs on playwright.dev', async () => nav('https://attacker.example/?q=secret')) === 2);
ok('…also through a new tab', await asAgent('read the docs on playwright.dev', async () =>
  assessRisk({ tool: 'browser_tab', args: { action: 'new', url: 'https://attacker.example/' }, baseRisk: 1 }).level) === 2);
ok('…and through control_browser open_url', await asAgent('read the docs on playwright.dev', async () =>
  assessRisk({ tool: 'control_browser', args: { action: 'open_url', target: 'https://attacker.example/' }, baseRisk: 1 }).level) === 2);

console.log('\n--- 4. A redirect to a local address (real Chromium) ---');
if (!findChromium()) {
  console.log('  (skipped: no Chromium or Chrome; set JARVIS_TEST_CHROME)');
} else {
  const site = http.createServer((req, res) => {
    if (req.url === '/go') { res.writeHead(302, { Location: `http://127.0.0.1:${(site.address() as net.AddressInfo).port}/admin` }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><head><title>${req.url === '/admin' ? 'Local admin' : 'Public page'}</title></head><body>${req.url}</body></html>`);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const port = (site.address() as net.AddressInfo).port;
  const chrome = await startChromium('about:blank', [`--host-resolver-rules=MAP public.example 127.0.0.1`]);
  process.env['JARVIS_CDP_PORT'] = String(chrome.port);
  try {
    const agent = await import('../control/browserAgent.js');
    const { listPages } = await import('../perception/cdpClient.js');
    for (let i = 0; i < 50 && !(await listPages(chrome.port)).length; i++) await new Promise((r) => setTimeout(r, 100));
    const direct = await agent.navigate({ action: 'go', url: `http://public.example:${port}/page` });
    ok('(setup) the public name opens normally', direct.success && direct.check?.status === 'verified', direct.check?.evidence ?? direct.error);
    const r = await agent.navigate({ action: 'go', url: `http://public.example:${port}/go` });
    const pages = await listPages(chrome.port);
    ok('a redirect to 127.0.0.1 is reported as not done', r.check?.status === 'failed' && /local network address/.test(r.check?.evidence ?? ''), r.check?.evidence ?? r.error);
    ok('…and the tab no longer shows the local page', !pages.some((p) => p.title === 'Local admin'), pages.map((p) => `${p.url} [${p.title}]`).join(' '));
  } finally {
    await chrome.stop();
    site.close();
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
