/**
 * tests/browserRefusalSpokenTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner's PC, 2026-10-28: for "close youtube" the planner chose control_window
 * (later control_app). Both refused, as phase A1 intends, with
 *   "YouTube" is a page open in Chrome, not an app. Ask me to close the
 *   YouTube tab instead.
 * but the voice said "I encountered an unexpected error and have been unable
 * to complete the task, sir." first: the reply builder did not know A1's
 * browser refusals, so a correct refusal sounded like a fault.
 *
 *   1. the page refusal (control_window, control_app) is spoken as a refusal,
 *      in full, without "unexpected error"
 *   2. the browser refusal (closing Chrome or Firefox through app or process
 *      control, longer than other refusals) is spoken in full
 *   3. not changed: another failure keeps the general failure wording
 *
 * Nothing is closed: the tools are stubbed, the model is scripted.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-browser-refusal-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
{
  const { worldState } = await import('../core/worldState.js');
  (worldState as any).refresh = async () => {};
}
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { browserPageRefusal, browserCloseRefusal } = await import('../control/appMatch.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

let script: Array<{ name: string; args: Record<string, unknown> }> = [];
modelRouter.chat = async (req: any) => {
  if (req.tools && script.length) {
    const calls = script;
    script = [];
    return { content: '', tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } as any;
  }
  return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' } as any;
};
modelRouter.streamChat = async function* () { yield 'Done, sir.'; } as any;

const spoken: string[] = [];
installFakeTts(orchestrator, (await import('../bridge/nodeBridge.js')).nodeBridge, 5, spoken, true);

async function refusedBy(tool: string, error: string, input: string, args: Record<string, unknown>): Promise<string> {
  const t = toolRegistryV2.get(tool)! as any;
  const saved = { execute: t.execute, requiredLevel: t.requiredLevel, meta: t.meta };
  t.execute = async () => JSON.stringify({ success: false, action: 'close', target: String(args['target'] ?? ''), error });
  // Level 0 floor and risk, so the permission check is not what refuses.
  t.requiredLevel = 0;
  t.meta = { ...t.meta, risk: 0, actions: undefined };
  spoken.length = 0; script = [{ name: tool, args }];
  try { await orchestrator.process(input, 'voice'); } finally { t.execute = saved.execute; t.requiredLevel = saved.requiredLevel; t.meta = saved.meta; }
  return spoken.join(' | ');
}

console.log('\n=== Browser refusals are spoken as refusals ===\n');

console.log('--- 1. "is a page open in Chrome, not an app" ---');
const page = browserPageRefusal('YouTube', 'Chrome');
let r = await refusedBy('control_window', page, 'i just say to you that close youtube', { action: 'close', target: 'YouTube' });
ok('control_window: the refusal is spoken in full', r.includes(page), r);
ok('…without "unexpected error"', !/unexpected error/i.test(r), r);
r = await refusedBy('control_app', browserPageRefusal('youtube', 'Chrome'), 'close youtube for me now', { action: 'close', target: 'youtube' });
ok('control_app: the refusal is spoken in full, without "unexpected error"', r.includes('not an app') && /close the youtube tab instead/.test(r) && !/unexpected error/i.test(r), r);

console.log('--- 2. "I don\'t close the … browser through app, window or process control" ---');
const browser = browserCloseRefusal('Firefox');
r = await refusedBy('control_app', browser, 'quit firefox now', { action: 'close', target: 'firefox' });
ok('control_app: the browser refusal is spoken in full', r.includes(browser), r);
ok('…without "unexpected error"', !/unexpected error/i.test(r), r);

console.log('--- 2b. A skill still loading says so plainly (review R5) ---');
const { skillStillLoading } = await import('../core/skillLoader.js');
const loading = skillStillLoading('Control Browser');
r = await refusedBy('control_browser', loading, 'close the youtube tab now', { action: 'close', target: 'youtube' });
ok('"still loading" is spoken as "not yet", without "unexpected error"', r.includes(`I couldn't do that yet, sir. ${loading}`) && !/unexpected error/i.test(r), r);

console.log('--- 3. Not changed: another failure keeps the general wording ---');
const other = 'The window manager returned code 0x80004005 while the request was in flight and the handle was no longer valid for this session.';
r = await refusedBy('control_window', other, 'minimize the notes window', { action: 'minimize', target: 'notes' });
ok('a failure that is not a refusal is not spoken as "I couldn\'t do that"', !/I couldn't do that/.test(r) && r.length > 0, r);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
