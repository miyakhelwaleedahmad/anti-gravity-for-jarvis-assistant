/**
 * tests/childEnvTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-06: child processes do not get JARVIS's keys and tokens.
 *
 * Synthetic secrets are put in this process's environment (as JARVIS's .env
 * would), then real child processes are started through the changed paths
 * and report the names they can see:
 *   - system/processRunner (admin shell/PowerShell commands)
 *   - core/terminalTools (run_command)
 *   - tools/devTools through the registry (a project's package.json script)
 * (git, the git probe, the app opener and the Windows probe scripts use the
 * same childEnv(); the rule itself is checked in part 1.)
 * The secrets must be absent; PATH, the home folder and what the caller sets
 * on purpose (CI, FORCE_COLOR) must be there, and the programs must run.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-child-env-')));
const workspace = path.join(base, 'jarvis');
const projects = path.join(base, 'projects');
const app = path.join(projects, 'app');
for (const d of [workspace, path.join(workspace, 'memory'), path.join(workspace, 'data'), app]) fs.mkdirSync(d, { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_PROJECT_DIRS'] = projects;

const SECRETS: Record<string, string> = {
  GEMINI_API_KEY: 'test-secret-gemini',
  GROQ_API_KEY: 'test-secret-groq',
  SERPER_API_KEY: 'test-secret-serper',
  JARVIS_BRIDGE_TOKEN: 'test-secret-bridge',
  JARVIS_A2A_TOKEN: 'test-secret-a2a',
  GITHUB_TOKEN: 'test-secret-github',
  AWS_SECRET_ACCESS_KEY: 'test-secret-aws',
  DB_PASSWORD: 'test-secret-db',
  npm_config__authToken: 'test-secret-npm',
  JARVIS_VECTOR_TOKEN: 'test-secret-vector',
};
Object.assign(process.env, SECRETS);

const { childEnv, passesToChild } = await import('../system/childEnv.js');
const { runProcess } = await import('../system/processRunner.js');
const { terminalTools } = await import('../core/terminalTools.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const DUMP = `process.stdout.write('ENV:'+JSON.stringify(Object.keys(process.env))+':END')`;
const names = (out: string): string[] => { const m = /ENV:(\[.*?\]):END/s.exec(out); return m ? JSON.parse(m[1]!) : []; };
const leaked = (keys: string[]) => keys.filter((k) => k in SECRETS);
const hasPath = (keys: string[]) => keys.some((k) => k.toLowerCase() === 'path');

console.log('\n=== Child process environment (SEC-06) ===\n');

console.log('--- 1. The rule ---');
const env = childEnv();
ok('no synthetic secret passes', leaked(Object.keys(env)).length === 0, leaked(Object.keys(env)).join(','));
ok('PATH and the home folder pass', hasPath(Object.keys(env)) && Object.keys(env).some((k) => /^(home|userprofile)$/i.test(k)));
ok('a secret-looking name is refused even if it looks like a toolchain variable', !passesToChild('NPM_TOKEN') && !passesToChild('PYTHON_API_KEY') && !passesToChild('GIT_PASSWORD'));
ok('what the caller sets on purpose is kept', childEnv({ CI: '1', PORT: '4000' }).PORT === '4000');

console.log('\n--- 2. Real child processes ---');
let keys = names((await runProcess(process.execPath, ['-e', DUMP])).stdout);
ok('admin commands (processRunner): the child runs, sees PATH, sees no secret', keys.length > 0 && hasPath(keys) && leaked(keys).length === 0, leaked(keys).join(',') || `${keys.length} names`);

const term = await terminalTools.run(`"${process.execPath}" -e "${DUMP.replace(/"/g, '\\"')}"`, { cwd: workspace });
keys = names(term.stdout ?? '');
ok('run_command (terminalTools): runs, no secret', keys.length > 0 && leaked(keys).length === 0, leaked(keys).join(',') || `${keys.length} names`);

fs.writeFileSync(path.join(app, 'dump.js'), DUMP);
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { test: 'node dump.js' } }));
registerAllTools();
const dev = await toolRegistryV2.execute('dev', { action: 'run', project: app, script: 'test' });
keys = names(dev.output.replace(/\\"/g, '"'));
ok('a project\'s package.json script (dev run): runs, sees CI, no secret', keys.length > 0 && keys.includes('CI') && leaked(keys).length === 0, leaked(keys).join(',') || dev.output.slice(0, 120));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
for (const k of Object.keys(SECRETS)) delete process.env[k];
try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
