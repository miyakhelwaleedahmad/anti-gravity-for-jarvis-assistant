"""Check of the selfCheckTest fix (Windows CI, run 42033994044): each change alone.
"fail" cases must make selfCheckTest fail (the read-only check still sees a real change);
"pass" cases must leave it passing (it no longer depends on the clock).
Every file is restored and checked by md5. Run from the repository root."""
import subprocess, pathlib, os, hashlib
SC = "core/selfCheck.ts"; T = "tests/selfCheckTest.ts"
HEAD = "export async function repairReport(deps: SelfCheckDeps = {}): Promise<SelfCheckReport> {\n"
CASES = [
  ("C1 PowerShell answers after 1.5 s (as a real start on Windows)", "pass",
   [(T, "powershell: async () => ({ ok: true as const, version: '5.1 (stand-in)' })", "powershell: () => new Promise<{ ok: true; version: string }>((r) => setTimeout(() => r({ ok: true, version: '5.1 (stand-in)' }), 1500))")]),
  ("M1 the repair report records a ledger outcome", "fail",
   [(SC, HEAD, HEAD + "  healthLedger.record(LEDGER_PIPELINES.tools, true, 'self-check ran (mutant)');\n")]),
  ("M2 the repair report records an issue", "fail",
   [(SC, HEAD, HEAD + "  issueStore.recordOccurrence({ component: 'self-check', tool: 'self_check', message: 'mutant' });\n")]),
  ("M3 the full self-check starts the real PowerShell again (stand-in dropped)", "fail-on-windows-only",
   [(T, "const fastHost = { platform: () => 'win32' as NodeJS.Platform, powershell: async () => ({ ok: true as const, version: '5.1 (stand-in)' }), chrome: async () => ({}) };", "const fastHost = {};")]),
]
files = sorted({e[0] for _, _, es in CASES for e in es})
md5 = lambda f: hashlib.md5(pathlib.Path(f).read_bytes()).hexdigest()
before = {f: md5(f) for f in files}
good = 0
for name, expect, edits in CASES:
    originals = {f: pathlib.Path(f).read_text() for f, _, _ in edits}
    bad = [(f, pathlib.Path(f).read_text().count(o)) for f, o, _ in edits if pathlib.Path(f).read_text().count(o) != 1]
    if bad:
        print(f"{name}: NOT APPLIED {bad}", flush=True); continue
    try:
        for f, o, n in edits:
            p = pathlib.Path(f); p.write_text(p.read_text().replace(o, n))
        r = subprocess.run(["pnpm", "test", "--", "--only=selfCheckTest"], capture_output=True, text=True, timeout=600,
                           env={**os.environ, "JARVIS_CHROME_AUTOSTART": "off"})
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        first = " / ".join(l.strip() for l in out.splitlines() if "❌" in l)
    finally:
        for f, text in originals.items(): pathlib.Path(f).write_text(text)
    if expect == "pass": ok = passed
    elif expect == "fail": ok = not passed
    else: ok = True  # off Windows nothing is started; recorded only
    good += ok
    print(f"{name}: expected {expect}, test {'PASSED' if passed else 'FAILED'} -> {'OK' if ok else 'WRONG'} | {first[:150]}", flush=True)
after = {f: md5(f) for f in files}
print(f"\n{good}/{len(CASES)} as expected")
print("tree restored (md5):", "YES" if before == after else "NO")
