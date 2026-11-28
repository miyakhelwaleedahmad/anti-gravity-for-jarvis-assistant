/**
 * tests/routerFollowupsP5Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracker MM-1A-P5, review INDEPENDENT_REVIEW.md L5, L8, L9 (owner approval
 * 2026-11-28 for bridge/modelRouter.ts):
 *
 *   L9  a routed stream with a time limit (JARVIS_MODEL_<KIND>_TIMEOUT_MS)
 *       stops when its provider sends nothing for that long: before any text
 *       the default model answers; after some text it fails, and is not
 *       answered again. A stream that keeps sending is not cut. Without a
 *       time limit nothing changes.
 *   L5  a route's fallback is recorded for the dashboard only when the
 *       fallback answered, and the dashboard names the provider that failed
 *   L8  a routed stream that the provider guard refuses leaves a usage
 *       record, as a refused routed chat does
 *
 * Scripted providers; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-router-p5-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
delete process.env['JARVIS_LLM_PROVIDER'];
// A stand-in key, so the dashboard health text is produced (nothing is sent anywhere).
process.env['GROQ_API_KEY'] = 'test-key-not-used';

const { ModelRouter } = await import('../bridge/modelRouter.js');
const { llmStatus } = await import('../bridge/llmStatus.js');
const { usageLog, clearUsage } = await import('../bridge/modelCategories.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = () => [{ role: 'user' as const, content: 'hi' }];
function setEnv(vars: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const httpError = (status: number, text: string) => Object.assign(new Error(`${text} (${status})`), { status });

/** A scripted provider. `stream` yields its pieces, waiting `gapMs` between them; `hangAfter` stops sending after that many pieces until aborted. */
function stub(who: string, opts: { chatFails?: boolean; streamFails?: boolean; pieces?: string[]; gapMs?: number; hangAfter?: number; noTools?: boolean } = {}) {
  const seen: { aborted: boolean } = { aborted: false };
  const p: Record<string, unknown> = {
    isConfigured: () => true,
    async chat(req: any) {
      if (opts.chatFails) throw httpError(500, `${who} is down`);
      return { content: `${who} answered`, model: req.model };
    },
    async *streamChat(req: any) {
      req.signal?.addEventListener('abort', () => { seen.aborted = true; }, { once: true });
      if (opts.streamFails) throw httpError(500, `${who} stream is down`);
      const pieces = opts.pieces ?? [`${who} streamed`];
      for (let i = 0; i < pieces.length; i++) {
        if (opts.hangAfter !== undefined && i >= opts.hangAfter) {
          await new Promise((_res, rej) => { if (req.signal?.aborted) rej(abortError()); req.signal?.addEventListener('abort', () => rej(abortError()), { once: true }); });
        }
        if (i > 0 && opts.gapMs) await tick(opts.gapMs);
        yield pieces[i]!;
      }
    },
  };
  if (opts.noTools) p['capabilities'] = () => ({ toolCalling: false, imageInput: false, audioInput: false, structuredOutput: false, webSearch: false, ownBreaker: false });
  return { provider: p, seen };
}
function router(primary: Record<string, unknown>, named: Record<string, Record<string, unknown>>) {
  const r = new ModelRouter('a');
  r.registerProvider('a', primary as never);
  for (const [n, p] of Object.entries(named)) r.registerNamedProvider(n, p as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : ['a']);
  return r;
}
/** Reads the whole stream, but never waits longer than `limitMs`: a hang is reported as a failure, not a stuck test. */
async function readStream(r: any, req: any, limitMs = 8_000): Promise<{ text: string; error?: string; ms: number; hung: boolean }> {
  const t0 = Date.now();
  let text = '';
  const run = (async () => { for await (const piece of r.streamChat(req)) text += piece; })();
  const outcome = await Promise.race([
    run.then(() => ({ error: undefined as string | undefined, hung: false }), (e) => ({ error: String((e as Error)?.message ?? e), hung: false })),
    tick(limitMs).then(() => ({ error: undefined as string | undefined, hung: true })),
  ]);
  run.catch(() => undefined);
  return { text, ...outcome, ms: Date.now() - t0 };
}

console.log('\n=== Router follow-ups: stream time limit, fallback record, refused-stream usage (MM-1A-P5) ===\n');

console.log('--- L9. A routed stream with a time limit ---');
{
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'elsewhere:talk', JARVIS_MODEL_CONVERSATION_TIMEOUT_MS: '1000' });
  const route = stub('elsewhere', { hangAfter: 0 });
  const r = router(stub('a').provider, { elsewhere: route.provider });
  const res = await readStream(r, { messages: msg(), category: 'conversation' });
  ok('L9a  a stream that sends nothing stops at its time limit', !res.hung && res.ms < 4_000, `${res.hung ? 'still waiting after 8 s' : `${res.ms} ms`}`);
  ok('L9a  …the provider\'s request is cancelled', route.seen.aborted);
  ok('L9a  …and the default model answers instead', res.text === 'a streamed', res.error ?? res.text);
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'elsewhere:talk', JARVIS_MODEL_CONVERSATION_TIMEOUT_MS: '1000' });
  const route = stub('elsewhere', { pieces: ['Hello, ', 'sir.'], hangAfter: 1 });
  const primary = stub('a');
  const r = router(primary.provider, { elsewhere: route.provider });
  const res = await readStream(r, { messages: msg(), category: 'conversation' });
  ok('L9b  a stream that stops sending halfway stops at its time limit', !res.hung && res.ms < 4_000, `${res.hung ? 'still waiting after 8 s' : `${res.ms} ms`}`);
  ok('L9b  …with an error that names the time limit', /1000 ms/.test(res.error ?? ''), res.error ?? '(no error)');
  ok('L9b  …the text already sent is kept and not answered again', res.text === 'Hello, ', JSON.stringify(res.text));
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'elsewhere:talk', JARVIS_MODEL_CONVERSATION_TIMEOUT_MS: '1000' });
  const pieces = ['one ', 'two ', 'three ', 'four ', 'five ', 'six'];
  const r = router(stub('a').provider, { elsewhere: stub('elsewhere', { pieces, gapMs: 400 }).provider });
  const res = await readStream(r, { messages: msg(), category: 'conversation' });
  ok('L9c  a stream that keeps sending is not cut, though it lasts longer than the limit', !res.error && res.text === pieces.join('') && res.ms >= 1_500, `${res.ms} ms; ${res.error ?? JSON.stringify(res.text)}`);
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'elsewhere:talk' });
  const pieces = ['slow ', 'but ', 'fine'];
  const r = router(stub('a').provider, { elsewhere: stub('elsewhere', { pieces, gapMs: 1_200 }).provider });
  const res = await readStream(r, { messages: msg(), category: 'conversation' });
  ok('L9d  without a time limit set, a slow stream is unchanged', !res.error && res.text === pieces.join(''), `${res.ms} ms; ${res.error ?? JSON.stringify(res.text)}`);
  restore();
}

console.log('\n--- L5. The fallback is recorded only when it answered, naming the provider that failed ---');
/** The fallback recorded since `before` (each record is a new object, so an earlier case's record is never taken for this one's). */
const fallbackSince = (before: unknown) => { const f = llmStatus.snapshot().lastFallback; return f && f !== before ? f : undefined; };
const startCase = async () => llmStatus.snapshot().lastFallback;
{
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'elsewhere:plan' });
  const r = router(stub('a', { chatFails: true }).provider, { elsewhere: stub('elsewhere', { chatFails: true }).provider });
  const t0 = await startCase();
  const res = await r.chat({ messages: msg(), category: 'planning' }).then(() => 'answered', (e: Error) => e.message);
  ok('L5a  route and fallback both fail: the call fails', res !== 'answered', res.slice(0, 80));
  ok('L5a  …and no "answered by" is recorded', fallbackSince(t0) === undefined, JSON.stringify(fallbackSince(t0)));
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'elsewhere:plan' });
  const r = router(stub('a').provider, { elsewhere: stub('elsewhere', { chatFails: true }).provider });
  const t0 = await startCase();
  const res = await r.chat({ messages: msg(), category: 'planning' });
  const f = fallbackSince(t0);
  ok('L5b  the route fails and the default model answers: recorded, from the route\'s provider', res.content === 'a answered' && f?.from === 'elsewhere' && f?.to === 'a', JSON.stringify(f));
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'elsewhere:talk' });
  const primary = stub('a', { streamFails: true, chatFails: true });
  const r = router(primary.provider, { elsewhere: stub('elsewhere', { streamFails: true }).provider });
  const t0 = await startCase();
  const res = await readStream(r, { messages: msg(), category: 'conversation' });
  ok('L5c  a routed stream and its fallback both fail: no "answered by" is recorded', !!res.error && fallbackSince(t0) === undefined, `${res.error?.slice(0, 60)}; ${JSON.stringify(fallbackSince(t0))}`);
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'elsewhere:talk' });
  const r = router(stub('a').provider, { elsewhere: stub('elsewhere', { streamFails: true }).provider });
  const t0 = await startCase();
  const res = await readStream(r, { messages: msg(), category: 'conversation' });
  const f = fallbackSince(t0);
  ok('L5d  a routed stream fails and the default model streams the answer: recorded', res.text === 'a streamed' && f?.from === 'elsewhere' && f?.to === 'a', `${res.text}; ${JSON.stringify(f)}`);
  restore();
}
{
  llmStatus.recordFallback('gemini', 'groq', 'test');
  const h = llmStatus.health();
  ok('L5e  the dashboard names the provider that failed, not the one that answered', /^Gemini failed/.test(h.detail) && /answered by Groq/.test(h.detail), h.detail);
}

console.log('\n--- L8. A refused routed stream leaves a usage record ---');
{
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'elsewhere:talk' });
  clearUsage();
  const r = router(stub('a').provider, { elsewhere: stub('elsewhere', { noTools: true }).provider });
  const tools = [{ type: 'function', function: { name: 'x', description: 'x', parameters: { type: 'object', properties: {} } } }];
  await readStream(r, { messages: msg(), category: 'conversation', tools });
  const rec = usageLog().filter((u) => u.provider === 'elsewhere');
  ok('L8   the refused stream is recorded as a failed call of that provider', rec.length === 1 && rec[0]!.ok === false && /no tool calling/.test(rec[0]!.error ?? '') && rec[0]!.streamed === true, JSON.stringify(rec.map((u) => ({ ok: u.ok, streamed: u.streamed, error: u.error }))));
  restore();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
