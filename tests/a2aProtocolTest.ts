/**
 * tests/a2aProtocolTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The A2A v1.0 layer (core/agents/a2a.ts): Agent Cards, SendMessage (blocking
 * and returnImmediately), SendStreamingMessage, GetTask, ListTasks,
 * CancelTask, SubscribeToTask, follow-up messages and the messaging rule
 * between agents, protocol errors, and the optional localhost HTTP binding
 * (token, Host/Origin checks, A2A-Version, SSE).
 *
 * Stand-in specialist and workers; no model is called, nothing on the PC changes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-a2a-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspaceDir, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspaceDir;
process.env['JARVIS_DATA_ROOT'] = workspaceDir;

const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { A2AServer, InProcessA2AClient, A2AHttpServer, A2AError, A2A_ERRORS, userMessage, isFinalStreamItem } = await import('../core/agents/a2a.js');
type AgentContext = import('../core/agents/agentContextApi.js').AgentContext;
type AgentOutcome = import('../core/agents/types.js').AgentOutcome;
type A2AStreamResponse = import('../core/agents/types.js').A2AStreamResponse;
type A2ATask = import('../core/agents/types.js').A2ATask;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function errorCode(p: Promise<unknown> | (() => unknown)): Promise<number | string> {
  try { await (typeof p === 'function' ? p() : p); return 'no error'; } catch (e) { return e instanceof A2AError ? e.code : String(e); }
}

type Scenario = (ctx: AgentContext) => Promise<AgentOutcome>;
const scenarios = new Map<string, Scenario>();
const scripted = { run: (ctx: AgentContext) => scenarios.get(String(ctx.input['scenario'] ?? 'research'))!(ctx) };

const m = new AgentManager(agentEvents, { ...loadAgentLimits({}) });
m.defineRole({
  role: 'research_agent', name: 'Research Agent', description: 'Researches questions.', capabilities: ['research'],
  supportedTaskTypes: [], tools: [], maxRisk: 1, canSpawn: true, allowedChildRoles: ['web_worker'], permanent: true,
  version: '1.0.0', examples: ['Find the best GitHub projects for browser awareness'], behavior: scripted,
});
m.defineRole({
  role: 'web_worker', name: 'Web Worker', description: 'Reads the web.', capabilities: ['web'],
  supportedTaskTypes: [], tools: [], maxRisk: 1, canSpawn: false, allowedChildRoles: [], version: '1.0.0', behavior: scripted,
});
const server = new A2AServer(m);
const client = new InProcessA2AClient(server);

// The default specialist behaviour: two workers that each report a finding, then a synthesis.
const workerIds: Record<string, { agentId: string; taskId: string }> = {};
const gates: (() => void)[] = [];
scenarios.set('research', async (ctx) => {
  const hs = [];
  for (const n of ['one', 'two']) {
    hs.push(await ctx.spawn({ childRole: 'web_worker', childTask: { description: `read page ${n}`, input: { scenario: 'page', n, hold: ctx.input['hold'] === true } } }));
  }
  workerIds['one'] = { agentId: hs[0].agentId, taskId: hs[0].taskId };
  workerIds['two'] = { agentId: hs[1].agentId, taskId: hs[1].taskId };
  const rs = await ctx.wait(hs);
  ctx.workspace.setFinalSynthesis(`Synthesis of ${rs.length} pages`, 0.8, ctx.agent.agentId);
  return { summary: `Synthesis of ${rs.length} pages`, confidence: 0.8, data: { pages: rs.length } };
});
scenarios.set('page', async (ctx) => {
  ctx.progress(`reading ${String(ctx.input['n'])}`);
  await sleep(30);
  ctx.addFinding({ text: `page ${String(ctx.input['n'])} says hello`, confidence: 0.7 });
  if (ctx.input['hold']) await ctx.idleWait(new Promise<void>((r) => { gates.push(r); }));
  await sleep(60);
  return { summary: `read ${String(ctx.input['n'])}`, confidence: 0.7 };
});

console.log('\n=== A2A protocol ===\n');

console.log('--- Agent Cards ---');
{
  const jarvis = client.card('jarvis');
  ok('JARVIS has a card with one skill per specialist', jarvis.name === 'JARVIS' && jarvis.skills.map((s) => s.id).join() === 'research_agent');
  ok('cards declare protocol 1.0, streaming and the JARVIS extension',
    jarvis.supportedInterfaces[0].protocolVersion === '1.0' && jarvis.capabilities.streaming === true
    && jarvis.capabilities.pushNotifications === false && jarvis.capabilities.extensions?.[0].uri === 'urn:jarvis:a2a:hierarchy:v1');
  const research = client.card('research_agent');
  ok('a specialist card lists its skill and examples', research.skills[0].id === 'research_agent' && research.skills[0].examples?.[0]?.includes('GitHub') === true);
  ok('discovery lists every live agent card', server.listCards().map((c) => c.name).join() === 'JARVIS,Research Agent');
}

console.log('\n--- SendMessage (blocking) ---');
let firstContext = '';
{
  const res = await client.sendMessage('research_agent', { message: userMessage('Compare two pages', { depth: 'quick' }) });
  const task = (res as { task: A2ATask }).task;
  firstContext = task.contextId;
  ok('a blocking SendMessage returns the finished task', task.status.state === 'TASK_STATE_COMPLETED', task.status.state);
  ok('the task id is server-made and the context is the root task', task.id.startsWith('task-') && task.contextId.startsWith('task-') && task.id !== task.contextId);
  const result = task.artifacts?.find((a) => a.name === 'result');
  ok('the result artifact has the summary as text', result?.parts[0].text === 'Synthesis of 2 pages');
  const data = result?.parts[1].data as Record<string, unknown> | undefined;
  ok('and findings, confidence and limitations as data', (data?.['findings'] as unknown[])?.length === 2 && data?.['confidence'] === 0.8 && Array.isArray(data?.['limitations']));
  ok('the status message carries the summary', task.status.message?.parts[0].text === 'Synthesis of 2 pages' && task.status.message?.role === 'ROLE_AGENT');
  ok('the history starts with the user request', task.history?.[0].role === 'ROLE_USER' && task.history?.[0].parts[0].text === 'Compare two pages');
  ok('lineage is in metadata.jarvis', (task.metadata?.['jarvis'] as Record<string, unknown>)?.['agentId'] === 'research_agent');
  const fetched = await client.getTask(task.id, 0);
  ok('GetTask returns the same task without history when historyLength is 0', fetched.id === task.id && fetched.history === undefined && fetched.status.state === 'TASK_STATE_COMPLETED');
}

console.log('\n--- SendMessage (returnImmediately), CancelTask ---');
{
  const res = await client.sendMessage('research_agent', { message: userMessage('Slow research'), configuration: { returnImmediately: true } });
  const task = (res as { task: A2ATask }).task;
  ok('returnImmediately returns a task still in progress', ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state), task.status.state);
  await sleep(10);
  const cancelled = await client.cancelTask(task.id);
  ok('CancelTask stops it: TASK_STATE_CANCELED', cancelled.status.state === 'TASK_STATE_CANCELED', cancelled.status.state);
  ok('cancelling an ended task is TaskNotCancelableError (-32002)', await errorCode(client.cancelTask(task.id)) === A2A_ERRORS.TASK_NOT_CANCELABLE);
  ok('an unknown task is TaskNotFoundError (-32001)', await errorCode(client.getTask('task-nope')) === A2A_ERRORS.TASK_NOT_FOUND
    && await errorCode(client.cancelTask('task-nope')) === A2A_ERRORS.TASK_NOT_FOUND);
}

console.log('\n--- SendStreamingMessage: updates arrive while the work runs ---');
{
  const items: A2AStreamResponse[] = [];
  const at: number[] = [];
  for await (const item of client.sendMessageStream('research_agent', { message: userMessage('Stream it') })) {
    items.push(item);
    at.push(Date.now());
  }
  ok('the first item is the Task', 'task' in items[0]);
  const findingIdx = items.findIndex((i) => 'artifactUpdate' in i && i.artifactUpdate.artifact.name === 'findings');
  const finalIdx = items.findIndex(isFinalStreamItem);
  ok('findings stream as artifact updates before the end', findingIdx > 0 && findingIdx < finalIdx, `finding at ${findingIdx}, final at ${finalIdx}`);
  ok('progress of the workers streams as status messages', items.some((i) => 'statusUpdate' in i && /reading one/.test(i.statusUpdate.status.message?.parts[0].text ?? '')));
  ok('the result artifact comes before the final status', items.findIndex((i) => 'artifactUpdate' in i && i.artifactUpdate.artifact.name === 'result') === finalIdx - 1);
  ok('the stream ends with TASK_STATE_COMPLETED', finalIdx === items.length - 1 && 'statusUpdate' in items[finalIdx] && items[finalIdx].statusUpdate.status.state === 'TASK_STATE_COMPLETED');
  ok('every item belongs to one task and context', items.every((i) => {
    const t = 'task' in i ? i.task.id : 'statusUpdate' in i ? i.statusUpdate.taskId : 'artifactUpdate' in i ? i.artifactUpdate.taskId : '';
    return t === (items[0] as { task: A2ATask }).task.id;
  }));
}

console.log('\n--- SubscribeToTask, follow-up messages, the messaging rule ---');
{
  const res = await client.sendMessage('research_agent', { message: userMessage('Held research', { hold: true }), configuration: { returnImmediately: true } });
  const task = (res as { task: A2ATask }).task;
  // The specialist passes `hold` to its workers.
  await sleep(100);
  const sub: A2AStreamResponse[] = [];
  const subDone = (async () => { for await (const i of client.subscribe(task.id)) sub.push(i); })();
  await sleep(50);
  const followed = await client.sendMessage('research_agent', { message: { ...userMessage('Also check page three'), taskId: task.id, contextId: task.contextId } });
  ok('a follow-up message to a running task is accepted', 'task' in followed && followed.task.id === task.id);
  ok('it reaches the agent\'s inbox', m.inbox('research_agent').some((x) => x.text === 'Also check page three' && x.from === 'user'));
  ok('a follow-up with a mismatching contextId is refused', await errorCode(client.sendMessage('research_agent', { message: { ...userMessage('x'), taskId: task.id, contextId: firstContext } })) === A2A_ERRORS.INVALID_PARAMS);

  const one = workerIds['one'];
  const two = workerIds['two'];
  const asWorkerOne = new InProcessA2AClient(server, { kind: 'agent', agentId: one.agentId, taskId: one.taskId });
  const sib = await asWorkerOne.sendMessage(two.agentId, { message: { ...userMessage('sibling hello'), taskId: two.taskId } });
  ok('an agent may message a sibling over A2A', 'task' in sib && m.inbox(two.agentId).some((x) => x.text === 'sibling hello' && x.from === one.agentId));
  const asStranger = new InProcessA2AClient(server, { kind: 'agent', agentId: 'web_worker-999', taskId: 'task-999' });
  ok('an agent outside parent/children/siblings is refused', await errorCode(asStranger.sendMessage(two.agentId, { message: { ...userMessage('hi'), taskId: two.taskId } })) === A2A_ERRORS.UNSUPPORTED_OPERATION);
  ok('an agent may not start tasks on a specialist', await errorCode(asWorkerOne.sendMessage('research_agent', { message: userMessage('new job') })) === A2A_ERRORS.UNSUPPORTED_OPERATION);
  ok('an agent may not cancel a sibling', await errorCode(asWorkerOne.cancelTask(two.taskId)) === A2A_ERRORS.TASK_NOT_CANCELABLE);

  for (const release of gates.splice(0)) release();
  await subDone;
  ok('SubscribeToTask sends the task first and ends at the terminal state', 'task' in sub[0] && isFinalStreamItem(sub[sub.length - 1]));
  ok('subscribing to an ended task is UnsupportedOperationError (-32004)', await errorCode(async () => { for await (const _ of client.subscribe(task.id)) { /* nothing */ } }) === A2A_ERRORS.UNSUPPORTED_OPERATION);
}

console.log('\n--- ListTasks ---');
{
  const all = await client.listTasks({ pageSize: 100 });
  ok('ListTasks returns tasks with totals and an empty last page token', all.tasks.length === all.totalSize && all.nextPageToken === '' && all.totalSize >= 12, `${all.totalSize} tasks`);
  ok('artifacts are left out unless asked for', all.tasks.every((t) => t.artifacts === undefined));
  const ctx = await client.listTasks({ contextId: firstContext });
  ok('contextId filters to one root task', ctx.tasks.length === 4 && ctx.tasks.every((t) => t.contextId === firstContext));
  const cancelled = await client.listTasks({ status: 'TASK_STATE_CANCELED' });
  ok('status filters by A2A state', cancelled.tasks.length >= 1 && cancelled.tasks.every((t) => t.status.state === 'TASK_STATE_CANCELED'));
  const page1 = await client.listTasks({ pageSize: 5 });
  const page2 = await client.listTasks({ pageSize: 5, pageToken: page1.nextPageToken });
  ok('pagination returns the next page', page1.nextPageToken !== '' && page2.tasks.length > 0 && page2.tasks[0].id !== page1.tasks[0].id);
}

console.log('\n--- Protocol errors ---');
{
  ok('JARVIS\'s endpoint needs metadata.jarvis.skill (-32602, lists the skills)', await errorCode(client.sendMessage('jarvis', { message: userMessage('anything') })) === A2A_ERRORS.INVALID_PARAMS);
  const viaJarvis = await client.sendMessage('jarvis', { message: userMessage('Via JARVIS', undefined, { jarvis: { skill: 'research_agent' } }) });
  ok('with the skill, JARVIS routes to the specialist', 'task' in viaJarvis && (viaJarvis.task.metadata?.['jarvis'] as Record<string, unknown>)['agentId'] === 'research_agent');
  ok('a message with no parts is -32602', await errorCode(server.handle('research_agent', 'SendMessage', { message: { messageId: 'x', role: 'ROLE_USER', parts: [] } }, { kind: 'user' })) === A2A_ERRORS.INVALID_PARAMS);
  ok('an unknown method is -32601', await errorCode(server.handle('research_agent', 'Frobnicate', {}, { kind: 'user' })) === A2A_ERRORS.METHOD_NOT_FOUND);
  ok('push notification methods are -32003', await errorCode(server.handle('research_agent', 'CreateTaskPushNotificationConfig', {}, { kind: 'user' })) === A2A_ERRORS.PUSH_NOTIFICATION_NOT_SUPPORTED);
  ok('the extended card is -32007', await errorCode(server.handle('research_agent', 'GetExtendedAgentCard', {}, { kind: 'user' })) === A2A_ERRORS.EXTENDED_CARD_NOT_CONFIGURED);
  ok('a new task for a non-specialist is refused', await errorCode(client.sendMessage('web_worker', { message: userMessage('x') })) === A2A_ERRORS.UNSUPPORTED_OPERATION);
}

console.log('\n--- HTTP binding (localhost, token, A2A-Version, SSE) ---');
{
  const token = 'test-token-0123456789abcdef';
  let refusedShort = false;
  try { new A2AHttpServer(server, { port: 0, token: 'short' }); } catch { refusedShort = true; }
  ok('a short token is refused', refusedShort);
  const httpServer = new A2AHttpServer(server, { port: 0, token });
  const port = await httpServer.start();
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${token}` };
  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/a2a/agents/research_agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth, 'A2A-Version': '1.0', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  ok('no token: 401', (await fetch(`${base}/.well-known/agent-card.json`)).status === 401);
  ok('wrong token: 401', (await fetch(`${base}/.well-known/agent-card.json`, { headers: { Authorization: 'Bearer wrong-token-0123456789ab' } })).status === 401);
  const card = await (await fetch(`${base}/.well-known/agent-card.json`, { headers: auth })).json() as { name: string; supportedInterfaces: { url: string; protocolBinding: string }[] };
  ok('the card is served with the HTTP JSON-RPC interface', card.name === 'JARVIS' && card.supportedInterfaces[0].url === `${base}/a2a/agents/jarvis` && card.supportedInterfaces[0].protocolBinding === 'JSONRPC');
  const agentCard = await (await fetch(`${base}/a2a/agents/research_agent/.well-known/agent-card.json`, { headers: auth })).json() as { name: string };
  ok('each agent has its own card URL', agentCard.name === 'Research Agent');
  ok('a browser request (Origin header) is refused: 403', (await fetch(`${base}/.well-known/agent-card.json`, { headers: { ...auth, Origin: 'https://evil.example' } })).status === 403);

  const noVersion = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }, { 'A2A-Version': '' })).json() as { error?: { code: number } };
  ok('no A2A-Version header means 0.3: VersionNotSupportedError (-32009)', noVersion.error?.code === A2A_ERRORS.VERSION_NOT_SUPPORTED);
  const parse = await (await rpc('{not json')).json() as { error?: { code: number } };
  ok('malformed JSON is -32700', parse.error?.code === A2A_ERRORS.PARSE_ERROR);
  const sent = await (await rpc({ jsonrpc: '2.0', id: 'a', method: 'SendMessage', params: { message: userMessage('Over HTTP') } })).json() as { id: string; result?: { task: A2ATask } };
  ok('SendMessage over HTTP returns the finished task', sent.id === 'a' && sent.result?.task.status.state === 'TASK_STATE_COMPLETED');
  const got = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: sent.result?.task.id } })).json() as { result?: A2ATask };
  ok('GetTask over HTTP', got.result?.id === sent.result?.task.id);

  const sse = await rpc({ jsonrpc: '2.0', id: 'sse', method: 'SendStreamingMessage', params: { message: userMessage('Stream over HTTP') } });
  ok('the stream answers with text/event-stream', (sse.headers.get('content-type') ?? '').startsWith('text/event-stream'));
  const text = await sse.text();
  const events = text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as { id: string; result: A2AStreamResponse });
  ok('SSE events are JSON-RPC responses: Task first, terminal status last',
    events.length > 3 && events.every((e) => e.id === 'sse') && 'task' in events[0].result && isFinalStreamItem(events[events.length - 1].result), `${events.length} events`);

  const wrongHost = await new Promise<number>((resolve) => {
    // fetch() does not allow a custom Host header; use node:http.
    import('node:http').then(({ request }) => {
      const r = request({ host: '127.0.0.1', port, path: '/.well-known/agent-card.json', headers: { ...auth, Host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.end();
    });
  });
  ok('another Host name is refused (DNS rebinding): 421', wrongHost === 421);
  await httpServer.stop();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
