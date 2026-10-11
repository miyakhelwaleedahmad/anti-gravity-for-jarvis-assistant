/**
 * tests/selfHealInstallTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-15 / REL-08: when a Python module failed with "No module named …", the
 * self-healing executor ran `python -m pip install <name>`:
 *   - with nobody asked (it downloads and runs code from PyPI),
 *   - with no version (whatever is newest that minute),
 *   - into the system Python, not the .venv the services run in,
 *   - with JARVIS's keys in its environment,
 *   - and "difflib" on its list, a standard-library module: `pip install
 *     difflib` installs whatever a stranger publishes under that name.
 *
 *   1. difflib and packages with no version in requirements.txt are refused
 *   2. without a .venv nothing is installed, and nobody is asked
 *   3. with one: the owner is asked; no → nothing runs; yes → the .venv's
 *      Python runs pip with the requirements.txt version, without JARVIS's keys
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-selfheal-'));
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['OPENAI_API_KEY'] = 'sk-test-not-real';
fs.copyFileSync(path.join(repo, 'requirements.txt'), path.join(root, 'requirements.txt'));

const { RepairExecutor, requirementFor } = await import('../self_healing/repairExecutor.js');
const { approvalGate } = await import('../security/approvalGate.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const asked: any[] = [];
let answer = false;
(approvalGate as any).requestApproval = async (...args: unknown[]) => { asked.push(args); return answer; };
const executor = RepairExecutor.getInstance();
const install = (target: string) => executor.execute({ kind: 'pip_install', target } as any);

console.log('\n=== Self-healing package installs (SEC-15, REL-08) ===\n');

console.log('--- 1. What may be installed ---');
const requirements = fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8');
ok('edge-tts gets the requirements.txt version', requirementFor('edge-tts', requirements) === 'edge-tts>=6.1.9', String(requirementFor('edge-tts', requirements)));
ok('SpeechRecognition too (names compared loosely)', requirementFor('speechrecognition', requirements) === 'SpeechRecognition>=3.10.0', String(requirementFor('speechrecognition', requirements)));
let r = await install('difflib');
ok('difflib (part of Python) is refused', !r.success && /not on allowlist: difflib/.test(r.error ?? ''), r.error);
r = await install('pyttsx3');
ok('a package with no version in requirements.txt is refused', !r.success && /no version in requirements.txt for: pyttsx3/.test(r.error ?? ''), r.error);

console.log('\n--- 2. No .venv ---');
asked.length = 0;
r = await install('edge-tts');
ok('nothing installed, nobody asked', !r.success && /\.venv was not found/.test(r.error ?? '') && asked.length === 0, r.error);

console.log('\n--- 3. With JARVIS\'s .venv ---');
if (process.platform === 'win32') {
  console.log('  NOTE: this part uses a stand-in python3 script and runs on Linux and macOS (CI); on Windows the .venv\\Scripts\\python.exe path is the one checked in section 2.');
} else {
  const record = path.join(root, 'pip-call.json');
  const bin = path.join(root, '.venv', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'python3'),
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env) }));\n`,
    { mode: 0o755 });

  asked.length = 0; answer = false;
  r = await install('edge-tts');
  ok('the owner is asked first', asked.length === 1 && /Install: edge-tts>=6\.1\.9/.test(String(asked[0]?.[1])), JSON.stringify(asked[0]?.slice(0, 2)));
  ok('no: nothing runs, and the reply gives the command to run', !r.success && !fs.existsSync(record) && /pip install edge-tts>=6\.1\.9/.test(r.error ?? ''), r.error);

  answer = true;
  r = await install('edge-tts');
  const call = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null;
  ok('yes: the .venv\'s Python runs pip', r.success && !!call, r.error ?? r.output);
  ok('…with the requirements.txt version', JSON.stringify(call?.args) === JSON.stringify(['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'edge-tts>=6.1.9']), JSON.stringify(call?.args));
  ok('…and without JARVIS\'s keys', call && !call.env.includes('OPENAI_API_KEY'));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
