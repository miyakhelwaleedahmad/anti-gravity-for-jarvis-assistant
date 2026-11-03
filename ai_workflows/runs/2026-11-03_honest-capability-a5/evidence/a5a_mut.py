"""Mutation check for phase A5a (TRA-07): each fault alone; honestReadToolsA5aTest must fail.
Every file is restored afterwards. Run from the repository root."""
import subprocess, pathlib, os
W = "perception/windowsState.ts"; O = "perception/systemStateObserver.ts"; T = "perception/readTools.ts"; ORCH = "core/orchestrator.ts"
MUTANTS = [
  ("M1 a failed window read is a silent empty result again", W,
   "    return unavailableResult(String(err?.message ?? err));", "    return { activeWindow: { title: '', processName: '', pid: 0 }, openApps: [] };"),
  ("M2 the observer does not keep why the read failed", O,
   "        this.state.windowsUnavailable = windowsData.unavailable;\n", ""),
  ("M3 get_open_apps ignores an unread list", "skills/get_open_apps/skill.ts",
   "  return windowsFailure(state) ?? JSON.stringify(state.openApps, null, 2);", "  return JSON.stringify(state.openApps, null, 2);"),
  ("M4 is_app_open ignores an unread list", "skills/is_app_open/skill.ts",
   "  if (unread) return unread;\n", ""),
  ("M5 get_active_window ignores an unread list", "skills/get_active_window/skill.ts",
   "  return windowsFailure(state) ?? JSON.stringify(state.activeWindow, null, 2);", "  return JSON.stringify(state.activeWindow, null, 2);"),
  ("M6 Chrome not running is 'no tabs'", T,
   "  if (running) return { port: running.port };\n", "  if (running) return { port: running.port };\n  if (Date.now() > 0) return { port: 1 };\n"),
  ("M7 a tab list that fails is 'no tabs'", T,
   "  } catch (err) {\n    return { failure: unreadable(err) };\n  }\n}\n\n/**\n * The tabs of JARVIS's Chrome now, with the one on screen",
   "  } catch (err) {\n    return { tabs: [] };\n  }\n}\n\n/**\n * The tabs of JARVIS's Chrome now, with the one on screen"),
  ("M8 is_tab_open reads the snapshot again", "skills/is_tab_open/skill.ts",
   "  const read = await liveTabList();\n  if ('failure' in read) return read.failure;\n\n  const found = read.tabs.some((tab) =>",
   "  const { systemStateObserver } = await import('../../perception/systemStateObserver.js');\n  const found = (systemStateObserver.getState().chrome?.tabs ?? []).some((tab: any) =>"),
  # Review round 1
  ("M12 is_tab_open reads per-tab details, touching every page (R2, R3)", "skills/is_tab_open/skill.ts",
   "  const read = await liveTabList();", "  const { liveTabs } = await import('../../perception/readTools.js');\n  const read = await liveTabs();"),
  ("M13 get_browser_tabs leaves out tabs beyond 20 (R2)", T,
   "    return { tabs: [...tabs, ...rest] };", "    return { tabs: [...tabs] }; void rest;"),
  ("M14 JARVIS_CDP_PORT not named when nothing answers on it (R6)", T,
   "  if (Number.isInteger(fixed) && fixed > 0 && fixed < 65536) {", "  if (Number.isInteger(fixed) && fixed > 0 && fixed < 65536 && Date.now() < 0) {"),
  ("M15 the planner's world state shows an unread list as 'none' (R4)", "core/worldState.ts",
   "        if (typeof d?.unavailable === 'string' && d.unavailable) return", "        if (Date.now() < 0) return"),
  ("M9 route is_tab_open says 'No' when Chrome was not read", ORCH,
   "          this.speak(result?.success\n            ? (result.output === 'true'", "          this.speak(true\n            ? (result?.output === 'true'"),
  ("M10 route whats_running lists no apps when the windows were not read", ORCH,
   "          this.speak(apps?.success\n            ? runningSummary(", "          this.speak(true\n            ? runningSummary("),
  ("M11 route get_browser_tabs falls back to the snapshot", ORCH,
   "          const result = await runRoutedTool('get_browser_tabs', {});\n          const tabs = result?.success ? parseJson(result.output) : null;",
   "          const result = await runRoutedTool('get_browser_tabs', {});\n          const tabs = result?.success ? parseJson(result.output) : ((await import('../perception/systemStateObserver.js')).systemStateObserver.getState().chrome?.tabs ?? []);"),
]
only = os.environ.get("MUT_ONLY")
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
caught = 0
for name, file, old, new in MUTANTS:
    p = pathlib.Path(file); original = p.read_text()
    if original.count(old) != 1:
        print(f"{name}: NOT APPLIED ({original.count(old)})", flush=True); continue
    try:
        p.write_text(original.replace(old, new))
        r = subprocess.run(["pnpm", "test", "--", "--only=honestReadToolsA5aTest"], capture_output=True, text=True, timeout=600)
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        first = next((l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")), "")
    finally:
        p.write_text(original)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {first[:170]}", flush=True)
print(f"\n{caught}/{len(MUTANTS)} caught")
