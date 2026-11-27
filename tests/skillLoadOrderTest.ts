/**
 * tests/skillLoadOrderTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * HYP-02: the orchestrator started loading the skills and did not wait for
 * them. A request in the first moments after start was planned with only the
 * built-in tools: the skills (open_app, control_*, get_weather …) were not
 * offered to the model, which then answered or picked something else.
 *
 * Skill loading is slowed to 1.5 s here, and a request is sent at once.
 *   1. the first plan is offered the skill tools
 *   2. the request waited for them (and not longer than needed)
 * The scripted model answers without calling a tool, so nothing is run.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skill-order-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

// Slow skill loading down before the orchestrator is created.
const { SkillLoader } = await import('../core/skillLoader.js');
const realLoad = SkillLoader.prototype.loadSkills;
let loadedAt = 0;
SkillLoader.prototype.loadSkills = async function (this: InstanceType<typeof SkillLoader>) {
  await new Promise((r) => setTimeout(r, 1_500));
  const n = await realLoad.call(this);
  loadedAt = Date.now();
  return n;
};

const { modelRouter } = await import('../bridge/modelRouter.js');
const offered: string[][] = [];
const fakeProvider = {
  isConfigured: () => true,
  async chat(req: any) {
    if (req.tools) offered.push((req.tools as any[]).map((t) => String(t.function?.name ?? t.name)));
    return { content: 'Opening it is not needed for this test, sir.' };
  },
  async *streamChat() { yield 'Fine, sir.'; },
};
modelRouter.registerProvider((modelRouter as any).primary, fakeProvider as any);
modelRouter.registerProvider('openai', fakeProvider as any);

const { orchestrator } = await import('../core/orchestrator.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { installFakeTts } = await import('./fakeTts.js');
const tts = installFakeTts(orchestrator, nodeBridge);

console.log('\n=== The first request waits for the skills (HYP-02) ===\n');
const sent = Date.now();
await orchestrator.process('please launch the notepad application and the calculator for me', 'cli');
await tts.idle();
const first = offered[0] ?? [];
ok('the first plan was made', offered.length >= 1, `${offered.length} plan call(s)`);
ok('…and offered skill tools', first.some((n) => /^(open_app|control_app|control_window|get_weather)$/.test(n)), first.filter((n) => /app|window|weather/.test(n)).join(',') || `${first.length} tools, no skills`);
ok('…after the skills had loaded', loadedAt > 0 && loadedAt - sent >= 1_000, `loaded ${loadedAt - sent} ms after the request`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
