/**
 * tests/childEnvCoverageTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-101: every program JARVIS starts gets the filtered environment.
 *
 * SEC-06 added system/childEnv.ts, but only some call sites used it. The
 * voice services (tts.py, stt.py, wakeWords.py, screen_capture.py), the app
 * and settings openers, the process restarter, the Explorer "reveal", the
 * Windows observer's PowerShell and several PowerShell/tasklist queries were
 * started with all of process.env: every provider key and token in .env.
 * execa merges process.env back in unless told not to (extendEnv: false).
 *
 *   1. Every child-process call in JARVIS's source passes env (and execa calls
 *      also extendEnv: false), and none spreads process.env. scripts/ is left
 *      out: those are the owner's own command-line tools, and
 *      superviseJarvis.ts starts JARVIS itself.
 *   2. Real child processes report the names they can see:
 *      - a voice service started by selfHealingManager (a stand-in script that
 *        prints its environment): no key, but the bridge token it needs and its
 *        own settings (JARVIS_TTS_*, TTS_VOICE);
 *      - the app opener (Linux/macOS: a stand-in xdg-open/open on PATH).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SECRETS: Record<string, string> = {
  GEMINI_API_KEY: 'test-secret-gemini',
  GROQ_API_KEY: 'test-secret-groq',
  SERPER_API_KEY: 'test-secret-serper',
  JARVIS_A2A_TOKEN: 'test-secret-a2a',
  JARVIS_VECTOR_TOKEN: 'test-secret-vector',
  GITHUB_TOKEN: 'test-secret-github',
  DB_PASSWORD: 'test-secret-db',
};
Object.assign(process.env, SECRETS, {
  JARVIS_BRIDGE_TOKEN: 'test-bridge-token',
  JARVIS_TTS_RATE: '+5%',
  TTS_VOICE: 'en-GB-RyanNeural',
});

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const names = (out: string): string[] => { const m = /ENV:(\[.*?\]):END/s.exec(out); return m ? JSON.parse(m[1]!) : []; };
const leaked = (keys: string[]) => keys.filter((k) => k in SECRETS);

console.log('\n=== Every child process gets the filtered environment (SEC-101) ===\n');

// ── 1. The source ────────────────────────────────────────────────────────────
console.log('--- 1. Child-process calls in the source ---');
const SKIP = new Set(['node_modules', 'dist', '_legacy', 'tests', 'scripts', '.git', 'data', 'logs', 'scratchpad']);
const CALL = /(?<![\w.$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync)\s*\(/g;

/** The text between the call's parentheses (strings skipped when counting). */
function argsOf(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

const offenders: string[] = [];
let calls = 0;
(function walk(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); continue; }
    if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue;
    const file = path.join(dir, e.name);
    // Comments blanked (newlines kept, so line numbers hold): "one-shot spawn (…)" is prose.
    const src = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (c, pre: string) => pre + ' '.repeat(c.length - pre.length));
    if (!/['"](?:node:)?child_process['"]|['"]execa['"]/.test(src)) continue;
    const rel = path.relative(repo, file).split(path.sep).join('/');
    for (const m of src.matchAll(CALL)) {
      const before = src.slice(Math.max(0, m.index! - 9), m.index!);
      if (/(async|function)\s+$/.test(before)) continue;   // a method named spawn/exec
      calls++;
      const args = argsOf(src, m.index! + m[0].length - 1);
      const line = src.slice(0, m.index!).split('\n').length;
      const problems: string[] = [];
      if (!/\benv\s*:/.test(args)) problems.push('no env');
      if (/\.\.\.\s*process\.env\b/.test(args)) problems.push('spreads process.env');
      if (m[1]!.startsWith('execa') && !/extendEnv\s*:\s*false/.test(args)) problems.push('execa without extendEnv: false');
      if (problems.length) offenders.push(`${rel}:${line} ${m[1]} (${problems.join(', ')})`);
    }
  }
})(repo);
ok('(setup) child-process calls found', calls > 15, `${calls}`);
ok('every one passes the filtered environment', offenders.length === 0, offenders.join('; '));

// ── 2. Real child processes ──────────────────────────────────────────────────
console.log('\n--- 2. Real child processes ---');
const { selfHealingManager } = await import('../self_healing/selfHealingManager.js');
let out = '';
const write = process.stdout.write.bind(process.stdout);
(process.stdout as unknown as { write: (s: unknown, ...r: unknown[]) => boolean }).write = (s: unknown, ...r: unknown[]) => {
  if (String(s).startsWith('[EnvProbe]')) { out += String(s); return true; }
  return write(s as string, ...(r as []));
};
selfHealingManager.launchPythonService('../tests/fixtures/print_env.py', 'EnvProbe');
const deadline = Date.now() + 20_000;
while (!/:END/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
(process.stdout as unknown as { write: typeof write }).write = write;
let keys = names(out);
ok('(setup) a voice service started and reported its environment', keys.length > 0, out.trim().slice(0, 160) || 'no output in 20 s (is Python installed?)');
ok('the voice service sees no provider key or other token', keys.length > 0 && leaked(keys).length === 0, leaked(keys).join(',') || `${keys.length} names`);
ok('…but has the bridge token it connects with', keys.includes('JARVIS_BRIDGE_TOKEN'));
ok('…and its own settings (JARVIS_TTS_RATE, TTS_VOICE) and PATH', keys.includes('JARVIS_TTS_RATE') && keys.includes('TTS_VOICE') && keys.some((k) => k.toLowerCase() === 'path'));

if (process.platform === 'win32') {
  console.log('  (the app opener runs cmd.exe start on Windows, which a test cannot stand in for; part 1 covers it)');
} else {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-opener-'));
  const dump = path.join(bin, 'env.txt');
  for (const name of ['xdg-open', 'open']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nenv | cut -d= -f1 > "${dump}"\n`, { mode: 0o755 });
  }
  process.env['PATH'] = `${bin}${path.delimiter}${process.env['PATH']}`;
  const { appController } = await import('../control/appController.js');
  try { await appController.openApp('https://example.com'); } catch (e) { console.log(`  (openApp: ${(e as Error).message})`); }
  const until = Date.now() + 10_000;
  while (!fs.existsSync(dump) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  keys = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean) : [];
  ok('(setup) the app opener ran', keys.length > 0);
  ok('the app opener sees no key or token', keys.length > 0 && leaked(keys).length === 0 && !keys.includes('JARVIS_BRIDGE_TOKEN'),
    [...leaked(keys), ...(keys.includes('JARVIS_BRIDGE_TOKEN') ? ['JARVIS_BRIDGE_TOKEN'] : [])].join(',') || `${keys.length} names`);
  try { fs.rmSync(bin, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
