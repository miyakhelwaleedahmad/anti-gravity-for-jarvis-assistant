// Reproduces the Windows CI failure of timeQuestionsNpc10Test (run 41450761455) on any OS,
// and shows the pathToFileURL form. Writes child scripts into the folder given as argv[2].
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
const [dir, repoRoot] = [process.argv[2], process.argv[3]];
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const run = (label, specifier) => {
  const probe = path.join(dir, `${label}.mts`);
  fs.writeFileSync(probe, `import { matchDeterministicCommand } from ${JSON.stringify(specifier)};\nconsole.log(JSON.stringify([matchDeterministicCommand('what time is it')?.reply]));\n`);
  const r = spawnSync(process.execPath, [tsx, probe], { encoding: 'utf8', timeout: 120_000 });
  const err = (r.stderr.match(/Error \[[A-Z_]+\][^\n]*/) ?? [''])[0];
  const out = r.stdout.trim().split('\n').filter((l) => l.startsWith('["')).pop() ?? '';
  console.log(`${label}\n  specifier: ${specifier}\n  exit=${r.status} stdout=${out || '(none)'}${err ? `\n  ${err.slice(0, 160)}` : ''}`);
};
const real = path.join(repoRoot, 'core', 'deterministicRoutes.ts');
// 1. What the test wrote on Windows: path.join gives a drive-letter path, e.g. D:\a\...\core\deterministicRoutes.ts
run('1-windows-style-plain-path', 'D:\\a\\anti-gravity-for-jarvis-assistant\\core\\deterministicRoutes.ts');
// 2. The same file address as Windows' pathToFileURL makes it (file:///D:/a/...): accepted as a file URL
console.log(`2-windows-pathToFileURL (format only)\n  ${pathToFileURL('D:\\a\\anti-gravity-for-jarvis-assistant\\core\\deterministicRoutes.ts', { windows: true }).href}`);
// 3. On this machine: plain path (works on Linux, which is why Linux CI passed) and pathToFileURL (the fix)
run('3a-this-os-plain-path', real);
run('3b-this-os-pathToFileURL', pathToFileURL(real).href);
