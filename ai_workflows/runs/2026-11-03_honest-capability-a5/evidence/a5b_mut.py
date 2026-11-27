"""Mutation check for phase A5b (TRA-08, B3): each fault alone; the named test must fail.
Every file is restored afterwards and checked by md5. Run from the repository root."""
import subprocess, pathlib, os, hashlib
SC = "core/selfCheck.ts"; HM = "monitoring/healthManager.ts"; T = "selfCheckA5bTest"
MUTANTS = [
  ("M1 tools item not relabelled", T, [(SC, "if (s.pipeline === LEDGER_PIPELINES.tools) {", "if (Date.now() < 0) {")]),
  ("M2 tools item without the disclaimer", T, [(SC, " s ago; not a check of what the tools can do`", " s ago`")]),
  ("M3 Redis fallback flag ignored (Q1)", T, [(SC, "  if (s.fallback) return { name: `service ${s.name}`, state: 'NOT_VERIFIED',", "  if (Date.now() < 0) return { name: `service ${s.name}`, state: 'NOT_VERIFIED',")]),
  ("M4 the real service list drops the flag", T, [(SC, ", ...(s.fallback ? { fallback: true } : {}) }));", " }));")]),
  ("M5 the probe does not mark the fallback", T, [(HM, "(p.state === 'fallback' ? { fallback: true } : { latencyMs: p.latencyMs })", "(p.state === 'fallback' ? {} : { latencyMs: p.latencyMs })")]),
  ("M6 a probe that throws is 'online' again", T, [(HM, "        status: 'degraded',\n        latencyMs: Date.now() - start,", "        status: 'online',\n        latencyMs: Date.now() - start,")]),
  ("M7 Chrome running not verified", T, [(SC, "if (c.running) return { name: CHROME_ITEM, state: 'VERIFIED'", "if (c.running) return { name: CHROME_ITEM, state: 'NOT_VERIFIED'")]),
  ("M8 Chrome not running is failing (Q2)", T, [(SC, "if (c.installedPath) return { name: CHROME_ITEM, state: 'NOT_VERIFIED'", "if (c.installedPath) return { name: CHROME_ITEM, state: 'FAILING'")]),
  ("M9 JARVIS_CDP_PORT not answering ignored", T, [(SC, "    if (c.fixedPort) return", "    if (Date.now() < 0) return")]),
  ("M10 Chrome check failure not failing", T, [(SC, "    return { name: CHROME_ITEM, state: 'FAILING', detail: `the check failed:", "    return { name: CHROME_ITEM, state: 'NOT_VERIFIED', detail: `the check failed:")]),
  ("M11 Chrome and PowerShell in every self-check (Q3)", T, [
     (SC, "    // Chrome and PowerShell in the full self-check only (phase A5b, owner Q3).\n    items.push(...await Promise.all([chromeItem(deps), powershellItem(deps)]));\n  }\n", "  }\n  items.push(...await Promise.all([chromeItem(deps), powershellItem(deps)]));\n")]),
  ("M12 PowerShell asked off Windows", T, [(SC, "  if (platform !== 'win32') return { name: POWERSHELL_ITEM, state: 'BLOCKED',", "  if (Date.now() < 0) return { name: POWERSHELL_ITEM, state: 'BLOCKED',")]),
  ("M13 PowerShell not answering is verified", T, [(SC, "    return { name: POWERSHELL_ITEM, state: 'FAILING', detail: `PowerShell did not answer", "    return { name: POWERSHELL_ITEM, state: 'VERIFIED', detail: `PowerShell did not answer")]),
  ("M14 permission not spoken", T, [(SC, "${issuesSentence(issues)} Permission: ${permission.said}.`;", "${issuesSentence(issues)}`;")]),
  ("M15 full-control minutes counted as seconds", T, [(SC, "Math.round(p.remainingSeconds / 60)", "Math.round(p.remainingSeconds)")]),
  ("M16 an unreadable level said as safe control", T, [(SC, "    return { said: 'not read', problem:", "    return { said: 'level 1, safe control', problem:")]),
  ("M17 the real Chrome check starts Chrome", T, [(SC, "  const running = await jarvisChrome.running();", "  const running = { port: await jarvisChrome.ensure() };")]),
  ("M18 the real PowerShell check without the filtered environment (SEC-101)", "childEnvCoverageTest", [(SC, "{ timeout: POWERSHELL_WAIT_MS, windowsHide: true, env: childEnv() },", "{ timeout: POWERSHELL_WAIT_MS, windowsHide: true },")]),
  # Review round 1 (B1-B8)
  ("M20 autostart off said as 'starts when needed' (B1)", T, [(SC, "    if (c.installedPath && c.autostartOff) return", "    if (Date.now() < 0) return")]),
  ("M21 the real check ignores JARVIS_CHROME_AUTOSTART (B1)", T, [(SC, "/^(off|0|false|no)$/i.test(process.env['JARVIS_CHROME_AUTOSTART']?.trim() ?? '') ? { autostartOff: true } : {}", "{}")]),
  ("M22 tools detail says 'working' again (B2)", T, [(SC, "detail = s.state === 'healthy' && s.last\n", "detail = Date.now() < 0 && s.last\n")]),
  ("M23 why stuck says 'tools' (B6)", T, [(SC, "failing.map((f) => pipelineName(f.pipeline))", "failing.map((f) => ledgerLabel(f.pipeline))")]),
  ("M24 slow PowerShell said as cannot work (B3)", T, [(SC, "    if (r.slow) return { name: POWERSHELL_ITEM, state: 'NOT_VERIFIED',", "    if (Date.now() < 0) return { name: POWERSHELL_ITEM, state: 'NOT_VERIFIED',")]),
  ("M25 under a minute said as N min (B8)", T, [(SC, "p.remainingSeconds < 60 ? 'full control, less than 1 min left'", "p.remainingSeconds < 0 ? 'full control, less than 1 min left'")]),
  ("M26 nested brackets in the item names (B8)", T, [(SC, "const POWERSHELL_ITEM = 'PowerShell for desktop control';", "const POWERSHELL_ITEM = 'PowerShell (desktop control)';")]),
  ("M19 the 'checked only for whether they answer' line removed", T, [(SC, "      'Chrome and PowerShell are checked only for whether they answer, not for every action that uses them.',\n", "")]),
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
