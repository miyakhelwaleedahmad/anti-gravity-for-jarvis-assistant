"""Mutation check for the B4 R3-1 review round-3 fixes (T1, T2, T5): each fault alone; the R3-1 test must fail.
Every file is restored afterwards and checked by md5. Run from the repository root.
Earlier rounds: r31_mut.py (M1-M14), r31_mut_round2.py (N1-N10), r31_mut_round3.py (P1-P7); this file: Q1-Q5."""
import subprocess, pathlib, os, hashlib
G = "security/approvalGate.ts"; T = "tests/approvalBudgetR31Test.ts"; TEST = "approvalBudgetR31Test"
MUTANTS = [
  ("Q1 T1 the F5 questions start inside the withdrawal grace again (test fault)", {}, [(T, "    await pastWithdrawalGrace();\n    // F5:", "    // F5:")]),
  ("Q2 T2 no upper limit on the setting", {}, [(G, "Number.isFinite(v) && v >= 0 && v <= MAX_ANSWER_GRACE_MS ? v", "Number.isFinite(v) && v >= 0 ? v")]),
  ("Q3 T2 exactly 60 000 rejected (off by one)", {}, [(G, "v >= 0 && v <= MAX_ANSWER_GRACE_MS ? v", "v >= 0 && v < MAX_ANSWER_GRACE_MS ? v")]),
  ("Q4 T2 the limit set at Node's timer maximum", {}, [(G, "const MAX_ANSWER_GRACE_MS = 60_000;", "const MAX_ANSWER_GRACE_MS = 2_147_483_647;")]),
  ("Q5 T5 the shell's setting is not removed (shell has JARVIS_APPROVAL_GRACE_MS=5000)", {"JARVIS_APPROVAL_GRACE_MS": "5000"}, [(T, "delete process.env['JARVIS_APPROVAL_GRACE_MS'];", "void 0;")]),
]
only = os.environ.get("MUT_ONLY")
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
files = sorted({e[0] for _, _, es in MUTANTS for e in es})
md5 = lambda f: hashlib.md5(pathlib.Path(f).read_bytes()).hexdigest()
before = {f: md5(f) for f in files}
caught = 0
for name, extra_env, edits in MUTANTS:
    originals = {f: pathlib.Path(f).read_text() for f, _, _ in edits}
    bad = [(f, pathlib.Path(f).read_text().count(o)) for f, o, _ in edits if pathlib.Path(f).read_text().count(o) != 1]
    if bad:
        print(f"{name}: NOT APPLIED {bad}", flush=True); continue
    try:
        for f, o, n in edits:
            p = pathlib.Path(f); p.write_text(p.read_text().replace(o, n))
        r = subprocess.run(["pnpm", "test", "--", f"--only={TEST}"], capture_output=True, text=True, timeout=900,
                           env={**os.environ, "JARVIS_CHROME_AUTOSTART": "off", **extra_env})
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        fails = [l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")]
    finally:
        for f, text in originals.items(): pathlib.Path(f).write_text(text)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {len(fails)} failing check(s); first: {(fails[0] if fails else '')[:200]}", flush=True)
after = {f: md5(f) for f in files}
print(f"\n{caught}/{len(MUTANTS)} caught")
print("tree restored (md5):", "YES" if before == after else f"NO {[(f, before[f], after[f]) for f in files if before[f] != after[f]]}")
