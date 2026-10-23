/**
 * tests/claudeProviderTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 4: Claude as JARVIS's LLM (JARVIS_LLM_PROVIDER=anthropic).
 *
 *   1. Config: with ANTHROPIC_API_KEY Claude is asked first (brain
 *      claude-opus-5-5, fast claude-haiku-5-5, both overridable) and Gemini
 *      stays configured as the fallback; without the key Gemini is used and
 *      the reason is noted. Nothing changes for a .env without the setting.
 *   2. Models: callers' brain/fast models become Claude's; on failover to
 *      Gemini, Gemini's own.
 *   3. Router: Claude answers; when a Claude call fails, Gemini answers with
 *      its model and the fallback is recorded; streaming falls back too.
 *   4. Provider: streams text through the SDK, records the stream's token
 *      counts, sends every registered tool with tool_choice auto and no
 *      temperature, and a refusal before any text is an error (so the router
 *      can fall back).
 *   5. Status, label, health probe and validator name Claude.
 * The Claude API and Gemini are stand-ins: no key or network is used.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claude-')));
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);   // no .env from the repository is loaded
const G = 'AIza' + 'x'.repeat(35);
Object.assign(process.env, { JARVIS_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-' + 'k'.repeat(30), GEMINI_API_KEY: G });
for (const k of ['GROQ_API_KEY', 'JARVIS_BRAIN_MODEL', 'JARVIS_FAST_MODEL', 'JARVIS_ANTHROPIC_BRAIN_MODEL', 'JARVIS_ANTHROPIC_FAST_MODEL', 'ANTHROPIC_BASE_URL']) delete process.env[k];

const { resolveProviderSettings, llmConfig } = await import('../config/llmconfig.js');
const { ModelRouter, modelFor } = await import('../bridge/modelRouter.js');
const { AnthropicProvider } = await import('../bridge/anthropicProvider.js');
const { llmStatus } = await import('../bridge/llmStatus.js');
const { pipelineLabel, LLM_PIPELINE } = await import('../self_healing/pipelineRegistry.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

console.log('\n--- 1. Config ---');
{
  const s = resolveProviderSettings({ JARVIS_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' + 'y'.repeat(20), GEMINI_API_KEY: G });
  ok('Claude is asked first, with claude-opus-5-5 and claude-haiku-5-5', s.primary === 'anthropic' && s.anthropic?.model === 'claude-opus-5-5' && s.anthropic?.fastModel === 'claude-haiku-5-5', JSON.stringify(s.anthropic));
  ok('…and Gemini stays configured as the fallback, with its own models', s.provider === 'gemini' && s.apiKey === G && /^gemini/.test(s.model) && /^gemini/.test(s.fastModel));
  const o = resolveProviderSettings({ JARVIS_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' + 'y'.repeat(20), JARVIS_ANTHROPIC_BRAIN_MODEL: 'claude-sonnet-5-5', JARVIS_ANTHROPIC_FAST_MODEL: 'claude-haiku-4-5' });
  ok('the models can be set in .env', o.anthropic?.model === 'claude-sonnet-5-5' && o.anthropic?.fastModel === 'claude-haiku-4-5');
  ok('…and no Gemini key: a note that Claude has no fallback', o.notes.some((n) => /no fallback/.test(n)), o.notes.join(' | '));
  const n = resolveProviderSettings({ JARVIS_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'your_anthropic_key_here', GEMINI_API_KEY: G });
  ok('no Claude key: Gemini answers, and the note says why', n.primary === 'gemini' && n.notes.some((x) => /ANTHROPIC_API_KEY is empty; using gemini/.test(x)), n.notes.join(' | '));
  const g = resolveProviderSettings({ GEMINI_API_KEY: G });
  ok('a .env without the setting is unchanged (Gemini, no Claude)', g.primary === 'gemini' && g.provider === 'gemini' && !g.anthropic);
  ok('(setup) this test runs with Claude first', llmConfig.primary === 'anthropic' && llmConfig.provider === 'gemini');
}

console.log('\n--- 2. Models per provider ---');
{
  const brain = llmConfig.model;
  const fast = llmConfig.fastModel;
  ok('the brain model asked for → Claude\'s brain model', modelFor('anthropic', brain) === 'claude-opus-5-5');
  ok('the fast model → Claude\'s fast model', modelFor('anthropic', fast) === 'claude-haiku-5-5');
  ok('no model → Claude\'s brain model', modelFor('anthropic', undefined) === 'claude-opus-5-5');
  ok('a Claude model named by a category is kept', modelFor('anthropic', 'claude-sonnet-5-5') === 'claude-sonnet-5-5');
  ok('on failover, Claude\'s models become Gemini\'s', modelFor('gemini', 'claude-opus-5-5') === brain && modelFor('gemini', 'claude-haiku-5-5') === fast);
  ok('with Gemini first, nothing is changed', modelFor('gemini', 'claude-opus-5-5', { primary: 'gemini', model: brain, fastModel: fast }) === 'claude-opus-5-5');
}

console.log('\n--- 3. Router ---');
const usageLines: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { const l = a.map(String).join(' '); if (l.startsWith('[LLM usage]')) usageLines.push(l); realLog(...a); };
{
  const seen: Array<[string, string | undefined]> = [];
  let claudeDown = false;
  const claude = {
    isConfigured: () => true,
    async chat(r: any) { seen.push(['anthropic', r.model]); if (claudeDown) throw new Error('Anthropic API error 529: overloaded'); return { content: 'Claude here, sir.', usage: { promptTokens: 120, completionTokens: 8, totalTokens: 128 } }; },
    async *streamChat(r: any) { seen.push(['anthropic-stream', r.model]); if (claudeDown) throw new Error('Anthropic API error 529: overloaded'); yield 'Claude '; yield 'streams.'; },
    lastStreamUsage: { promptTokens: 50, completionTokens: 3, totalTokens: 53 },
  };
  const gemini = { async chat(r: any) { seen.push(['gemini', r.model]); return { content: 'Gemini here, sir.' }; } };
  const router = new ModelRouter('anthropic');
  router.registerProvider('anthropic', claude as never);
  router.registerProvider('gemini', gemini as never);
  router.registerProvider('openai', { isConfigured: () => false, chat: async () => ({ content: '' }) } as never);

  const r1 = await router.chat({ model: llmConfig.model, messages: [{ role: 'user', content: 'hello' }], category: 'conversation' } as never);
  ok('Claude answers, asked with its brain model', r1.content === 'Claude here, sir.' && seen[0]?.[0] === 'anthropic' && seen[0]?.[1] === 'claude-opus-5-5', JSON.stringify(seen));
  ok('…and the call\'s tokens are logged', usageLines.some((l) => /anthropic claude-opus-5-5 conversation: 120 in \/ 8 out tokens/.test(l)), usageLines.join(' | '));

  seen.length = 0;
  claudeDown = true;
  const r2 = await router.chat({ model: llmConfig.fastModel, messages: [{ role: 'user', content: 'hello' }] } as never);
  ok('Claude failing: Gemini answers', r2.content === 'Gemini here, sir.', JSON.stringify(seen));
  ok('…asked with Gemini\'s own fast model, not Claude\'s', seen[1]?.[0] === 'gemini' && seen[1]?.[1] === llmConfig.fastModel, JSON.stringify(seen));
  const fb = llmStatus.snapshot().lastFallback;
  ok('…and the fallback is recorded for the dashboard', fb?.from === 'anthropic' && fb?.to === 'gemini', JSON.stringify(fb));

  seen.length = 0;
  claudeDown = false;
  let text = '';
  for await (const c of router.streamChat({ model: llmConfig.model, messages: [{ role: 'user', content: 'hi' }], category: 'conversation' } as never)) text += c;
  ok('a reply streams from Claude', text === 'Claude streams.' && seen[0]?.[1] === 'claude-opus-5-5', `${text} ${JSON.stringify(seen)}`);
  ok('…with the stream\'s token counts logged', usageLines.some((l) => /50 in \/ 3 out tokens.*streamed/.test(l)), usageLines.slice(-1).join(''));
  claudeDown = true;
  text = '';
  for await (const c of router.streamChat({ model: llmConfig.model, messages: [{ role: 'user', content: 'hi' }] } as never)) text += c;
  ok('Claude\'s stream failing before any text: Gemini answers', text === 'Gemini here, sir.', text);
}
console.log = realLog;

console.log('\n--- 4. Provider (SDK stand-in) ---');
{
  registerAllTools();
  const defs = toolRegistryV2.getLLMDefinitions();
  let body: any = null;
  let mode: 'text' | 'refusal' = 'text';
  const events = () => mode === 'text'
    ? [{ type: 'message_start' }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Opening ' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'YouTube, sir.' } }, { type: 'message_stop' }]
    : [{ type: 'message_start' }, { type: 'message_stop' }];
  const final = () => mode === 'text'
    ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Opening YouTube, sir.' }], usage: { input_tokens: 900, output_tokens: 6 } }
    : { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: { input_tokens: 10, output_tokens: 0 } };
  const fake = {
    models: { retrieve: async (id: string) => ({ id }) },
    beta: { messages: {
      create: async (b: any) => { body = b; return final(); },
      stream: (b: any) => { body = b; return { async *[Symbol.asyncIterator]() { for (const e of events()) yield e; }, finalMessage: async () => final() }; },
    } },
  };
  const p = new AnthropicProvider({}, () => fake as never);
  let out = '';
  for await (const c of p.streamChat({ model: 'claude-opus-5-5', messages: [{ role: 'system', content: 'You are JARVIS.' }, { role: 'user', content: 'open YouTube and play Sanam Re' }], tools: defs } as never)) out += c;
  ok('the reply streams as it is generated', out === 'Opening YouTube, sir.', out);
  ok('…and the stream\'s token counts are kept', p.lastStreamUsage?.promptTokens === 900 && p.lastStreamUsage?.completionTokens === 6, JSON.stringify(p.lastStreamUsage));
  ok(`every registered tool is sent (${defs.length})`, defs.length > 0 && body?.tools?.length === defs.length && body.tools.every((t: any) => t.name && t.input_schema?.type === 'object'), `${body?.tools?.length} of ${defs.length}`);
  ok('…with tool_choice auto, the system prompt on top, and no temperature', body?.tool_choice?.type === 'auto' && body?.system === 'You are JARVIS.' && !('temperature' in body) && !('top_p' in body));
  mode = 'refusal';
  let refused = '';
  try { for await (const _ of p.streamChat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] } as never)) { /* none */ } } catch (e) { refused = (e as Error).message; }
  ok('a refusal before any text is an error the router can fall back on', /Anthropic declined the request \(cyber\)/.test(refused), refused);
}

console.log('\n--- 5. Status, label, health probe, validator ---');
{
  const s = llmStatus.snapshot();
  ok('the LLM status names Claude and its models', s.provider === 'anthropic' && s.model === 'claude-opus-5-5' && s.fastModel === 'claude-haiku-5-5' && s.host === 'api.anthropic.com', JSON.stringify({ p: s.provider, m: s.model, h: s.host }));
  ok('alerts and speech say "Claude language model"', pipelineLabel(LLM_PIPELINE) === 'Claude language model', pipelineLabel(LLM_PIPELINE));
  const hc = fs.readFileSync(path.join(repo, 'self_healing', 'healthChecker.ts'), 'utf8');
  ok('the health check probes Claude (model lookup, no tokens) when it is first', /primary === 'anthropic'[\s\S]{0,200}anthropicProvider\.ping\(llmConfig\.anthropic\.model/.test(hc));
  const { configValidator } = await import('../config/configValidator.js');
  const report = configValidator.validate() as any;
  const llmCritical = (report.issues ?? []).filter((i: any) => i.level === 'CRITICAL' && /API_KEY/.test(i.field));
  ok('the validator does not ask for a Gemini key when Claude is first', llmCritical.length === 0, JSON.stringify(llmCritical));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* in use */ }
process.exit(failed > 0 ? 1 : 0);
