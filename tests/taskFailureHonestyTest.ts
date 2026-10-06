/**
 * tests/taskFailureHonestyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Why JARVIS said it had done things it had not, and gave no usable reason
 * when it could not:
 *
 *  1. open_app and the control_* skills report failure as JSON
 *     ({"success": false, "error": ...}), but the registry only treated
 *     "Error:"-prefixed text as a failure: "open paint" (refused) answered
 *     "Opening paint, sir.", and "close notepad" with nothing open answered
 *     "Closing Notepad, sir."
 *  2. "close chrome" offered the model no tool that can close an app.
 *  3. "open spotify / firefox / edge" went to open_app, whose allow-list did
 *     not contain them.
 *  4. A permission refusal said "encountered an issue" or "unexpected error",
 *     was retried twice (~3 s) and cost an extra LLM request.
 *  5. Reflection asked the LLM for a repair strategy when retries were spent
 *     and its answer would be discarded.
 *
 * Nothing is launched or closed: tools are stubbed or refuse before acting,
 * and refusals are forced with an unreachable permission level (3) rather
 * than by changing the saved full-control session.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// A throwaway workspace: memory and goals written by these requests must never
// land in the real memory/ and data/ folders. Set before JARVIS modules load.
const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-honesty-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2, reportedFailure } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { reflectionEngine } = await import('../core/reflectionEngine.js');
const { agentMemory } = await import('../memory/agentMemory.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { TaskGraphBuilder } = await import('../core/taskGraphEngine.js');
const { resolveTargetUrl } = await import('../skills/automation/skill.js');
const { FULL_CONTROL_HINT } = await import('../control/permissionDenial.js');
const { appController } = await import('../control/appController.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

// A stand-in model: on a planning call it makes the scripted tool calls.
let script: Array<{ name: string; args: Record<string, unknown> }> = [];
let llmCalls = 0;
let offered: string[] = [];
modelRouter.chat = async (req: any) => {
  llmCalls++;
  if (req.tools) offered = req.tools.map((t: any) => t.function?.name);
  if (req.tools && script.length) {
    const calls = script;
    script = [];
    return {
      content: '',
      tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    } as any;
  }
  return { content: '{"failureClass":"unknown","repairStrategy":"retry_same","context":""}' } as any;
};
modelRouter.streamChat = async function* () { llmCalls++; yield 'Done, sir.'; } as any;

let spoken: string[] = [];
(orchestrator as any).speak = (text: string) => { spoken.push(text); };

async function say(input: string, calls: typeof script = []): Promise<{ reply: string; ms: number }> {
  spoken = []; llmCalls = 0; offered = []; script = calls;
  const t0 = Date.now();
  await orchestrator.process(input, 'voice');
  return { reply: spoken.join(' | '), ms: Date.now() - t0 };
}

/**
 * Swap a registered tool's behaviour and level for one check, then restore.
 * `level` sets both the tool's floor and its risk, so that neither permission
 * check is what the check is about.
 */
async function withTool<T>(name: string, patch: { level?: number; output?: string }, fn: () => Promise<T>): Promise<T> {
  const tool = toolRegistryV2.get(name)! as any;
  const saved = { execute: tool.execute, requiredLevel: tool.requiredLevel, meta: tool.meta };
  if (patch.level !== undefined) {
    tool.requiredLevel = patch.level;
    tool.meta = { ...tool.meta, risk: patch.level, actions: undefined };
  }
  if (patch.output !== undefined) tool.execute = async () => patch.output;
  try { return await fn(); } finally { tool.execute = saved.execute; tool.requiredLevel = saved.requiredLevel; tool.meta = saved.meta; }
}

console.log('\n=== Task Failure Honesty Test ===\n');

console.log('--- 1. A tool that reports {"success": false} has failed ---');
ok('reportedFailure() reads it', reportedFailure('{"success":false,"error":"Target is not in the open_app allowlist."}').failed);
ok('and keeps the reason', reportedFailure('{"success":false,"error":"nope"}').reason === 'nope');
ok('a success, plain text or broken JSON is not a failure',
  !reportedFailure('{"success":true}').failed && !reportedFailure('Opened chrome').failed && !reportedFailure('{oops').failed);

let r = await withTool('open_app', { output: JSON.stringify({ success: false, target: 'youtube', error: 'Target is not in the open_app allowlist.' }) },
  () => say('open youtube'));
ok('"open youtube" refused by the tool is not reported as opening', !/Opening youtube, sir\./.test(r.reply) && r.reply.includes('allowlist'), r.reply);

r = await withTool('control_app', { level: 0, output: JSON.stringify({ success: false, action: 'closeApp', target: 'notepad', error: 'No open application matches "notepad".' }) },
  () => say('close notepad'));
ok('"close notepad" with nothing open says so instead of "Closing Notepad"', !/Closing Notepad/.test(r.reply) && r.reply.includes('No open application matches'), r.reply);

console.log('\n--- 2. Close requests offer tools that can close ---');
for (const input of ['close chrome', 'close whatsapp', 'minimize spotify']) {
  const tools: string[] = (orchestrator as any).selectPlanningToolNames(input);
  ok(`"${input}" offers control_app and control_window`, tools.includes('control_app') && tools.includes('control_window'), tools.join(','));
}

console.log('\n--- 3. Every app the voice router opens is on the open_app allow-list ---');
const routerAliases = ['youtube', 'you tube', 'google', 'gmail', 'github', 'git hub', 'whatsapp', 'whats app', 'vscode', 'vs code',
  'code', 'visual studio code', 'notepad', 'cmd', 'command prompt', 'terminal', 'calculator', 'calc', 'spotify', 'chrome',
  'firefox', 'edge', 'browser', 'settings', 'downloads'];
for (const alias of routerAliases) {
  const route = orchestrator.matchDeterministicCommand(`open ${alias}`);
  const target = route?.target ?? '';
  const resolved = resolveTargetUrl(target);
  ok(`"open ${alias}" → ${target} is openable`, route?.type === 'open_app' && (resolved.allowed || !!resolved.requiresApproval), resolved.reason ?? resolved.resolvedTarget);
}

console.log('\n--- 4. A permission refusal says how to fix it, without retries ---');
r = await withTool('control_app', { level: 3 }, () => say('close notepad'));
ok('quick command: tells you to enable full control mode', r.reply === FULL_CONTROL_HINT, r.reply);

r = await withTool('control_window', { level: 3 }, () => say('minimize the chrome window', [{ name: 'control_window', args: { action: 'minimize', target: 'chrome' } }]));
ok('AI path: tells you to enable full control mode', r.reply === FULL_CONTROL_HINT, r.reply);
ok('AI path: no retries (no 1 s back-off)', r.ms < 900, `${r.ms}ms`);
ok('AI path: only the planning request reached the LLM', llmCalls === 1, `${llmCalls} calls`);

r = await say('open paint please', [{ name: 'open_app', args: { target: 'paint' } }]);
ok('an app off the allow-list is refused out loud, not "Opening paint"', !/Opening paint/.test(r.reply) && r.reply.includes('allowlist'), r.reply);
ok('without retries or a diagnosis request', r.ms < 900 && llmCalls === 1, `${r.ms}ms, ${llmCalls} calls`);

console.log('\n--- closeApp now fails when nothing matches; restart still opens ---');
{
  const ac = appController as any;
  const saved = { closeApp: ac.closeApp, openApp: ac.openApp };
  ac.closeApp = async () => { throw new Error('No open application matches "notepad".'); };
  ac.openApp = async () => 'Opened "notepad" successfully.';
  let restarted = '';
  try { restarted = await appController.restartApp('notepad'); } catch (e) { restarted = `threw: ${(e as Error).message}`; }
  ac.closeApp = saved.closeApp; ac.openApp = saved.openApp;
  ok('"restart notepad" when it is not running just opens it', restarted === 'Opened "notepad" successfully.', restarted);
}

console.log('\n--- 5. No LLM diagnosis once retries are spent ---');
const graph = TaskGraphBuilder.fromToolCalls('do something', [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] as any);
for (const node of graph.nodes.values()) {
  node.status = 'failed';
  node.error = 'Something odd happened';
  node.retryCount = node.maxRetries + 1;
}
llmCalls = 0;
const reflection = await reflectionEngine.reflect(graph, agentMemory);
ok('retries spent: strategy is abort', reflection.repairStrategy === 'abort', reflection.repairStrategy);
ok('and the LLM was not asked', llmCalls === 0, `${llmCalls} calls`);

try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
