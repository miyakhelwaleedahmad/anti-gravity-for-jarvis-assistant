"""Mutation check for B4 R3-1: each fault alone; the named test must fail.
Every file is restored afterwards and checked by md5. Run from the repository root."""
import subprocess, pathlib, os, hashlib
S = "core/toolExecutionSandbox.ts"; G = "security/approvalGate.ts"; T = "approvalBudgetR31Test"
MUTANTS = [
  ("M1 no pause while the owner answers", T, [(S, "  call.pause();\n  try {\n    return await fn();", "  try {\n    return await fn();")]),
  ("M2 no resume after the answer", T, [(S, "  } finally {\n    call.resume();\n  }", "  } finally {\n  }")]),
  ("M3 resume with the full budget, not what was left", T, [(S, "      deadline = Date.now() + remaining;\n      timer = setTimeout(fire, remaining);", "      deadline = Date.now() + budget;\n      timer = setTimeout(fire, budget);")]),
  ("M4 no pause counter (restart after the first of two questions)", T, [(S, "      if (--pauses > 0) return;", "      pauses = 0;")]),
  ("M5 a resume after a cancellation restarts the budget", T, [(S, "      if (signal.aborted) return;\n      deadline", "      deadline")]),
  ("M6 the deadline not moved on resume (a second question counts stale time)", T, [(S, "      deadline = Date.now() + remaining;\n", "")]),
  ("M7 a question is not withdrawn when its call is stopped", T, [(G, "    else signal?.addEventListener('abort', onAbort, { once: true });", "")]),
  ("M8 a call already stopped is asked anyway", T, [(G, "    if (call?.signal.aborted) return this.cancelled(request);\n    return whileOwnerAnswers", "    return whileOwnerAnswers")]),
  ("M9 a call stopped while waiting its turn is still asked (box shown)", T, [(G, "        if (call?.signal.aborted) return this.cancelled(request);\n        return await this.ask", "        return await this.ask")]),
  ("M10 a stopped call keeps waiting its turn", T, [(G, "  if (!signal) return promise.then(() => undefined, () => undefined);", "  return promise.then(() => undefined, () => undefined);")]),
  ("M11 the turn passes on before the earlier question is done", T, [(G, "        void previous.then(release, release);", "        release();")]),
  ("M12 a yes as the call is stopped is taken", T, [(G, "    if (approved && signal?.aborted) return this.cancelled(request);\n", "")]),
  ("M13 a cancellation recorded as a timeout", T, [(G, "    this.record(request, { approved: false, by: 'cancelled' });", "    this.record(request, { approved: false, by: 'timeout' });")]),
  ("M14 a withdrawn spoken question is not handled", T, [(G, "    typed?.close();\n    if (answer === CANCELLED) throw new Error('APPROVAL_CANCELLED');", "    typed?.close();")]),
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
