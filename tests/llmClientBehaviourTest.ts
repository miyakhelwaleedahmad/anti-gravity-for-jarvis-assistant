/**
 * tests/llmClientBehaviourTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The primary LLM client against a fake OpenAI-compatible server (no network).
 *
 * Gemini's free tier allows 5 requests a minute per model, so a wasted retry is
 * a real cost. Behaviour pinned here:
 *   - what is sent (address, key header, model, reasoning_effort)
 *   - which failures are retried: 5xx and network yes; 4xx, a reply cut off
 *     by max_tokens, and a cancelled request no
 *   - 429 tries the fast model once, then stops (it made 3 calls before)
 *   - streaming does not retry a 4xx
 *   - ping() lists models instead of generating
 *   - a failed call leaves no unhandled promise rejection
 *   - the router answers a failed stream through chat(); the fallback
 *     provider sends its own model, not the primary's
 */

const KEY = 'AQ.fake-key-for-tests-0123456789abcdef';
for (const name of ['GROQ_API_KEY', 'GROQ_API_URL', 'XAI_API_KEY', 'JARVIS_LLM_PROVIDER', 'JARVIS_LLM_REASONING_EFFORT',
  'JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'JARVIS_FALLBACK_MODEL']) process.env[name] = '';
process.env['GEMINI_API_KEY'] = KEY;
process.env['GEMINI_API_URL'] = 'https://generativelanguage.googleapis.com/v1beta';
process.env['JARVIS_BRAIN_MODEL'] = 'gemini-3.5-flash';
process.env['JARVIS_FAST_MODEL'] = 'gemini-3.5-flash-lite';

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

const { GroqProvider } = await import('../bridge/groqProvider.js');
const { ModelRouter } = await import('../bridge/modelRouter.js');
const { OpenAICompatibleProvider } = await import('../bridge/openaiProvider.js');
const { llmConfig } = await import('../config/llmconfig.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

// ── Fake server ──────────────────────────────────────────────────────────────
interface Seen { url: string; method: string; auth: string; body: any }
let seen: Seen[] = [];
type Reply = (req: Seen) => Response | Promise<Response>;
let replies: Reply[] = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (content: string | null, finish = 'stop', extra: Record<string, unknown> = {}) =>
  json(200, { choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, ...extra } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const geminiError = (status: number, message: string) => json(status, [{ error: { code: status, message, status: 'ERR' } }]);

globalThis.fetch = (async (input: any, init: any = {}) => {
  const req: Seen = {
    url: String(input), method: init.method ?? 'GET',
    auth: new Headers(init.headers).get('Authorization') ?? '',
    body: init.body ? JSON.parse(init.body) : undefined,
  };
  seen.push(req);
  if (init.signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const next = replies.shift();
  if (!next) throw new Error('fake server: no reply queued');
  return next(req);
}) as typeof fetch;

function reset(...queue: Reply[]): void {
  seen = [];
  replies = queue;
  const P = GroqProvider as any;
  P.isCircuitBroken = false;
  P.consecutive429s = 0;
}
let n = 0;
const msg = () => [{ role: 'user' as const, content: `request ${++n}` }]; // unique: defeats the 60 s cache

const provider = new GroqProvider();
const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

console.log('\n=== LLM Client Behaviour Test ===\n');

console.log('--- What is sent to Gemini ---');
{
  reset(() => completion('Hello sir.'));
  const res = await provider.chat({ messages: msg() });
  const r = seen[0]!;
  ok('posts to the OpenAI-compatible endpoint', r.url === `${BASE}/chat/completions`, r.url);
  ok('sends the Gemini key as a bearer token', r.auth === `Bearer ${KEY}`);
  ok('sends the brain model', r.body.model === 'gemini-3.5-flash', r.body.model);
  ok('sends reasoning_effort=minimal', r.body.reasoning_effort === 'minimal', String(r.body.reasoning_effort));
  ok('returns the content', res.content === 'Hello sir.');
}

console.log('\n--- Tool calls (Gemini adds extra_content; an empty id is replaced) ---');
{
  reset(() => completion(null, 'tool_calls', { tool_calls: [{ id: '', type: 'function', extra_content: { google: { thought_signature: 'sig' } }, function: { name: 'open_app', arguments: '{"target":"notepad"}' } }] }));
  const res = await provider.chat({ messages: msg(), tools: [{ type: 'function', function: { name: 'open_app', description: 'open', parameters: { type: 'object', properties: {} } } }] as any });
  ok('tools and tool_choice are forwarded', Array.isArray(seen[0]!.body.tools) && seen[0]!.body.tool_choice === 'auto');
  ok('the tool call is returned', res.tool_calls?.[0]?.function.name === 'open_app');
  ok('an empty tool-call id gets a generated one', !!res.tool_calls?.[0]?.id);
}

console.log('\n--- A reply cut off by max_tokens is not retried ---');
{
  reset(() => completion(null, 'length'), () => completion('should not be reached'));
  let err = '';
  try { await provider.chat({ messages: msg(), max_tokens: 1 }); } catch (e) { err = (e as Error).message; }
  ok('it fails', err.length > 0);
  ok('after exactly one request', seen.length === 1, `${seen.length} request(s)`);
  ok('the error names the cause and the fix', err.includes('max_tokens') && err.includes('JARVIS_LLM_REASONING_EFFORT'), err.slice(0, 90));
}

console.log('\n--- 4xx is not retried, and the provider message is shown ---');
{
  reset(() => geminiError(400, 'models/gemini-9 is not found'), () => completion('no'));
  let err = '';
  try { await provider.chat({ messages: msg() }); } catch (e) { err = (e as Error).message; }
  ok('one request only', seen.length === 1, `${seen.length}`);
  ok('the provider explanation is in the error', err.includes('is not found'), err.slice(0, 90));
}

console.log('\n--- 5xx is retried; the final error is not "undefined" ---');
{
  reset(() => json(503, { error: { message: 'overloaded' } }), () => json(503, { error: { message: 'overloaded' } }), () => json(503, { error: { message: 'overloaded' } }));
  let err = '';
  try { await provider.chat({ messages: msg() }); } catch (e) { err = (e as Error).message; }
  ok('three attempts', seen.length === 3, `${seen.length}`);
  ok('the last error is reported', err.includes('503') && !err.includes('undefined'), err.slice(0, 110));

  reset(() => json(500, {}), () => completion('recovered'));
  const res = await provider.chat({ messages: msg() });
  ok('a transient 5xx recovers on retry', res.content === 'recovered' && seen.length === 2);
}

console.log('\n--- A cancelled request is not retried ---');
{
  reset(() => completion('never'));
  const ctrl = new AbortController();
  ctrl.abort();
  let threw = false;
  try { await provider.chat({ messages: msg(), signal: ctrl.signal }); } catch { threw = true; }
  ok('it fails', threw);
  ok('without retrying', seen.length === 1, `${seen.length} request(s)`);
}

console.log('\n--- 429: the fast model once, then stop ---');
{
  reset(() => geminiError(429, 'quota exceeded'), () => completion('from lite'));
  const res = await provider.chat({ messages: msg() });
  ok('answered by the fast model', res.content === 'from lite' && seen[1]?.body.model === 'gemini-3.5-flash-lite', seen[1]?.body.model);

  reset(() => geminiError(429, 'quota exceeded'), () => geminiError(429, 'quota exceeded'), () => completion('third call'));
  let err = '';
  try { await provider.chat({ messages: msg() }); } catch (e) { err = (e as Error).message; }
  ok('two rate-limited requests, not three', seen.length === 2, `${seen.length}`);
  ok('the quota message reaches the log', err.includes('quota exceeded'), err.slice(0, 90));
}

console.log('\n--- A daily quota (retry in hours) skips that model until then ---');
{
  const { parseRetryDelayMs } = await import('../bridge/groqProvider.js');
  ok('parses "37.1s"', parseRetryDelayMs('Please retry in 37.1s.') === 37100);
  ok('parses "16h37m57.5s"', parseRetryDelayMs('Please retry in 16h37m57.5s.') === ((16 * 60 + 37) * 60 + 57.5) * 1000);
  ok('no delay → undefined', parseRetryDelayMs('quota exceeded') === undefined);

  const daily = 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash Please retry in 16h37m57.5s.';
  reset(() => geminiError(429, daily), () => completion('from lite'));
  let err = '';
  const first = await provider.chat({ messages: msg() }).catch((e) => { err = (e as Error).message; return null; });
  ok('first command still answered by the fast model', first?.content === 'from lite', err);

  reset(() => completion('straight to lite'));
  const second = await provider.chat({ messages: msg() });
  ok('next command goes straight to the fast model (one request)', seen.length === 1 && seen[0]!.body.model === 'gemini-3.5-flash-lite', `${seen.length} req, ${seen[0]?.body.model}`);
  ok('and is answered', second.content === 'straight to lite');
  (GroqProvider as any).modelCooldownUntil.clear();

  reset(() => geminiError(429, daily), () => geminiError(429, daily));
  err = '';
  try { await provider.chat({ messages: msg() }); } catch (e) { err = (e as Error).message; }
  ok('the quota line, not the boilerplate, reaches the log', err.includes('limit: 20') && err.includes('16h37m'), err.slice(0, 140));
  (GroqProvider as any).modelCooldownUntil.clear();
}

console.log('\n--- Streaming ---');
{
  const sse = 'data: {"choices":[{"delta":{"content":"Hello, "}}]}\n\ndata: {"choices":[{"delta":{"content":"sir."}}]}\n\ndata: [DONE]\n\n';
  reset(() => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  let text = '';
  for await (const piece of provider.streamChat({ messages: msg() })) text += piece;
  ok('stream content is assembled', text === 'Hello, sir.', text);
  ok('stream sends stream=true and reasoning_effort', seen[0]!.body.stream === true && seen[0]!.body.reasoning_effort === 'minimal');

  reset(() => geminiError(400, 'bad model'), () => completion('no'), () => completion('no'));
  let err = '';
  try { for await (const _ of provider.streamChat({ messages: msg() })) { /* drain */ } } catch (e) { err = (e as Error).message; }
  ok('a 4xx stream error is not retried', seen.length === 1, `${seen.length} request(s)`);
  ok('and says why', err.includes('bad model'), err.slice(0, 80));
}

console.log('\n--- ping() lists models instead of generating ---');
{
  reset(() => json(200, { object: 'list', data: [{ id: 'models/gemini-3.5-flash' }, { id: 'models/gemini-3.5-flash-lite' }] }));
  const p = await provider.ping();
  ok('GET /models', seen[0]!.method === 'GET' && seen[0]!.url === `${BASE}/models`, `${seen[0]!.method} ${seen[0]!.url}`);
  ok('the configured model is found under its "models/" id', p.modelFound === true);

  reset(() => json(200, { data: [{ id: 'models/gemini-2.5-flash' }] }));
  let err = '';
  try { await provider.ping(); } catch (e) { err = (e as Error).message; }
  ok('a misspelt model is reported by name', err.includes(llmConfig.model), err.slice(0, 90));

  reset(() => geminiError(400, 'API key not valid'));
  err = '';
  try { await provider.ping(); } catch (e) { err = (e as Error).message; }
  ok('a bad key is reported', err.includes('API key not valid'), err.slice(0, 80));
}

console.log('\n--- Router: a failed stream is answered once through chat() ---');
{
  const fake = (streamFails: 'before' | 'after' | 'no') => ({
    chats: 0,
    async chat() { this.chats++; return { content: 'non-streamed answer' }; },
    async *streamChat() {
      if (streamFails === 'after') { yield 'partial '; throw new Error('cut'); }
      if (streamFails === 'before') throw new Error('stream down');
      yield 'streamed';
    },
  });
  const r1 = new ModelRouter('gemini'); const p1 = fake('before'); r1.registerProvider('gemini', p1 as any);
  let out = ''; for await (const c of r1.streamChat({ messages: msg() })) out += c;
  ok('failure before any text falls back to chat()', out === 'non-streamed answer' && p1.chats === 1, out);

  const r2 = new ModelRouter('gemini'); const p2 = fake('after'); r2.registerProvider('gemini', p2 as any);
  let threw = false; out = '';
  try { for await (const c of r2.streamChat({ messages: msg() })) out += c; } catch { threw = true; }
  ok('failure mid-reply is not answered twice', threw && p2.chats === 0, `chats=${p2.chats}`);

  const r3 = new ModelRouter('gemini'); const p3 = fake('no'); r3.registerProvider('gemini', p3 as any);
  out = ''; for await (const c of r3.streamChat({ messages: msg() })) out += c;
  ok('a healthy stream is untouched', out === 'streamed' && p3.chats === 0);
}

console.log('\n--- Fallback provider sends its own model ---');
{
  const fb = new OpenAICompatibleProvider('https://fallback.example.test/v1', 'sk-test', 'gpt-4o-mini');
  let sentModel = '';
  (fb as any).client = { post: async (_url: string, body: any) => { sentModel = body.model; return { data: { choices: [{ message: { content: 'ok' } }] } }; } };
  await fb.chat({ model: 'gemini-3.5-flash', messages: msg() });
  ok('not the primary\'s model', sentModel === 'gpt-4o-mini', sentModel);
}

await new Promise((r) => setTimeout(r, 50));
ok('no unhandled promise rejections from failed calls', unhandled === 0, `${unhandled}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
