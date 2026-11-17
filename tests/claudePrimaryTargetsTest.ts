/**
 * tests/claudePrimaryTargetsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Low-finding closure R1 (LOW_CLOSURE_PLAN.md; owner approval 2026-11-16):
 * with Claude as the primary provider, the models listed for an agent without
 * its own setting are the models really sent (the Claude model the router maps
 * the agent model to), not a name that is never sent.
 * Claude as primary (set before import), a stand-in Claude; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claude-targets-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
process.env['JARVIS_LLM_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-stand-in-not-a-real-key-000000';
for (const name of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_AGENT_MODEL'];

const { llmConfig } = await import('../config/llmconfig.js');
const { ModelRouter } = await import('../bridge/modelRouter.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Claude as primary: listed models are the models sent ===\n');
ok('(setup) Claude is the primary provider', llmConfig.primary === 'anthropic', String(llmConfig.primary));

const sent: string[] = [];
const claude = { isConfigured: () => true, async chat(req: any) { sent.push(req.model); return { content: 'ok', model: req.model }; } };
const r = new ModelRouter('anthropic');
r.registerProvider('anthropic', claude as never);
r.registerNamedProvider('anthropic', claude as never);   // replaces the real Claude adapter: no network
(r as any).failoverOrder = (name?: string) => [name ?? 'anthropic'];

const targets = r.possibleTargets('coding_agent');
// What an agent without its own setting really sends: agentModel() (the fast model), through the failover order.
await r.chat({ model: llmConfig.fastModel, messages: [{ role: 'user', content: 'x' }], agentRole: 'coding_agent' } as never);
ok('coding without its own setting: the listed model is the model really sent', targets.length > 0 && targets.every((t) => t.model === String(sent[0]).toLowerCase()), `listed ${JSON.stringify(targets)}; sent ${sent.join(',')}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
