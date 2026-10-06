/**
 * tests/filesAndDevToolsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 10 — files, git and project scripts, through the tool registry (risk
 * engine, approval, verify step), with real folders, a real git repository and
 * a real local remote, and real processes:
 *
 *  1. files: list, recursive search by name and text, compare, create, modify
 *     (one or all occurrences; the previous version kept), rename, move,
 *     delete to the JARVIS trash, restore, empty the trash — each checked on
 *     disk. Paths outside the approved folders, a link leading out of one,
 *     executables and whole approved folders are refused; control_file no
 *     longer reads through such a link either.
 *  2. Levels: a temp .txt 1, other files 2, source/config/keys 3, delete 3,
 *     empty trash 3.
 *  3. git: status, diff, branches, log; commit (approval, checked); a commit
 *     holding a .env file or a key refused before anything is staged; switch;
 *     push to a feature branch (approval, checked on the remote); push to main
 *     needs a typed code; force refused; a repository outside the project
 *     folders refused.
 *  4. dev: scripts listed; test scripts run with their exit code; a script not
 *     on the allowlist refused; a dev server started, answering on its port,
 *     stopped; a process JARVIS did not start is not stopped.
 *  5. The planner offers the tools.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p10-')));
const workspace = path.join(base, 'jarvis');
const projects = path.join(base, 'projects');
const scratch = path.join(base, 'scratch'); // inside the temp folder: approved
for (const dir of [workspace, path.join(workspace, 'memory'), path.join(workspace, 'data'), projects, scratch]) fs.mkdirSync(dir, { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_PROJECT_DIRS'] = projects;
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
process.env['JARVIS_DEV_SERVER_START_MS'] = '8000';
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { assessRisk } = await import('../security/riskEngine.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
const approvals: any[] = [];
let answer = true;
(approvalGate as any).requestApproval = async (request: any) => { approvals.push(request); return answer; };

async function run(tool: string, args: Record<string, unknown>) {
  const r = await toolRegistryV2.execute(tool, args);
  let body: any = null;
  try { body = JSON.parse(r.output); } catch { /* not JSON */ }
  return { ...r, body };
}
const level = (tool: string, args: Record<string, unknown>) => {
  const a = assessRisk({ tool, args, baseRisk: toolRegistryV2.riskOf(tool, args) });
  return a.refused ? `refused: ${a.refused}` : a.level;
};
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const freePort = async () => {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};

console.log('\n=== Files and Dev Tools Test ===\n');

console.log('--- 1. Registered ---');
const TOOLS = ['files', 'git', 'git_push', 'dev'];
ok('files, git, git_push and dev are registered with metadata and their own check',
  TOOLS.every((t) => toolRegistryV2.has(t) && !!toolRegistryV2.getMeta(t) && typeof (toolRegistryV2.get(t) as any)?.verify === 'function'),
  TOOLS.filter((t) => !toolRegistryV2.has(t)).join(', '));

console.log('\n--- 2. files ---');
fs.mkdirSync(path.join(scratch, 'a', 'b', 'c'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'a', 'b', 'c', 'deep-notes.txt'), 'first line\nthe budget is 42\nlast line\n');
fs.writeFileSync(path.join(scratch, 'node_modules', 'pkg', 'budget.txt'), 'the budget is hidden here');
fs.writeFileSync(path.join(scratch, '.env'), 'BUDGET_TOKEN=abc123secret');
fs.writeFileSync(path.join(scratch, 'one.txt'), 'alpha\nbeta\ngamma\n');
fs.writeFileSync(path.join(scratch, 'two.txt'), 'alpha\nBETA\ngamma\ndelta\n');

let r = await run('files', { action: 'list', path: scratch, depth: 2 });
ok('list: entries with type, size and time', r.success && r.body?.entries?.some((e: any) => e.path === 'one.txt' && e.type === 'file' && e.size === 17)
  && r.body?.entries?.some((e: any) => e.path === path.join('a', 'b') && e.type === 'folder'), JSON.stringify(r.body?.entries?.slice(0, 4)));
r = await run('files', { action: 'search', path: scratch, name: 'notes' });
ok('search by name finds a file three folders down', r.success && r.body?.results?.some((x: any) => x.path === path.join('a', 'b', 'c', 'deep-notes.txt')), JSON.stringify(r.body?.results));
r = await run('files', { action: 'search', path: scratch, text: 'budget' });
ok('search by text gives the line; skips node_modules; .env content not searched',
  r.success && r.body?.results?.length === 1 && r.body.results[0].lines?.[0]?.line === 2 && /budget is 42/.test(r.body.results[0].lines[0].text),
  JSON.stringify(r.body?.results));
r = await run('files', { action: 'compare', path: path.join(scratch, 'one.txt'), other: path.join(scratch, 'two.txt') });
ok('compare: a unified diff', r.success && /^-beta$/m.test(r.body?.diff ?? '') && /^\+BETA$/m.test(r.body?.diff ?? '') && /^\+delta$/m.test(r.body?.diff ?? ''), r.body?.diff);

approvals.length = 0;
r = await run('files', { action: 'create', path: path.join(scratch, 'todo.txt'), content: 'buy milk' });
ok('create a .txt in the temp folder: level 1, no approval, checked', r.success && approvals.length === 0 && r.verification?.status === 'verified'
  && fs.readFileSync(path.join(scratch, 'todo.txt'), 'utf8') === 'buy milk', r.verification?.evidence);
r = await run('files', { action: 'create', path: path.join(workspace, 'notes.md'), content: '# Notes\nfirst\n' });
ok('create a file in the JARVIS folder: level 2, asked first', r.success && approvals.length === 1 && approvals[0].risk === 2
  && fs.existsSync(path.join(workspace, 'notes.md')), JSON.stringify(approvals.map((a) => [a.action, a.risk])));
r = await run('files', { action: 'create', path: path.join(scratch, 'todo.txt'), content: 'again' });
ok('create over an existing file is refused', !r.success && /already exists/.test(r.output) && fs.readFileSync(path.join(scratch, 'todo.txt'), 'utf8') === 'buy milk');
fs.writeFileSync(path.join(scratch, 'list.txt'), 'apple\npear\napple\n');
r = await run('files', { action: 'modify', path: path.join(scratch, 'list.txt'), find: 'apple', replace: 'plum' });
ok('modify with two matches and no "all": refused, file unchanged', !r.success && /appears 2 times/.test(r.output)
  && fs.readFileSync(path.join(scratch, 'list.txt'), 'utf8') === 'apple\npear\napple\n', r.output.slice(0, 120));
r = await run('files', { action: 'modify', path: path.join(scratch, 'list.txt'), find: 'apple', replace: 'plum', all: true });
const backup = r.body?.backup;
ok('modify all: both replaced, checked, previous version kept', r.success && r.verification?.status === 'verified'
  && fs.readFileSync(path.join(scratch, 'list.txt'), 'utf8') === 'plum\npear\nplum\n' && typeof backup === 'string', r.verification?.evidence);
r = await run('files', { action: 'restore', id: backup });
ok('restore the previous version', r.success && fs.readFileSync(path.join(scratch, 'list.txt'), 'utf8') === 'apple\npear\napple\n', r.verification?.evidence ?? r.output.slice(0, 120));
r = await run('files', { action: 'rename', path: path.join(scratch, 'todo.txt'), to: 'shopping.txt' });
ok('rename: new name there, old gone, checked', r.success && r.verification?.status === 'verified'
  && fs.existsSync(path.join(scratch, 'shopping.txt')) && !fs.existsSync(path.join(scratch, 'todo.txt')));
r = await run('files', { action: 'move', path: path.join(scratch, 'shopping.txt'), to: path.join(scratch, 'a') });
ok('move into a folder, checked', r.success && fs.existsSync(path.join(scratch, 'a', 'shopping.txt')) && r.verification?.status === 'verified');
approvals.length = 0;
r = await run('files', { action: 'delete', path: path.join(scratch, 'a', 'shopping.txt') });
const trashId = r.body?.trashId;
ok('delete: level 3 asked, gone from the folder, kept in the JARVIS trash', r.success && approvals[0]?.risk === 3
  && !fs.existsSync(path.join(scratch, 'a', 'shopping.txt')) && fs.existsSync(path.join(workspace, 'data', 'trash', trashId, 'shopping.txt')),
  `${r.verification?.evidence} ${trashId}`);
r = await run('files', { action: 'trash' });
ok('trash lists it with where it was', r.success && r.body?.items?.some((i: any) => i.id === trashId && i.originalPath === path.join(scratch, 'a', 'shopping.txt')));
r = await run('files', { action: 'restore', id: trashId });
ok('restore puts it back', r.success && fs.readFileSync(path.join(scratch, 'a', 'shopping.txt'), 'utf8') === 'buy milk');
await run('files', { action: 'delete', path: path.join(scratch, 'a', 'shopping.txt') });
approvals.length = 0;
r = await run('files', { action: 'empty_trash' });
ok('empty_trash: level 3 asked, the trash is empty', r.success && approvals[0]?.risk === 3 && r.verification?.evidence === 'the trash is empty'
  && fs.readdirSync(path.join(workspace, 'data', 'trash')).length === 0);

console.log('\n--- 2b. Refused ---');
const outside = fs.existsSync('/etc/hostname') ? '/etc/hostname' : 'C:\\Windows\\win.ini';
r = await run('files', { action: 'list', path: path.dirname(outside) });
ok('a folder outside the approved folders is refused', !r.success && r.error === 'RISK_REFUSED' && /approved folders/.test(r.output), r.output.slice(0, 120));
let linked = false;
try { fs.symlinkSync(path.dirname(outside), path.join(scratch, 'way-out'), 'junction'); linked = true; } catch { /* no links here */ }
if (linked) {
  r = await run('files', { action: 'list', path: path.join(scratch, 'way-out') });
  ok('a link inside an approved folder that leads out is refused', !r.success && /approved folders/.test(r.output), r.output.slice(0, 120));
  // The older control_file tool compared paths as text and read through such a link.
  const { fileController } = await import('../control/fileController.js');
  const read = await fileController.readFile(path.join(scratch, 'way-out', path.basename(outside)));
  ok('control_file cannot read through that link either', /Access Denied/.test(read), read.slice(0, 100));
}
r = await run('files', { action: 'create', path: path.join(scratch, 'run-me.bat'), content: 'del /q *' });
ok('creating a .bat is refused', !r.success && /run when opened/.test(r.output) && !fs.existsSync(path.join(scratch, 'run-me.bat')));
r = await run('files', { action: 'delete', path: workspace });
ok('deleting a whole approved folder is refused', !r.success && /whole approved folder/.test(r.output) && fs.existsSync(workspace), r.output.slice(0, 120));
r = await run('files', { action: 'rename', path: path.join(scratch, 'one.txt'), to: '../one.txt' });
ok('a rename with a folder in the name is refused', !r.success && fs.existsSync(path.join(scratch, 'one.txt')));
r = await run('files', { action: 'move', path: path.join(scratch, 'one.txt'), to: path.dirname(outside) });
ok('moving out of the approved folders is refused', !r.success && fs.existsSync(path.join(scratch, 'one.txt')), r.output.slice(0, 100));

console.log('\n--- 2c. Levels ---');
ok('a temp .txt 1; a .md in the JARVIS folder 2; a .ts or .env 3', level('files', { action: 'create', path: path.join(scratch, 'x.txt') }) === 1
  && level('files', { action: 'create', path: path.join(workspace, 'x.md') }) === 2
  && level('files', { action: 'modify', path: path.join(workspace, 'x.ts') }) === 3
  && level('files', { action: 'modify', path: path.join(scratch, '.env') }) === 3);
ok('delete 3, empty_trash 3, list 0', level('files', { action: 'delete', path: path.join(scratch, 'one.txt') }) === 3
  && level('files', { action: 'empty_trash' }) === 3 && level('files', { action: 'list', path: scratch }) === 0);

console.log('\n--- 3. git ---');
const repo = path.join(projects, 'app');
const remote = path.join(base, 'remote.git');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
sh(repo, 'init', '-q', '-b', 'main');
sh(repo, 'config', 'user.name', 'Test User');
sh(repo, 'config', 'user.email', 'test@example.com');
sh(repo, 'remote', 'add', 'origin', remote);
fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
sh(repo, 'add', '-A');
sh(repo, 'commit', '-q', '-m', 'first');
sh(repo, 'push', '-q', '-u', 'origin', 'main');
fs.writeFileSync(path.join(repo, 'README.md'), 'hello world\n');
fs.writeFileSync(path.join(repo, 'new file.txt'), 'new\n');

r = await run('git', { action: 'status', repo });
ok('status: branch, upstream, a changed and an untracked file (with a space in its name)', r.success && r.body?.branch === 'main' && r.body?.upstream === 'origin/main'
  && r.body?.files?.some((f: any) => f.path === 'README.md' && /modified/.test(f.state)) && r.body?.files?.some((f: any) => f.path === 'new file.txt' && f.state === 'untracked'),
  JSON.stringify(r.body?.files));
r = await run('git', { action: 'diff', repo });
ok('diff shows the change', r.success && /^\+hello world$/m.test(r.body?.diff ?? ''), r.body?.diff?.slice(0, 200));
r = await run('git', { action: 'log', repo });
ok('log lists the first commit', r.success && r.body?.commits?.[0]?.subject === 'first');

fs.writeFileSync(path.join(repo, '.env'), `API_KEY=${'sk-' + 'test-not-real-0000000000000000'}`);
const headBefore = sh(repo, 'rev-parse', 'HEAD');
r = await run('git', { action: 'commit', repo, message: 'with secrets' });
ok('a commit that would take a .env file is refused, nothing staged', !r.success && /key or credential files \(\.env\)/.test(r.output)
  && sh(repo, 'diff', '--cached', '--name-only') === '' && sh(repo, 'rev-parse', 'HEAD') === headBefore, r.output.slice(0, 160));
fs.unlinkSync(path.join(repo, '.env'));
fs.writeFileSync(path.join(repo, 'config.txt'), `aws = ${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`); // a fake key, built so no scanner flags this file
r = await run('git', { action: 'commit', repo, message: 'config' });
ok('a commit holding a key in a file is refused', !r.success && /looks like a key or password/.test(r.output) && sh(repo, 'rev-parse', 'HEAD') === headBefore, r.output.slice(0, 160));
fs.unlinkSync(path.join(repo, 'config.txt'));
approvals.length = 0;
r = await run('git', { action: 'commit', repo, message: 'Update readme' });
ok('commit: level 2 asked, the new commit checked', r.success && approvals[0]?.risk === 2 && r.verification?.status === 'verified'
  && sh(repo, 'log', '-1', '--format=%s') === 'Update readme' && sh(repo, 'status', '--porcelain') === '', r.verification?.evidence);
r = await run('git', { action: 'switch', repo, branch: 'feature/login', create: true });
ok('switch to a new branch, checked', r.success && r.verification?.status === 'verified' && sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'feature/login');
r = await run('git', { action: 'switch', repo, branch: '--orphan' });
ok('a branch name that is an option is refused', !r.success && sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'feature/login');
r = await run('git', { action: 'branches', repo });
ok('branches lists both, the current one marked', r.success && r.body?.branches?.some((b: any) => b.name === 'feature/login' && b.current)
  && r.body?.branches?.some((b: any) => b.name === 'main' && !b.current));

ok('push of a feature branch: level 3', level('git_push', { repo }) === 3, String(level('git_push', { repo })));
approvals.length = 0;
r = await run('git_push', { repo });
ok('push: asked, then the remote has the commit (checked)', r.success && approvals[0]?.risk === 3 && r.verification?.status === 'verified'
  && execFileSync('git', ['-C', remote, 'rev-parse', 'feature/login']).toString().trim() === sh(repo, 'rev-parse', 'HEAD'), r.verification?.evidence ?? r.output.slice(0, 160));
sh(repo, 'switch', '-q', 'main');
fs.writeFileSync(path.join(repo, 'main.txt'), 'on main\n');
sh(repo, 'add', '-A');
sh(repo, 'commit', '-q', '-m', 'main change');
ok('push to main: level 4', level('git_push', { repo }) === 4, String(level('git_push', { repo })));
approvals.length = 0;
answer = false;
const remoteMain = execFileSync('git', ['-C', remote, 'rev-parse', 'main']).toString().trim();
r = await run('git_push', { repo });
ok('push to main asks for a typed code; denied, the remote is unchanged', approvals[0]?.risk === 4 && approvals[0]?.strong === true && !r.success
  && execFileSync('git', ['-C', remote, 'rev-parse', 'main']).toString().trim() === remoteMain);
answer = true;
ok('force is refused', /never force-pushes/.test(String(level('git_push', { repo, force: true }))));
const strayRepo = path.join(base, 'stray');
fs.mkdirSync(strayRepo);
sh(strayRepo, 'init', '-q');
r = await run('git', { action: 'status', repo: strayRepo });
ok('a repository outside the project folders is refused', !r.success && r.error === 'RISK_REFUSED' && /project folders/.test(r.output), r.output.slice(0, 120));

console.log('\n--- 4. dev ---');
const app = path.join(projects, 'web');
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, 'server.js'), `
  const http = require('http');
  const port = Number(process.env.PORT);
  http.createServer((req, res) => res.end('hi')).listen(port, '127.0.0.1', () => console.log('ready on http://localhost:' + port));
`);
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
  name: 'web', version: '1.0.0', private: true,
  scripts: {
    test: 'node -e "console.log(\'tests ok\')"',
    'test:fail': 'node -e "process.exit(3)"',
    dev: 'node server.js',
    preview: 'node -e "process.exit(2)"',
    deploy: 'node -e "console.log(\'deployed\')"',
  },
}, null, 2));
r = await run('dev', { action: 'scripts', project: app });
ok('scripts: listed with what JARVIS does with each', r.success && r.body?.scripts?.find((s: any) => s.name === 'deploy')?.jarvis === 'does not run it'
  && r.body?.scripts?.find((s: any) => s.name === 'test')?.jarvis === 'runs it');
r = await run('dev', { action: 'run', project: app, script: 'test' });
ok('run test: exit code 0, output, checked', r.success && r.body?.exitCode === 0 && /tests ok/.test(r.body?.output ?? '') && r.verification?.status === 'verified', r.verification?.evidence);
r = await run('dev', { action: 'run', project: app, script: 'test:fail' });
ok('run a failing test script: the exit code is reported', r.success && r.body?.exitCode === 3 && /code 3/.test(r.verification?.evidence ?? ''), r.verification?.evidence);
r = await run('dev', { action: 'run', project: app, script: 'deploy' });
ok('a script not on the allowlist is refused', !r.success && r.error === 'RISK_REFUSED' && /only test, build, lint/.test(r.output), r.output.slice(0, 120));
const port = await freePort();
r = await run('dev', { action: 'start_server', project: app, script: 'dev', port });
const serverPid = r.body?.pid;
ok('start a dev server: it answers on its port (checked)', r.success && r.body?.port === port && r.verification?.status === 'verified'
  && /answers on port/.test(r.verification?.evidence ?? '') && (await fetch(`http://127.0.0.1:${port}/`).then((x) => x.text()).catch(() => '')) === 'hi',
  r.verification?.evidence ?? r.output.slice(0, 200));
r = await run('dev', { action: 'start_server', project: app, script: 'preview' });
ok('a server that exits at once is reported as not started', !r.success && r.error === 'VERIFICATION_FAILED' && /stopped at once/.test(r.output), r.output.slice(0, 160));
r = await run('dev', { action: 'stop_server', pid: process.pid });
ok('stopping a process JARVIS did not start is refused (this test is still running)', !r.success && r.error === 'RISK_REFUSED' && /only servers it started/.test(r.output));
approvals.length = 0;
r = await run('dev', { action: 'stop_server', project: app });
let gone = false;
try { process.kill(serverPid, 0); } catch { gone = true; }
ok('stop the server JARVIS started: level 2 asked, process gone, port closed (checked)', r.success && approvals[0]?.risk === 2 && gone
  && r.verification?.status === 'verified' && !(await fetch(`http://127.0.0.1:${port}/`).then(() => true).catch(() => false)), r.verification?.evidence);

console.log('\n--- 5. Planner ---');
{
  const { orchestrator } = await import('../core/orchestrator.js');
  const offered = (q: string): string[] => (orchestrator as any).selectPlanningToolNames(q);
  ok('"delete the old report file" offers files', offered('delete the old report file').includes('files'));
  ok('"commit my changes and push the branch" offers git and git_push', ['git', 'git_push'].every((t) => offered('commit my changes and push the branch').includes(t)));
  ok('"run the tests" offers dev', offered('run the tests').includes('dev'));
}

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
