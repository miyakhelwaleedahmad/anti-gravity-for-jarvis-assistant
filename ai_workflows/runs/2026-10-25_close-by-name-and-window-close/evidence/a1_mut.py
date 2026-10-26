#!/usr/bin/env python3
"""Phase A1 mutation run: one fault per run in a copy of the fixed tree; the file is restored from its saved text and compared."""
import subprocess, sys, pathlib, re
MUT = {
  'M1_exe_not_stripped': ('control/appMatch.ts', "return name.toLowerCase().trim().replace(/\\.exe$/, '');", "return name.toLowerCase().trim();"),
  'M2_no_exact_preference': ('control/appMatch.ts', "const byProgram = exact.length > 0 ? exact :", "const byProgram ="),
  'M3_no_browser_page_rule': ('control/appMatch.ts', "if (others.length === 0) return { kind: 'browser-page', browser: browserName(browserWindow!.name)! };\n  return { kind: 'close', windows: others };", "return { kind: 'close', windows: match.windows };"),
  'M4_no_browser_program_rule': ('control/appMatch.ts', "if (match.by === 'program' && browserWindow) return { kind: 'browser', browser: browserName(browserWindow.name)! };", ""),
  'M5_no_several_question': ('control/appController.ts', "if (windows.length > 1 && !isProtected) {", "if (false) {"),
  'M6_handle_filter_dropped': ('control/appController.ts', "const windows = plan.windows.filter(hasHandle);", "const windows = plan.windows as Array<{ hwnd: string; windowTitle: string }>;"),
  'M7_window_browser_guard_dropped': ('control/windowController.ts', "    if (!isHwnd(target)) {\n      const plan", "    if (false) {\n      const plan"),
  'M8_kill_exit_code_ignored': ('control/processController.ts', "if (stopped.exitCode !== 0) {", "if (false) {"),
  'M9_kill_still_running_ignored': ('control/processController.ts', "if (check.stdout.trim() === '') break;", "break;"),
  'M10_kill_browser_allowed': ('control/processController.ts', "if (browser) throw new Error(browserCloseRefusal(browser));", ""),
  'M11_kill_first_match': ('control/processController.ts', "matches.find((p) => programKey(p.name) === wanted) ?? matches[0]!", "matches[0]!"),
  'M12_planner_tab_rule_dropped': ('core/planningToolSelection.ts', "const isTabRequest = /\\btabs?\\b/.test(clean);", "const isTabRequest = false;"),
}
export, tests = sys.argv[1], sys.argv[2]
for name in sys.argv[3:]:
    target = None
    if name != 'none':
        rel, old, new = MUT[name]
        target = pathlib.Path(export, rel); saved = target.read_bytes(); src = saved.decode()
        n = src.count(old); assert n == 1, f'{name}: anchor found {n} times'
        target.write_text(src.replace(old, new))
    try:
        out = subprocess.run(['pnpm', 'test', '--', f'--only={tests}'], cwd=export, capture_output=True, text=True, timeout=1500).stdout
    finally:
        if target is not None:
            target.write_bytes(saved); assert target.read_bytes() == saved
    summary = next((l.strip() for l in out.splitlines() if l.startswith('=== ') and 'passed' in l), '?')
    failing = [l.split()[1] for l in out.splitlines() if re.match(r'^\s+(FAIL|TIMEOUT)\s', l)]
    print(f'{name:34} {summary}  failing: {", ".join(failing) or "-"}', flush=True)
