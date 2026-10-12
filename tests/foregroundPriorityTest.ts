/**
 * tests/foregroundPriorityTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PERF-02: background agents and goals share the model quota with the
 * request the owner is waiting for. While a conversation is active, a model
 * call made inside an agent waits (up to a limit); a foreground call never
 * waits. Stand-in provider; no network.
 *
 *   1. during a conversation, the foreground call goes first and the
 *      background call reaches the provider only after the conversation ends
 *   2. with no conversation, a background call goes at once
 *   3. the wait has a limit (JARVIS_BACKGROUND_YIELD_MS)
 *   4. a background call cancelled while waiting never reaches the provider
 *   5. with a provider limit of 2 calls, three queued background calls no
 *      longer take the owner's call's place
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-foreground-'));
process.env['JARVIS_DATA_ROOT'] = root;
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_BACKGROUND_YIELD_MS'] = '5000';

const { modelRouter } = await import('../bridge/modelRouter.js');
const { conversationBus } = await import('../core/conversationBus.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const reached: string[] = [];
let quota = Infinity;
const provider = {
  isConfigured: () => true,
  async chat(req: any) {
    if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const who = String(req.messages.at(-1).content);
    reached.push(who);
    if (quota <= 0) throw new Error('429 rate limit reached');
    quota--;
    await new Promise((r) => setTimeout(r, 10));
    return { content: `ok ${who}` };
  },
  async *streamChat() { yield 'ok'; },
};
modelRouter.registerProvider((modelRouter as any).primary, provider as any);
(modelRouter as any).failoverOrder = () => [(modelRouter as any).primary];

const agent = { rootTaskId: 'r1', taskId: 't1', agentId: 'research-1', agentPath: 'JARVIS › Research Agent', request: 'research laptops', source: 'cli' as const };
const ask = (who: string, signal?: AbortSignal) => modelRouter.chat({ model: 'm', messages: [{ role: 'user', content: who }], signal } as any);
const background = (who: string, signal?: AbortSignal) => runAsAgent(agent, () => ask(who, signal));
const settle = (p: Promise<any>) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e?.message ?? e) }));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== The owner\'s request goes first (PERF-02) ===\n');

console.log('--- 1. During a conversation ---');
conversationBus.conversationStarted();
const bg = settle(background('background 1'));
await tick(50);
const fg = await settle(ask('owner'));
ok('the owner\'s call is answered', fg.ok);
ok('the background call has not reached the provider yet', !reached.includes('background 1'), reached.join(','));
conversationBus.conversationEnded();
const bgResult = await bg;
ok('…and goes ahead once the conversation ends', bgResult.ok && reached.indexOf('background 1') > reached.indexOf('owner'), reached.join(','));

console.log('\n--- 2. No conversation ---');
reached.length = 0;
const t0 = Date.now();
await background('background 2');
ok('a background call goes at once', Date.now() - t0 < 500, `${Date.now() - t0} ms`);

console.log('\n--- 3. The wait has a limit ---');
process.env['JARVIS_BACKGROUND_YIELD_MS'] = '200';
conversationBus.conversationStarted();
const t1 = Date.now();
const limited = await settle(background('background 3'));
const waited = Date.now() - t1;
ok('it goes ahead after the limit although the conversation goes on', limited.ok && waited >= 180 && waited < 2000, `${waited} ms`);
conversationBus.conversationEnded();
process.env['JARVIS_BACKGROUND_YIELD_MS'] = '5000';

console.log('\n--- 4. Cancelled while waiting ---');
reached.length = 0;
conversationBus.conversationStarted();
const stop = new AbortController();
const cancelled = settle(background('background 4', stop.signal));
await tick(50);
stop.abort();
const c = await cancelled;
ok('the call ends as cancelled', !c.ok, c.ok ? 'it finished' : (c as any).e);
ok('it never reached the provider', !reached.includes('background 4'), reached.join(','));
conversationBus.conversationEnded();

console.log('\n--- 5. A provider limit of 2 calls ---');
reached.length = 0;
quota = 2;
conversationBus.conversationStarted();
const queued = [settle(background('bg A')), settle(background('bg B')), settle(background('bg C'))];
await tick(30);
const owner = await settle(ask('owner question'));
ok('the owner\'s call is answered, not refused for quota', owner.ok, owner.ok ? '' : (owner as any).e);
conversationBus.conversationEnded();
const after = await Promise.all(queued);
ok('the background calls ran after it (one fits the quota left; the others get the 429)',
  after.filter((r) => r.ok).length === 1 && reached[0] === 'owner question', `${reached.join(',')}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
