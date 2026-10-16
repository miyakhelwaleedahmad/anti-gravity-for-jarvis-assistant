/**
 * tests/policyOwnershipTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-04 / ARCH-05: who owns the security decisions, checked in the code.
 *
 *   1. the approved folders and protected services are defined in security/;
 *      the controllers use the same functions (no second copy to drift)
 *   2. no security module takes policy from a controller module, nor from a
 *      skill: open_app's allow-list and run_command's allow-list are defined
 *      in security/ and the skill and tool use those same functions (a skill
 *      folder is trusted by its description's hash, not its code)
 *   3. every model tool call goes through the registry: the orchestrator's
 *      routed commands use toolRegistryV2.execute, and production code never
 *      swaps the agents' tool executor (only tests do)
 *   4. no skill lets the model choose how approval is asked: a skill that
 *      reads args.source also reads how the request really arrived
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-policy-owner-'));
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Policy ownership (ARCH-04 / ARCH-05) ===\n');

const policy = await import('../security/protectedTargets.js');
const files = await import('../control/fileController.js');
const admin = await import('../control/adminController.js');
ok('control_file uses the approved folders from security/', files.approvedFolders === policy.approvedFolders);
ok('the admin controller uses the protected services from security/', admin.isSecurityService === policy.isSecurityService);
ok('Windows Defender is still protected', policy.isSecurityService('WinDefend') && !policy.isSecurityService('spooler'));

const securityDir = path.join(repo, 'security');
const fromControllers = fs.readdirSync(securityDir).filter((f) => f.endsWith('.ts'))
  .filter((f) => /from '\.\.\/control\/(fileController|adminController)\.js'/.test(fs.readFileSync(path.join(securityDir, f), 'utf8')));
ok('no security module imports policy from fileController or adminController', fromControllers.length === 0, fromControllers.join(', '));
const fromSkills = fs.readdirSync(securityDir).filter((f) => f.endsWith('.ts'))
  .filter((f) => /from '\.\.\/skills\//.test(fs.readFileSync(path.join(securityDir, f), 'utf8')));
ok('no security module imports policy from a skill', fromSkills.length === 0, fromSkills.join(', '));
const openApp = await import('../skills/automation/skill.js') as any;
const terminal = await import('../tools/terminalTool.js') as any;
const openAppPolicy = await import('../security/openAppPolicy.js').catch(() => null) as any;
const commandPolicy = await import('../security/developerCommands.js').catch(() => null) as any;
ok('open_app\'s allow-list is defined in security/, and the skill uses it', !!openAppPolicy && openApp.resolveTargetUrl === openAppPolicy.resolveTargetUrl);
ok('run_command\'s allow-list is defined in security/, and the tool uses it', !!commandPolicy && terminal.validateDeveloperCommand === commandPolicy.validateDeveloperCommand);
const risk = read('security/riskEngine.ts');
ok('the risk engine takes both from security/', /from '\.\/openAppPolicy\.js'/.test(risk) && /from '\.\/developerCommands\.js'/.test(risk));

const orch = read('core/orchestrator.ts');
const routed = /const runRoutedTool = async \([^)]*\) => \{\s*const result = await toolRegistryV2\.execute\(/.test(orch);
ok('routed commands run through toolRegistryV2.execute', routed);

const swaps: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', '_legacy', '.git', 'dist'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.ts') && /\.useToolExecutor\(/.test(fs.readFileSync(p, 'utf8'))) swaps.push(path.relative(repo, p));
  }
};
walk(repo);
ok('production code never swaps the agents\' tool executor', swaps.length === 0, swaps.join(', '));

const skillsDir = path.join(repo, 'skills');
const modelChosen = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  .map((e) => path.join(skillsDir, e.name, 'skill.ts')).filter((p) => fs.existsSync(p))
  .filter((p) => { const s = fs.readFileSync(p, 'utf8'); return /args\[['"]source['"]\]/.test(s) && !/getRequestSource\(\)/.test(s); })
  .map((p) => path.relative(repo, p));
ok('no skill takes the approval channel from the model alone', modelChosen.length === 0, modelChosen.join(', '));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
