/**
 * tests/toolRegistryMetadataTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Upgrade phase P1 (docs/upgrade/phases/phase-01-tool-registry.md).
 *
 * Every tool must carry metadata — category, risk 0–4 (per action where a
 * tool has several), reversibility, external effect, output — and JARVIS must
 * answer "what can you do" from that metadata, not from a fixed sentence.
 * Before P1 none of this existed: "what can you do" always said "I can launch
 * applications, search the web, manage system files, and run commands."
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-registry-meta-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const warnings: string[] = [];
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); realWarn(...args); };

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const registry: any = await import('../core/toolRegistryV2.js');
const { toolRegistryV2 } = registry;
const orchestratorModule: any = await import('../core/orchestrator.js');
const { orchestrator } = orchestratorModule;
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
let catalog: Record<string, any> = {};
try { catalog = (await import('../core/toolCatalog.js' as string)).TOOL_CATALOG; } catch { /* not on the old code */ }

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
function attempt<T>(label: string, fn: () => T): T | undefined {
  try { return fn(); } catch (e) { ok(label, false, (e as Error).message); return undefined; }
}

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

let llmCalls = 0;
let planningMessages: any[] = [];
modelRouter.chat = async (req: any) => {
  llmCalls++;
  if (req.tools) planningMessages = req.messages;
  return { content: 'Here is what I found, sir.' } as any;
};
modelRouter.streamChat = async function* () { llmCalls++; yield 'Done, sir.'; } as any;
let spoken: string[] = [];
(orchestrator as any).speak = (text: string) => { spoken.push(text); };
async function say(input: string): Promise<string> {
  spoken = []; llmCalls = 0; planningMessages = [];
  await orchestrator.process(input, 'voice');
  return spoken.join(' | ');
}

const CATEGORIES = ['OBSERVATION', 'BROWSER', 'COMPUTER', 'FILESYSTEM', 'TERMINAL', 'DEVELOPMENT',
  'NETWORK', 'COMMUNICATION', 'SCHEDULING', 'MEMORY', 'SYSTEM'];

console.log('\n=== Tool Registry Metadata Test ===\n');

console.log('--- 1. Every tool has metadata ---');
const tools: any[] = toolRegistryV2.getAll();
const withoutMeta = tools.filter((t) => !t.meta).map((t) => t.name);
ok(`all ${tools.length} registered tools carry metadata`, tools.length >= 34 && withoutMeta.length === 0, withoutMeta.join(', '));
const derived: string[] = typeof toolRegistryV2.derivedMetaTools === 'function' ? toolRegistryV2.derivedMetaTools() : ['(no derivedMetaTools)'];
ok('none of them uses derived defaults', derived.length === 0, derived.join(', '));
ok('every catalogue entry is a registered tool', Object.keys(catalog).length > 0 && Object.keys(catalog).every((n) => toolRegistryV2.has(n)),
  Object.keys(catalog).filter((n) => !toolRegistryV2.has(n)).join(', ') || `${Object.keys(catalog).length} entries`);

let problems = 0;
for (const tool of tools) {
  const meta = tool.meta;
  if (!meta) continue;
  const complete = CATEGORIES.includes(meta.category) && [0, 1, 2, 3, 4].includes(meta.risk)
    && ['yes', 'partial', 'no'].includes(meta.reversible) && ['none', 'query', 'change'].includes(meta.external)
    && typeof meta.effect === 'string' && meta.effect.length > 0
    && ['text', 'json'].includes(meta.output?.format) && typeof meta.output?.description === 'string';
  if (!complete) { problems++; console.error(`  ${tool.name}: metadata incomplete ${JSON.stringify(meta).slice(0, 120)}`); }
  const actionEnum: string[] | undefined = tool.inputSchema?.action?.enum;
  if (actionEnum) {
    const missing = actionEnum.filter((a) => !meta.actions?.[a]);
    if (missing.length) { problems++; console.error(`  ${tool.name}: actions without a risk: ${missing.join(', ')}`); }
    const maxAction = Math.max(...Object.values(meta.actions ?? {}).map((a: any) => a.risk));
    if (meta.risk !== maxAction) { problems++; console.error(`  ${tool.name}: tool risk ${meta.risk}, highest action risk ${maxAction}`); }
  }
}
ok('metadata fields valid for every tool, and every action of every multi-action tool has a risk', problems === 0, `${problems} problem(s)`);

console.log('\n--- 2. Risk of a call ---');
attempt('riskOf exists', () => {
  ok('control_app close → 2', toolRegistryV2.riskOf('control_app', { action: 'close', target: 'notepad' }) === 2);
  ok('control_app focus → 1', toolRegistryV2.riskOf('control_app', { action: 'focus' }) === 1);
  ok('an unknown action gets the highest risk, not a lower one', toolRegistryV2.riskOf('control_app', { action: 'launch' }) === 2);
  ok('"Close" is "close"', toolRegistryV2.riskOf('control_app', { action: 'Close' }) === 2);
  ok('control_process kill → 3, list → 0', toolRegistryV2.riskOf('control_process', { action: 'kill' }) === 3
    && toolRegistryV2.riskOf('control_process', { action: 'list' }) === 0);
  ok('read_file → 0, write_file → 2', toolRegistryV2.riskOf('read_file', {}) === 0 && toolRegistryV2.riskOf('write_file', {}) === 2);
  ok('an unregistered tool → 4', toolRegistryV2.riskOf('no_such_tool', {}) === 4);
});

console.log('\n--- 3. Discovery ---');
attempt('describeCapabilities exists', () => {
  const groups: any[] = toolRegistryV2.describeCapabilities();
  const order = groups.map((g) => g.category);
  ok('grouped by category, in the documented order', order.join() === CATEGORIES.filter((c) => order.includes(c)).join(), order.join(', '));
  ok('every tool appears once', groups.reduce((n, g) => n + g.tools.length, 0) === tools.length);
  const entry = (name: string) => groups.flatMap((g) => g.tools).find((t: any) => t.name === name);
  ok('approval derived: control_process required, write_file policy, web_search none',
    entry('control_process')?.approval === 'required' && entry('write_file')?.approval === 'policy' && entry('web_search')?.approval === 'none');
  ok('risk range per tool: control_file 0–3', JSON.stringify(entry('control_file')?.risk) === '[0,3]');
  const browser = toolRegistryV2.describeCapabilities({ category: 'browser' });
  ok('filter by category (any case)', browser.length === 1 && browser[0].category === 'BROWSER');
  const safe = toolRegistryV2.describeCapabilities({ maxRisk: 0 }).flatMap((g: any) => g.tools);
  ok('filter by risk: only tools with a level-0 action', safe.length > 0 && safe.every((t: any) => t.risk[0] === 0));
  const summary: string = toolRegistryV2.capabilitySummary();
  ok('summary has a line per category', order.every((c: string) => summary.includes(`${c}:`)), `${summary.length} characters`);
});

console.log('\n--- 4. list_capabilities ---');
const listed = await toolRegistryV2.execute('list_capabilities', {});
ok('runs through the registry', listed.success, listed.error ?? '');
let parsed: any[] = [];
try { parsed = JSON.parse(listed.output); } catch { /* checked below */ }
ok('returns the grouped tools', Array.isArray(parsed) && parsed.some((g) => g.category === 'BROWSER'));
const onlyFiles = await toolRegistryV2.execute('list_capabilities', { category: 'filesystem' });
ok('category filter', onlyFiles.success && JSON.parse(onlyFiles.output).every((g: any) => g.category === 'FILESYSTEM'));
ok('nothing secret in the output', !/[A-Za-z]:\\|\/home\/|apikey|api_key|token=/i.test(listed.output));

console.log('\n--- 5. Planner and LLM definitions ---');
const def: any = toolRegistryV2.getLLMDefinitions(['control_app'])[0];
ok('LLM tool definitions carry no metadata', def && !('meta' in def) && !('meta' in def.function) && Object.keys(def).join() === 'type,function');
const offered = (input: string): string[] => (orchestrator as any).selectPlanningToolNames(input);
ok('"which tools do you have for files" offers list_capabilities first', offered('which tools do you have for files')[0] === 'list_capabilities');
ok('"open notepad" does not', !offered('open notepad').includes('list_capabilities'));
ok('"close chrome" does not', !offered('close chrome').includes('list_capabilities'));

console.log('\n--- 6. "What can you do" comes from the registry ---');
const route = orchestrator.matchDeterministicCommand('what can you do');
ok('route reply counts the real tools', route?.type === 'what_can_you_do' && route.reply.includes(`${tools.length} tools`), route?.reply);
let reply = await say('what can you do');
ok('spoken reply is that reply', reply === route?.reply, reply);
ok('no LLM request', llmCalls === 0, `${llmCalls}`);
reply = await say('who are you');
ok('"who are you" introduces JARVIS and its tools', reply.startsWith('I am JARVIS') && reply.includes('tools'), reply);
reply = await say('list your tools');
ok('"list your tools" answers from the registry', /I have \d+ tools in \d+ groups/.test(reply), reply);
ok('no LLM request', llmCalls === 0, `${llmCalls}`);

console.log('\n--- 7. The planner knows which tool groups exist ---');
await say('which tools do you have for files');
const overview = planningMessages.find((m) => m.role === 'system' && /tool groups/i.test(String(m.content)));
ok('planning request carries the tool-group line', !!overview, overview?.content);
ok('and it is short', !!overview && String(overview.content).length < 400, `${String(overview?.content ?? '').length} characters`);

console.log('\n--- 8. A tool without metadata ---');
warnings.length = 0;
toolRegistryV2.register({ name: 'test_undescribed_tool', description: 'Does a thing. More text.', riskLevel: 'low',
  inputSchema: {}, fallbacks: [], execute: async () => 'ok' });
const undescribed = toolRegistryV2.get('test_undescribed_tool')?.meta;
ok('gets derived metadata, never risk 0', !!undescribed && undescribed.risk >= 1, JSON.stringify(undescribed ?? null).slice(0, 80));
ok('and a warning naming it', warnings.some((w) => w.includes('test_undescribed_tool')));

try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use by a child process; the runner clears its temp folder */ }
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
