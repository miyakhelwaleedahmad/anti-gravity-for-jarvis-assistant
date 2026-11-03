"""Mutation check for phase A5c (TRA-10): each fault alone; kernelOutcomeA5cTest must fail.
A mutant may need several edits to bring back the old behaviour. Every file is
restored afterwards. Run from the repository root."""
import subprocess, pathlib, os
A = "control/appController.ts"; W = "control/windowController.ts"; B = "control/browserController.ts"
S = "control/systemController.ts"; P = "control/processController.ts"; F = "control/fileController.ts"; K = "control/pcControlKernel.ts"
MUTANTS = [
  ("M1 focusApp: no window returned as text", [(A, "      throw new Error(`No running window found for app \"${target}\".`);", "      return `No running window found for app \"${target}\".`;")]),
  ("M2 focusApp: permission refusal returned as text", [(A, "    if (!permissionSession.checkPermission(1, `Focus app ${target}`)) {\n      throw new Error('Permission denied.');", "    if (!permissionSession.checkPermission(1, `Focus app ${target}`)) {\n      return 'Permission denied.';")]),
  ("M3 focusWindow: an error caught and returned as text", [(W, "    const hwnd = await this.findHwnd(target);\n    return this.deps.automate(['-Action', 'control-window', '-ActionType', 'focus', '-Hwnd', hwnd]);",
     "    try {\n      const hwnd = await this.findHwnd(target);\n      return this.deps.automate(['-Action', 'control-window', '-ActionType', 'focus', '-Hwnd', hwnd]);\n    } catch (err) {\n      return err instanceof Error ? err.message : String(err);\n    }")]),
  ("M4 focusWindow: permission refusal returned as text", [(W, "    if (!permissionSession.checkPermission(1, `Focus window ${target}`)) {\n      throw new Error('Permission denied.');", "    if (!permissionSession.checkPermission(1, `Focus window ${target}`)) {\n      return 'Permission denied.';")]),
  ("M5 listTabs: permission refusal returned as text", [(B, "    if (!permissionSession.checkPermission(0, 'List browser tabs')) {\n      throw new Error('Permission denied.');", "    if (!permissionSession.checkPermission(0, 'List browser tabs')) {\n      return 'Permission denied.';")]),
  ("M6 listTabs: an unreadable list returned as text", [(B, "    const tabs = await this.fetchCDPTabs();\n    const pageTabs", "    const tabs = await this.fetchCDPTabs().catch((err) => { throw { text: err instanceof Error ? err.message : String(err) }; }).catch((e) => e.text as never);\n    if (typeof tabs === 'string') return tabs;\n    const pageTabs")]),
  ("M7 closeTab: a tab that is not open is a success (Q1)", [(B, "      throw new Error(`Tab matching \"${query}\" is not open, so nothing was closed.`);", "      return `Tab matching \"${query}\" is not open.`;")]),
  ("M8 system lists: PowerShell's exit code ignored (Q2)", [(S, "  if (r.exitCode !== 0) throw new Error(", "  if (Date.now() < 0) throw new Error(")]),
  ("M9 process list: a failed read is [] again (Q2)", [
     (P, "    if (r.exitCode !== 0 || !r.stdout.trim()) {", "    if (Date.now() < 0) {"),
     (P, "    } catch (err) {\n      throw new Error(`The process list could not be read: ${err instanceof Error ? err.message : String(err)}`);\n    }", "    } catch (err) {\n      return [];\n    }")]),
  ("M10 window list: not read is 'none' again (Q3)", [("perception/windowsState.ts", "  if (state.unavailable) throw new Error(`The open windows could not be read: ${state.unavailable}`);", "  void state.unavailable;")]),
  ("M11 PC state: not read is 'no windows' again (Q3)", [(K, "      if (win.unavailable) throw new Error(`The open windows could not be read: ${win.unavailable}`);\n", "")]),
  ("M12 readFile: the secret-file refusal returned as text", [(F, "        throw new Error(SECRET_FILE_REFUSAL);", "        return `Error reading file: ${SECRET_FILE_REFUSAL}`;")]),
  ("M13 readFile: a failed read returned as text", [(F, "      throw new Error(`Error reading file: ${err?.message ?? String(err)}`);", "      return `Error reading file: ${err?.message ?? String(err)}`;")]),
  ("M14 kernel: a controller's reported failure ignored", [(K, "      if (reported) throw new Error(reported);\n", "      void reported;\n")]),
  ("M15 kernel: a top-level error is not a failure (only success:false)", [(K, "  if (success === false) return why || 'The action reported a failure.';\n  return why || undefined;", "  if (success === false) return why || 'The action reported a failure.';\n  return undefined;")]),
  ("M16 kernel: a list is judged as a failure too", [(K, "  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;", "  if (!parsed || typeof parsed !== 'object') return undefined;\n  if (Array.isArray(parsed)) return parsed.find((x: any) => x?.error)?.error;")]),
  # Review round 1 (C2-C5)
  ("M17 get_pc_state returns the empty message on failure (C2)", [("skills/get_pc_state/skill.ts", "  return res.success ? res.message : JSON.stringify(res);", "  return res.message;")]),
  ("M18 readFile's own JSON judged as a report (C3)", [(K, "fileController.readFile(filePath), { passThrough: true });", "fileController.readFile(filePath));")]),
  ("M19 an unread window list is retried (C4)", [("control/actionQueue.ts", "const FINAL_FAILURE = /could not be read|", "const FINAL_FAILURE = /")]),
  ("M20 a tab that is not open is retried (C4)", [("control/actionQueue.ts", "|is not open, so nothing was closed|", "|")]),
  ("M21 focusApp takes 'not read' for 'no window' (C5)", [(A, "    const match = matchAppWindows(target, openAppsOrWhy(winState)).windows.find(hasHandle);", "    const match = matchAppWindows(target, winState.openApps).windows.find(hasHandle);")]),
  ("M22 closeApp takes 'not read' for 'no app' (C5)", [(A, "    const plan = planAppClose(target, openAppsOrWhy(winState));", "    const plan = planAppClose(target, winState.openApps);")]),
  ("M23 listApps takes 'not read' for 'no apps' (C5)", [(A, "    const apps = openAppsOrWhy(winState).map(", "    const apps = winState.openApps.map(")]),
  ("M24 window close by name takes 'not read' for 'not found' (C5)", [(W, "    const openApps = isHwnd(target) ? state.openApps : openAppsOrWhy(state);", "    const openApps = state.openApps;")]),
]
only = os.environ.get("MUT_ONLY")
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
caught = 0
for name, edits in MUTANTS:
    originals = {}
    applied = True
    for file, old, new in edits:
        p = pathlib.Path(file); text = originals.get(file, p.read_text())
        originals.setdefault(file, p.read_text())
        if text.count(old) != 1 and pathlib.Path(file).read_text().count(old) != 1:
            print(f"{name}: NOT APPLIED ({file}: {pathlib.Path(file).read_text().count(old)})", flush=True); applied = False; break
    if not applied:
        for file, text in originals.items(): pathlib.Path(file).write_text(text)
        continue
    try:
        for file, old, new in edits:
            p = pathlib.Path(file); p.write_text(p.read_text().replace(old, new))
        r = subprocess.run(["pnpm", "test", "--", "--only=kernelOutcomeA5cTest"], capture_output=True, text=True, timeout=600)
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        first = next((l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")), "")
    finally:
        for file, text in originals.items(): pathlib.Path(file).write_text(text)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {first[:170]}", flush=True)
print(f"\n{caught}/{len(MUTANTS)} caught")
