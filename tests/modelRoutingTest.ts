/**
 * tests/modelRoutingTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Model routing (bridge/modelCategories.ts, bridge/modelRouter.ts) and the
 * optional Claude provider (bridge/anthropicProvider.ts). No network: the
 * providers are stand-ins at their own boundary (the SDK client for Claude).
 * Live calls are not tested here; nothing in this file proves that a real key
 * or a real model works.
 *
 *   1. Categories: defaults from the configured models; moved by
 *      configuration alone; review is independent of coding when possible.
 *   2. Usage: every call through the router is recorded with its category,
 *      provider, model and correlation id; tokens a provider did not report
 *      are null, never 0; cost only from a price table and known tokens.
 *   3. The Claude provider is never in the failover order, so a key in .env
 *      does not move ordinary requests; a category that names it without a
 *      key fails with the reason.
 *   4. Translation: system prompt, tool calls and results, a forced tool
 *      choice, refusal, usage; no temperature; effort set; fallbacks on by
 *      default and off by setting; the model is looked up before first use.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-model-routing-')));
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k === 'ANTHROPIC_API_KEY') delete process.env[k];

const { routeFor, usageLog, usageSummary, clearUsage, recordUsage, MODEL_CATEGORIES } = await import('../bridge/modelCategories.js');
const { ModelRouter } = await import('../bridge/modelRouter.js');
const { llmConfig } = await import('../config/llmconfig.js');
const { AnthropicProvider, toAnthropicMessages, fromAnthropicMessage } = await import('../bridge/anthropicProvider.js');
const Anthropic = (await import('@anthropic-ai/sdk')).default;
const { beginTrace, endTrace } = await import('../core/traceContext.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

// ── 1. Categories ────────────────────────────────────────────────────────────
console.log('\n--- 1. Categories ---');
ok('six categories', MODEL_CATEGORIES.join() === 'intent,conversation,planning,repair_plan,coding,review');
ok('defaults: intent and conversation on the fast model, planning on the brain model', routeFor('intent', {}).model === llmConfig.fastModel && routeFor('conversation', {}).model === llmConfig.fastModel && routeFor('planning', {}).model === llmConfig.model && routeFor('planning', {}).provider === 'default');
ok('intent has a short time limit', routeFor('intent', {}).timeoutMs === 3000);
const moved = routeFor('coding', { JARVIS_MODEL_CODING: 'anthropic:claude-sonnet-5-5', JARVIS_MODEL_CODING_TIMEOUT_MS: '90000' });
ok('moved by configuration alone: provider, model, time limit', moved.provider === 'anthropic' && moved.model === 'claude-sonnet-5-5' && moved.timeoutMs === 90000 && moved.source === 'config');
ok('"anthropic" alone: the provider default model', routeFor('coding', { JARVIS_MODEL_CODING: 'anthropic' }).model === 'claude-opus-5-5');
ok('a bare model name keeps the configured provider', routeFor('planning', { JARVIS_MODEL_PLANNING: 'some-model' }).provider === 'default');
ok('an invalid time limit falls back to the default', routeFor('review', { JARVIS_MODEL_REVIEW_TIMEOUT_MS: 'soon' }).timeoutMs === 120000);
const same = routeFor('review', { JARVIS_MODEL_CODING: 'x:m', JARVIS_MODEL_REVIEW: 'x:m' });
ok('review on the same model as coding is marked not independent', same.independent === false);
ok('review defaults to a model other than coding\'s when one exists', llmConfig.fastModel === llmConfig.model || routeFor('review', {}).independent === true);

// ── 2. Usage records ─────────────────────────────────────────────────────────
console.log('\n--- 2. Usage records ---');
const router = new ModelRouter('stub');
let usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | undefined;
let sentBodies: any[] = [];
router.registerProvider('stub', { chat: async (r: any) => { sentBodies.push(r); return { content: 'hi', ...(usage ? { usage } : {}) }; } } as never);
clearUsage();
const trace = beginTrace('cli', 'x');
await router.chat({ messages: [{ role: 'user', content: 'a' }], model: 'm1', category: 'planning' });
endTrace();
usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
await router.chat({ messages: [{ role: 'user', content: 'b' }], model: 'm1' });
const [r1, r2] = usageLog();
ok('a call is recorded with category, provider, model and correlation id', r1?.category === 'planning' && r1.provider === 'stub' && r1.model === 'm1' && r1.correlationId === trace && r1.ok === true);
ok('tokens a provider did not report are null, not 0', r1?.promptTokens === null && r1.completionTokens === null);
ok('an untagged call is recorded as unspecified', r2?.category === 'unspecified' && r2.promptTokens === 10);
ok('no cost without a price table', r2?.estimatedCostUsd === undefined);
process.env['JARVIS_MODEL_PRICES'] = JSON.stringify({ m1: { input: 4, output: 20 } });
ok('cost estimated only with a price and both counts', recordUsage({ category: 'coding', provider: 'p', model: 'm1', latencyMs: 1, ok: true, fallbackUsed: false, streamed: false, promptTokens: 1_000_000, completionTokens: 100_000 }).estimatedCostUsd === 6
  && recordUsage({ category: 'coding', provider: 'p', model: 'm1', latencyMs: 1, ok: true, fallbackUsed: false, streamed: false, promptTokens: 5, completionTokens: null }).estimatedCostUsd === undefined);
delete process.env['JARVIS_MODEL_PRICES'];
const sum = usageSummary();
ok('the summary counts calls without token counts separately', sum['planning']?.unknownTokenCalls === 1 && sum['coding']?.unknownTokenCalls === 1 && sum['coding']?.promptTokens === 1_000_000);
{
  // The real body builder of the Groq/Gemini client: the category is not part of what is sent.
  const { groqProvider } = await import('../bridge/groqProvider.js');
  const sent = (groqProvider as any).buildBody({ messages: [{ role: 'user', content: 'a' }], category: 'planning' }, 'm1', 100) as Record<string, unknown>;
  ok('the category is not in the body the real provider sends', !('category' in sent) && sent['model'] === 'm1', JSON.stringify(sent));
}
await router.chat({ messages: [{ role: 'user', content: 'c' }], model: 'm1', category: 'planning' }).catch(() => {});
router.registerProvider('stub', { chat: async () => { throw new Error('boom 503'); } } as never);
await router.chat({ messages: [{ role: 'user', content: 'd' }], model: 'm1', category: 'conversation' }).catch(() => {});
const lastRec = usageLog().at(-1)!;
ok('a failed call is recorded as failed, with the error', lastRec.ok === false && /boom 503/.test(lastRec.error ?? ''));

// ── 3. The Claude provider stays out of the failover ────────────────────────
console.log('\n--- 3. Isolation ---');
let claudeCalls = 0;
const fakeClient = (create: (body: any) => any, retrieve: (id: string) => any = () => ({ id: 'ok' })) => ({
  beta: { messages: { create: async (body: any) => { claudeCalls++; return create(body); } } },
  models: { retrieve: async (id: string) => retrieve(id) },
}) as unknown as InstanceType<typeof Anthropic>;
const okMessage = (extra: Record<string, unknown> = {}) => ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'fixed' }], usage: { input_tokens: 12, output_tokens: 3 }, ...extra });
const configured = new AnthropicProvider({}, () => fakeClient(() => okMessage()));
const iso = new ModelRouter('stub');
iso.registerProvider('stub', { chat: async () => { throw new Error('primary down 503'); } } as never);
iso.registerNamedProvider('anthropic', configured as never);
await iso.chat({ messages: [{ role: 'user', content: 'x' }] }).catch(() => {});
ok('a configured Claude provider is not used when the primary fails (no silent failover)', claudeCalls === 0);
process.env['JARVIS_MODEL_CODING'] = 'anthropic';
const viaCategory = await iso.categoryChat('coding', { messages: [{ role: 'user', content: 'fix' }] });
ok('…it is used when the category names it', claudeCalls === 1 && viaCategory.content === 'fixed' && usageLog().at(-1)!.provider === 'anthropic' && usageLog().at(-1)!.category === 'coding');
ok('…with its token counts in the usage record', usageLog().at(-1)!.promptTokens === 12 && usageLog().at(-1)!.completionTokens === 3);
const noKey = new ModelRouter('stub');
noKey.registerProvider('stub', { chat: async () => ({ content: 'x' }) } as never);
noKey.registerNamedProvider('anthropic', new AnthropicProvider({}) as never);
const err = await noKey.categoryChat('coding', { messages: [{ role: 'user', content: 'x' }] }).then(() => '', (e: Error) => e.message);
ok('named without a key: fails with the reason', /set ANTHROPIC_API_KEY/.test(err), err);
process.env['JARVIS_MODEL_CODING'] = 'nosuch:model';
const err2 = await noKey.categoryChat('coding', { messages: [{ role: 'user', content: 'x' }] }).then(() => '', (e: Error) => e.message);
ok('a category naming an unknown provider fails with the reason', /not configured/.test(err2), err2);
delete process.env['JARVIS_MODEL_CODING'];

// ── 4. Translation and request shape ────────────────────────────────────────
console.log('\n--- 4. The Claude request ---');
const t = toAnthropicMessages([
  { role: 'system', content: 'You are JARVIS.' },
  { role: 'user', content: 'list files' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'files', arguments: '{"action":"list"}' } }, { id: 'c2', type: 'function', function: { name: 'git', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'a.ts' },
  { role: 'tool', tool_call_id: 'c2', content: 'clean' },
], true);
ok('system messages become the system prompt', t.system.startsWith('You are JARVIS.'));
ok('a forced tool choice becomes an instruction (current models reject a forced choice)', /calling one of the provided tools/.test(t.system));
const asst = t.messages[1] as any;
ok('tool calls become tool_use blocks with parsed input', asst.role === 'assistant' && asst.content[0].type === 'tool_use' && asst.content[0].input.action === 'list');
const results = t.messages[2] as any;
ok('all tool results of a turn go back in one user message', t.messages.length === 3 && results.role === 'user' && results.content.length === 2 && results.content.every((b: any) => b.type === 'tool_result'));
let refusal = '';
try { fromAnthropicMessage({ ...okMessage(), stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } as never); } catch (e) { refusal = (e as Error).message; }
ok('a refusal throws (never an empty answer)', /declined the request \(cyber\)/.test(refusal));
const tu = fromAnthropicMessage({ ...okMessage(), stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'files', input: { a: 1 } }], usage: { input_tokens: 4 } } as never);
ok('tool_use back to tool calls; a missing count is null', tu.tool_calls?.[0]?.function.arguments === '{"a":1}' && tu.usage?.completionTokens === null && tu.usage?.totalTokens === null);
let body: any;
let looked = 0;
const p = new AnthropicProvider({}, () => fakeClient((b) => { body = b; return okMessage(); }, () => { looked++; return { id: 'claude-opus-5-5' }; }));
await p.chat({ model: 'claude-opus-5-5', temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] });
await p.chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'again' }] });
ok('no temperature is sent', body && !('temperature' in body));
ok('effort is set explicitly (high by default)', body.output_config?.effort === 'high');
ok('server-side fallback on by default', body.fallbacks === 'default' && body.betas?.includes('server-side-fallback-2026-07-01'));
ok('the model is looked up once before its first use', looked === 1);
const off = new AnthropicProvider({ JARVIS_ANTHROPIC_FALLBACKS: 'off', JARVIS_ANTHROPIC_EFFORT: 'xhigh' }, () => fakeClient((b) => { body = b; return okMessage(); }));
await off.chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] });
ok('fallbacks off and effort changed by setting', !('fallbacks' in body) && body.output_config.effort === 'xhigh');
const missing = new AnthropicProvider({}, () => fakeClient(() => okMessage(), () => { throw new Anthropic.NotFoundError(404, { type: 'error' }, 'model: nope', new Headers()); }));
const mErr = await missing.chat({ model: 'nope', messages: [{ role: 'user', content: 'x' }] }).then(() => '', (e: Error) => e.message);
ok('an unknown model is refused before any message is sent, with the reason', /not available to this Anthropic key/.test(mErr) , mErr);
const limited = new AnthropicProvider({}, () => fakeClient(() => { throw new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', new Headers()); }));
const rErr = await limited.chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] }).then(() => '', (e: Error) => e.message);
ok('a rate limit is reported as such (typed error, not text matching)', /429: rate limit/.test(rErr), rErr);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
