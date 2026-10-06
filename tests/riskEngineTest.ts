/**
 * tests/riskEngineTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Upgrade phase P2 (docs/upgrade/phases/phase-02-risk-engine.md).
 *
 * One decision per concrete call — run, ask, refuse — from the tool's
 * metadata, its arguments, the session level and JARVIS_LEVEL2_POLICY:
 *  - level 0–1 run (level 1 is the default session level now; it was defined
 *    but never granted, so open/focus/navigate were refused by default);
 *  - level 2 needs full control mode (policy `session`) or an approval (`ask`);
 *  - level 3–4 need approval, asked once (the controller does not ask again);
 *  - blocklisted and critical commands are refused before anyone is asked.
 * Also: `control_app open` passed its target to `cmd /c start`, so
 * "notepad&calc" ran calc; explain_code read any absolute path.
 *
 * Nothing runs on the PC: tools are stubbed, approvals answered by a spy,
 * and the permission session is saved in a temporary data folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-risk-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
delete process.env['JARVIS_LEVEL2_POLICY'];
delete process.env['JARVIS_DEFAULT_PERMISSION_LEVEL'];
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { appController } = await import('../control/appController.js');
let engine: any = null;
let scope: any = null;
try { engine = await import('../security/riskEngine.js' as string); } catch { /* not on the old code */ }
try { scope = await import('../security/approvalScope.js' as string); } catch { /* not on the old code */ }
let denial: any = {};
try { denial = await import('../control/permissionDenial.js'); } catch { /* */ }

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();

// Approvals: the real gate runs; only the person's answer is simulated
// (`nextAnswer`), and every question shown is counted.
let prompts = 0;
let nextAnswer = true;
const answer = async () => { prompts++; return nextAnswer ? 'YES' : 'NO'; };
(approvalGate as any)._promptWithTimeout = answer;
(approvalGate as any)._voiceOrTextPromptWithTimeout = answer;
// The real gate, for checks of the approved-call scope.
const RealGate = (approvalGate as any).constructor;
const realGate = new RealGate();

/** Swap a tool's body for one check, then restore. */
async function withTool<T>(name: string, body: (args: any) => Promise<string>, fn: () => Promise<T>): Promise<T> {
  const tool = toolRegistryV2.get(name)! as any;
  const saved = tool.execute;
  tool.execute = body;
  try { return await fn(); } finally { tool.execute = saved; }
}

function fullControl(on: boolean): void {
  if (on) permissionSession.activateFullControl(5, 'cli');
  else permissionSession.deactivateFullControl('risk test');
}

console.log('\n=== Risk Engine Test ===\n');

console.log('--- 1. Defaults ---');
ok('default session level is 1 (safe control)', permissionSession.getCurrentLevel() === 1, `L${permissionSession.getCurrentLevel()}`);
ok('level-2 policy is "session" unless set to "ask"',
  engine?.level2Policy({}) === 'session' && engine?.level2Policy({ JARVIS_LEVEL2_POLICY: 'ask' }) === 'ask');

if (engine) {
  const assess = (tool: string, args: Record<string, unknown> = {}) =>
    engine.assessRisk({ tool, args, baseRisk: toolRegistryV2.riskOf(tool, args) });

  console.log('\n--- 2. Level of a call ---');
  const downloads = path.join(os.homedir(), 'Downloads');
  const cases: Array<[string, Record<string, unknown>, number | 'refused']> = [
    ['get_system_info', {}, 0],
    ['control_app', { action: 'focus', target: 'notepad' }, 1],
    ['control_app', { action: 'close', target: 'notepad' }, 2],
    // The level the controller itself checks.
    ['control_window', { action: 'move', target: 'notepad', x: 1, y: 1 }, 2],
    ['control_system', { action: 'settings', target: 'display' }, 2],
    ['control_system', { action: 'restart_jarvis' }, 3],
    ['control_process', { action: 'kill', target: 'notepad' }, 3],
    ['run_command', { command: 'git status' }, 0],
    ['run_command', { command: 'npm run test' }, 1],
    ['run_command', { command: 'rm -rf /' }, 'refused'],
    ['run_command', { command: 'git push origin main' }, 'refused'],
    ['run_command', { command: 'git branch -a' }, 0],
    ['run_command', { command: 'git branch -D main' }, 'refused'],
    ['run_command', { command: 'git diff --output=notes.txt' }, 'refused'],
    ['run_command', { command: 'git status && del /s *' }, 'refused'],
    ['open_app', { target: 'cmd', dryRun: true }, 0],
    ['control_system', { action: 'powershell', target: 'Get-Date' }, 3],
    ['control_system', { action: 'shell', target: 'format c:' }, 'refused'],
    ['control_system', { action: 'shell', target: 'diskpart' }, 'refused'],
    ['control_system', { action: 'stop_service', target: 'WinDefend' }, 'refused'],
    ['control_system', { action: 'start_service', target: 'Spooler' }, 3],
    ['control_file', { action: 'write', path: path.join(os.tmpdir(), 'jarvis-note.txt') }, 1],
    ['control_file', { action: 'write', path: path.join(os.homedir(), 'Documents', 'notes.txt') }, 2],
    ['control_file', { action: 'write', path: path.join(path.dirname(os.tmpdir()), `${path.basename(os.tmpdir())}-x`, 'a.txt') }, 2],
    ['control_file', { action: 'write', path: path.join(os.tmpdir(), 'jarvis-note.ts') }, 3],
    ['control_file', { action: 'write', path: path.join(os.homedir(), 'Documents', 'app.ts') }, 3],
    ['write_file', { filePath: 'notes.md', content: 'x' }, 2],
    ['write_file', { filePath: '.env', content: 'x' }, 3],
    ['control_file', { action: 'delete', path: 'notes.txt' }, 3],
    ['control_file', { action: 'delete_folder', path: downloads }, 4],
    ['open_app', { target: 'notepad' }, 1],
    ['open_app', { target: 'cmd' }, 3],
    ['control_browser', { action: 'close', target: 'youtube' }, 1],
    ['control_browser', { action: 'close', target: 'github' }, 2],
    ['enable_full_control_session', {}, 3],
  ];
  for (const [tool, args, expected] of cases) {
    const a = assess(tool, args);
    const got = a.refused ? 'refused' : a.level;
    ok(`${tool} ${JSON.stringify(args).slice(0, 60)} → ${expected}`, got === expected, `got ${got}${a.refused ? `: ${a.refused.slice(0, 60)}` : ''}`);
  }

  console.log('\n--- 2b. Shell commands that cannot be undone ---');
  const shell: Array<[string, string, number | 'refused']> = [
    ['powershell', 'Get-Date', 3], ['shell', 'echo hi', 3], ['shell', 'del notes.txt', 3], ['powershell', 'Remove-Item notes.txt', 3],
    ['shell', 'shutdown /s /t 0', 3], ['shell', 'reg query HKLM\\Software', 3], ['shell', 'reg add HKCU\\Software\\x /v y /d 1', 3],
    ['shell', 'icacls C:\\data', 3], ['shell', 'net user', 3],
    ['shell', 'rd /s /q C:\\Users\\me\\Downloads\\old', 4], ['powershell', 'Remove-Item -Recurse .\\build', 4], ['powershell', 'rm -r dist', 4],
    ['shell', 'reg delete HKLM\\Software\\x /f', 4], ['shell', 'reg import tweaks.reg', 4],
    ['powershell', 'Set-ItemProperty -Path HKLM:\\SOFTWARE\\x -Name y -Value 1', 4],
    ['shell', 'bcdedit /set testsigning on', 4], ['shell', 'vssadmin delete shadows /all', 4], ['shell', 'wmic shadowcopy delete', 4],
    ['powershell', 'Clear-Disk -Number 0', 4], ['shell', 'cipher /w:C:', 4], ['shell', 'takeown /f C:\\data', 4],
    ['shell', 'icacls C:\\data /grant Everyone:F', 4], ['powershell', 'Set-ExecutionPolicy Unrestricted', 4],
    ['shell', 'schtasks /create /tn x /tr calc', 4], ['shell', 'net user bob pass /add', 4],
    ['shell', 'rd /s /q C:\\', 'refused'], ['shell', 'rmdir /s C:\\Users\\me', 'refused'], ['shell', 'del /s /q C:\\*', 'refused'],
    ['powershell', 'Remove-Item -Recurse -Force C:\\Users', 'refused'], ['powershell', 'Remove-Item -Recurse C:\\Windows\\System32', 'refused'],
    ['powershell', 'rm -r $env:USERPROFILE', 'refused'], ['shell', 'rd /s /q %USERPROFILE%', 'refused'], ['powershell', 'Remove-Item -Recurse ~', 'refused'],
    ['powershell', 'Remove-Item -Recurse "C:\\Program Files\\App"', 'refused'],
    ['shell', 'netsh advfirewall set allprofiles state off', 'refused'],
  ];
  for (const [action, target, expected] of shell) {
    const a = assess('control_system', { action, target });
    const got = a.refused ? 'refused' : a.level;
    ok(`${action} ${target} → ${expected}`, got === expected, `got ${got}`);
  }

  console.log('\n--- 3. Decisions ---');
  const d = (tool: string, args: Record<string, unknown>, sessionLevel: number, policy = 'session', floor = 0) =>
    engine.decide(assess(tool, args), { sessionLevel, policy, floor });
  ok('level 1 runs at the default level', d('control_app', { action: 'focus', target: 'x' }, 1).outcome === 'allow');
  ok('level 2 without full control: refused, with the full-control hint',
    d('control_app', { action: 'close', target: 'x' }, 1).outcome === 'deny'
    && d('control_app', { action: 'close', target: 'x' }, 1).code === 'PERMISSION_DENIED');
  ok('level 2 in full control mode: runs', d('control_app', { action: 'close', target: 'x' }, 2).outcome === 'allow');
  const ask2 = d('control_app', { action: 'close', target: 'x' }, 1, 'ask');
  ok('level 2, policy ask: asks, and the approval stands in for level 2', ask2.outcome === 'approve' && ask2.grantsLevel === 2);
  ok('level 3 without full control: refused', d('control_process', { action: 'kill', target: 'x' }, 1).outcome === 'deny');
  const l3 = d('control_process', { action: 'kill', target: 'x' }, 2);
  ok('level 3 in full control mode: asks', l3.outcome === 'approve' && l3.grantsLevel === 0);
  ok('turning on full control asks, at the default level', d('enable_full_control_session', {}, 1).outcome === 'approve');
  ok('Command Prompt asks, at the default level', d('open_app', { target: 'cmd' }, 1).outcome === 'approve');
  ok('a refused command is refused in full control mode too',
    d('control_system', { action: 'shell', target: 'format c:' }, 2).code === 'RISK_REFUSED');
  const floor = d('control_mouse', { action: 'move', x: 1, y: 1 }, 1, 'ask', 2);
  ok('policy ask, below the tool floor: asks and stands in for the floor', floor.outcome === 'approve' && floor.grantsLevel === 2);

  console.log('\n--- 3b. Every session level and policy ---');
  // Outcome at session 0, 1, 2 (2 = full control mode), each under policy
  // "session" then "ask". A run, Q ask, P needs full control, R refused.
  const matrix: Array<[string, Record<string, unknown>, string]> = [
    ['get_system_info', {}, 'AA AA AA'],
    ['run_command', { command: 'git status' }, 'AA AA AA'],
    ['run_command', { command: 'npm run test' }, 'AA AA AA'],
    ['control_browser', { action: 'open_url', target: 'https://example.com' }, 'AA AA AA'],
    ['control_browser', { action: 'close', target: 'youtube' }, 'AA AA AA'],
    ['control_app', { action: 'focus', target: 'notepad' }, 'PQ AA AA'],
    ['control_window', { action: 'focus', target: 'notepad' }, 'PQ AA AA'],
    ['control_app', { action: 'close', target: 'notepad' }, 'PQ PQ AA'],
    ['control_browser', { action: 'close', target: 'github' }, 'PQ PQ AA'],
    ['control_keyboard', { action: 'type', text: 'hello' }, 'PQ PQ AA'],
    ['control_file', { action: 'write', path: path.join(os.tmpdir(), 'jarvis-note.txt') }, 'PQ PQ AA'],
    ['control_process', { action: 'kill', target: 'notepad' }, 'PQ PQ QQ'],
    ['control_system', { action: 'start_service', target: 'Spooler' }, 'PQ PQ QQ'],
    ['control_file', { action: 'delete', path: 'notes.txt' }, 'PQ PQ QQ'],
    ['control_file', { action: 'delete_folder', path: downloads }, 'PQ PQ QQ'],
    ['write_file', { filePath: '.env', content: 'x' }, 'PQ PQ QQ'],
    ['open_app', { target: 'cmd' }, 'QQ QQ QQ'],
    ['enable_full_control_session', {}, 'QQ QQ QQ'],
    ['control_system', { action: 'shell', target: 'format c:' }, 'RR RR RR'],
    ['run_command', { command: 'rm -rf /' }, 'RR RR RR'],
  ];
  const letter = (r: any) => r.outcome === 'allow' ? 'A' : r.outcome === 'approve' ? 'Q' : r.code === 'RISK_REFUSED' ? 'R' : 'P';
  for (const [tool, args, expected] of matrix) {
    const floorLevel = (toolRegistryV2.get(tool) as any)?.requiredLevel ?? 0;
    const got = [0, 1, 2].map((level) => (['session', 'ask'] as const)
      .map((policy) => letter(engine.decide(assess(tool, args), { sessionLevel: level, policy, floor: floorLevel })))
      .join('')).join(' ');
    ok(`${tool} ${JSON.stringify(args).slice(0, 50)}: ${expected}`, got === expected, `got ${got}`);
  }
}

console.log('\n--- 4. Through the registry ---');
fullControl(false);
let ran = 0;
await withTool('control_app', async () => { ran++; return '{"success":true}'; }, async () => {
  const focus = await toolRegistryV2.execute('control_app', { action: 'focus', target: 'notepad' });
  ok('control_app focus runs at the default level, no approval', focus.success && ran === 1 && prompts === 0, `${focus.error ?? ''} ran=${ran} prompts=${prompts}`);
  const close = await toolRegistryV2.execute('control_app', { action: 'close', target: 'notepad' });
  ok('control_app close is refused without full control mode', !close.success && close.error === 'PERMISSION_DENIED' && ran === 1, close.output);
});

fullControl(true);
let innerAnswer: boolean | undefined;
ran = 0; prompts = 0; nextAnswer = true;
await withTool('control_process', async () => {
  ran++;
  innerAnswer = await approvalGate.requestApproval('Terminate Process', 'Kill process: notepad');
  return '{"success":true}';
}, async () => {
  const kill = await toolRegistryV2.execute('control_process', { action: 'kill', target: 'notepad' });
  ok('a level-3 call asks once and runs when approved', kill.success && prompts === 1 && ran === 1, `prompts=${prompts}`);
  ok("the controller's own approval request is answered by that approval", innerAnswer === true);
  nextAnswer = false;
  const refused = await toolRegistryV2.execute('control_process', { action: 'kill', target: 'notepad' });
  ok('not approved: nothing runs', !refused.success && refused.error === 'APPROVAL_DENIED' && ran === 1, refused.output);
});
ok('outside an approved call the real gate still asks (and denies with no terminal)',
  (await realGate.requestApproval('Terminate Process', 'Kill process: notepad', 'HIGH_RISK', 'test', 'cli', 1)) === false);

ran = 0; prompts = 0; nextAnswer = true;
await withTool('control_system', async () => { ran++; return '{"success":true}'; }, async () => {
  const format = await toolRegistryV2.execute('control_system', { action: 'shell', target: 'format c:' });
  ok('"format c:" is refused before anyone is asked', !format.success && format.error === 'RISK_REFUSED' && prompts === 0 && ran === 0, format.output);
});
const rm = await toolRegistryV2.execute('run_command', { command: 'rm -rf /' });
ok('run_command "rm -rf /" is refused without a prompt', !rm.success && rm.error === 'RISK_REFUSED' && prompts === 0, rm.output);

// The risk check failing refuses the call; it does not run unchecked.
const realRiskOf = toolRegistryV2.riskOf;
(toolRegistryV2 as any).riskOf = () => { throw new Error('metadata unreadable'); };
ran = 0;
const broken = await withTool('control_window', async () => { ran++; return '{"success":true}'; },
  () => toolRegistryV2.execute('control_window', { action: 'focus', target: 'notepad' }));
(toolRegistryV2 as any).riskOf = realRiskOf;
ok('a risk check that throws refuses the call, which does not run',
  !broken.success && broken.error === 'RISK_REFUSED' && ran === 0, broken.output);

// Real writes through FileController, in the temp folder and the throwaway workspace.
const tempNote = path.join(os.tmpdir(), `jarvis-risk-${process.pid}.txt`);
const note = await toolRegistryV2.execute('control_file', { action: 'write', path: tempNote, content: 'hello' });
ok('a .txt file in the temp folder is written without a prompt',
  note.success && fs.existsSync(tempNote) && prompts === 0, `prompts=${prompts} ${note.output.slice(0, 60)}`);
fs.rmSync(tempNote, { force: true });
const source = path.join(workspace, 'sample-write.ts');
const ts = await toolRegistryV2.execute('control_file', { action: 'write', path: source, content: 'export const x = 1;\n' });
ok('a source file: asked once (not again by FileController), then written',
  ts.success && fs.existsSync(source) && fs.readFileSync(source, 'utf8').includes('x = 1') && prompts === 1,
  `prompts=${prompts} ${ts.output.slice(0, 60)}`);
nextAnswer = false; prompts = 0;
const kept = path.join(workspace, 'kept.ts');
const declined = await toolRegistryV2.execute('control_file', { action: 'write', path: kept, content: 'x' });
ok('declined: the file is not written, asked once', !declined.success && !fs.existsSync(kept) && prompts === 1, `prompts=${prompts}`);
nextAnswer = true;
fullControl(false);

console.log('\n--- 5. Policy "ask" ---');
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
let levelInside = false;
ran = 0; prompts = 0; nextAnswer = true;
await withTool('control_keyboard', async () => {
  ran++;
  levelInside = permissionSession.checkPermission(2, 'Type text');
  return '{"success":true}';
}, async () => {
  const typed = await toolRegistryV2.execute('control_keyboard', { action: 'type', text: 'hello' });
  ok('a level-2 call without full control asks, then runs', typed.success && prompts === 1 && ran === 1, typed.error ?? '');
  ok('inside that call the approval stands in for level 2', levelInside);
  ok('after it, level 2 is not granted', !permissionSession.checkPermission(2, 'Type text'));
});
delete process.env['JARVIS_LEVEL2_POLICY'];

console.log('\n--- 6. An approval belongs to one call ---');
if (scope) {
  fullControl(true);
  prompts = 0; nextAnswer = true;
  let seenByOther: unknown = 'not run';
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await withTool('control_process', async () => { await gate; return '{"success":true}'; }, async () => {
    await withTool('get_system_info', async () => { seenByOther = scope.currentApproval(); release(); return 'info'; }, async () => {
      await Promise.all([
        toolRegistryV2.execute('control_process', { action: 'kill', target: 'notepad' }),
        new Promise((r) => setTimeout(r, 20)).then(() => toolRegistryV2.execute('get_system_info', {})),
      ]);
    });
  });
  ok('a call running alongside an approved call is not approved', seenByOther === undefined, String(seenByOther));

  // The same through the shared action queue, where the second action waits
  // behind the approved one.
  const { actionQueue } = await import('../control/actionQueue.js');
  let queuedSaw: unknown = 'not run';
  let releaseQueue!: () => void;
  const held = new Promise<void>((r) => { releaseQueue = r; });
  await withTool('control_process', async () => actionQueue.enqueue('kill', async () => { await held; return '{"success":true}'; }), async () => {
    await withTool('control_window', async () => actionQueue.enqueue('focus', async () => { queuedSaw = scope.currentApproval(); return '{"success":true}'; }), async () => {
      const first = toolRegistryV2.execute('control_process', { action: 'kill', target: 'notepad' });
      await new Promise((r) => setTimeout(r, 20));
      const second = toolRegistryV2.execute('control_window', { action: 'focus', target: 'notepad' });
      setTimeout(releaseQueue, 20);
      await Promise.all([first, second]);
    });
  });
  ok('an action queued behind an approved one does not run under its approval', queuedSaw === undefined, String(queuedSaw));
  fullControl(false);
} else {
  ok('approval scope exists', false);
}

console.log('\n--- 7. Replies ---');
let llmCalls = 0;
modelRouter.chat = async (req: any) => {
  llmCalls++;
  if (req.tools) return { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'control_process', arguments: '{"action":"kill","target":"notepad"}' } }] } as any;
  return { content: '{"failureClass":"unknown","repairStrategy":"abort","context":""}' } as any;
};
modelRouter.streamChat = async function* () { llmCalls++; yield 'Done, sir.'; } as any;
let spoken: string[] = [];
(orchestrator as any).speak = (t: string) => { spoken.push(t); };
spoken = [];
await orchestrator.process('close notepad', 'voice');
ok('"close notepad" without full control: the full-control hint', spoken.join(' ') === denial.FULL_CONTROL_HINT, spoken.join(' | '));
fullControl(true);
nextAnswer = false; prompts = 0; ran = 0; spoken = []; llmCalls = 0;
await withTool('control_process', async () => { ran++; return '{"success":true}'; }, async () => {
  await orchestrator.process('end the frozen notepad process', 'voice');
});
ok('a refused approval is reported as cancelled', spoken.join(' ') === denial.APPROVAL_DENIED_REPLY, spoken.join(' | '));
ok('and nothing ran, asked once, no retry', ran === 0 && prompts === 1, `ran=${ran} prompts=${prompts}`);
fullControl(false);

console.log('\n--- 8. Command Prompt targets and explain_code ---');
let threw = '';
try { await appController.openApp('notepad&calc'); } catch (e) { threw = (e as Error).message; }
ok('control_app open "notepad&calc" is refused, nothing started', /safety policy/.test(threw), threw || 'not refused');
fs.writeFileSync(path.join(workspace, 'sample.ts'), 'export const x = 1;\n');
fs.writeFileSync(path.join(workspace, '.env'), 'GEMINI_API_KEY=not-a-real-key\n');
const inside = await toolRegistryV2.execute('explain_code', { file_path: 'sample.ts' });
ok('explain_code reads a file in the JARVIS folder', inside.success && inside.output.includes('export const x'), inside.error ?? '');
const outside = await toolRegistryV2.execute('explain_code', { file_path: '/etc/hostname' });
ok('explain_code refuses a file outside it', !outside.success && /denied/i.test(outside.output), outside.output.slice(0, 80));
const escape = await toolRegistryV2.execute('explain_code', { file_path: '../secret.txt' });
ok('explain_code refuses ".."', !escape.success && /denied/i.test(escape.output), escape.output.slice(0, 80));
const env = await toolRegistryV2.execute('explain_code', { file_path: '.env' });
ok('explain_code refuses .env', !env.success && !env.output.includes('not-a-real-key'), env.output.slice(0, 80));

try { await memoryManager.flush(); } catch { /* best effort */ }
permissionSession.shutdown?.();
process.chdir(os.tmpdir());
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
