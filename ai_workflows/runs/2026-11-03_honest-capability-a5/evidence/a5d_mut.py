"""Mutation check for phase A5d (TRA-19): each fault alone; the named test must fail.
Every file is restored afterwards and checked by md5. Run from the repository root."""
import subprocess, pathlib, os, hashlib
SK = "skills/automation/skill.ts"; PO = "security/openAppPolicy.ts"; OR = "core/orchestrator.ts"
T = "openAppHonestA5dTest"
GATE = ("  if (dryRun) {\n    return JSON.stringify({\n      success: true,",
        "  if (openAppDeps.platform() !== 'win32' && windowsOnlyTarget(resolved.resolvedTarget)) return JSON.stringify({ success: false, error: 'needs Windows' });\n  if (dryRun) {\n    return JSON.stringify({\n      success: true,")
MUTANTS = [
  ("M1 launcher exit code ignored", T, [(SK, "code === 0 || code === null\n        ? { success: true }", "true\n        ? { success: true }")]),
  ("M2 success after 50 ms again", T, [(SK, "const LAUNCHER_WAIT_MS = 3_000;", "const LAUNCHER_WAIT_MS = 50;")]),
  ("M3 launcher start failure not caught", T, [(SK, "proc.on('error', (err: Error) => answer({ success: false, error: err.message }));", "proc.on('error', () => undefined);")]),
  ("M4 still-running wait not bounded (30 s)", T, [(SK, "const LAUNCHER_WAIT_MS = 3_000;", "const LAUNCHER_WAIT_MS = 30_000;")]),
  ("M5 off-Windows gate removed (Q2)", T, [(SK, "if (openAppDeps.platform() !== 'win32' && windowsOnlyTarget(", "if (false && windowsOnlyTarget(")]),
  ("M6 gate also refuses a dry run", T, [(SK, GATE[0], GATE[1])]),
  ("M7 Settings pages not Windows-only", T, [(PO, "/^(ms-settings|shell):/i", "/^(shell):/i")]),
  ("M8 .exe not Windows-only", T, [(PO, "/\\.exe$/i.test(resolvedTarget) || ", "")]),
  ("M9 gate reads the real platform", T, [(SK, "if (openAppDeps.platform() !== 'win32' && windowsOnlyTarget(", "if (process.platform !== 'win32' && windowsOnlyTarget(")]),
  ("M10 route: unverifiable said as 'Opening' (Q1)", T, [(OR, "result.verification?.status === 'unverifiable' ?", "false ?")]),
  ("M11 route: every success said as unverifiable", T, [(OR, "result.verification?.status === 'unverifiable' ?", "true ?")]),
  ("M12 spawn bound at load (patched child_process missed)", T, [(SK, "spawn: ((cmd: string, args: string[], options: Record<string, unknown>) => spawn(cmd, args, { ...options, env: childEnv() } as any)) as", "spawn: spawn as unknown as")]),
  ("M13 launcher wrapper drops the filtered environment (SEC-101)", "childEnvCoverageTest", [(SK, "spawn(cmd, args, { ...options, env: childEnv() } as any)) as", "spawn(cmd, args, options as any)) as")]),
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
