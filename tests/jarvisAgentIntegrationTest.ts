/**
 * tests/jarvisAgentIntegrationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS using its agents, through the real orchestrator:
 *  - fixed routes: research requests, "what are your agents doing", "how many
 *    agents are running", "show the task tree", "what has each worker
 *    discovered", "which agents failed", "how much work remains", "what
 *    subagents did the research agent create", "stop this research";
 *  - existing routes still work ("open youtube", "stop", app diagnosis);
 *  - a delegated task runs in the background, JARVIS answers other requests
 *    meanwhile, and speaks the result when idle; strong findings go to memory;
 *  - the planner is offered delegate_task; agents can never use it;
 *  - the dashboard lists active agents; the optional A2A endpoint needs a token.
 *
 * Offline: fetch answers with fixed GitHub/Serper data; the model is scripted.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agents-int-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspaceDir, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspaceDir;
process.env['JARVIS_DATA_ROOT'] = workspaceDir;
process.env['SERPER_API_KEY'] = 'test-serper-key-not-real';
process.chdir(workspaceDir);

let slowNetwork = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (slowNetwork) await new Promise((r) => setTimeout(r, slowNetwork));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const repo = (name: string, lang: string, stars: number, desc: string) => ({
    full_name: name, html_url: `https://github.com/${name}`, description: desc, stargazers_count: stars, language: lang,
    license: { spdx_id: 'MIT' }, topics: ['browser', 'cdp'], pushed_at: new Date().toISOString(), archived: false,
  });
  if (url.startsWith('https://api.github.com/search/repositories')) {
    return json({ total_count: 2, items: [repo('cdp-org/aware', 'TypeScript', 1500, 'Browser awareness over CDP for agents'), repo('py/tabs', 'Python', 500, 'Tab reader for agents')] });
  }
  if (url.startsWith('https://api.github.com/repos/')) {
    if (url.endsWith('/readme')) return new Response('# aware\nReads tabs and page text over the Chrome DevTools Protocol.', { status: 200 });
    if (url.endsWith('/contents/')) return json([{ name: 'package.json', type: 'file' }]);
    return json(repo('cdp-org/aware', 'TypeScript', 1500, 'Browser awareness over CDP for agents'));
  }
  if (url === 'https://google.serper.dev/search') return json({ organic: [{ title: 'CDP agents', link: 'https://blog.example.com/cdp', snippet: 'Agents read the browser over CDP.' }] });
  return realFetch(input as string, init);
}) as typeof fetch;

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { healthManager } = await import('../monitoring/healthManager.js');
const { agentManager } = await import('../core/agents/agentManager.js');
const { ensureAgentSystem, shutdownAgentSystem, isResearchRequest, chooseSpecialist } = await import('../core/agents/jarvisAgents.js');
const { checkCall } = await import('../core/agents/permissions.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(25); }
  return cond();
}

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

const spoken: string[] = [];
nodeBridge.speakToClients = ((text: string) => { spoken.push(text); }) as typeof nodeBridge.speakToClients;
const remembered: string[] = [];
const realRemember = memoryManager.rememberFact.bind(memoryManager);
memoryManager.rememberFact = (async (fact: string, source?: string, importance?: number, confidence?: number) => {
  remembered.push(fact);
  return realRemember(fact, source, importance, confidence);
}) as typeof memoryManager.rememberFact;

// No model is available: the agents use their rules, and the orchestrator's
// fixed routes need no model.
modelRouter.chat = (async () => { throw new Error('503 model unavailable (test)'); }) as typeof modelRouter.chat;

console.log('\n=== JARVIS and its agents ===\n');

console.log('--- Fixed routes ---');
{
  const r = (t: string) => orchestrator.matchDeterministicCommand(t);
  const cases: [string, string, string | undefined][] = [
    ['Find the best GitHub projects for giving JARVIS browser awareness', 'delegate', undefined],
    ['research CDP libraries for TypeScript', 'delegate', undefined],
    ['what are your agents doing', 'agent_status', 'summary'],
    ['how many agents are running', 'agent_status', 'count'],
    ['show the task tree', 'agent_status', 'tree'],
    ['what has each worker discovered', 'agent_status', 'findings'],
    ['which agents failed', 'agent_status', 'failures'],
    ['how much work remains', 'agent_status', 'remaining'],
    ['what subagents did the research agent create and why', 'agent_status', 'spawns|research_agent'],
    ['stop this research', 'agent_stop', 'latest'],
    ['stop all agents', 'agent_stop', 'all'],
  ];
  for (const [text, type, target] of cases) {
    const route = r(text);
    ok(`"${text}" → ${type}${target ? ` (${target})` : ''}`, route?.type === type && (target === undefined || route?.target === target), JSON.stringify(route));
  }
  ok('"open youtube" still opens an app', r('open youtube')?.type === 'open_app');
  ok('"stop" is still the speech stop', r('stop')?.type === 'stop');
  ok('"investigate why my app is not working" is not research', r('investigate why my app is not working')?.type !== 'delegate');
  ok('"find my python files" is not research', !isResearchRequest('find my python files'));
  ok('specialists are chosen by topic', chooseSpecialist('compare playwright and puppeteer') === 'research_agent'
    && chooseSpecialist('show my open tabs') === 'browser_agent' && chooseSpecialist('run the tests') === 'qa_agent'
    && chooseSpecialist('what changed in the pull request') === 'github_agent');
}

console.log('\n--- The planner is offered the agent tools; agents never get them ---');
{
  const select = (t: string) => (orchestrator as unknown as { selectPlanningToolNames(i: string): string[] }).selectPlanningToolNames(t);
  ok('a research-style request offers delegate_task', select('compare the two approaches in the background').includes('delegate_task'));
  ok('a question about agents offers agent_status', select('are the agents still busy').includes('agent_status'));
  ok('a GitHub search offers github_search', select('search github for cdp libraries').includes('github_search'));
  await ensureAgentSystem();
  const research = agentManager.registry.get('research_agent')!;
  ok('no agent may call delegate_task, agent_status or cancel_agent_task',
    ['delegate_task', 'agent_status', 'cancel_agent_task'].every((t) => checkCall(research.permissions, t, {}, toolRegistryV2).code === 'AGENT_TOOL_DENIED'));
}

console.log('\n--- A delegated request runs in the background; JARVIS keeps answering ---');
{
  slowNetwork = 150;
  spoken.length = 0;
  await orchestrator.process('Find the best GitHub projects for giving JARVIS browser awareness', 'voice');
  ok('JARVIS acknowledges at once', spoken.some((s) => /^On it, sir\. The Research Agent is working on it/.test(s)), spoken.join(' | '));
  const root = agentManager.rootRuns().find((r) => !r.endedAt);
  ok('a root task is running', !!root);
  await until(() => agentManager.status().activeAgents >= 3, 3_000);

  spoken.length = 0;
  await orchestrator.process('how many agents are running', 'voice');
  ok('"how many agents are running" gets a count', /^\d+ agents? (is|are) active, sir/.test(spoken[0] ?? ''), spoken[0]);
  spoken.length = 0;
  await orchestrator.process('what are your agents doing', 'voice');
  ok('"what are your agents doing" says what they work on', /agents? (is|are) working on "Find the best GitHub projects/.test(spoken[0] ?? ''), spoken[0]);
  ok('the dashboard lists the active agents', [...((healthManager as unknown as { activeAgents: Set<string> }).activeAgents)].some((n) => /Research Agent|GitHub Research Agent/.test(n)));

  const done = await until(() => spoken.some((s) => /^Sir, the Research Agent has finished\./.test(s)), 20_000);
  ok('when the agents finish, JARVIS says so', done, spoken.join(' | '));
  const finished = agentManager.rootResult(root!.rootTaskId);
  ok('the result ranks the TypeScript CDP project first', ((finished?.specialist.data?.['ranking'] as { fullName: string }[]) ?? [])[0]?.fullName === 'cdp-org/aware');
  ok('the answer and strong findings went to long-term memory', remembered.some((f) => /^Research \(\d{4}-\d{2}-\d{2}\) "Find the best GitHub projects/.test(f)), remembered.join(' | ').slice(0, 200));
  ok('the limitations say the model was not used', finished?.limitations.some((l) => /rules were used/.test(l)) === true);
  slowNetwork = 0;

  spoken.length = 0;
  await orchestrator.process('what subagents did the research agent create and why', 'voice');
  ok('"what subagents did the research agent create" names them', /The Research Agent created \d+: .*GitHub Research Agent/.test(spoken[0] ?? ''), spoken[0]);
  spoken.length = 0;
  await orchestrator.process('show the task tree', 'voice');
  ok('"show the task tree" answers and prints the tree', /task tree/.test(spoken[0] ?? ''), spoken[0]);
  spoken.length = 0;
  await orchestrator.process('what has each worker discovered', 'voice');
  ok('"what has each worker discovered" counts the findings', /agents have reported \d+ findings/.test(spoken[0] ?? ''), spoken[0]);
  spoken.length = 0;
  await orchestrator.process('how much work remains', 'voice');
  ok('"how much work remains" after the end says nothing remains', /nothing remains/.test(spoken[0] ?? ''), spoken[0]);
}

console.log('\n--- "Stop this research" stops the whole tree ---');
{
  slowNetwork = 400;
  spoken.length = 0;
  await orchestrator.process('research TypeScript libraries for reading browser tabs', 'voice');
  await until(() => agentManager.status().activeAgents >= 2, 3_000);
  const running = agentManager.rootRuns().find((r) => !r.endedAt)!;
  spoken.length = 0;
  await orchestrator.process('stop this research', 'voice');
  ok('JARVIS says it stopped the research', /^Stopped "research TypeScript libraries/.test(spoken[0] ?? ''), spoken[0]);
  ok('no agent is left running', agentManager.status().activeAgents === 0);
  await until(() => !!agentManager.rootResult(running.rootTaskId), 5_000);
  const stoppedResult = agentManager.rootResult(running.rootTaskId);
  ok('the root result says CANCELLED', stoppedResult?.status === 'CANCELLED', stoppedResult?.status);
  if (stoppedResult && stoppedResult.findings.length) {
    ok('findings made before the stop are reported', await until(() => spoken.some((s) => /before the Research Agent was stopped it had \d+ findings/.test(s)), 20_000), spoken.join(' | '));
  } else {
    await sleep(1_500);
    ok('nothing found before the stop: no second announcement', spoken.length === 1, spoken.join(' | '));
  }
  ok('every task of that root ended', agentManager.tasksOfRoot(running.rootTaskId).every((t) => ['CANCELLED', 'COMPLETED', 'FAILED', 'TIMED_OUT'].includes(t.status)));
  spoken.length = 0;
  await orchestrator.process('stop this research', 'voice');
  ok('stopping again: nothing is running', /No agents are working/.test(spoken[0] ?? ''), spoken[0]);
  slowNetwork = 0;
}

console.log('\n--- The optional A2A endpoint ---');
{
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  process.env['JARVIS_A2A_PORT'] = String(port);
  process.env['JARVIS_A2A_TOKEN'] = 'short';
  await ensureAgentSystem({ startHttp: true });
  const refused = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`).then(() => 'open', () => 'closed');
  ok('with a token shorter than 16 characters the endpoint stays off', refused === 'closed');
  process.env['JARVIS_A2A_TOKEN'] = 'integration-token-0123456789';
  await ensureAgentSystem({ startHttp: true });
  const noToken = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
  const card = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, { headers: { Authorization: 'Bearer integration-token-0123456789' } }).then((r) => r.json()) as { skills: { id: string }[] };
  ok('with a proper token it starts, refuses calls without the token, and serves JARVIS\'s card', noToken.status === 401 && card.skills.length === 7, `${noToken.status}, ${card.skills.length} skills`);
  await shutdownAgentSystem();
  const after = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`).then(() => 'open', () => 'closed');
  ok('shutdown closes it', after === 'closed');
}

globalThis.fetch = realFetch;
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
