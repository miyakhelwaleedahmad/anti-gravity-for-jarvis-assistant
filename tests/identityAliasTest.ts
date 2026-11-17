/**
 * tests/identityAliasTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Low-finding closure R2, R4, L1 (LOW_CLOSURE_PLAN.md; owner approval
 * 2026-11-16). Model independence is never claimed without identity evidence:
 *
 *   R2  aliases of one model count as one model: a gateway "vendor/" id, a
 *       "models/" prefix, a ":variant" suffix, a date stamp (-YYYYMMDD,
 *       -YYYY-MM-DD, @YYYYMMDD), a "-NNN" version; a floating alias
 *       ("-latest") is unknown, never independent; the reply check catches
 *       an alias of coding's model
 *   R4  identity look-ups are bounded (JARVIS_QA_IDENTITY_LOOKUP_MS), made only
 *       when independence is required, and a failed look-up is not repeated
 *       within a minute
 *   L1  a coding helper's own model setting counts among coding's models; the
 *       helper list matches the agent registry
 * Stand-in providers; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-identity-alias-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
delete process.env['JARVIS_AGENT_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const categories = await import('../bridge/modelCategories.js') as Record<string, any>;
const { ModelRouter, modelRouter } = await import('../bridge/modelRouter.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
function setEnv(vars: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}
const within = <T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> => Promise.race([p, new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), ms))]);
const reporting = (who: string, log?: string[]) => ({ isConfigured: () => true, async chat(req: any) { log?.push(`${who}:${req.agentRole}`); return { content: `${who} answered`, model: req.model }; } });

function router(named: Record<string, unknown>) {
  const r = new ModelRouter('primary');
  r.registerProvider('primary', reporting('primary') as never);
  for (const [k, v] of Object.entries(named)) r.registerNamedProvider(k, v as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : ['primary']);
  return r;
}

console.log('\n=== Model identity: aliases, bounded look-ups, helpers ===\n');

console.log('--- R2. Aliases of one model ---');
{
  const r = router({ p1: reporting('p1'), p2: reporting('p2') });
  const pair = (coding: string, qa: string) => within(r.qaIndependence({ JARVIS_MODEL_AGENT_CODING_AGENT: `p1:${coding}`, JARVIS_MODEL_AGENT_QA_AGENT: `p2:${qa}` }, { resolve: true } as never), 4000);
  const same = async (label: string, a: string, b: string) => { const x = await pair(a, b); ok(label, x !== 'TIMEOUT' && x.independent === false, x === 'TIMEOUT' ? 'timeout' : x.reason); };
  await same('a gateway id ("vendor/") of the same model: not independent', 'anthropic/claude-opus-5-5', 'claude-opus-5-5');
  await same('a "-NNN" version of the same model: not independent', 'gemini-2.5-flash-001', 'gemini-2.5-flash');
  await same('an "@date" stamp: not independent', 'claude-x@20261101', 'claude-x');
  await same('a "-YYYYMMDD" stamp: not independent', 'claude-x-20261101', 'claude-x');
  await same('a "-YYYY-MM-DD" stamp: not independent', 'gpt-x-2026-11-01', 'gpt-x');
  await same('a ":variant" suffix: not independent', 'llama-4-70b:free', 'llama-4-70b');
  await same('a floating alias ("-latest"): unknown, not independent', 'gemini-flash-latest', 'gemini-3.5-pro');
  const diff = await pair('model-a', 'model-b');
  ok('two genuinely different names: independent', diff !== 'TIMEOUT' && diff.independent === true, diff === 'TIMEOUT' ? 'timeout' : diff.reason);
}

console.log('\n--- R4. Bounded look-ups, only when required, failures not repeated ---');
{
  let lookups = 0;
  const hanging = { ...reporting('hang'), async validateModel() { lookups++; return new Promise<void>(() => { /* never answers */ }); }, modelIdentities: (m: string) => [m] };
  const r = router({ hang: hanging, p2: reporting('p2') });
  const restore = setEnv({ JARVIS_QA_IDENTITY_LOOKUP_MS: '1000' });
  const t0 = Date.now();
  const res = await within(r.qaIndependence({ JARVIS_MODEL_AGENT_CODING_AGENT: 'hang:model-a', JARVIS_MODEL_AGENT_QA_AGENT: 'p2:model-b', JARVIS_QA_IDENTITY_LOOKUP_MS: '1000' }, { resolve: true } as never), 5000);
  ok('a look-up that never answers ends within its limit', res !== 'TIMEOUT' && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  ok('…as unresolved: not independent', res !== 'TIMEOUT' && res.independent === false, res === 'TIMEOUT' ? 'timeout' : res.reason);
  restore();

  let failing = 0;
  const broken = { ...reporting('broken'), async validateModel() { failing++; throw new Error('lookup failed'); }, modelIdentities: (m: string) => [m] };
  const r2 = router({ broken, p2: reporting('p2') });
  const env = { JARVIS_MODEL_AGENT_CODING_AGENT: 'broken:model-a', JARVIS_MODEL_AGENT_QA_AGENT: 'p2:model-b' };
  await within(r2.qaIndependence(env, { resolve: true } as never), 4000);
  await within(r2.qaIndependence(env, { resolve: true } as never), 4000);
  ok('a failed look-up is not repeated within a minute', failing === 1, `${failing} look-up(s)`);
}
{
  // Through a QA task: independence not required → no identity look-up at all.
  registerAllTools();
  const executor = { names: () => toolRegistryV2.names(), riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a), getMeta: (n: string) => toolRegistryV2.getMeta(n), async execute(name: string) { return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 }; } };
  modelRouter.registerProvider((modelRouter as any).primary, reporting('default') as never);
  (modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
  let lookups = 0;
  modelRouter.registerNamedProvider('lookups', { ...reporting('lookups'), async validateModel() { lookups++; }, modelIdentities: (m: string) => [m] } as never);
  const m = new AgentManager(agentEvents, loadAgentLimits({}));
  m.useToolExecutor(executor as never);
  registerAgentRoles(m);
  const restore = setEnv({ JARVIS_QA_REQUIRE_INDEPENDENT: 'false', JARVIS_MODEL_AGENT_QA_AGENT: 'lookups:qa-model' });
  const h = await m.startRootTask({ request: 'Review the change summary', specialistRole: 'qa_agent', task: { description: 'Review the change summary' } });
  const res = (await h.result) as any;
  ok('independence not required: QA runs with no identity look-up', res.specialist?.status === 'COMPLETED' && lookups === 0, `${res.specialist?.status} lookups=${lookups}`);
  restore();

  // R2 reply check: QA required, coding strict on shared-x; the default model's reply reports a dated gateway id of it.
  const restore2 = setEnv({ JARVIS_QA_REQUIRE_INDEPENDENT: 'true', JARVIS_MODEL_AGENT_CODING_AGENT: 'lookups:shared-x' });
  modelRouter.registerProvider((modelRouter as any).primary, { isConfigured: () => true, async chat() { return { content: 'checked', model: 'gw/shared-x-20261101' }; } } as never);
  const h2 = await m.startRootTask({ request: 'Review the change summary again', specialistRole: 'qa_agent', task: { description: 'Review the change summary again' } });
  const res2 = (await h2.result) as any;
  ok('a QA reply reporting an alias of coding\'s model: FAILED "independent QA unavailable"', res2.specialist?.status === 'FAILED' && /independent QA unavailable/i.test(String(res2.specialist?.error?.message ?? '')), `${res2.specialist?.status} ${String(res2.specialist?.error?.message ?? '').slice(0, 160)} ${JSON.stringify(res2.specialist?.data?.['independence'])}`);
  restore2();

  console.log('\n--- L1. Coding helpers\' own settings ---');
  const restore3 = setEnv({ JARVIS_MODEL_AGENT_CODE_ANALYSIS_WORKER: 'p1:helper-model', JARVIS_MODEL_AGENT_QA_AGENT: 'p2:helper-model-2026-11-01' });
  const r3 = router({ p1: reporting('p1'), p2: reporting('p2') });
  const ind = await within(r3.qaIndependence(undefined as never, { resolve: true } as never), 4000);
  ok('a coding helper on QA\'s model makes coding and QA not independent', ind !== 'TIMEOUT' && ind.independent === false, ind === 'TIMEOUT' ? 'timeout' : ind.reason);
  ok('…the helper\'s model is listed among coding\'s', r3.possibleTargets('coding_agent').some((t: any) => t.provider === 'p1' && t.model === 'helper-model'), JSON.stringify(r3.possibleTargets('coding_agent')));
  restore3();
  const helpers = categories['HELPER_ROLES'] as Record<string, string[]> | undefined;
  const closure = (role: string): Set<string> => {
    const out = new Set<string>();
    const queue = [...((m as any).registry.role(role).allowedChildRoles as string[])];
    while (queue.length) { const c = queue.shift()!; if (out.has(c)) continue; out.add(c); try { queue.push(...((m as any).registry.role(c).allowedChildRoles as string[])); } catch { /* unknown */ } }
    return out;
  };
  for (const role of ['coding_agent', 'qa_agent']) {
    const want = [...closure(role)].sort().join(',');
    const have = [...new Set(helpers?.[role] ?? [])].sort().join(',');
    ok(`HELPER_ROLES.${role} matches the agents the registry lets it create`, !!helpers && want === have, `registry: ${want} | list: ${have}`);
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
