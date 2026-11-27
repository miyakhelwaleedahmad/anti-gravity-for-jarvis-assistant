"""Mutation check for the B4 R3-1 review round-1 fixes (F2, F3, F5, F7, F8): each fault alone;
the named test must fail. Every file is restored afterwards and checked by md5. Run from the repository root.
The round-1 mutants (M1-M14) are in r31_mut.py; this file adds N1-N10 for the new safeguards."""
import subprocess, pathlib, os, hashlib
S = "core/toolExecutionSandbox.ts"; G = "security/approvalGate.ts"; T = "approvalBudgetR31Test"
MUTANTS = [
  ("N1 F2 no grace after a withdrawal", T, [(G, "    const afterWithdrawal = Math.max(0, this.withdrawnAt + ANSWER_GRACE_MS - now);", "    const afterWithdrawal = 0;")]),
  ("N2 F2 the withdrawal time is not kept", T, [(G, "          if (value === CANCELLED) this.withdrawnAt = Date.now();\n", "")]),
  ("N3 F2 the deadline is not moved by the grace (window shortened)", T, [(G, "        pending.expiresAt = listeningFrom + timeoutMs + afterWithdrawal;", "        pending.expiresAt = listeningFrom + timeoutMs;")]),
  ("N4 F2 the grace applies to every question (normal behaviour changed)", T, [(G, "    const grace = Math.max(request.goalId ? ANSWER_GRACE_MS : 0, afterWithdrawal);", "    const grace = ANSWER_GRACE_MS;")]),
  ("N5 F3 an ended call is still the current call", T, [(S, "  return call && !call.ended ? call : undefined;", "  return call;")]),
  ("N6 F3 a call is never marked ended", T, [(S, "      ended = true;\n      clock.end();", "      clock.end();")]),
  ("N7 F5 the budget clock uses the system clock", T, [(S, "  let deadline = performance.now() + budget;", "  let deadline = Date.now() + budget;"), (S, "Math.max(0, deadline - performance.now()));", "Math.max(0, deadline - Date.now()));"), (S, "      deadline = performance.now() + remaining;", "      deadline = Date.now() + remaining;")]),
  ("N8 F5 no upper limit on the remaining time", T, [(S, "        remaining = Math.min(budget, Math.max(0, deadline - performance.now()));", "        remaining = Math.max(0, deadline - performance.now());")]),
  ("N9 F7 a withdrawn spoken question is still said", T, [(G, "    if (!pending.isSettled()) nodeBridge.speakToClients(", "    nodeBridge.speakToClients(")]),
  ("N10 F8 no budget left at the pause: the budget does not end", T, [(S, "        if (remaining === 0) fire();\n", "")]),
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
