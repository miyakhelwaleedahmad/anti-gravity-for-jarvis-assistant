/**
 * tests/secretSinksTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 4 — credentials do not leave JARVIS (docs/upgrade/SECURITY_MODEL.md):
 *
 *  1. Planted secrets in a tool's output and in the user's own words reach no
 *     LLM request, memory file, episode log or log file.
 *  2. save_relation refuses a credential; a fact is stored without it.
 *  3. Calls per minute are limited by risk; over the limit the call is refused
 *     honestly and not retried.
 *  4. A tool that changes something outside the PC is at least risk 2.
 *  5. action_history lists recent calls and approvals, without credentials.
 *
 * The secrets are synthetic (filler in the shape of real formats). The LLM is
 * a fake provider behind the real model router, so the router's own redaction
 * runs; tool bodies are stubbed; data goes to a throwaway folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sinks-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_MIN_TOOL_GAP_MS'] = '0';
delete process.env['JARVIS_TOOL_RATE_LIMITS'];
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { agentMemory } = await import('../memory/agentMemory.js');
const { securityAuditLogger } = await import('../security/securityAuditLogger.js');
const { actionAuditLog } = await import('../control/actionAuditLog.js');
const { toolExecutionSandbox } = await import('../core/toolExecutionSandbox.js');
const { logger } = await import('../monitoring/structuredLogger.js');
let denial: any = {};
try { denial = await import('../control/permissionDenial.js'); } catch { /* */ }

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

// Synthetic credentials.
const GROQ = 'gsk_' + 'Zq9'.repeat(14);
const GITHUB = 'ghp_' + 'Wx7'.repeat(12);
const PASSWORD = 'hunter2-' + 'p'.repeat(6);
const PEM_BODY = 'MIIE' + 'Qk1'.repeat(20);
const BEARER = 'tk' + 'R5'.repeat(15);
const PLANTED = [GROQ, GITHUB, PASSWORD, PEM_BODY, BEARER];
const leaks = (text: string) => PLANTED.filter((s) => text.includes(s));

// A fake LLM provider behind the real router: everything sent is recorded.
const sent: any[] = [];
let plans: Array<Array<{ name: string; args: Record<string, unknown> }>> = [];
const fakeProvider = {
  isConfigured: () => true,
  async chat(req: any) {
    sent.push(req);
    if (req.tools) {
      const next = plans.shift();
      if (next?.length) {
        return { content: '', tool_calls: next.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
      }
      return { content: 'Done, sir.' };
    }
    return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' };
  },
  async *streamChat(req: any) { sent.push(req); yield 'Here is what I found, sir.'; },
};
modelRouter.registerProvider((modelRouter as any).primary, fakeProvider as any);
modelRouter.registerProvider('openai', fakeProvider as any);

const spoken: string[] = [];
(orchestrator as any).speak = (t: string) => { spoken.push(t); };

/** Swap a tool's body for one check, then restore. */
async function withTool<T>(name: string, body: (args: any) => Promise<string>, fn: () => Promise<T>): Promise<T> {
  const tool = toolRegistryV2.get(name)! as any;
  const saved = tool.execute;
  tool.execute = body;
  try { return await fn(); } finally { tool.execute = saved; }
}

/** Every file under the throwaway folder, as text. */
function allFiles(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full));
    else { try { out.push([full, fs.readFileSync(full, 'utf8')]); } catch { /* */ } }
  }
  return out;
}

console.log('\n=== Secret Sinks Test ===\n');

console.log('--- 1. From a tool\'s output ---');
const configText = [
  'settings for the app',
  `GROQ_API_KEY=${GROQ}`,
  `password: ${PASSWORD}`,
  `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`,
  `github ${GITHUB}`,
].join('\n');
fs.writeFileSync(path.join(workspace, 'config.txt'), 'placeholder');
let toolRuns = 0;
await withTool('read_file', async () => { toolRuns++; return configText; }, async () => {
  const direct = await toolRegistryV2.execute('read_file', { filePath: 'config.txt' });
  ok('the registry returns the output without the secrets', leaks(direct.output).length === 0 && direct.output.includes('[REDACTED:'), direct.output.replace(/\n/g, ' | ').slice(0, 120));
  ok('…and keeps the rest', direct.output.includes('settings for the app'));
  plans = [[{ name: 'read_file', args: { filePath: 'config.txt' } }]];
  sent.length = 0;
  await orchestrator.process('read config.txt and tell me what is in it', 'cli');
});
ok('the tool ran', toolRuns >= 2, `${toolRuns} run(s)`);
ok('JARVIS asked the LLM (planning and the answer)', sent.length >= 1, `${sent.length} request(s)`);
ok('no LLM request carries a planted secret', leaks(JSON.stringify(sent)).length === 0, leaks(JSON.stringify(sent)).map((s) => s.slice(0, 6)).join(','));

console.log('\n--- 2. From the user\'s own words ---');
plans = [[]];
sent.length = 0;
await orchestrator.process(`my github token is ${GITHUB} and the wifi password: ${PASSWORD}`, 'cli');
const userRequests = JSON.stringify(sent);
ok('the request reached the LLM', sent.length >= 1);
ok('…without the token or password', leaks(userRequests).length === 0 && userRequests.includes('[REDACTED:'), leaks(userRequests).map((s) => s.slice(0, 6)).join(','));
const history = memoryManager.getConversationHistory(20).map((m) => m.content).join('\n');
ok('conversation memory has the message, without them', history.includes('my github token is') && leaks(history).length === 0);
const { goalManager } = await import('../core/goalManager.js');
await goalManager.flush();
const goalsFile = path.join(workspace, 'data', 'runtime', 'goals.json');
const goalsText = fs.existsSync(goalsFile) ? fs.readFileSync(goalsFile, 'utf8') : '';
ok('the goal file has the request, without them', goalsText.includes('my github token is') && leaks(goalsText).length === 0);

console.log('\n--- 3. Memory ---');
const saved = await toolRegistryV2.execute('save_relation', { entity1: 'User', relation: 'HAS_TOKEN', entity2: GITHUB });
ok('save_relation refuses a credential', !saved.success && /don't store passwords, keys or tokens/.test(saved.output), saved.output);
await memoryManager.rememberFact(`The router admin password: ${PASSWORD}`, 'test', 5);
const facts = memoryManager.getLongTermFacts(50).map((f) => f.fact).join('\n');
ok('a fact is stored without the credential', facts.includes('The router admin password') && !facts.includes(PASSWORD), facts.split('\n').slice(-1)[0]);
agentMemory.pushEpisode('user_input', `User [cli]: deploy with ${GROQ}`, { header: `Authorization: Bearer ${BEARER}` }, 3);
const episode = agentMemory.getRecentEpisodes(1)[0];
ok('an episode is kept without it', !!episode && leaks(JSON.stringify(episode)).length === 0, JSON.stringify(episode).slice(0, 120));

console.log('\n--- 4. Logs ---');
securityAuditLogger.denied(`curl -H "Authorization: Bearer ${BEARER}"`, 'HIGH_RISK', `token=${GROQ}`, 'run_command');
securityAuditLogger.log({ eventType: 'RISK_ASSESSED', timestamp: new Date().toISOString(), target: `https://admin:${PASSWORD}@example.com`, action: `use ${GITHUB}` } as any);
logger.info('test entry', { apiKey: `api_key=${GROQ}`, note: 'ok' });
// (A password with no label — "login with hunter2" — cannot be recognised by
// any pattern; it is planted here with its label, as a user or tool writes it.)
await actionAuditLog.log({ userCommand: `login with password: ${PASSWORD}`, normalizedIntent: 'x', action: 'x', target: `password: ${PASSWORD}`, permissionLevel: 0, riskLevel: 'safe', allowed: true, confirmationRequired: false, result: 'success', durationMs: 1 } as any);
const highTool: any = { name: 'fake_high_tool', riskLevel: 'high', description: 'test', inputSchema: {}, fallbacks: [], execute: async () => 'ok' };
await toolExecutionSandbox.run(highTool, { command: `deploy --key ${'x'.repeat(170)} ${GROQ}` });
await sleep(400); // the structured log and the tool audit are written asynchronously

console.log('\n--- 5. Every file JARVIS wrote ---');
await memoryManager.flush?.();
await sleep(300);
const files = allFiles(workspace).filter(([f]) => !f.endsWith('config.txt'));
const leaking = files.filter(([, text]) => leaks(text).length > 0).map(([f]) => path.relative(workspace, f));
ok(`no planted secret in any of the ${files.length} files written`, leaking.length === 0, leaking.join(', '));
const auditText = files.filter(([f]) => f.endsWith('security_audit.log')).map(([, t]) => t).join('');
ok('the audit log still has the entries', auditText.includes('COMMAND_DENIED') && auditText.includes('[REDACTED:'));
ok('the tool audit has the high-risk call', files.some(([f, t]) => f.endsWith('tool_audit.log') && t.includes('fake_high_tool')));

console.log('\n--- 6. Rate limits ---');
process.env['JARVIS_TOOL_RATE_LIMITS'] = '120,3,20,10,10';
let searches = 0;
await withTool('web_search', async () => { searches++; return 'result'; }, async () => {
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await toolRegistryV2.execute('web_search', { query: `rate limit test ${i}` }));
  ok('three level-1 calls run', results.slice(0, 3).every((r) => r.success) && searches === 3);
  ok('the fourth in the same minute is refused, not run', !results[3].success && results[3].error === 'RATE_LIMITED' && searches === 3, results[3].output);
  plans = [[{ name: 'web_search', args: { query: 'rate limit test planned' } }]];
  spoken.length = 0;
  await orchestrator.process('search the web for the weather in Paris', 'cli');
  ok('through the orchestrator: an honest reply, and no retry', spoken.join(' ') === denial.RATE_LIMITED_REPLY && searches === 3, spoken.join(' | '));
});
delete process.env['JARVIS_TOOL_RATE_LIMITS'];
const { rateLimitFor } = await import('../core/toolRegistryV2.js') as any;
ok('defaults by risk: 120, 60, 20, 10, 10', [0, 1, 2, 3, 4].map((l) => rateLimitFor?.(l, {})).join() === '120,60,20,10,10');

console.log('\n--- 7. Changing something outside the PC ---');
toolRegistryV2.register({
  name: 'test_send_message', description: 'test', riskLevel: 'low', inputSchema: {}, fallbacks: [],
  meta: { category: 'COMMUNICATION', risk: 1, reversible: 'no', external: 'change', effect: 'Sends a message.', output: { format: 'text', description: 'status' } },
  execute: async () => 'sent',
} as any);
ok('a tool with external "change" is at least risk 2', toolRegistryV2.riskOf('test_send_message', {}) === 2, String(toolRegistryV2.riskOf('test_send_message', {})));

console.log('\n--- 8. action_history ---');
const recent = await toolRegistryV2.execute('action_history', { limit: 50 });
let parsed: any = null;
try { parsed = JSON.parse(recent.output); } catch { /* */ }
ok('lists recent calls and approvals', recent.success && Array.isArray(parsed?.calls) && Array.isArray(parsed?.approvals)
  && parsed.calls.some((c: any) => c.tool === 'read_file') && parsed.calls.some((c: any) => c.tool === 'save_relation'), recent.output.slice(0, 100));
ok('without the credentials passed to them', leaks(recent.output).length === 0);
ok('action_history is level 0', toolRegistryV2.riskOf('action_history', {}) === 0);

try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
