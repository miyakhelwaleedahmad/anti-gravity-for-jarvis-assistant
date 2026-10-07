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

// The Win32 code each script compiles with Add-Type -MemberDefinition (a
// literal, or a variable set to one): compiled here by PowerShell's own
// Add-Type, so a mistake in it shows up before it reaches a Windows PC.
const COMPILE = `
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:JARVIS_TEST_FILE, [ref]$tokens, [ref]$errors)
  $assigned = @{}
  foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
    $right = $a.Right
    if ($a.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $right -is [System.Management.Automation.Language.CommandExpressionAst] -and $right.Expression -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
      $assigned[$a.Left.VariablePath.UserPath] = $right.Expression.Value
    }
  }
  $defs = New-Object System.Collections.ArrayList
  foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type' }, $true)) {
    for ($i = 0; $i -lt $c.CommandElements.Count - 1; $i++) {
      $e = $c.CommandElements[$i]
      if ($e -is [System.Management.Automation.Language.CommandParameterAst] -and $e.ParameterName -eq 'MemberDefinition') {
        $v = $c.CommandElements[$i + 1]
        if ($v -is [System.Management.Automation.Language.StringConstantExpressionAst]) { [void]$defs.Add($v.Value) }
        elseif ($v -is [System.Management.Automation.Language.VariableExpressionAst]) { [void]$defs.Add($assigned[$v.VariablePath.UserPath]) }
        else { [void]$defs.Add($null) }
      }
    }
  }
  $failures = @()
  $n = 0
  foreach ($d in $defs) {
    $n++
    try {
      if (-not $d) { throw 'not a literal' }
      Add-Type -Namespace ('JarvisCompile' + $n) -Name ('T' + $n) -MemberDefinition $d -ErrorAction Stop
    } catch { $failures += ('#' + $n + ': ' + ([string]$_.Exception.Message).Split([char]10)[0]) }
  }
  ConvertTo-Json -Compress -InputObject @{ count = $defs.Count; failures = @($failures) }`;
let compiled = 0;
for (const file of FILES) {
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', COMPILE], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, JARVIS_TEST_FILE: path.join(repo, file) },
  });
  let parsed: { count?: number; failures?: string[] } = {};
  try { parsed = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop() ?? ''); } catch { /* reported below */ }
  compiled += parsed.count ?? 0;
  ok(`${file}: its Win32 code compiles`, typeof parsed.count === 'number' && (parsed.failures ?? []).length === 0,
    `${parsed.count ?? '?'} block(s)${(parsed.failures ?? []).length ? `; ${(parsed.failures ?? []).join('; ')}` : ''}${typeof parsed.count === 'number' ? '' : `; ${String(r.stdout + r.stderr).slice(0, 200)}`}`);
}
ok('all five Win32 blocks were found and compiled (probe 3, desktop 1, uia 1)', compiled === 5, `${compiled}`);

// uia.ps1's own listing, given a stand-in window: stand-in UI Automation
// types compiled here (none exist off Windows), then the script's functions
// dot-sourced (its own run stops at once: no UI Automation here). One child
// cannot be read, another's children cannot be read: both must be reported,
// and the rest still listed. On the owner's PC such errors were hidden.
const LISTING = `
  $ErrorActionPreference = 'Stop'
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
namespace System.Windows.Automation {
  public class ControlType { public string ProgrammaticName { get; set; } }
  public class AutomationPattern { public string ProgrammaticName { get; set; } }
  public class ValuePattern { public static AutomationPattern Pattern = new AutomationPattern(); }
  public class FakeInfo {
    public string Name { get; set; }
    public string AutomationId { get; set; }
    public string ClassName { get; set; }
    public bool IsEnabled { get; set; }
    public bool HasKeyboardFocus { get; set; }
    public bool IsPassword { get; set; }
    public bool IsOffscreen { get; set; }
    public ControlType ControlType { get; set; }
  }
  public class FakeElement {
    public FakeInfo Info;
    public bool Unreadable;
    public bool ChildrenFail;
    public int[] Id;
    public FakeElement Parent;
    public List<FakeElement> Children = new List<FakeElement>();
    public FakeInfo Current { get { return Info; } }
    // As UI Automation does for an element that has gone: its methods throw.
    public AutomationPattern[] GetSupportedPatterns() {
      if (Unreadable) throw new InvalidOperationException("The element is not available.");
      return new AutomationPattern[0];
    }
    public int[] GetRuntimeId() { return Id; }
    public static FakeElement Make(string type, string name, int id) {
      var e = new FakeElement();
      e.Info = new FakeInfo { Name = name, IsEnabled = true, ControlType = new ControlType { ProgrammaticName = "ControlType." + type } };
      e.Id = new int[] { 42, id };
      return e;
    }
    public FakeElement Add(FakeElement child) { child.Parent = this; Children.Add(child); return child; }
  }
  public class TreeWalker {
    public static TreeWalker ControlViewWalker = new TreeWalker();
    public FakeElement GetFirstChild(FakeElement e) {
      if (e.ChildrenFail) throw new TimeoutException("The operation timed out.");
      return e.Children.Count > 0 ? e.Children[0] : null;
    }
    public FakeElement GetNextSibling(FakeElement e) {
      if (e.Parent == null) return null;
      int i = e.Parent.Children.IndexOf(e);
      return i + 1 < e.Parent.Children.Count ? e.Parent.Children[i + 1] : null;
    }
  }
}
'@
  $null = . $env:JARVIS_TEST_FILE
  $root = [System.Windows.Automation.FakeElement]::Make('Window', 'Test window', 1)
  $busy = $root.Add([System.Windows.Automation.FakeElement]::Make('Pane', 'Busy pane', 2))
  $busy.ChildrenFail = $true
  [void]$busy.Add([System.Windows.Automation.FakeElement]::Make('Button', 'Hidden', 5))
  $gone = $root.Add([System.Windows.Automation.FakeElement]::Make('Pane', 'Gone', 3))
  $gone.Unreadable = $true
  [void]$root.Add([System.Windows.Automation.FakeElement]::Make('Button', 'OK', 4))
  $result = Get-Elements $root
  $helpers = $null
  if (Get-Command Register-ClassicControlHelpers -ErrorAction SilentlyContinue) { $helpers = Register-ClassicControlHelpers }
  'RESULT ' + (ConvertTo-Json -Compress -Depth 4 -InputObject @{
    types = @($result.elements | ForEach-Object { $_.type }); more = [bool]$result.more
    reported = [bool]$result.ContainsKey('problems'); problems = @($result.problems); helpers = $helpers
  })`;
{
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', LISTING], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, JARVIS_TEST_FILE: path.join(repo, 'control/uia.ps1') },
  });
  const line = String(r.stdout).split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  let got: { types?: string[]; more?: boolean; reported?: boolean; problems?: string[]; helpers?: string | null } = {};
  try { got = line ? JSON.parse(line.slice(7)) : {}; } catch { /* reported below */ }
  const problems = got.problems ?? [];
  ok('uia.ps1 listing: the readable elements are still listed (window, busy pane, OK)', JSON.stringify(got.types) === '["Window","Pane","Button"]' && got.more === false,
    line ? JSON.stringify(got.types) : String(r.stdout + r.stderr).slice(0, 300));
  ok('uia.ps1 listing: an element it could not read is reported, not left out silently',
    got.reported === true && problems.some((p) => /depth 1/.test(p) && /not available/.test(p)), problems.join(' | '));
  ok('uia.ps1 listing: children it could not read are reported, with what they belong to',
    problems.some((p) => /children of the Pane at depth 1/.test(p) && /timed out/.test(p)) && problems.length === 2, problems.join(' | '));
  ok('uia.ps1: registering the helpers for classic controls says why it could not (no UI Automation here), and does not stop the script',
    typeof got.helpers === 'string' && /^not registered: /.test(got.helpers), String(got.helpers));
}

// uia.ps1's registration of those helpers, given a stand-in for the library
// whose own one-time attempt throws first (as it can on the owner's PC): a
// second call must register them, two failures are reported with the reason,
// and a library type that is missing is reported without stopping the script.
function registering(withProviders: boolean, failFirst: number[]): { results: Array<{ result: string; calls: number }>; out: string } {
  const script = `
  $ErrorActionPreference = 'Stop'
  Add-Type -TypeDefinition @'
${withProviders ? 'namespace UIAutomationClientsideProviders { public static class UIAutomationClientSideProviders { } }' : ''}
namespace System.Windows.Automation {
  public static class ClientSettings {
    public static int Calls;
    public static int FailFirst;
    public static void RegisterClientSideProviderAssembly(System.Reflection.AssemblyName name) {
      Calls++;
      if (Calls <= FailFirst) throw new System.InvalidOperationException("The default helpers could not be loaded.");
    }
  }
}
'@
  # No UI Automation library here to add: adding it does nothing.
  function Add-Type { }
  $null = . $env:JARVIS_TEST_FILE
  $results = @(foreach ($n in @(${failFirst.join(',')})) {
    [System.Windows.Automation.ClientSettings]::Calls = 0
    [System.Windows.Automation.ClientSettings]::FailFirst = $n
    $result = Register-ClassicControlHelpers
    @{ result = [string]$result; calls = [System.Windows.Automation.ClientSettings]::Calls }
  })
  'RESULT ' + (ConvertTo-Json -Compress -Depth 3 -InputObject $results)`;
  const r = spawnSync(pwsh!, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, JARVIS_TEST_FILE: path.join(repo, 'control/uia.ps1') },
  });
  const out = String(r.stdout ?? '') + String(r.stderr ?? '');
  const line = String(r.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  try { return { results: line ? [JSON.parse(line.slice(7))].flat() : [], out }; } catch { return { results: [], out }; }
}
{
  const { results, out } = registering(true, [0, 1, 2]);
  const show = results.length ? JSON.stringify(results) : out.slice(0, 300);
  ok('uia.ps1: the helpers are registered at the first call when nothing fails',
    results[0]?.result === 'registered' && results[0]?.calls === 1, show);
  ok('uia.ps1: when the library\'s own first attempt throws, the second call registers the helpers',
    results[1]?.result === 'registered' && results[1]?.calls === 2, show);
  ok('uia.ps1: when both calls fail, it stops after two and says why',
    results[2]?.calls === 2 && /^not registered: .*could not be loaded/.test(results[2]?.result ?? ''), show);
  const missing = registering(false, [0]);
  ok('uia.ps1: a library type that is missing is reported, and the script goes on',
    missing.results[0]?.calls === 0 && /^not registered: /.test(missing.results[0]?.result ?? ''),
    missing.results.length ? JSON.stringify(missing.results) : missing.out.slice(0, 300));
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
