/**
 * tests/windowsScriptsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 14 — JARVIS's own PowerShell files, checked with a real PowerShell 7
 * (pwsh; JARVIS_TEST_PWSH names it when it is not on PATH):
 *
 *  1. Each parses without errors, and uses nothing Windows PowerShell 5.1
 *     lacks (??, ?., ternaries, && and || between commands).
 *  2. Run off Windows, each answers with one line of JSON — an unknown
 *     section or action, a handle or reference that is not a number, and a
 *     section name with a command tacked on are all refused, never run.
 *
 * What the scripts read on Windows is checked by pnpm verify:windows.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { findPwsh } from './chromeHelper.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pwsh = findPwsh();
if (!pwsh) {
  console.error('No PowerShell 7 (pwsh) found: set JARVIS_TEST_PWSH.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const FILES = ['perception/windows_probe.ps1', 'control/desktop.ps1', 'control/uia.ps1'];
const PS7_ONLY = ['QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr', 'QuestionMark'];

function run(file: string, env: Record<string, string>): any {
  const r = spawnSync(pwsh!, ['-NoProfile', '-NonInteractive', '-File', path.join(repo, file)], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env },
  });
  const line = String(r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  try { return line ? JSON.parse(line) : { unparsed: r.stdout + r.stderr }; } catch { return { unparsed: line }; }
}

console.log('\n=== Windows Scripts Test ===\n');
console.log(`(${pwsh})`);

console.log('--- 1. They parse, for Windows PowerShell 5.1 too ---');
for (const file of FILES) {
  const script = `
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($env:JARVIS_TEST_FILE, [ref]$tokens, [ref]$errors)
    $bad = @($tokens | Where-Object { $_.Kind -in @(${PS7_ONLY.map((k) => `'${k}'`).join(',')}) } | ForEach-Object { '{0}@{1}' -f $_.Kind, $_.Extent.StartLineNumber })
    ConvertTo-Json -Compress -InputObject @{ errors = @($errors | ForEach-Object { '{0}: {1}' -f $_.Extent.StartLineNumber, $_.Message }); ps7 = $bad }`;
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, JARVIS_TEST_FILE: path.join(repo, file) },
  });
  let parsed: { errors?: string[]; ps7?: string[] } = {};
  try { parsed = JSON.parse(String(r.stdout).trim()); } catch { /* reported below */ }
  ok(`${file}: no parse errors`, Array.isArray(parsed.errors) && parsed.errors.length === 0, (parsed.errors ?? [String(r.stdout + r.stderr).slice(0, 200)]).join('; '));
  // Only meaningful for a file that was read and parsed.
  ok(`${file}: nothing only PowerShell 7 understands`, Array.isArray(parsed.errors) && parsed.errors.length === 0
    && Array.isArray(parsed.ps7) && parsed.ps7.length === 0, (parsed.ps7 ?? []).join(' '));
}
for (const file of FILES) {
  // Windows PowerShell 5.1 reads a script without a byte-order mark in the
  // local code page: plain ASCII reads the same either way.
  ok(`${file}: plain ASCII`, [...fs.readFileSync(path.join(repo, file))].every((b) => b < 0x80));
}

console.log('\n--- 2. Run here, they refuse what is not theirs, as one line of JSON ---');
let out = run('perception/windows_probe.ps1', { JARVIS_PROBE_SECTION: 'nonsense' });
ok('probe: an unknown section → "unknown section"', out.ok === false && out.error === 'unknown section', JSON.stringify(out));
out = run('perception/windows_probe.ps1', { JARVIS_PROBE_SECTION: 'gpu; Remove-Item -Recurse $HOME' });
ok('probe: a section with a command tacked on is just an unknown section', out.ok === false && out.error === 'unknown section', JSON.stringify(out));
out = run('perception/windows_probe.ps1', { JARVIS_PROBE_SECTION: 'window_state', JARVIS_PROBE_HWND: '12; calc' });
ok('probe: a window handle that is not a number is refused', out.ok === false && /not a number/.test(out.error), JSON.stringify(out));
out = run('perception/windows_probe.ps1', { JARVIS_PROBE_SECTION: 'ports' });
ok('probe: a Windows-only reading off Windows is an error in JSON, not a crash', out.ok === false && typeof out.error === 'string' && out.section === 'ports', JSON.stringify(out).slice(0, 160));
out = run('control/desktop.ps1', { JARVIS_DESKTOP_ACTION: 'format_disk' });
ok('desktop: an unknown action → "unknown action"', out.ok === false && out.error === 'unknown action', JSON.stringify(out));
out = run('control/desktop.ps1', { JARVIS_DESKTOP_ACTION: 'clipboard_write', JARVIS_DESKTOP_FILE: path.join(repo, 'no-such-file.txt') });
ok('desktop: clipboard text only from the file JARVIS wrote; a missing file is refused', out.ok === false && /file with the text is missing/.test(out.error), JSON.stringify(out));
out = run('control/desktop.ps1', { JARVIS_DESKTOP_ACTION: 'screenshot', JARVIS_DESKTOP_FILE: path.join(repo, 'shot.exe') });
ok('desktop: a screenshot is written only as .png', out.ok === false && /No PNG file/.test(out.error) && !fs.existsSync(path.join(repo, 'shot.exe')), JSON.stringify(out));
out = run('control/uia.ps1', { JARVIS_UIA_ACTION: 'list' });
ok('uia: off Windows, an error in JSON (no UI Automation here)', out.ok === false && typeof out.error === 'string' && out.action === 'list', JSON.stringify(out).slice(0, 160));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
