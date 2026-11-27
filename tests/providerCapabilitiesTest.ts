/**
 * tests/providerCapabilitiesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1A (MM-1A-04): providers say what they can take, and a request they
 * cannot take is refused before it is sent, never silently changed.
 *
 * Before Phase 1A a provider was only `chat()`; the Claude adapter kept the
 * text parts of a message and dropped its images without a word.
 *
 *   1. the three adapters declare their capabilities
 *   2. an image request is refused by a provider without image input; the
 *      provider is not called; failover reaches one that can take it
 *   3. a provider that declares nothing has nothing enforced
 *   4. tools to a provider without tool calling are refused
 *   5. the real Claude adapter is never handed an image through the router
 * Scripted providers and a stand-in Claude client; no network.
 */

for (const name of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'JARVIS_LLM_PROVIDER', 'JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];

const { ModelRouter } = await import('../bridge/modelRouter.js');
const { groqProvider } = await import('../bridge/groqProvider.js');
const { openaiProvider } = await import('../bridge/openaiProvider.js');
const { AnthropicProvider, anthropicProvider } = await import('../bridge/anthropicProvider.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e: String((e as Error)?.message ?? e) }));

const KEYS = ['streaming', 'toolCalling', 'structuredOutput', 'imageInput', 'audioInput', 'audioOutput', 'webSearch', 'reportsUsage', 'reportsStreamUsage', 'cancellation', 'ownBreaker'];
const capsOf = (p: unknown) => (typeof (p as { capabilities?: unknown }).capabilities === 'function' ? (p as { capabilities: () => Record<string, unknown> }).capabilities() : undefined);
const complete = (c: Record<string, unknown> | undefined) => !!c && KEYS.every((k) => typeof c[k] === 'boolean');

const imageRequest = () => ({
  messages: [{ role: 'user' as const, content: [{ type: 'text', text: 'What is in this picture?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }],
});
const toolRequest = () => ({
  messages: [{ role: 'user' as const, content: 'open notepad' }],
  tools: [{ type: 'function', function: { name: 'open_app', description: 'open', parameters: { type: 'object', properties: {} } } }],
});
function provider(name: string, caps?: Partial<Record<string, boolean>>) {
  const c = { calls: 0, provider: undefined as unknown as Record<string, unknown> };
  const full = caps ? { streaming: false, toolCalling: true, structuredOutput: false, imageInput: false, audioInput: false, audioOutput: false, webSearch: false, reportsUsage: true, reportsStreamUsage: false, cancellation: true, ownBreaker: false, ...caps } : undefined;
  c.provider = { isConfigured: () => true, async chat() { c.calls++; return { content: `${name} answered` }; }, ...(full ? { capabilities: () => full } : {}) };
  return c;
}
function routerWith(order: string[], providers: Record<string, Record<string, unknown>>) {
  const r = new ModelRouter(order[0]!);
  for (const [n, p] of Object.entries(providers)) r.registerProvider(n, p as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : order);
  return r;
}

console.log('\n=== Providers declare what they can take (Phase 1A) ===\n');

console.log('--- 1. The adapters declare their capabilities ---');
{
  const claude = capsOf(anthropicProvider);
  const gemini = capsOf(groqProvider);
  const fallback = capsOf(openaiProvider);
  ok('Claude adapter declares every capability', complete(claude), JSON.stringify(claude));
  ok('…image input is false (the adapter does not translate images yet)', claude?.['imageInput'] === false);
  ok('…it streams, calls tools and has no breaker of its own', claude?.['streaming'] === true && claude?.['toolCalling'] === true && claude?.['ownBreaker'] === false);
  ok('Gemini/Groq client declares every capability', complete(gemini), JSON.stringify(gemini));
  ok('…with its own breaker and no image input claimed', gemini?.['ownBreaker'] === true && gemini?.['imageInput'] === false);
  ok('OpenAI-compatible fallback declares every capability', complete(fallback), JSON.stringify(fallback));
  ok('…and does not claim streaming (it has no streamChat)', fallback?.['streaming'] === false && typeof (openaiProvider as any).streamChat !== 'function');
  ok('no adapter claims web search, structured output or audio (none implements them)', [claude, gemini, fallback].every((c) => c?.['webSearch'] === false && c?.['structuredOutput'] === false && c?.['audioInput'] === false && c?.['audioOutput'] === false));
}

console.log('\n--- 2. An image is refused, not dropped ---');
{
  const textOnly = provider('textOnly', { imageInput: false });
  const r = routerWith(['textOnly'], { textOnly: textOnly.provider });
  const res = await settle(r.chat(imageRequest()));
  ok('a provider without image input is not called', textOnly.calls === 0, `${textOnly.calls} call(s)`);
  ok('…and the request fails with the reason', !res.ok && /no image input/.test(res.e), res.ok ? 'answered' : res.e);

  const seeing = provider('seeing', { imageInput: true });
  const textOnly2 = provider('textOnly', { imageInput: false });
  const r2 = routerWith(['textOnly', 'seeing'], { textOnly: textOnly2.provider, seeing: seeing.provider });
  const res2 = await settle(r2.chat(imageRequest()));
  ok('failover skips it and reaches a provider that takes images', res2.ok && res2.v.content === 'seeing answered' && textOnly2.calls === 0, res2.ok ? res2.v.content : res2.e);
  const res3 = await settle(r2.chat({ messages: [{ role: 'user', content: 'plain text' }] }));
  ok('a text request still goes to the first provider', res3.ok && res3.v.content === 'textOnly answered', res3.ok ? res3.v.content : res3.e);
}

console.log('\n--- 3. Nothing declared, nothing enforced ---');
{
  const plain = provider('plain');
  const r = routerWith(['plain'], { plain: plain.provider });
  const a = await settle(r.chat(imageRequest()));
  const b = await settle(r.chat(toolRequest()));
  ok('a provider without capabilities() still gets images and tools (unknown is not "no")', a.ok && b.ok && plain.calls === 2, `${plain.calls} call(s)`);
}

console.log('\n--- 4. Tools to a provider without tool calling ---');
{
  const noTools = provider('noTools', { toolCalling: false });
  const r = routerWith(['noTools'], { noTools: noTools.provider });
  const res = await settle(r.chat(toolRequest()));
  ok('refused before sending', !res.ok && noTools.calls === 0 && /no tool calling/.test(res.e), res.ok ? 'answered' : res.e);
  const res2 = await settle(r.chat({ messages: [{ role: 'user', content: 'hello' }] }));
  ok('…a request without tools still goes', res2.ok && noTools.calls === 1);
}

console.log('\n--- 5. The real Claude adapter is never handed an image ---');
{
  let sent: any = null;
  const fake = () => ({
    beta: { messages: { create: async (body: any) => { sent = body; return { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'I see nothing, sir.' }], usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    models: { retrieve: async () => ({ id: 'ok' }) },
  }) as never;
  const claude = new AnthropicProvider({}, fake);
  const r = new ModelRouter('stub');
  r.registerProvider('stub', provider('stub', { imageInput: false }).provider as never);
  r.registerNamedProvider('anthropic', claude as never);
  process.env['JARVIS_MODEL_CODING'] = 'anthropic:claude-opus-5-5';
  const res = await settle(r.categoryChat('coding', imageRequest()));
  delete process.env['JARVIS_MODEL_CODING'];
  ok('an image request to Claude is refused before the API is called', !res.ok && sent === null, res.ok ? `answered: sent ${JSON.stringify(sent?.messages)?.slice(0, 120)}` : res.e);
  ok('…with the reason', !res.ok && /no image input/.test(res.e), res.ok ? '' : res.e);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
