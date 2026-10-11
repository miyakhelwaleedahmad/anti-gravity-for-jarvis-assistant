/**
 * tests/secretFileTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-14: a file named for what it holds ("github my persnal tokens.txt", in
 * an approved folder) was not recognised as a secret: read_file returned its
 * text to the model, document indexing could store it, and control_file only
 * caught names ending in ".env". Redaction catches known key formats only.
 *
 *   1. names: secrets recognised by whole words, ordinary files not
 *   2. read_file, files compare, control_file read, document indexing and
 *      browser upload refuse such a file, and its text appears in no result
 *   3. ordinary files are read as before
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-secret-files-'));
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const { isSecretFile } = await import('../security/secretFiles.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { fileController } = await import('../control/fileController.js');
const { parseFile } = await import('../rag/parse.js');
const { uploadPathProblem } = await import('../security/browserPolicy.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Files named for keys and passwords (SEC-14) ===\n');

console.log('--- 1. Names ---');
const SECRET = [
  'ai_workflows/_config/github my persnal tokens.txt', 'passwords.csv', 'api_keys.json', 'API Key.txt', 'my-secret.txt',
  'recovery codes.txt', 'Seed Phrase.txt', 'credentials.md', 'C:\\Users\\me\\Desktop\\bank password.txt', '.env', '.env.local', 'id_rsa', 'server.pem',
];
const ORDINARY = ['tokenizer.py', 'password-reset.ts', 'seed.json', 'notes.txt', 'README.md', 'token-usage.ts', 'secretary-meeting.txt', 'keyboard.md', 'passport-photo.jpg'];
for (const n of SECRET) ok(`secret: ${n}`, isSecretFile(n));
for (const n of ORDINARY) ok(`ordinary: ${n}`, !isSecretFile(n));

console.log('\n--- 2. Refused everywhere ---');
const VALUE = 'not-a-real-value-7f3k9q';
const config = path.join(workspace, 'ai_workflows', '_config');
fs.mkdirSync(config, { recursive: true });
const tokenFile = path.join(config, 'github my persnal tokens.txt');
fs.writeFileSync(tokenFile, `github: ${VALUE}\n`);
const notes = path.join(workspace, 'notes.txt');
fs.writeFileSync(notes, 'buy milk\n');

registerAllTools();
const read = await toolRegistryV2.execute('read_file', { filePath: tokenFile });
ok('read_file refuses it', /does not read, index or send files that hold keys/.test(read.output), read.output.slice(0, 90));
ok('…and its text is in no result', !read.output.includes(VALUE));

const compare = await toolRegistryV2.execute('files', { action: 'compare', path: tokenFile, other: notes });
ok('files compare refuses it (a diff shows contents)', !compare.success && !compare.output.includes(VALUE), compare.output.slice(0, 90));

const viaController = await fileController.readFile(tokenFile);
ok('control_file read refuses it', /does not read/.test(viaController) && !viaController.includes(VALUE), viaController.slice(0, 90));

const parsed = parseFile(tokenFile);
ok('document indexing skips it', !parsed.ok && !(parsed.text ?? '').includes(VALUE), parsed.reason);

ok('browser upload refuses it', /does not upload keys/.test(uploadPathProblem(tokenFile) ?? ''), uploadPathProblem(tokenFile));

const env = path.join(workspace, '.env');
fs.writeFileSync(env, `SOME_SETTING=${VALUE}\n`);
const envRead = await toolRegistryV2.execute('read_file', { filePath: env });
ok('read_file refuses .env too', !envRead.output.includes(VALUE), envRead.output.slice(0, 80));

console.log('\n--- 3. Ordinary files ---');
const plain = await toolRegistryV2.execute('read_file', { filePath: notes });
ok('read_file reads notes.txt', plain.success && plain.output.includes('buy milk'), plain.output.slice(0, 40));
ok('control_file reads it', (await fileController.readFile(notes)).includes('buy milk'));
ok('indexing accepts it', parseFile(notes).ok === true);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
