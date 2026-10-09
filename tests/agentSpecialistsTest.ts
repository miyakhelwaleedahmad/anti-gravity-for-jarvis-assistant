/**
 * tests/agentSpecialistsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The seven permanent specialists and their worker roles
 * (core/agents/specialists.ts) and the tool-loop behaviour of the Browser,
 * PC, Coding, GitHub, QA and Memory agents (core/agents/behaviors/toolLoop.ts):
 * registration, permissions per role, model-chosen tool calls through the
 * real registry, refusal of tools outside the scope, the rule fallback
 * without a model, splitting a request among workers, and the GitHub agent
 * routing research to the research flow.
 *
 * The model is scripted and the network is an offline stand-in.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-specialists-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspaceDir, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspaceDir;
process.env['JARVIS_DATA_ROOT'] = workspaceDir;
process.chdir(workspaceDir);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('https://api.github.com/search/repositories')) {
    return json({ total_count: 1, items: [{ full_name: 'cdp-org/cdp-kit', html_url: 'https://github.com/cdp-org/cdp-kit', description: 'TypeScript Chrome DevTools Protocol kit', stargazers_count: 800, language: 'TypeScript', license: { spdx_id: 'MIT' }, topics: ['cdp', 'typescript'], pushed_at: new Date().toISOString(), archived: false }] });
  }
  if (url.startsWith('https://api.github.com/repos/cdp-org/cdp-kit')) {
    if (url.endsWith('/readme')) return new Response('# cdp-kit\nA TypeScript client for the Chrome DevTools Protocol.', { status: 200 });
    if (url.endsWith('/contents/')) return json([{ name: 'package.json', type: 'file' }]);
    return json({ full_name: 'cdp-org/cdp-kit', html_url: 'https://github.com/cdp-org/cdp-kit', description: 'TypeScript Chrome DevTools Protocol kit', stargazers_count: 800, language: 'TypeScript', license: { spdx_id: 'MIT' }, topics: ['cdp'], pushed_at: new Date().toISOString(), archived: false });
  }
  return realFetch(input as string, init);
}) as typeof fetch;

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles, SPECIALIST_ROLES, WORKER_ROLES } = await import('../core/agents/specialists.js');
const { checkCall, AGENT_DENIED_TOOLS } = await import('../core/agents/permissions.js');
const { splitParts } = await import('../core/agents/behaviors/toolLoop.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();

// Every tool call the agents make, through the real registry.
const calls: string[] = [];
const realExecute = toolRegistryV2.execute.bind(toolRegistryV2);
toolRegistryV2.execute = (async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
  calls.push(name);
  return realExecute(name, args, signal);
}) as typeof toolRegistryV2.execute;

// Scripted model: a tool call on the first turn when the prompt names one, then an answer.
let modelDown = false;
const toolMessages: string[] = [];
modelRouter.chat = (async (req: { messages: { role: string; content: unknown; name?: string }[]; tools?: { function: { name: string } }[] }) => {
  if (modelDown) throw new Error('503 (test)');
  const user = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  const toolTurns = req.messages.filter((m) => m.role === 'tool');
  for (const t of toolTurns) toolMessages.push(String(t.content));
  const want = /USE:(\w+)/.exec(user)?.[1];
  if (want && !toolTurns.length) {
    return { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: want, arguments: '{}' } }] };
  }
  if (/search queries/.test(String(req.messages[0]?.content))) return { content: '{"queries":["cdp typescript"]}' };
  if (/judge whether/.test(String(req.messages[0]?.content))) return { content: '{"summary":"A CDP client.","integration":"library","risks":[]}' };
  return { content: `answer for: ${user.split('\n')[0].replace(/USE:\w+/, '').trim()}` };
}) as typeof modelRouter.chat;

const m = new AgentManager(agentEvents, { ...loadAgentLimits({}) });
registerAgentRoles(m);

console.log('\n=== Specialists ===\n');

console.log('--- The seven permanent specialists ---');
{
  const specialists = m.registry.all().filter((a) => a.permanent && a.agentId !== 'jarvis');
  const ids = specialists.map((a) => a.agentId).sort();
  ok('exactly seven permanent specialists', ids.join() === 'browser_agent,coding_agent,github_agent,memory_agent,pc_agent,qa_agent,research_agent', ids.join());
  ok('all at depth 1 under JARVIS and READY', specialists.every((a) => a.depth === 1 && a.parentAgentId === 'jarvis' && a.status === 'READY'));
  ok('no specialist has a denied tool', specialists.every((a) => a.permissions.tools.every((t) => !AGENT_DENIED_TOOLS.includes(t.split(':')[0]))));
  ok('scopes contain only registered tools', specialists.every((a) => a.permissions.tools.every((t) => toolRegistryV2.has(t.split(':')[0]))));
  const risk = Object.fromEntries(specialists.map((a) => [a.agentId, a.permissions.maxRisk]));
  ok('risk ceilings: research/browser/QA/memory 1, PC/coding 2, GitHub 3',
    risk['research_agent'] === 1 && risk['browser_agent'] === 1 && risk['qa_agent'] === 1 && risk['memory_agent'] === 1
    && risk['pc_agent'] === 2 && risk['coding_agent'] === 2 && risk['github_agent'] === 3, JSON.stringify(risk));
  ok('the Memory agent cannot spawn; the others can', specialists.every((a) => a.permissions.canSpawn === (a.agentId !== 'memory_agent')));
  ok('each has an Agent Card with its skill', specialists.every((a) => m.registry.agentCard(a.agentId)?.skills[0]?.id === a.agentId));
  ok('worker roles are defined but have no agents until needed', WORKER_ROLES.every((w) => m.registry.hasRole(w.role) && !m.registry.get(w.role)) && SPECIALIST_ROLES.length === 7);
  const gh = m.registry.get('github_agent')!;
  const research = m.registry.get('research_agent')!;
  ok('git_push is in the GitHub agent\'s scope (the registry still asks for approval)', checkCall(gh.permissions, 'git_push', {}, toolRegistryV2).allowed);
  ok('git_push is not in the Research agent\'s scope', checkCall(research.permissions, 'git_push', {}, toolRegistryV2).code === 'AGENT_SCOPE_DENIED');
  ok('only allowed git actions: status yes, commit no, for the Coding agent',
    checkCall(m.registry.get('coding_agent')!.permissions, 'git', { action: 'status' }, toolRegistryV2).allowed
    && !checkCall(m.registry.get('coding_agent')!.permissions, 'git', { action: 'commit' }, toolRegistryV2).allowed);
}

console.log('\n--- Tool loop: the model picks tools from the scope; the registry runs them ---');
{
  calls.length = 0;
  const h = await m.startRootTask({ request: 'project status', specialistRole: 'qa_agent', task: { description: 'Check the project status USE:dev_status' } });
  const r = await h.result;
  ok('the QA agent called dev_status through the registry', calls.includes('dev_status'), calls.join(','));
  ok('it answered after seeing the result', r.status === 'COMPLETED' && /answer for: Check the project status/.test(r.answer), r.answer);
  ok('the tool result reached the model inside <untrusted_context>', toolMessages.some((t) => t.startsWith('<untrusted_context source="tool:dev_status">')));
  ok('the result was recorded as a finding', r.findings.some((f) => f.text.startsWith('dev_status:')));

  calls.length = 0;
  const h2 = await m.startRootTask({ request: 'run a command', specialistRole: 'qa_agent', task: { description: 'Delete the build folder USE:run_command' } });
  const r2 = await h2.result;
  ok('a tool outside the scope is refused before the registry', !calls.includes('run_command'));
  ok('the refusal is reported as a limitation', r2.limitations.some((l) => /run_command/.test(l) && /outside this agent's permissions/.test(l)), r2.limitations.join(' | '));
  ok('the model was told it was refused', toolMessages.some((t) => t.includes('FAILED: Refused: run_command')));
}

console.log('\n--- Without a model, keyword rules pick read-only tools ---');
{
  modelDown = true;
  calls.length = 0;
  const h = await m.startRootTask({ request: 'git changes', specialistRole: 'coding_agent', task: { description: 'What changed in git recently?' } });
  const r = await h.result;
  modelDown = false;
  ok('the Coding agent used git_overview from its rules', calls.includes('git_overview'), calls.join(','));
  ok('it says the model was not available', r.status === 'COMPLETED' && r.limitations.some((l) => /model was not available/.test(l) && /keyword rules/.test(l)), r.limitations.join(' | '));
}

console.log('\n--- A request with independent parts goes to workers ---');
{
  ok('parts are split on ";" and "then"', JSON.stringify(splitParts('Read the active tab; then list the open tabs')) === JSON.stringify(['Read the active tab', 'list the open tabs']));
  const h = await m.startRootTask({ request: 'two browser things', specialistRole: 'browser_agent', task: { description: 'Read the active tab; then list the open tabs' } });
  const r = await h.result;
  const kids = m.spawnedBy(h.rootTaskId, 'browser_agent');
  ok('the Browser agent created two Browser Page Workers', kids.length === 2 && kids.every((k) => k.role === 'browser_page_worker' && k.status === 'COMPLETED'), kids.map((k) => `${k.role}/${k.status}`).join(', '));
  ok('their answers were combined', /answer for: Read the active tab/.test(r.answer) && /answer for: list the open tabs/.test(r.answer), r.answer);
  const workerScope = m.agentOf(h.rootTaskId, kids[0].agentId)!.permissions;
  ok('the workers got a narrower, read-only scope', workerScope.maxRisk === 0 && workerScope.tools.every((t) => ['browser_state', 'browser_read_page', 'browser_page_structure'].includes(t)), workerScope.tools.join(','));
}

console.log('\n--- The GitHub agent: research goes to the research flow, chores to the tool loop ---');
{
  const h = await m.startRootTask({ request: 'cdp libs', specialistRole: 'github_agent', task: { description: 'Find TypeScript libraries for the Chrome DevTools Protocol' } });
  const r = await h.result;
  const kids = m.spawnedBy(h.rootTaskId, 'github_agent').map((k) => k.role).sort();
  ok('a research request created discovery and analysis workers', kids.join() === 'repo_code_analysis_worker,repo_discovery_worker', kids.join());
  ok('and ranked the repository it found', ((r.specialist.data?.['ranked'] as { fullName: string }[]) ?? [])[0]?.fullName === 'cdp-org/cdp-kit');
  calls.length = 0;
  const h2 = await m.startRootTask({ request: 'git status', specialistRole: 'github_agent', task: { description: 'Show the local repository status USE:git_overview' } });
  await h2.result;
  ok('a repository chore used the tool loop', calls.includes('git_overview') && m.spawnedBy(h2.rootTaskId, 'github_agent').length === 0);
}

globalThis.fetch = realFetch;
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
