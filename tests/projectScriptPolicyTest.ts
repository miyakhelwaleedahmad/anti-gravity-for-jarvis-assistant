/**
 * tests/projectScriptPolicyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-07: running a project's package.json script.
 *
 *   - the approval and the log show the command the script runs, not only
 *     its name ("test → node evil.js")
 *   - the owner's request to run a script of a project other than JARVIS:
 *     the first time it asks (level 2, also without full control mode),
 *     showing the command. A script's text is code from that project (a
 *     cloned repository, say), and a plan steered by text from it could pick
 *     it. Said no: it does not run. Said yes: it runs, and the same unchanged
 *     script runs again without asking for the rest of the session; changed
 *     text asks again. Before, it ran at level 1 with no question.
 *   - JARVIS's own scripts: level 1, no question
 *   - an agent running a script in another project: level 2, so it asks; the
 *     owner says no and the script does not run (a marker file it would write
 *     is not there)
 *   - an agent running JARVIS's own scripts: level 1
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scripts-')));
const workspace = path.join(base, 'jarvis');
const projects = path.join(base, 'projects');
const other = path.join(projects, 'other');
for (const d of [workspace, path.join(workspace, 'memory'), path.join(workspace, 'data'), other]) fs.mkdirSync(d, { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_PROJECT_DIRS'] = `${projects};${workspace}`;
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';

const marker = path.join(base, 'ran.txt');
fs.writeFileSync(path.join(other, 'evil.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other', private: true, scripts: { test: 'node evil.js' } }));
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'jarvis', private: true, scripts: { test: 'node -e "0"' } }));

const { assessRisk, decide } = await import('../security/riskEngine.js');
const { beginTrace } = await import('../core/traceContext.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { approvalGate } = await import('../security/approvalGate.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
registerAllTools();
const approvals: any[] = [];
let answer = false;
(approvalGate as any).requestApproval = async (r: any) => { approvals.push(r); return answer; };
const asAgent = <T>(fn: () => Promise<T>) => runAsAgent({ rootTaskId: 'r', taskId: 't', agentId: 'a', agentPath: 'Code Agent', request: 'check the tests', source: 'cli' }, fn);
const assess = (project: string) => assessRisk({ tool: 'dev', args: { action: 'run', project, script: 'test' }, baseRisk: 1 });

console.log('\n=== Project scripts (SEC-07) ===\n');
beginTrace('cli', 'run the tests of my other project');
let a = assess(other);
ok('the owner\'s request, a script of another project, first time: level 2, asks', a.level === 2 && !!a.askOwner, `${a.level} ${a.askOwner ?? 'no question'}`);
ok('…also without full control mode (asks, is not denied)', decide(a, { sessionLevel: 0, policy: 'session' }).outcome === 'approve', JSON.stringify(decide(a, { sessionLevel: 0, policy: 'session' })));
ok('the approval/log target shows what the script runs', /test → node evil\.js/.test(a.target ?? ''), a.target);

let r = await toolRegistryV2.execute('dev', { action: 'run', project: other, script: 'test' });
ok('through the registry the owner is asked, shown the command', approvals.length === 1 && /node evil\.js/.test(JSON.stringify(approvals[0])), JSON.stringify(approvals[0] ?? {}).slice(0, 160));
ok('…said no: refused, the script never ran', !r.success && !fs.existsSync(marker), r.error ?? r.output.slice(0, 80));
answer = true;
r = await toolRegistryV2.execute('dev', { action: 'run', project: other, script: 'test' });
ok('…said yes: it runs', r.success && fs.existsSync(marker) && approvals.length === 2, `${r.success} ${approvals.length}`);
fs.rmSync(marker, { force: true });
answer = false;
a = assess(other);
r = await toolRegistryV2.execute('dev', { action: 'run', project: other, script: 'test' });
ok('the same unchanged script again: level 1, runs without asking', a.level === 1 && r.success && fs.existsSync(marker) && approvals.length === 2, `${a.level} ${r.success} ${approvals.length}`);
fs.rmSync(marker, { force: true });
fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other', private: true, scripts: { test: 'node evil.js --changed' } }));
a = assess(other);
r = await toolRegistryV2.execute('dev', { action: 'run', project: other, script: 'test' });
ok('its text changed: asks again (said no: not run)', a.level === 2 && approvals.length === 3 && !r.success && !fs.existsSync(marker), `${a.level} ${approvals.length}`);
fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other', private: true, scripts: { test: 'node evil.js' } }));
const own = assess(workspace);
ok('JARVIS\'s own scripts: level 1, no question', own.level === 1 && !own.askOwner, `${own.level} ${own.askOwner ?? ''}`);
approvals.length = 0;

a = await asAgent(async () => assess(other));
ok('an agent running a script in another project: level 2', a.level === 2, a.reasons.join('; '));
a = await asAgent(async () => assess(workspace));
ok('an agent running JARVIS\'s own scripts: level 1', a.level === 1, String(a.level));

r = await asAgent(() => toolRegistryV2.execute('dev', { action: 'run', project: other, script: 'test' }));
ok('through the registry the agent\'s call asks the owner, showing the command', approvals.length === 1 && /node evil\.js/.test(JSON.stringify(approvals[0])), JSON.stringify(approvals[0] ?? {}).slice(0, 160));
ok('…the owner says no: refused, and the script never ran', !r.success && !fs.existsSync(marker), r.error ?? r.output.slice(0, 80));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
