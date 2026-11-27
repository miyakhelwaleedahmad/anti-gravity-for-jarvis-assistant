"""Mutation check for the B4 R3-1 review round-2 fixes (S1, S2): each fault alone; the named test must fail.
Every file is restored afterwards and checked by md5. Run from the repository root.
Round 1 mutants: r31_mut.py (M1-M14); round 2: r31_mut_round2.py (N1-N10); this file: P1-P7."""
import subprocess, pathlib, os, hashlib
G = "security/approvalGate.ts"; T = "approvalBudgetR31Test"
MUTANTS = [
  ("P1 S1 the setting read as before (NaN possible)", T, [(G, "  const v = value === undefined || value.trim() === '' ? NaN : Number(value);\n  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_ANSWER_GRACE_MS;", "  return Number(value ?? DEFAULT_ANSWER_GRACE_MS);")]),
  ("P2 S1 infinite values accepted", T, [(G, "  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_ANSWER_GRACE_MS;", "  return !Number.isNaN(v) && v >= 0 ? v : DEFAULT_ANSWER_GRACE_MS;")]),
  ("P3 S1 negative values accepted", T, [(G, "  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_ANSWER_GRACE_MS;", "  return Number.isFinite(v) ? v : DEFAULT_ANSWER_GRACE_MS;")]),
  ("P4 S1 an empty setting taken as 0", T, [(G, "  const v = value === undefined || value.trim() === '' ? NaN : Number(value);", "  const v = value === undefined ? NaN : Number(value);")]),
  ("P5 S2 the withdrawal measured on the system clock", T, [(G, "          if (value === CANCELLED) this.withdrawnAt = performance.now();", "          if (value === CANCELLED) this.withdrawnAt = Date.now();"), (G, "this.withdrawnAt + ANSWER_GRACE_MS - performance.now()));", "this.withdrawnAt + ANSWER_GRACE_MS - Date.now()));")]),
  ("P6 S2 no upper limit on the grace", T, [(G, "    const afterWithdrawal = Math.min(ANSWER_GRACE_MS, Math.max(0, this.withdrawnAt + ANSWER_GRACE_MS - performance.now()));", "    const afterWithdrawal = Math.max(0, this.withdrawnAt + ANSWER_GRACE_MS - performance.now());")]),
  ("P7 S2 no lower limit on the grace", T, [(G, "    const afterWithdrawal = Math.min(ANSWER_GRACE_MS, Math.max(0, this.withdrawnAt + ANSWER_GRACE_MS - performance.now()));", "    const afterWithdrawal = Math.min(ANSWER_GRACE_MS, this.withdrawnAt + ANSWER_GRACE_MS - performance.now());")]),
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
