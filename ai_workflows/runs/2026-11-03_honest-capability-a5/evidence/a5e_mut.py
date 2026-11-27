"""Mutation check for phase A5e (TRA-09): each fault alone; the named test must fail.
Every file is restored afterwards and checked by md5. Run from the repository root."""
import subprocess, pathlib, os, hashlib
CAT = "core/toolCatalog.ts"; CAP = "core/capabilities.ts"; REG = "core/toolRegistryV2.ts"
PL = "core/planningToolSelection.ts"; OR = "core/orchestrator.ts"; T = "capabilityA5eTest"
MUTANTS = [
  ("M1 control_window does not require Windows", T, [(CAT, "  control_window: withActions(\n    { requires: WINDOWS, ", "  control_window: withActions(\n    { ")]),
  ("M2 clipboard does not require Windows", T, [(CAT, "  clipboard: withActions(\n    { requires: WINDOWS, ", "  clipboard: withActions(\n    { ")]),
  ("M3 the requirement is never checked against the platform", T, [(CAP, "if (requires?.includes('windows') && capabilityHost.platform() !== 'win32') {", "if (Date.now() < 0) {")]),
  ("M4 the real platform, not the stand-in", T, [(CAP, "capabilityHost.platform() !== 'win32'", "process.platform !== 'win32'")]),
  ("M5 the planner offers tools that cannot run", T, [(PL, "if (toolRegistryV2.has(name) && !toolRegistryV2.unavailableBecause(name)) requested.add(name);", "if (toolRegistryV2.has(name)) requested.add(name);")]),
  ("M6 the registry runs tools that cannot run", T, [(REG, "    const unmet = this.unavailableBecause(name);\n    if (unmet) {", "    const unmet = this.unavailableBecause(name);\n    if (Date.now() < 0 && unmet) {")]),
  ("M7 the refusal is not final (another error code)", T, [(REG, "        output: `Refused by safety policy: ${unmet}.`,\n        error: 'RISK_REFUSED',", "        output: `Refused by safety policy: ${unmet}.`,\n        error: 'UNAVAILABLE',")]),
  ("M8 list_capabilities says every tool is available", T, [(REG, "        available: !unmet,", "        available: true,")]),
  ("M9 list_capabilities drops the reason", T, [(REG, "        ...(unmet ? { unavailableBecause: unmet } : {}),\n      });", "      });")]),
  ("M10 the old fallback (shell and launch)", T, [(PL, "addIfRegistered('list_capabilities', 'web_search', 'get_system_info');", "addIfRegistered('open_app', 'web_search', 'get_system_info', 'run_command');")]),
  ("M11 the fallback without the capability list", T, [(PL, "addIfRegistered('list_capabilities', 'web_search', 'get_system_info');", "addIfRegistered('web_search', 'get_system_info');")]),
  ("M12 'minimise' not understood", T, [(PL, "exit|minimi[sz]e|maximi[sz]e)\\b/i.test(clean);", "exit|minimize|maximize)\\b/i.test(clean);")]),
  ("M13 a dry run said as 'Opening' (Q3)", T, [(OR, "reply = opened?.['dryRun'] === true || firstNode.args?.['dryRun'] === true\n", "reply = Date.now() < 0\n")]),
  ("M14 an unchecked open said as 'Opening' (Q3)", T, [(OR, "          : firstNode.verification?.status === 'unverifiable'\n            ? `I started ${name}", "          : Date.now() < 0\n            ? `I started ${name}")]),
  ("M16 the refusal not worded as a refusal (retried, 'unexpected error')", T, [(REG, "        output: `Refused by safety policy: ${unmet}.`,", "        output: `Not available here: ${unmet}.`,")]),
  # Review round 1 (E1, E7)
  ("M17 questions about recent changes not given git_overview (E1)", T, [(PL, "  if (GIT_QUESTION.test(clean) || CHANGES_QUESTION.test(clean) || (PROJECT_WORDS", "  if (GIT_QUESTION.test(clean) || (PROJECT_WORDS")]),
  ("M18 the check moved after the approval step (E7)", T, [
     (REG, "    const unmet = this.unavailableBecause(name);\n    if (unmet) {", "    const unmet = this.unavailableBecause(name);\n    if (Date.now() < 0 && unmet) {"),
     (REG, "    // 3b. Risk engine (docs/upgrade/PERMISSION_MODEL.md): run, ask, or refuse", "    if (unmet) {\n      const { approvalGate } = await import('../security/approvalGate.js');\n      await approvalGate.requestApproval('capability', name, 'HIGH_RISK', unmet, 'text');\n      return { success: false, output: `Refused by safety policy: ${unmet}.`, error: 'RISK_REFUSED', tool: name, durationMs: Date.now() - start };\n    }\n    // 3b. Risk engine (docs/upgrade/PERMISSION_MODEL.md): run, ask, or refuse")]),
  # The owner's PC check C (2026-11-06)
  ("M19 the PC phrase 'what change in my project' not understood (both rules back)", T, [(PL, "chang(?:e|ed|es) in (?:my|the|this)", "changed in (?:my|the|this)"), (PL, " || (PROJECT_WORDS.test(clean) && CHANGE_WORDS.test(clean))) {", ") {")]),
  ("M20 the project + change-word rule removed (review E15)", T, [(PL, " || (PROJECT_WORDS.test(clean) && CHANGE_WORDS.test(clean))) {", ") {")]),
  ("M15 the route fixture's old fallback", "routeGoldenTest", [(PL, "addIfRegistered('list_capabilities', 'web_search', 'get_system_info');", "addIfRegistered('open_app', 'web_search', 'get_system_info', 'run_command');")]),
]
only = os.environ.get("MUT_ONLY")
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
files = sorted({e[0] for _, _, es in MUTANTS for e in es})
md5 = lambda f: hashlib.md5(pathlib.Path(f).read_bytes()).hexdigest()
before = {f: md5(f) for f in files}
caught = 0
for name, test, edits in MUTANTS:
    originals = {f: pathlib.Path(f).read_text() for f, _, _ in edits}
    bad = [(f, pathlib.Path(f).read_text().count(o)) for f, o, _ in edits if pathlib.Path(f).read_text().count(o) != 1]
    if bad:
        print(f"{name}: NOT APPLIED {bad}", flush=True); continue
    try:
        for f, o, n in edits:
            p = pathlib.Path(f); p.write_text(p.read_text().replace(o, n))
        r = subprocess.run(["pnpm", "test", "--", f"--only={test}"], capture_output=True, text=True, timeout=600,
                           env={**os.environ, "JARVIS_CHROME_AUTOSTART": "off"})
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        first = next((l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")), "")
    finally:
        for f, text in originals.items(): pathlib.Path(f).write_text(text)
    caught += not passed
    print(f"{name} [{test}]: {'CAUGHT' if not passed else 'MISSED'} | {first[:170]}", flush=True)
after = {f: md5(f) for f in files}
print(f"\n{caught}/{len(MUTANTS)} caught")
print("tree restored (md5):", "YES" if before == after else f"NO {[(f, before[f], after[f]) for f in files if before[f] != after[f]]}")
