/**
 * tests/scenarios/harness.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a test: the world the P13 scenarios run in (docs/upgrade/phases/
 * phase-13-integration.md). Everything JARVIS observes here is real:
 *
 *  - a headless Chromium with a throwaway profile and a debugging port;
 *  - a local test site (three pages; one title holds a fake token);
 *  - two projects in the project folder, each a package with a server script:
 *    `web` (a website, a git repository with one uncommitted change) and
 *    `api` (a backend). JARVIS starts them through its `dev` tool. Both can be
 *    made to crash (`/crash`, which logs a fake password first) or to stop
 *    answering while the process lives on (`/close`);
 *  - HOME and USERPROFILE point at a temporary folder, so "Downloads" is a
 *    temporary folder with two files — the user's real one is never named;
 *  - the model is scripted: each planning request takes the next plan. Every
 *    request is counted and kept, after the model router's redaction, which
 *    is what a real provider would receive.
 *
 * `createWorld()` must run before `loadJarvis()`: JARVIS reads some settings
 * (ports, project folders, timeouts) when its modules load.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { freePort, startChromium, type RunningChrome } from '../chromeHelper.js';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Fake credentials planted where JARVIS can see them; none may reach the model or the speaker. */
export const PLANTED = {
  // Built at run time, so the repository holds no credential-shaped string.
  tabToken: 'ghp_' + 'Z9'.repeat(18),
  logPassword: 'hunter2-' + 'scenario'.repeat(2),
  envKey: 'AKIA' + 'SCENARIO' + 'TESTKEY0',
};

export interface World {
  base: string;
  workspace: string;
  home: string;
  downloads: string;
  projects: string;
  web: { dir: string; port: number };
  api: { dir: string; port: number };
  site: { port: number; url: (p?: string) => string; close: () => Promise<void> };
  chrome: RunningChrome;
  close: () => Promise<void>;
}

const SERVER_JS = (name: string, title: string) => `
const http = require('http');
const port = Number(process.env.PORT);
let server;
server = http.createServer((req, res) => {
  if (req.url === '/crash') {
    res.end('bye');
    console.error('Error: lost the connection to the database (DB_PASSWORD=' + process.env.SCENARIO_DB_PASSWORD + ')');
    console.error('    at connect (${name}/db.js:12:7)');
    setTimeout(() => process.exit(1), 50);
    return;
  }
  if (req.url === '/close') {
    res.end('closing');
    server.close();
    setInterval(() => {}, 1 << 30); // the process lives on, the port is closed
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<html><head><title>${title}</title></head><body><h1>${title}</h1><p>' + req.url + '</p></body></html>');
}).listen(port, '127.0.0.1', () => console.log('${name} ready on http://localhost:' + port));
`;

function writeProject(dir: string, name: string, script: string, title: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), SERVER_JS(name, title));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { [script]: 'node server.js' } }, null, 2));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

async function startSite(): Promise<World['site']> {
  const pages: Record<string, string> = {
    '/': '<title>Shop - Home</title><h1>Shop</h1><p>Spring sale.</p>',
    '/docs': '<title>Docs - Getting started</title><h1>Docs</h1>',
    '/deploy': `<title>Deploy key ${PLANTED.tabToken}</title><h1>Deploy</h1>`,
  };
  const server = http.createServer((req, res) => {
    const page = pages[req.url ?? '/'];
    res.statusCode = page ? 200 : 404;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head>${page ?? '<title>Not found</title>'}</head><body></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    url: (p = '/') => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function createWorld(): Promise<World> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p13-')));
  const workspace = path.join(base, 'jarvis');
  const home = path.join(base, 'home');
  const downloads = path.join(home, 'Downloads');
  const projects = path.join(base, 'projects');
  for (const dir of [path.join(workspace, 'memory'), path.join(workspace, 'data'), downloads, path.join(home, 'Documents'), projects]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(downloads, 'report.pdf'), 'report');
  fs.writeFileSync(path.join(downloads, 'photo.jpg'), 'photo');

  const web = { dir: path.join(projects, 'web'), port: await freePort() };
  const api = { dir: path.join(projects, 'api'), port: await freePort() };
  writeProject(web.dir, 'web', 'dev', 'Web app');
  writeProject(api.dir, 'api', 'start', 'API');
  fs.writeFileSync(path.join(web.dir, '.env'), `AWS_ACCESS_KEY_ID=${PLANTED.envKey}\n`);
  fs.writeFileSync(path.join(web.dir, '.gitignore'), '.env\n');
  git(web.dir, 'init', '-q', '-b', 'main');
  git(web.dir, '-c', 'user.name=Scenario', '-c', 'user.email=scenario@example.invalid', 'add', '.');
  git(web.dir, '-c', 'user.name=Scenario', '-c', 'user.email=scenario@example.invalid', 'commit', '-q', '-m', 'first');
  fs.appendFileSync(path.join(web.dir, 'server.js'), '\n// work in progress\n');

  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
  process.env['JARVIS_DATA_ROOT'] = workspace;
  process.env['JARVIS_PROJECT_DIRS'] = projects;
  process.env['JARVIS_DEV_PORTS'] = `${web.port},${api.port}`;
  process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
  process.env['JARVIS_DEV_SERVER_START_MS'] = '8000';
  process.env['SCENARIO_DB_PASSWORD'] = PLANTED.logPassword;
  process.chdir(workspace);

  const site = await startSite();
  const chrome = await startChromium('about:blank');
  process.env['JARVIS_CDP_PORT'] = String(chrome.port);

  return {
    base, workspace, home, downloads, projects, web, api, site, chrome,
    async close() {
      await chrome.stop().catch(() => undefined);
      await site.close().catch(() => undefined);
      process.chdir(os.tmpdir());
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

export interface Plan { name: string; args: Record<string, unknown> }

export async function loadJarvis() {
  const { registerAllTools } = await import('../../core/tools/index.js');
  const { SkillLoader } = await import('../../core/skillLoader.js');
  const { toolRegistryV2 } = await import('../../core/toolRegistryV2.js');
  const { orchestrator } = await import('../../core/orchestrator.js');
  const { modelRouter } = await import('../../bridge/modelRouter.js');
  const { memoryManager } = await import('../../memory/memoryManager.js');
  const { approvalGate } = await import('../../security/approvalGate.js');
  const { nodeBridge } = await import('../../bridge/nodeBridge.js');

  registerAllTools();
  await new SkillLoader(path.join(repo, 'skills')).loadSkills();
  approvalGate.attachConsole(); // as in the running app: typed answers reach the gate
  await memoryManager.init();

  // The scripted model. Planning requests (with tools) take the next plan;
  // a reply is a plain sentence; anything else (failure analysis) aborts.
  const plans: Plan[][] = [];
  const requests: string[] = [];
  let count = 0;
  const provider = {
    isConfigured: () => true,
    async chat(req: any) {
      count++;
      requests.push(JSON.stringify(req.messages ?? req));
      if (req.tools) {
        const next = plans.shift();
        if (next?.length) {
          return { content: '', tool_calls: next.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
        }
        return { content: 'Done, sir.' };
      }
      return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' };
    },
    async *streamChat(req: any) {
      count++;
      requests.push(JSON.stringify(req.messages ?? req));
      yield 'Done, sir.';
    },
  };
  modelRouter.registerProvider((modelRouter as any).primary, provider as any);
  modelRouter.registerProvider('openai', provider as any);

  // What JARVIS says, and a speaker on which each sentence plays for 150 ms
  // (the approval gate listens only after its request has been said).
  const spoken: string[] = [];
  (orchestrator as any).speak = (t: string) => { spoken.push(t); };
  const said: string[] = [];
  (nodeBridge as any).speakToClients = (text: string) => {
    said.push(text);
    nodeBridge.ttsStartedMs = Date.now();
    setTimeout(() => { nodeBridge.ttsEndedMs = Date.now(); }, 150);
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** An approval is on display and JARVIS has finished asking (plus the echo tail). */
  async function whenAsked(stop: () => boolean = () => false, timeoutMs = 20_000): Promise<any> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !stop()) {
      const p = (approvalGate as any).pending;
      if (p && Date.now() >= p.listeningFrom && nodeBridge.ttsEndedMs >= nodeBridge.ttsStartedMs) {
        await sleep(350);
        return p.request;
      }
      await sleep(25);
    }
    return undefined;
  }

  /**
   * Say or type `text`. `plans` feed the scripted model; `answer` (when given)
   * runs once an approval is on display, as the user would answer it.
   */
  async function ask(text: string, opts: { source?: 'voice' | 'cli'; plans?: Plan[][]; answer?: (request: any) => void | Promise<void> } = {}) {
    plans.splice(0, plans.length, ...(opts.plans ?? []));
    spoken.length = 0;
    said.length = 0;
    const llmBefore = count;
    const historyBefore = toolRegistryV2.getHistory(500).length;
    const approvalsBefore = approvalGate.recentDecisions(50).length;
    let finished = false;
    const run = orchestrator.process(text, opts.source ?? 'voice').finally(() => { finished = true; });
    let request: any;
    if (opts.answer) {
      request = await whenAsked(() => finished);
      if (request) await opts.answer(request);
    }
    await run;
    await sleep(50);
    return {
      reply: spoken.join(' '),
      said: [...said],
      llm: count - llmBefore,
      calls: toolRegistryV2.getHistory(500).slice(historyBefore),
      decisions: approvalGate.recentDecisions(50).slice(approvalsBefore),
      request,
    };
  }

  return {
    toolRegistryV2, orchestrator, approvalGate, nodeBridge, memoryManager,
    ask, whenAsked, sleep,
    llm: { requests, count: () => count },
  };
}

/** `fetch` that answers false instead of throwing. */
export async function answers(port: number, p = '/'): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.ok).catch(() => false);
}
