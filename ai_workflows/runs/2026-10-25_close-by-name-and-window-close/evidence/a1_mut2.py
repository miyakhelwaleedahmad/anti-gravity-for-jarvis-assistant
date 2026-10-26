#!/usr/bin/env python3
"""Phase A1 mutation run, round 2 (after review round 1): one fault per run in a copy of the fixed tree; each file restored from its saved bytes and compared."""
import subprocess, sys, pathlib, re
MUT = {
  'M1_exe_not_stripped': ('control/appMatch.ts', "return name.toLowerCase().trim().replace(/\\.exe$/, '');", "return name.toLowerCase().trim();"),
  'M2_no_exact_preference': ('control/appMatch.ts', "if (exact.length > 0) return { by: 'program', windows: exact };", ""),
  'M3_no_browser_page_rule': ('control/appMatch.ts', "if (others.length === 0) return { kind: 'browser-page', browser: browserName(browserWindow!.name)! };\n  return { kind: 'close', windows: others, exact: match.by === 'program' };", "return { kind: 'close', windows: match.windows, exact: match.by === 'program' };"),
  'M4_no_browser_program_rule': ('control/appMatch.ts', "if (match.by !== 'title' && browserWindow) return { kind: 'browser', browser: browserName(browserWindow.name)! };", ""),
  'M5_no_several_question': ('control/appController.ts', "if ((windows.length > 1 || !plan.exact) && !isProtected && !protectedWindow) {", "if (false) {"),
  'M6_handle_filter_dropped': ('control/appController.ts', "const windows = plan.windows.filter(hasHandle);", "const windows = plan.windows as Array<{ hwnd: string; windowTitle: string; name: string }>;"),
  'M7_window_browser_guard_dropped': ('control/windowController.ts', "      if (plan.kind === 'browser') throw new Error(browserCloseRefusal(plan.browser));\n      if (plan.kind === 'browser-page') throw new Error(browserPageRefusal(target, plan.browser));\n      // The window", "      // The window"),
  'M8_kill_exit_code_ignored': ('control/processController.ts', "if (stopped.exitCode !== 0) {", "if (false) {"),
  'M9_kill_still_running_ignored': ('control/processController.ts', "if (answer === 'gone') break;", "break;"),
  'M10_kill_browser_allowed': ('control/processController.ts', "if (browser) throw new Error(browserCloseRefusal(browser));", ""),
  'M11_kill_first_match': ('control/processController.ts', "matches.find((p) => programKey(p.name) === wanted) ?? matches[0]!", "matches[0]!"),
  'M12_planner_tab_rule_dropped': ('core/planningToolSelection.ts', "const isTabClose = /\\b(close|kill|exit)\\b/.test(clean) && /\\btabs?\\b/.test(clean);", "const isTabClose = false;"),
  'R1_window_handle_from_any_match': ('control/windowController.ts', "const chosen = plan.kind === 'close' ? plan.windows.find(hasHandle) : undefined;", "const chosen = matchAppWindows(target, openApps).windows.find(hasHandle);"),
  'R2_question_inside_scope': ('control/appController.ts', "await withoutApproval(() => this.deps.approve('Close Several Windows',", "await (async (f: () => Promise<boolean>) => f())(() => this.deps.approve('Close Several Windows',"),
  'R3_restart_first_match': ('control/processController.ts', "const name = chooseProcess(matches, target).name;", "const name = matches[0]!.name;"),
  'R4_tab_rule_any_verb': ('core/planningToolSelection.ts', "/\\b(close|kill|exit)\\b/.test(clean) && /\\btabs?\\b/.test(clean)", "isKillOrClose && /\\btabs?\\b/.test(clean)"),
  'R5_no_answer_is_gone': ('control/processController.ts', "if (answer !== 'running') {", "if (answer === '') break;\n      if (answer !== 'running') {"),
  'R6_empty_guard_dropped': ('control/appMatch.ts', "if (!program) return { by: 'none', windows: [] };", ""),
  'R7_check_ignores_handles': ('core/verifiers.ts', "if (closed.length > 0) {", "if (false) {"),
  'R8_arc_not_browser': ('control/appMatch.ts', "arc: 'Arc', ", ""),
  'R9_browser_handle_allowed': ('control/windowController.ts', "const browser = currentWindow ? undefined :", "const browser = true ? undefined :"),
  'R10_partial_any_count': ('control/appMatch.ts', "new Set(partial.map((w) => programKey(w.name))).size === 1", "true"),
  'R11_matched_protection_dropped': ('control/appController.ts', "const protectedWindow = !isProtected && windows.some(", "const protectedWindow = false && windows.some("),
  'R12_zero_handles_success': ('control/appController.ts', "if (windows.length === 0) {\n      throw new Error(`No window of \"${target}\" can be closed: the window list gave none a handle.`);\n    }", ""),
  'R13_find_keeps_exe': ('control/processController.ts', "const lower = programKey(target);", "const lower = target.toLowerCase().trim();"),
  'R10b_title_stage_matches_programs': ('control/appMatch.ts', "(known && matcher.test(w.name))", "matcher.test(w.name)"),
  'R2_1_owner_from_app_list': ('control/windowController.ts', "owner = (await this.deps.allWindows()).find((w) => sameHandle(w.hwnd, hwnd));", "owner = openApps.find((w) => sameHandle(w.hwnd, hwnd)) ?? { name: '', pid: 0, windowTitle: '', hwnd };"),
  'R2_2_restart_start_error_raw': ('control/processController.ts', "throw new Error(`Ended ${chosen.name}, but could not start it again: ${err instanceof Error ? err.message : String(err)}`);", "throw err;"),
  'R2_3_handle_parse_first': ('core/verifiers.ts', "/\(windows ([^)]*)\)\.?\s*$/", "/\(windows ([^)]*)\)/"),
  'R2_4_protected_in_scope': ('control/appController.ts', "await withoutApproval(() => this.deps.approve('Close Protected App',", "await (async (f: () => Promise<boolean>) => f())(() => this.deps.approve('Close Protected App',"),
  'R2_5_calculator_asks': ('control/appMatch.ts', "if (byTitle.length > 0 && known) return { by: 'program', windows: byTitle };", ""),
  'R2_8_restart_rechooses': ('control/processController.ts', "await this.terminate(chosen);", "await this.terminate(chooseProcess(await this.findProcess(target), target + '+'));"),
  'R3_1_2_any_title_is_the_app': ('control/appMatch.ts', "const own = hosts ? byTitle.filter((w) => hosts.includes(programKey(w.name))) : [];", "const own = hosts ? byTitle : [];"),
  'R3_3_protection_from_app_list': ('control/windowController.ts', "    const match = owner;\n", "    const match = openApps.find((app) => app.hwnd === hwnd);\n"),
  'R3_4_always_read_all_windows': ('control/windowController.ts', "      owner = openApps.find((w) => sameHandle(w.hwnd, hwnd));\n      if (!currentWindow && !owner) {", "      owner = undefined;\n      if (!currentWindow && !owner) {"),
  'R4_1a_cmd_matches_terminal': ('control/appMatch.ts', "cmd: /command prompt|^cmd$/i, 'command prompt': /command prompt|^cmd$/i,", "cmd: /command prompt|^cmd$|windowsterminal/i, 'command prompt': /command prompt|^cmd$|windowsterminal/i,"),
  'R4_1b_terminal_title_dropped': ('control/appMatch.ts', "{ program: 'windowsterminal', title: /command prompt|cmd\\.exe/i },", "{ program: 'windowsterminal' },"),
  'R4_1c_protected_in_scope': ('control/appController.ts', "await withoutApproval(() => this.deps.approve('Close Protected App',", "await (async (f: () => Promise<boolean>) => f())(() => this.deps.approve('Close Protected App',"),
  'R4_2_frame_host_any_title': ('control/appMatch.ts', "{ program: 'applicationframehost', title: /^calculator$/i }", "{ program: 'applicationframehost' }"),
  'R4_3_host_stage_dropped': ('control/appMatch.ts', "const own = hosts ? windows.filter((w) => isAppItself(hosts, w)) : [];", "const own: AppWindow[] = [];"),
  'R4_4_no_active_fallback': ('control/windowController.ts', "?? (active ? { name: active.processName, pid: 0, windowTitle: active.title, hwnd } : undefined);", ";"),
  'R5_1_window_question_in_scope': ('control/windowController.ts', "await withoutApproval(() => this.deps.approve('Close Protected Window',", "await (async (f: () => Promise<boolean>) => f())(() => this.deps.approve('Close Protected Window',"),
  'R5_2_no_windows_terminal_alias': ('control/appMatch.ts', "  'windows terminal': 'windowsterminal',\n", ""),
  'O1_current_browser_no_question': ('control/windowController.ts', "      if (browser) {\n        // \"close current window\" alone", "      if (false) {\n        // \"close current window\" alone"),
  'O2_current_browser_question_in_scope': ('control/windowController.ts', "await withoutApproval(() => this.deps.approve('Close Browser Window',", "await (async (f: () => Promise<boolean>) => f())(() => this.deps.approve('Close Browser Window',"),
  'O3_current_browser_refused_outright': ('control/windowController.ts', "if (browser && !currentWindow) throw new Error(browserCloseRefusal(browser));", "if (browser) throw new Error(browserCloseRefusal(browser));"),
  'R7_1_unknown_owner_closes': ('control/windowController.ts', "      if (browser || !owner?.name) {", "      if (browser) {"),
  'R7_1b_no_full_list_for_front': ('control/windowController.ts', "      if (!owner?.name) {\n        // Not a main window", "      if (!currentWindow && !owner?.name) {\n        // Not a main window"),
  'R7_2_long_title_kept': ('control/windowController.ts', "return t.length > 40 ? `${t.slice(0, 39)}…` : t;", "return t;"),
  'R14_refusals_retried': ('control/actionQueue.ts', "|through app, window or process control|is a page open in|still running after Stop-Process|Could not terminate|could not confirm it ended/i;", "/i;"),
}
export, tests = sys.argv[1], sys.argv[2]
names = sys.argv[3:] or ['none', *MUT]
for name in names:
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
