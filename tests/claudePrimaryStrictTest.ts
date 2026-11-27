/**
 * tests/claudePrimaryStrictTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Gap-closure review M-B (INDEPENDENT_REVIEW_GAP_CLOSURE.md): with Claude as
 * the primary provider, a strict route given as a bare non-Claude model name
 * would be mapped to Claude's brain model and "confirmed" as that. A strict
 * route is sent exactly as configured or not at all, and the independence
 * check sees the model that would really be sent.
 * Claude as primary (set before import), a stand-in Claude; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claude-primary-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
process.env['JARVIS_LLM_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-stand-in-not-a-real-key-000000';
for (const name of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY']) process.env[name] = '';

const { llmConfig } = await import('../config/llmconfig.js');
const { ModelRouter } = await import('../bridge/modelRouter.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Claude as primary: a strict route is sent exactly as configured ===\n');
ok('(setup) Claude is the primary provider', llmConfig.primary === 'anthropic', String(llmConfig.primary));

const sent: string[] = [];
const claude = { isConfigured: () => true, async chat(req: any) { sent.push(req.model); return { content: 'ok', model: req.model }; } };
const r = new ModelRouter('anthropic');
r.registerProvider('anthropic', claude as never);
r.registerNamedProvider('anthropic', claude as never);   // replaces the real Claude adapter: no network
(r as any).failoverOrder = (name?: string) => [name ?? 'anthropic'];

{
  process.env['JARVIS_MODEL_AGENT_QA_AGENT'] = 'gpt-5-mini';
  let err = '';
  let name = '';
  try { await r.chat({ messages: [{ role: 'user', content: 'x' }], category: 'planning', agentRole: 'qa_agent' } as never); } catch (e) { err = (e as Error).message; name = (e as Error).name; }
  ok('a strict route naming a bare non-Claude model is not sent as Claude\'s model', !sent.length, sent.join(','));
  ok('…it fails as a strict route, saying which model would have been sent', name === 'StrictRouteError' && /gpt-5-mini/.test(err) && new RegExp(llmConfig.anthropic?.model ?? 'claude', 'i').test(err), `${name}: ${err}`);
  const targets = r.possibleTargets('qa_agent');
  ok('the target list shows the model that would really be sent', targets.length === 1 && targets[0]!.model === String(llmConfig.anthropic?.model).toLowerCase(), JSON.stringify(targets));
}
{
  process.env['JARVIS_MODEL_AGENT_CODING_AGENT'] = `anthropic:${llmConfig.anthropic?.model}`;
  const q = await r.qaIndependence();
  ok('coding on Claude\'s brain model, QA "gpt-5-mini" (really the same model): not independent before any call', q.independent === false, q.reason);
}
{
  sent.length = 0;
  process.env['JARVIS_MODEL_AGENT_QA_AGENT'] = `anthropic:${llmConfig.anthropic?.model}`;
  const res = await r.chat({ messages: [{ role: 'user', content: 'x' }], category: 'planning', agentRole: 'qa_agent' } as never);
  ok('a strict Claude route named exactly is unchanged', res.content === 'ok' && sent[0] === llmConfig.anthropic?.model, sent.join(','));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
