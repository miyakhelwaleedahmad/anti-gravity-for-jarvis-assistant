/**
 * tests/errorRecoveryTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 11 — permission-aware error recovery, through the real orchestrator
 * with a scripted model, a real headless Chromium, real dev servers:
 *
 *  1. A page on a local port that is down, where JARVIS ran a server before:
 *     the server is started again (level 1, through the registry), the port
 *     answers, the page opens, and JARVIS says what it repaired.
 *  2. Starting a server whose port JARVIS's own old server holds: stopping the
 *     old one needs approval (level 2), the request shows the failure as WHY;
 *     denied → nothing is stopped and the reply says why; approved → the old
 *     process is gone and the new server answers.
 *  3. A tab that is not open but is an address: opened, then read.
 *  4. A file that does not exist: JARVIS asks; nothing is guessed or touched.
 *  5. Repairs stop after 2 rounds when the step keeps failing.
 *  6. Every repair went through the registry (its call history).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { findChromium, startChromium } from './chromeHelper.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!findChromium()) {
  console.error('No Chromium or Chrome found (set JARVIS_TEST_CHROME): this test needs a real browser.');
  process.exit(1);
}

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p11-')));
const workspace = path.join(base, 'jarvis');
const projects = path.join(base, 'projects');
const app = path.join(projects, 'web');
for (const dir of [workspace, path.join(workspace, 'memory'), path.join(workspace, 'data'), app]) fs.mkdirSync(dir, { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_PROJECT_DIRS'] = projects;
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
process.env['JARVIS_DEV_SERVER_START_MS'] = '8000';
process.chdir(workspace);

fs.writeFileSync(path.join(app, 'server.js'), `
  const http = require('http');
  const port = Number(process.env.PORT);
  http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><head><title>Web app ' + req.url + '</title></head><body>hello from the web app</body></html>');
  }).listen(port, '127.0.0.1', () => console.log('ready on http://localhost:' + port));
`);
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'web', private: true, scripts: { dev: 'node server.js' } }, null, 2));

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { listPages } = await import('../perception/cdpClient.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();
await memoryManager.init();

// The scripted model: each planning call takes the next plan; anything else
// (failure diagnosis) is told to abort, so only JARVIS's own recovery repairs.
let plans: Array<Array<{ name: string; args: Record<string, unknown> }>> = [];
const fakeProvider = {
  isConfigured: () => true,
  async chat(req: any) {
    if (req.tools) {
      const next = plans.shift();
      if (next?.length) {
        return { content: '', tool_calls: next.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
      }
      return { content: 'Done, sir.' };
    }
    return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' };
  },
  async *streamChat() { yield 'Here it is, sir.'; },
};
modelRouter.registerProvider((modelRouter as any).primary, fakeProvider as any);
modelRouter.registerProvider('openai', fakeProvider as any);

const spoken: string[] = [];
(orchestrator as any).speak = (t: string) => { spoken.push(t); };
const approvals: any[] = [];
let answer = true;
(approvalGate as any).requestApproval = async (request: any) => { approvals.push(request); return answer; };

const freePort = async () => {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};
const answers = async (port: number) => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok).catch(() => false);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const historySince = (n: number) => toolRegistryV2.getHistory(500).slice(n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(request: string, plan: Array<{ name: string; args: Record<string, unknown> }>) {
  plans = [plan];
  spoken.length = 0;
  const before = toolRegistryV2.getHistory(500).length;
  await orchestrator.process(request, 'cli');
  return { said: spoken.join(' | '), calls: historySince(before) };
}

const chrome = await startChromium('about:blank');
process.env['JARVIS_CDP_PORT'] = String(chrome.port);
const port = await freePort();

console.log('\n=== Error Recovery Test ===\n');
try {
  await sleep(500);

  console.log('--- 1. A server that is down, which JARVIS ran before ---');
  let r = await toolRegistryV2.execute('dev', { action: 'start_server', project: app, script: 'dev', port });
  const firstPid = JSON.parse(r.output)?.pid;
  ok('(setup) JARVIS starts the server once, then it stops', r.success && await answers(port));
  answer = true;
  await toolRegistryV2.execute('dev', { action: 'stop_server', project: app });
  ok('(setup) the port is now closed', !(await answers(port)) && !alive(firstPid));
  approvals.length = 0;
  let out = await ask('open my web app', [{ name: 'browser_navigate', args: { action: 'go', url: `http://127.0.0.1:${port}/` } }]);
  ok('the failed step is repaired by starting that server, and JARVIS says so',
    /I started the dev server of web on port \d+ first, because nothing answers on port \d+/.test(out.said), out.said);
  ok('the port answers again', await answers(port));
  ok('the page opened in the tab after the repair', (await listPages(chrome.port)).some((p) => p.url === `http://127.0.0.1:${port}/`),
    JSON.stringify((await listPages(chrome.port)).map((p) => p.url)));
  ok('the repair went through the registry (dev start_server in its history), with no approval at level 1',
    out.calls.some((c) => c.tool === 'dev' && (c.args as any).action === 'start_server' && c.success) && approvals.length === 0,
    out.calls.map((c) => `${c.tool}:${(c.args as any).action ?? ''}:${c.success}`).join(' '));

  console.log('\n--- 2. The port is held by JARVIS\'s own old server ---');
  const holder = (JSON.parse((await toolRegistryV2.execute('dev', { action: 'servers' })).output)?.servers ?? []).find((s: any) => s.port === port)?.pid;
  approvals.length = 0;
  answer = false;
  out = await ask('start my web app', [{ name: 'dev', args: { action: 'start_server', project: app, script: 'dev', port } }]);
  const request = approvals.find((a) => /Stop a development server/.test(a.action));
  ok('stopping the old server asks first (level 2), with the failure as WHY', request?.risk === 2
    && /repair this: port \d+ is held by a server JARVIS started earlier/.test(request?.why ?? ''), JSON.stringify({ action: request?.action, why: request?.why, risk: request?.risk }));
  ok('denied: nothing is stopped, the server still answers', typeof holder === 'number' && alive(holder) && await answers(port));
  ok('…and the reply says what was needed and why it was not done',
    /I wanted to stop the old dev server \(process \d+\) on port \d+, but it was not approved/.test(out.said), out.said);
  approvals.length = 0;
  answer = true;
  out = await ask('start my web app', [{ name: 'dev', args: { action: 'start_server', project: app, script: 'dev', port } }]);
  await sleep(300);
  const newPid = (JSON.parse((await toolRegistryV2.execute('dev', { action: 'servers' })).output)?.servers ?? []).find((s: any) => s.port === port)?.pid;
  ok('approved: the old process is gone, a new server answers, JARVIS says what it did', !alive(holder) && typeof newPid === 'number'
    && newPid !== holder && await answers(port) && /I stopped the old dev server/.test(out.said), `${holder} → ${newPid}: ${out.said}`);

  console.log('\n--- 3. A tab that is not open ---');
  out = await ask('read the about page of my app', [{ name: 'browser_read_page', args: { tab: `127.0.0.1:${port}/about` } }]);
  ok('the address is opened in a new tab, then read', /I opened http:\/\/127\.0\.0\.1:\d+\/about in a new tab first/.test(out.said)
    && (await listPages(chrome.port)).some((p) => p.url === `http://127.0.0.1:${port}/about`)
    && out.calls.some((c) => c.tool === 'browser_read_page' && c.success), out.said);

  console.log('\n--- 4. A file that does not exist ---');
  const missing = path.join(base, 'notes', 'missing.txt');
  const other = path.join(workspace, 'other.txt');
  fs.writeFileSync(other, 'x');
  out = await ask('compare my notes with the other file', [{ name: 'files', args: { action: 'compare', path: missing, other } }]);
  ok('JARVIS asks where it is, and touches nothing', /I could not find .*missing\.txt, sir\. Tell me where it is; I will not guess\./.test(out.said)
    && out.calls.every((c) => c.tool === 'files') && fs.readFileSync(other, 'utf8') === 'x', out.said);

  console.log('\n--- 5. At most two repair rounds ---');
  // A tool with a clean record: the planner's own check refuses a plan whose
  // tool failed often just before (browser_read_page failed in part 3).
  const tool = toolRegistryV2.get('browser_page_structure') as any;
  const real = tool.execute;
  tool.execute = async () => `Error: No open tab matches "127.0.0.1:${port}/flaky".`;
  try {
    out = await ask('read the flaky page', [{ name: 'browser_page_structure', args: { tab: `127.0.0.1:${port}/flaky` } }]);
  } finally {
    tool.execute = real;
  }
  const flakyTabs = (await listPages(chrome.port)).filter((p) => p.url === `http://127.0.0.1:${port}/flaky`).length;
  ok('two repairs, then an honest stop', flakyTabs === 2 && /I repaired it 2 times, sir, but the step still fails: no tab shows 127\.0\.0\.1:\d+\/flaky/.test(out.said),
    `${flakyTabs} tabs: ${out.said}`);
  ok('each repair went through the registry', out.calls.filter((c) => c.tool === 'browser_tab' && (c.args as any).action === 'new').length === 2,
    out.calls.map((c) => c.tool).join(' '));
} finally {
  await toolRegistryV2.execute('dev', { action: 'stop_server', project: app }).catch(() => undefined);
  await chrome.stop();
}

try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
fs.rmSync(base, { recursive: true, force: true });
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
