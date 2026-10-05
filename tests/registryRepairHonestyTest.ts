/**
 * tests/registryRepairHonestyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bugs in the tool registry, the repair loop and the control layer:
 *
 *  1. Every low-risk tool's result was cached for 30 s, so "is notepad open?"
 *     repeated an old answer, and "disable full control" a second time within
 *     30 s did not run at all.
 *  2. The task graph retried any unrecognised failure twice, including steps
 *     that type, click, close or run something.
 *  3. Bad arguments and unknown tools were retried as "transient" (~3 s).
 *  4. The skill loader dropped each skill's list of allowed actions, so the
 *     model guessed action names; and five tools printed a startup warning.
 *  5. A replan that answered directly was followed by "I was unable to recover
 *     from the error"; abort messages promised retries that never came.
 *  6. Text containing a JSON example was executed as a tool call, with any tool.
 *  7. The LLM-down fallback called an unregistered tool, and on a replan it
 *     matched JARVIS's own "[SYSTEM NOTE" instead of the user's words.
 *  8. A failed command with long output was reported as "Task completed".
 *  9. Service names went into PowerShell unchecked; stopping Defender skipped
 *     the blocklist; a kill was approved before being refused as protected.
 * 10. A command given while JARVIS was speaking had its own LLM call
 *     cancelled before it started.
 *
 * Nothing runs on the PC: tools are stubbed, approvals are refused by a spy,
 * and permission checks are stubbed on the instance (nothing is persisted).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-registry-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_MIN_TOOL_GAP_MS'] = '0';
process.chdir(workspace);

// Registration warnings are printed while the modules load.
const warnings: string[] = [];
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); realWarn(...args); };

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const orchestratorModule: any = await import('../core/orchestrator.js');
const { orchestrator } = orchestratorModule;
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { approvalGate } = await import('../security/approvalGate.js');
const adminModule: any = await import('../control/adminController.js');
const { processController } = await import('../control/processController.js');
const { taskGraphEngine } = await import('../core/taskGraphEngine.js');
const { agentStateMachine } = await import('../core/agentStateMachine.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

// Approvals are always refused, and counted.
let approvalsAsked = 0;
(approvalGate as any).requestApproval = async () => { approvalsAsked++; return false; };

// A stand-in model. Each planning call takes the next entry: tool calls, a
// text answer, or an error. Diagnosis calls (no tools) get `diagnosis`.
type Call = { name: string; args: Record<string, unknown> };
let plans: Array<Call[] | string | Error> = [];
let diagnosis = '{"failureClass":"unknown","repairStrategy":"abort","context":""}';
let llmCalls = 0;
let planningSignalAborted: boolean | undefined;
modelRouter.chat = async (req: any) => {
  llmCalls++;
  if (!req.tools) return { content: diagnosis } as any;
  planningSignalAborted = req.signal?.aborted;
  const next = plans.shift();
  if (next instanceof Error) throw next;
  if (typeof next === 'string') return { content: next } as any;
  if (next && next.length) {
    return {
      content: '',
      tool_calls: next.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    } as any;
  }
  return { content: 'Done, sir.' } as any;
};
modelRouter.streamChat = async function* () { llmCalls++; yield 'Done, sir.'; } as any;

let spoken: string[] = [];
(orchestrator as any).speak = (text: string) => { spoken.push(text); };

async function say(input: string, script: typeof plans = []): Promise<{ reply: string; ms: number }> {
  spoken = []; llmCalls = 0; plans = script;
  // Failure history from earlier checks would make the planner distrust a tool.
  (toolRegistryV2 as any)._metrics.clear();
  const t0 = Date.now();
  await orchestrator.process(input, 'voice');
  return { reply: spoken.join(' | '), ms: Date.now() - t0 };
}

/** Swap a registered tool's behaviour (and level) for one check, then restore. */
async function withTool<T>(name: string, patch: { level?: number; execute?: (args: any) => Promise<string> }, fn: () => Promise<T>): Promise<T> {
  const tool = toolRegistryV2.get(name)! as any;
  const saved = { execute: tool.execute, requiredLevel: tool.requiredLevel };
  if (patch.level !== undefined) tool.requiredLevel = patch.level;
  if (patch.execute) tool.execute = patch.execute;
  try { return await fn(); } finally { tool.execute = saved.execute; tool.requiredLevel = saved.requiredLevel; }
}

console.log('\n=== Registry and Repair Honesty Test ===\n');

console.log('--- 1. Only tools marked cacheable reuse a result ---');
{
  let runs = 0;
  await withTool('disable_full_control_session', { execute: async () => { runs++; return 'Full Control Mode disabled.'; } }, async () => {
    await toolRegistryV2.execute('disable_full_control_session', {});
    await toolRegistryV2.execute('disable_full_control_session', {});
  });
  ok('"disable full control" said twice runs twice', runs === 2, `${runs} run(s)`);

  let open = false;
  await withTool('is_app_open', { execute: async () => String(open) }, async () => {
    await toolRegistryV2.execute('is_app_open', { appName: 'notepad' });
    open = true;
    const again = await toolRegistryV2.execute('is_app_open', { appName: 'notepad' });
    ok('"is notepad open?" answers from the current state', again.output === 'true', again.output);
  });

  let searches = 0;
  await withTool('web_search', { execute: async () => { searches++; return 'Paris is the capital of France.'; } }, async () => {
    await toolRegistryV2.execute('web_search', { query: 'capital of france registry test' });
    const second = await toolRegistryV2.execute('web_search', { query: 'capital of france registry test' });
    ok('the same web search within 30 s is reused', searches === 1 && second.fromCache === true, `${searches} search(es)`);
  });
  ok('weather and deep search are cacheable',
    (toolRegistryV2.get('get_weather') as any)?.cacheable === true && (toolRegistryV2.get('deep_search') as any)?.cacheable === true);
}

console.log('\n--- 2. A step that changes something is not repeated ---');
{
  const typed: string[] = [];
  const r = await withTool('control_keyboard', {
    level: 0,
    execute: async (args) => { typed.push(String(args.text)); return JSON.stringify({ success: false, error: 'Failed to type text: device busy' }); },
  }, () => say('type hello into notepad', [[{ name: 'control_keyboard', args: { action: 'type', text: 'hello' } }]]));
  ok('a failed "type hello" ran once, not three times', typed.length === 1, `${typed.length} run(s)`);
  ok('without retry delays', r.ms < 900, `${r.ms}ms`);
  ok('and the reply gives the reason', r.reply.includes('device busy'), r.reply);
  ok('without promising another attempt', !/alternative approach|I'll retry|re-approach/i.test(r.reply), r.reply);

  const graph = (await import('../core/taskGraphEngine.js')).TaskGraphBuilder.fromToolCalls('x', [
    { id: 'a', function: { name: 'control_mouse', arguments: '{"action":"click"}' } },
    { id: 'b', function: { name: 'get_open_apps', arguments: '{}' } },
  ]);
  try {
    orchestratorModule.limitRetriesToReadOnlyTools(graph);
    const [click, read] = [...graph.nodes.values()];
    ok('a click gets no retries, reading state keeps its two', click!.maxRetries === 0 && read!.maxRetries === 2, `${click!.maxRetries}/${read!.maxRetries}`);
  } catch (e) { ok('limitRetriesToReadOnlyTools exists', false, (e as Error).message); }
}

console.log('\n--- 3. Skills show their allowed actions; invented ones are refused ---');
{
  const def: any = toolRegistryV2.getLLMDefinitions(['control_app'])[0];
  const actions = def?.function?.parameters?.properties?.action?.enum;
  ok('control_app tells the model its actions', JSON.stringify(actions) === '["open","close","focus","restart"]', JSON.stringify(actions));

  const seen: string[] = [];
  await withTool('control_app', { level: 0, execute: async (args) => { seen.push(String(args.action)); return '{"success":true}'; } }, async () => {
    const bad = await toolRegistryV2.execute('control_app', { action: 'launch', target: 'notepad' });
    ok('an invented action is refused before the skill runs', !bad.success && /must be one of/.test(bad.error ?? '') && seen.length === 0, bad.error);
    const mixed = await toolRegistryV2.execute('control_app', { action: 'Close', target: 'notepad' });
    ok('"Close" is accepted as "close"', mixed.success && seen.join() === 'Close', seen.join());
  });

  seen.length = 0;
  const r = await withTool('control_app', { level: 0, execute: async (args) => { seen.push(String(args.action)); return '{"success":true,"message":"Opened notepad."}'; } },
    () => say('bring up notepad for me now', [
      [{ name: 'control_app', args: { action: 'launch', target: 'notepad' } }],
      [{ name: 'control_app', args: { action: 'open', target: 'notepad' } }],
    ]));
  ok('the model is asked again, and only the valid action runs', seen.join() === 'open', `ran: ${seen.join() || 'nothing'}`);
  ok('quickly (the refusal is not retried)', r.ms < 900, `${r.ms}ms`);

  const blank = await toolRegistryV2.execute('web_search', {});
  const g = (await import('../core/taskGraphEngine.js')).TaskGraphBuilder.fromToolCalls('x', [
    { id: 'c', function: { name: 'web_search', arguments: '{}' } },
  ]);
  const t0 = Date.now();
  await taskGraphEngine.execute(g, async () => { throw new Error(blank.error ?? ''); });
  ok('a missing argument is not retried', Date.now() - t0 < 900 && [...g.nodes.values()][0]!.retryCount === 1, `${Date.now() - t0}ms`);

  const noLevel = warnings.filter((w) => w.includes('declares no requiredLevel'));
  ok('no "declares no requiredLevel" warnings at startup', noLevel.length === 0, noLevel.map((w) => w.split('"')[1]).join(', '));
}

console.log('\n--- 4. Level-0 tools still refuse what needs full control ---');
if (permissionSession.getCurrentLevel() === 0) {
  const stop = await toolRegistryV2.execute('control_system', { action: 'stop_service', target: 'Spooler' });
  ok('control_system: stopping a service is refused at level 0', !stop.success && /level 2/i.test(stop.error ?? ''), stop.error);
  const kill = await toolRegistryV2.execute('control_process', { action: 'kill', target: 'jarvis-no-such-process' });
  ok('control_process: killing is refused at level 0', !kill.success && /level 2/i.test(kill.error ?? ''), kill.error);
} else {
  console.log('  SKIP: full control is active in this environment');
}

console.log('\n--- 5. A replan that answers is not followed by a failure message ---');
{
  diagnosis = '{"failureClass":"tool_error","repairStrategy":"replan","context":"memory store refused"}';
  let r = await withTool('search_memory', { execute: async () => JSON.stringify({ success: false, error: 'Request unauthorized by provider' }) },
    () => say('recall what I told you about my car', [[{ name: 'search_memory', args: { query: 'my car' } }], 'You told me your car is blue, sir.']));
  ok('only the answer is spoken', r.reply === 'You told me your car is blue, sir.', r.reply);

  r = await withTool('search_memory', { execute: async () => JSON.stringify({ success: false, error: 'Request unauthorized by provider' }) },
    () => say('recall what I said about my bike', [[{ name: 'search_memory', args: { query: 'my bike' } }], new Error('fetch failed')]));
  ok('an LLM failure during the replan is reported once', spoken.length === 1 && /difficulty reaching/.test(r.reply), r.reply);
  diagnosis = '{"failureClass":"unknown","repairStrategy":"abort","context":""}';
}

console.log('\n--- 6. Only a reply that is a tool call is run as one ---');
{
  const extract = (text: string, offered?: string[]) => (orchestrator as any).extractToolCallsFromContent(text, offered);
  ok('an answer containing an example call is an answer',
    extract('Here is how, sir: ```json\n{"tool":"open_app","args":{"target":"chrome"}}\n``` Anything else?', ['open_app']).length === 0);
  ok('a tool that was not offered is not run', extract('{"tool":"control_file","args":{"action":"delete","path":"notes.txt"}}', ['open_app']).length === 0);
  const call = extract('```json\n{"tool":"open_app","args":{"target":"chrome"}}\n```', ['open_app']);
  ok('a reply that is only a call still works', call.length === 1 && call[0].function.name === 'open_app');
}

console.log('\n--- 7. When the LLM is down, the fallback uses real tools and the user\'s words ---');
{
  let infoRuns = 0;
  const r = await withTool('get_system_info', { execute: async () => { infoRuns++; return 'Windows 10, 8 GB RAM'; } },
    () => say('how is my system doing today', [new Error('fetch failed')]));
  ok('the system fallback runs get_system_info', infoRuns === 1 && r.reply === 'Windows 10, 8 GB RAM', r.reply);
}

console.log('\n--- 8. A failed command is not "Task completed" ---');
{
  const output = 'Exit code: 1\nOutput:\nnpm ERR! Missing script: "test"\n' + 'npm ERR! more detail about the failure here\n'.repeat(5);
  const r = await withTool('run_command', { level: 0, execute: async () => output },
    () => say('run the tests', [[{ name: 'run_command', args: { command: 'npm test' } }]]));
  ok('says it failed, with the exit code and first line', r.reply === 'The command failed with exit code 1, sir. npm ERR! Missing script: "test"', r.reply);
  const describe = orchestratorModule.describeCommandResult;
  ok('a successful command says done', typeof describe === 'function' && describe('Exit code: 0\nOutput:\nall good') === 'Done, sir. all good');
}

console.log('\n--- 9. Services and processes ---');
{
  const check = adminModule.checkServiceName;
  let threw = '';
  try { check('spooler; Remove-Item C:\\important'); } catch (e) { threw = (e as Error).message; }
  ok('a service "name" carrying a second command is refused', /rejected by policy/.test(threw), threw || 'accepted');

  approvalsAsked = 0;
  const realCheck = permissionSession.checkPermission.bind(permissionSession);
  (permissionSession as any).checkPermission = () => true; // as if full control were on
  try {
    let msg = '';
    try { await adminModule.adminController.stopService('WinDefend'); } catch (e) { msg = (e as Error).message; }
    ok('stopping Windows Defender is refused', /safety policy/.test(msg), msg);
    try { await adminModule.adminController.startService("Spooler'; calc; '"); } catch (e) { msg = (e as Error).message; }
    ok('an injected start is refused', /rejected by policy/.test(msg), msg);
    ok('neither reached the approval prompt', approvalsAsked === 0, `${approvalsAsked} prompt(s)`);

    const pc = processController as any;
    const realFind = pc.findProcess;
    pc.findProcess = async () => [{ name: 'lsass', pid: 700 }];
    try { await processController.killProcess('lsass'); } catch (e) { msg = (e as Error).message; }
    ok('killing a protected process is refused without asking first', /forbidden/.test(msg) && approvalsAsked === 0, `${msg} / ${approvalsAsked} prompt(s)`);
    pc.findProcess = async () => [];
    msg = '';
    try { msg = await processController.killProcess('nothing-like-this'); } catch (e) { msg = `threw: ${(e as Error).message}`; }
    ok('killing a process that is not running fails', msg.startsWith('threw: No process found'), msg);
    pc.findProcess = realFind;
  } finally {
    (permissionSession as any).checkPermission = realCheck;
  }
}

console.log('\n--- 10. A command given while JARVIS is speaking is not cancelled ---');
{
  agentStateMachine.reset();
  agentStateMachine.safeTransitionToSpeaking();
  planningSignalAborted = undefined;
  const r = await say('what should I cook tonight', ['Pasta, sir.']);
  ok('its LLM request starts with a live signal', planningSignalAborted === false, `aborted=${planningSignalAborted}`);
  ok('and it is answered', r.reply === 'Pasta, sir.', r.reply);
}

try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
