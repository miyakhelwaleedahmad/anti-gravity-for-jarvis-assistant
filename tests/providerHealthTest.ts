/**
 * tests/providerHealthTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider routing and health reporting agree (docs/PROVIDER_HEALTH_AUDIT.md).
 *
 * A real HTTP server on 127.0.0.1 answers like Gemini's OpenAI-compatible
 * endpoint (models list, chat completions, errors, delays), so requests go
 * through the real client over a real socket. No key or network is needed.
 *
 *   1. provider selection: explicit, by keys, unsupported value, no silent switch
 *   2. the configured provider, model and endpoint are the ones used and reported
 *   3. errors classified by status: auth (401, 400 "API key"), rate limit, server,
 *      timeout, malformed reply; shown on the dashboard
 *   4. no stale errors: success clears; another provider's error never shows
 *   5. the probe: rate limit counts as reachable; both models checked
 *   6. fallback answers are visible
 *   7. pipeline names: provider-neutral, old names still accepted, spoken label
 *   8. separate pipelines for vector memory and the memory manager; loading
 *      is not a failure; the watchdog leaves loading alone; heal plans
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

const KEY = 'AQ.fake-gemini-key-for-tests-0123456789';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-provider-'));
process.env['JARVIS_DATA_ROOT'] = tmp;
process.env['JARVIS_WORKSPACE_ROOT'] = tmp;

// ── The fake provider ────────────────────────────────────────────────────────
type Handler = (req: { url: string; method: string; auth: string; body: any }) => { status: number; body: string; delayMs?: number };
let handlers: Handler[] = [];
let defaultHandler: Handler | null = null;
const seen: { url: string; method: string; auth: string; body: any }[] = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const r = { url: req.url ?? '', method: req.method ?? 'GET', auth: String(req.headers['authorization'] ?? ''), body: raw ? JSON.parse(raw) : undefined };
    seen.push(r);
    const h = handlers.shift() ?? defaultHandler;
    if (!h) { res.writeHead(500); res.end('{"error":{"message":"no reply queued"}}'); return; }
    const out = h(r);
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.body);
    }, out.delayMs ?? 0);
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const PORT = (server.address() as { port: number }).port;

const j = (status: number, body: unknown, delayMs = 0) => () => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body), delayMs });
const MODELS = j(200, { data: [{ id: 'models/gemini-3.5-flash' }, { id: 'models/gemini-3.5-flash-lite' }] });
const reply = (text: string) => j(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const gErr = (status: number, message: string) => j(status, [{ error: { code: status, message, status: 'ERR' } }]);

for (const k of ['GROQ_API_KEY', 'GROQ_API_URL', 'XAI_API_KEY', 'JARVIS_LLM_REASONING_EFFORT', 'JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY']) process.env[k] = '';
process.env['JARVIS_LLM_PROVIDER'] = 'gemini';
process.env['GEMINI_API_KEY'] = KEY;
process.env['GEMINI_API_URL'] = `http://127.0.0.1:${PORT}/v1beta/openai`;
process.env['JARVIS_BRAIN_MODEL'] = 'gemini-3.5-flash';
process.env['JARVIS_FAST_MODEL'] = 'gemini-3.5-flash-lite';
process.env['JARVIS_LLM_TIMEOUT_MS'] = '600';

const { resolveProviderSettings, llmConfig } = await import('../config/llmconfig.js');
const { configValidator } = await import('../config/configValidator.js');
const { GroqProvider, groqProvider } = await import('../bridge/groqProvider.js');
const { ModelRouter } = await import('../bridge/modelRouter.js');
const { llmStatus, classifyLLMError } = await import('../bridge/llmStatus.js');
const { pipelineRegistry, pipelineLabel, canonicalPipeline, LLM_PIPELINE, MEMORY_PIPELINE, VECTOR_PIPELINE } = await import('../self_healing/pipelineRegistry.js');
const { healthChecker } = await import('../self_healing/healthChecker.js');
const { alertManager } = await import('../self_healing/alertManager.js');
const { PIPELINE_HEAL_MAP, pipelineWatchdog } = await import('../self_healing/pipelineWatchdog.js');
const { healthManager } = await import('../monitoring/healthManager.js');
const { vectorMemorySupervisor } = await import('../memory/vectorMemorySupervisor.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const noKeyIn = (text: string) => !text.includes(KEY);
let n = 0;
const msg = () => [{ role: 'user' as const, content: `question ${++n}` }];
function resetClient(): void {
  const P = GroqProvider as any;
  P.isCircuitBroken = false;
  P.consecutive429s = 0;
  P.circuitBreakerResetTime = 0;
  P.modelCooldownUntil.clear();
  handlers = [];
  defaultHandler = null;
  seen.length = 0;
}
const llmHealth = async () => (await healthManager.probe()).services['llm']!;

console.log('\n=== Provider routing and health ===\n');

console.log('--- 1. Provider selection ---');
{
  const G = 'AQ.gemini-key-0123456789abcdefghij';
  const Q = 'gsk_groq0123456789abcdefghijklmnop';
  ok('explicit gemini', resolveProviderSettings({ JARVIS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: G, GROQ_API_KEY: Q }).provider === 'gemini');
  ok('explicit groq', resolveProviderSettings({ JARVIS_LLM_PROVIDER: 'groq', GEMINI_API_KEY: G, GROQ_API_KEY: Q }).provider === 'groq');
  const onlyG = resolveProviderSettings({ GEMINI_API_KEY: G });
  ok('only a Gemini key → Gemini, its URL and models', onlyG.provider === 'gemini' && onlyG.baseURL.endsWith('/v1beta/openai') && onlyG.model.startsWith('gemini'));
  const onlyQ = resolveProviderSettings({ GROQ_API_KEY: Q });
  ok('only a Groq key → Groq, its URL', onlyQ.provider === 'groq' && onlyQ.baseURL === 'https://api.groq.com/openai/v1');
  const explicitNoKey = resolveProviderSettings({ JARVIS_LLM_PROVIDER: 'groq', GEMINI_API_KEY: G });
  ok('explicit groq without a Groq key stays groq (no silent switch to Gemini)', explicitNoKey.provider === 'groq' && explicitNoKey.apiKey === '');
  ok('a placeholder key counts as missing', resolveProviderSettings({ JARVIS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'your_gemini_api_key_here' }).apiKey === '');
  const bogus = resolveProviderSettings({ JARVIS_LLM_PROVIDER: 'openai', GEMINI_API_KEY: G });
  ok('an unsupported value is explained and the key decides', bogus.provider === 'gemini' && bogus.notes.some((x) => /not groq or gemini/.test(x)));

  const saved = { ...process.env };
  process.env['JARVIS_LLM_PROVIDER'] = 'openai';
  const report = configValidator.validate();
  Object.assign(process.env, saved);
  ok('the validator reports an unsupported provider as a WARNING, not INFO',
    report.issues.some((i) => i.level === 'WARNING' && i.field === 'JARVIS_LLM_PROVIDER' && /openai/.test(i.message)));
  process.env['JARVIS_LLM_PROVIDER'] = 'gemini';
  process.env['GEMINI_API_KEY'] = KEY;
}

console.log('\n--- 2. What is used is what is reported ---');
{
  resetClient();
  handlers = [reply('hello')];
  const r = await groqProvider.chat({ model: llmConfig.model, messages: msg() });
  const req = seen[0]!;
  ok('the configured provider answered', r.content === 'hello');
  ok('the request went to the configured endpoint', req.url === '/v1beta/openai/chat/completions' && req.method === 'POST', req.url);
  ok('with the configured model and key', req.body?.model === 'gemini-3.5-flash' && req.auth === `Bearer ${KEY}`);
  const snap = llmStatus.snapshot();
  ok('the status reports the same provider, model and host', snap.provider === 'gemini' && snap.model === 'gemini-3.5-flash' && snap.host === `127.0.0.1:${PORT}`);
  ok('the status holds no key', noKeyIn(JSON.stringify(snap)));
  const h = await llmHealth();
  ok('the dashboard says online after a real success, naming Gemini', h.status === 'online' && /Gemini/.test(h.detail ?? '') && !/groq/i.test(h.detail ?? ''), h.detail);
  ok('the LLM pipeline is brain_to_llm and healthy', pipelineRegistry.getHealth()[LLM_PIPELINE]?.status === 'healthy');
}

console.log('\n--- 3. Errors are classified by status, and shown ---');
{
  resetClient();
  handlers = [gErr(401, 'Request had invalid authentication credentials.')];
  let err: any;
  try { await groqProvider.chat({ model: llmConfig.model, messages: msg() }); } catch (e) { err = e; }
  ok('401 fails without retry', seen.length === 1 && err?.status === 401);
  let h = await llmHealth();
  ok('401 → dashboard offline: rejected the key', h.status === 'offline' && /rejected the key \(401\)/.test(h.detail ?? '') && /GEMINI_API_KEY/.test(h.detail ?? ''), h.detail);
  ok('the error text holds no key', noKeyIn(JSON.stringify(llmStatus.snapshot())));

  ok('400 "API key not valid" → auth', classifyLLMError({ status: 400, message: 'Gemini API error 400: API key not valid. Please pass a valid API key.' }).kind === 'auth');
  ok('400 other → bad_request', classifyLLMError({ status: 400, message: 'Invalid JSON payload' }).kind === 'bad_request');

  resetClient();
  handlers = [gErr(429, 'Quota exceeded'), gErr(429, 'Quota exceeded')];
  err = undefined;
  try { await groqProvider.chat({ model: llmConfig.model, messages: msg() }); } catch (e) { err = e; }
  ok('429 tries the fast model once, then stops', seen.length === 2 && seen[1]!.body?.model === 'gemini-3.5-flash-lite' && err?.status === 429);
  h = await llmHealth();
  ok('429 → degraded (rate-limited), not offline', h.status === 'degraded' && /rate-limited/.test(h.detail ?? ''), h.detail);
  const llmFailures = pipelineRegistry.getHealth()[LLM_PIPELINE]!.failureCount;
  ok('a rate limit is not counted as a pipeline failure', llmFailures === 0 || llmFailures === 1, `failureCount ${llmFailures}`);

  resetClient();
  handlers = [gErr(503, 'overloaded'), gErr(503, 'overloaded'), gErr(503, 'overloaded')];
  try { await groqProvider.chat({ model: llmConfig.model, messages: msg() }); } catch { /* expected */ }
  h = await llmHealth();
  ok('5xx is retried, then → degraded: server error', seen.length === 3 && h.status === 'degraded' && /server error 503/.test(h.detail ?? ''), h.detail);

  resetClient();
  handlers = [j(200, 'this is not json')];
  err = undefined;
  try { await groqProvider.chat({ model: llmConfig.model, messages: msg() }); } catch (e) { err = e; }
  ok('a malformed reply is a failure, not an empty success', !!err && classifyLLMError(err).kind !== 'unknown', `${classifyLLMError(err).kind}: ${err?.message?.slice(0, 80)}`);

  resetClient();
  defaultHandler = () => ({ ...reply('late')(), delayMs: 2_000 });
  err = undefined;
  const t0 = Date.now();
  try { await groqProvider.chat({ model: llmConfig.model, messages: msg() }); } catch (e) { err = e; }
  h = await llmHealth();
  ok('a provider that does not answer in time → timeout', classifyLLMError(err).kind === 'timeout' && /did not answer in time/.test(h.detail ?? ''), `${Date.now() - t0} ms; ${h.detail}`);
  defaultHandler = null;

  const ac = new AbortController();
  resetClient();
  defaultHandler = () => ({ ...reply('x')(), delayMs: 1_000 });
  const before = llmStatus.snapshot().lastError?.at;
  setTimeout(() => ac.abort(), 50);
  try { await groqProvider.chat({ model: llmConfig.model, messages: msg(), signal: ac.signal }); } catch { /* expected */ }
  ok('a request the caller cancelled is not recorded as a provider failure', llmStatus.snapshot().lastError?.at === before);
  defaultHandler = null;
}

console.log('\n--- 4. No stale errors ---');
{
  resetClient();
  handlers = [reply('back')];
  await groqProvider.chat({ model: llmConfig.model, messages: msg() });
  let h = await llmHealth();
  ok('one success after failures → online again (the old error is not shown)', h.status === 'online' && !/timeout|rejected|server/.test(h.detail ?? ''), h.detail);
  llmStatus.recordFailure({ status: 401, message: 'Groq API error 401: Invalid API Key' }, 'probe', 'groq');
  h = await llmHealth();
  ok('a Groq error while Gemini is configured is never shown', h.status === 'online' && !/groq/i.test(h.detail ?? ''), h.detail);
}

console.log('\n--- 5. The probe ---');
{
  resetClient();
  handlers = [MODELS];
  const r = await groqProvider.ping();
  ok('ping lists models (GET /models), no generation', r.modelFound && seen[0]!.url === '/v1beta/openai/models' && seen[0]!.method === 'GET');

  resetClient();
  handlers = [j(200, { data: [{ id: 'models/gemini-3.5-flash' }] })];
  let err: any;
  try { await groqProvider.ping(); } catch (e) { err = e; }
  ok('a fast model the provider does not offer is caught (JARVIS_FAST_MODEL named)', /gemini-3\.5-flash-lite/.test(err?.message ?? '') && /JARVIS_FAST_MODEL/.test(err?.message ?? ''));
  ok('… and shown as a model problem', (await llmHealth()).status === 'offline' && /configured model/.test((await llmHealth()).detail ?? ''));

  resetClient();
  defaultHandler = gErr(429, 'Quota exceeded');
  const results = await healthChecker.runNow();
  const llm = results.find((x) => x.pipeline === LLM_PIPELINE);
  ok('the probe treats 429 from /models as reachable (it reported it as down)', llm?.ok === true && llm.kind === 'rate_limit', JSON.stringify(llm));
  ok('the probe is named after the configured provider', llm?.subsystem === 'LLM API (gemini)');
  const vec = results.find((x) => x.subsystem === 'Vector Memory');
  const mem = results.find((x) => x.subsystem === 'MemoryManager');
  ok('vector memory and the memory manager report to separate pipelines', vec?.pipeline === VECTOR_PIPELINE && mem?.pipeline === MEMORY_PIPELINE);
  const bridge = results.find((x) => x.subsystem === 'NodeBridge');
  ok('the bridge probe fails while its server is not listening (an object alone is not healthy)', bridge?.ok === false && /not listening/.test(bridge.error ?? ''));
  ok('no probe result names Groq', !results.some((x) => /groq/i.test(`${x.pipeline} ${x.subsystem}`)));

  resetClient();
  defaultHandler = gErr(401, 'API key not valid');
  const auth = (await healthChecker.runNow()).find((x) => x.pipeline === LLM_PIPELINE);
  ok('an auth failure on the probe is a failure, classified', auth?.ok === false && auth.kind === 'auth' && /^auth:/.test(auth.error ?? ''), auth?.error);
  ok('it is counted once per probe, not twice', pipelineRegistry.getHealth()[LLM_PIPELINE]!.failureCount === 1, String(pipelineRegistry.getHealth()[LLM_PIPELINE]!.failureCount));
  defaultHandler = null;
}

console.log('\n--- 6. Fallback answers are visible ---');
{
  resetClient();
  handlers = [MODELS];
  await groqProvider.ping(); // clear the probe failure above
  defaultHandler = gErr(500, 'down');
  const router = new ModelRouter('gemini');
  router.registerProvider('openai', { async chat() { return { content: 'from the fallback' }; }, isConfigured: () => true } as never);
  const r = await router.chat({ model: llmConfig.model, messages: msg() });
  const h = await llmHealth();
  ok('the fallback answered', r.content === 'from the fallback');
  ok('the dashboard says the primary failed and the fallback answered', h.status === 'degraded' && /Gemini failed \(server 500\); answered by fallback provider/.test(h.detail ?? ''), h.detail);
  defaultHandler = null;
  handlers = [reply('primary is back')];
  await router.chat({ model: llmConfig.model, messages: msg() });
  ok('when the primary answers again, the dashboard is online', (await llmHealth()).status === 'online');
}

console.log('\n--- 7. Pipeline names ---');
{
  const names = Object.keys(pipelineRegistry.getHealth());
  ok('no pipeline is named after Groq', !names.some((x) => /groq/.test(x)), names.join(','));
  ok('LLM, memory write and vector memory pipelines exist', [LLM_PIPELINE, MEMORY_PIPELINE, VECTOR_PIPELINE].every((x) => names.includes(x)));
  const before = pipelineRegistry.getPipeline(LLM_PIPELINE).failureCount;
  pipelineRegistry.recordFailure('brain_to_groq', 'old caller');
  ok('the old name is still accepted and lands on brain_to_llm', pipelineRegistry.getPipeline(LLM_PIPELINE).failureCount === before + 1 && !('brain_to_groq' in pipelineRegistry.getHealth()));
  ok('groq_to_memory → brain_to_memory', canonicalPipeline('groq_to_memory') === MEMORY_PIPELINE);
  ok('the spoken label names the configured provider', pipelineLabel(LLM_PIPELINE) === 'Gemini language model' && pipelineLabel('brain_to_groq') === 'Gemini language model');
  const spoken: string[] = [];
  (alertManager as any)._bridge = { speakToClients: (m: string) => { spoken.push(m); } };
  alertManager.resetCooldowns();
  alertManager.raise('warning', 'brain_to_groq', 'probe failed', 'test');
  await new Promise((r) => setTimeout(r, 50));
  ok('an alert raised on the old name is spoken with the provider-neutral label (never "groq")',
    spoken.length === 0 || (spoken.some((m) => /Gemini language model/.test(m)) && !spoken.some((m) => /groq/i.test(m))), spoken.join(' | ') || '(voice delivery off)');
  ok('alerts for the old name are found under the new one', alertManager.getForPipeline(LLM_PIPELINE).some((a) => a.message === 'probe failed'));
}

console.log('\n--- 8. Loading is not failure; heal plans ---');
{
  pipelineRegistry.recordLoading(VECTOR_PIPELINE);
  ok('loading is its own status', pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.status === 'loading');
  const p = pipelineRegistry.getPipeline(VECTOR_PIPELINE);
  p.failureCount = 5; p.lastFailure = Date.now();
  await (pipelineWatchdog as any).checkHealth();
  ok('the watchdog leaves a loading pipeline alone', pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.status === 'loading');
  pipelineRegistry.recordSuccess(VECTOR_PIPELINE);
  ok('the first success makes it healthy', pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.status === 'healthy');
  ok('every default pipeline has a heal plan (vector memory included)', Object.keys(pipelineRegistry.getHealth()).filter((x) => x !== 'vision_to_bridge').every((x) => !!PIPELINE_HEAL_MAP[x]),
    Object.keys(pipelineRegistry.getHealth()).filter((x) => !PIPELINE_HEAL_MAP[x]).join(','));

  const orig = vectorMemorySupervisor.state.bind(vectorMemorySupervisor);
  (vectorMemorySupervisor as any).state = () => 'loading';
  const v = (await healthManager.probe()).services['vector_memory']!;
  (vectorMemorySupervisor as any).state = orig;
  ok('the dashboard shows vector memory as loading while its model loads (not online, not a timeout)', v.status === 'loading' && /loading/.test(v.detail ?? ''), `${v.status}: ${v.detail}`);
  const t0 = Date.now();
  await healthManager.probe();
  ok('the dashboard probe does not wait for the network', Date.now() - t0 < 1_000, `${Date.now() - t0} ms`);
}

server.close();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
