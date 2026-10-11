/**
 * tests/vectorAuthTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-18, JARVIS's side: the token every vector request carries.
 *
 *   1. the token is made once, kept owner-only in data/security/vector_token,
 *      and reused (JARVIS adopts a service started by an earlier run)
 *   2. JARVIS_VECTOR_TOKEN wins over the file
 *   3. the service is started with its token and its own settings, never with
 *      JARVIS's other keys
 *   4. JARVIS and vectorMemory.py read the same token (when a Python with
 *      fastapi and numpy is available; the service itself is tested in
 *      tests/python/test_vector_access.py)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vector-auth-'));
process.env['JARVIS_DATA_ROOT'] = root;
delete process.env['JARVIS_VECTOR_TOKEN'];

const { getVectorToken, vectorHeaders, vectorTokenFile, VECTOR_TOKEN_HEADER } = await import('../memory/vectorAuth.js');
const { vectorServiceEnv } = await import('../memory/vectorMemorySupervisor.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Vector service token (SEC-18) ===\n');

console.log('--- 1. The kept token ---');
const file = vectorTokenFile();
ok('it lives in data/security under the data root', file === path.join(root, 'data', 'security', 'vector_token'), file);
const token = getVectorToken();
ok('a 64-character random token is made', /^[0-9a-f]{64}$/.test(token));
ok('…and written to the file', fs.readFileSync(file, 'utf8').trim() === token);
if (process.platform !== 'win32') {
  const mode = fs.statSync(file).mode & 0o777;
  ok('…readable by the owner only', mode === 0o600, mode.toString(8));
}
ok('the same token next time', getVectorToken() === token);
ok('every request carries it', vectorHeaders()[VECTOR_TOKEN_HEADER] === token && vectorHeaders(true)['Content-Type'] === 'application/json');

console.log('\n--- 2. JARVIS_VECTOR_TOKEN ---');
ok('the variable wins over the file', getVectorToken({ JARVIS_VECTOR_TOKEN: ' chosen-by-owner ' }) === 'chosen-by-owner');

console.log('\n--- 3. What the service process gets ---');
const env = vectorServiceEnv({
  OPENAI_API_KEY: 'sk-test-not-real', GEMINI_API_KEY: 'g-test', JARVIS_BRIDGE_TOKEN: 'b-test', HF_TOKEN: 'hf-test',
  HF_HOME: 'C:\\hf', EMBEDDING_MODEL: 'all-MiniLM-L6-v2', VECTOR_REQUEST_TIMEOUT: '30', JARVIS_VECTOR_PERSIST: 'true',
  JARVIS_DATA_ROOT: root, HTTPS_PROXY: 'http://proxy:3128', PYTHONUTF8: '1',
});
ok('its own settings are passed', env['HF_HOME'] === 'C:\\hf' && env['EMBEDDING_MODEL'] === 'all-MiniLM-L6-v2' && env['VECTOR_REQUEST_TIMEOUT'] === '30'
  && env['JARVIS_VECTOR_PERSIST'] === 'true' && env['JARVIS_DATA_ROOT'] === root && env['HTTPS_PROXY'] === 'http://proxy:3128' && env['PYTHONUTF8'] === '1', Object.keys(env).join(','));
ok('…and its one credential, the Hugging Face read token for the model download', env['HF_TOKEN'] === 'hf-test');
ok('JARVIS\'s other keys are not (provider keys, bridge token)', !['OPENAI_API_KEY', 'GEMINI_API_KEY', 'JARVIS_BRIDGE_TOKEN'].some((k) => k in env));
const supervisor = fs.readFileSync(path.join(repo, 'memory', 'vectorMemorySupervisor.ts'), 'utf8');
ok('the spawn passes the token and that environment (and only that)', /env: childEnv\(\{ JARVIS_VECTOR_TOKEN: getVectorToken\(\), \.\.\.vectorServiceEnv\(\) \}\)/.test(supervisor));
const unauthenticated = [...supervisor.matchAll(/fetch\([A-Z_]+_URL, \{([^}]*)/g)].filter((m) => !/headers:/.test(m[1]!));
ok('every supervisor request carries the token', unauthenticated.length === 0, `${unauthenticated.length} without`);

console.log('\n--- 4. Python reads the same token ---');
const candidates = [
  path.join(repo, '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python3'),
  process.platform === 'win32' ? 'python' : 'python3',
];
const probe = `
import os, sys
sys.path.insert(0, os.path.join(${JSON.stringify(repo)}, "memory"))
import types
sys.modules["sentence_transformers"] = types.ModuleType("sentence_transformers")
import vectorMemory
print("TOKEN_OK" if vectorMemory._token_ok(sys.argv[1]) else "TOKEN_BAD")
`;
let pythonChecked = false;
for (const py of candidates) {
  const run = spawnSync(py, ['-c', probe, token], {
    env: { ...process.env, JARVIS_DATA_ROOT: root, JARVIS_VECTOR_PERSIST: 'false', JARVIS_VECTOR_STORE_DIR: path.join(root, 'vec') },
    encoding: 'utf8', timeout: 60_000,
  });
  if (run.error || !/TOKEN_(OK|BAD)/.test(run.stdout ?? '')) continue;
  ok(`vectorMemory.py accepts JARVIS's token (${path.basename(py)})`, /TOKEN_OK/.test(run.stdout));
  const wrong = spawnSync(py, ['-c', probe, 'not-the-token'], {
    env: { ...process.env, JARVIS_DATA_ROOT: root, JARVIS_VECTOR_PERSIST: 'false', JARVIS_VECTOR_STORE_DIR: path.join(root, 'vec') },
    encoding: 'utf8', timeout: 60_000,
  });
  ok('…and refuses another', /TOKEN_BAD/.test(wrong.stdout ?? ''));
  pythonChecked = true;
  break;
}
if (!pythonChecked) console.log('  NOTE: no Python with fastapi and numpy here; the shared-token check across languages was not run.');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
