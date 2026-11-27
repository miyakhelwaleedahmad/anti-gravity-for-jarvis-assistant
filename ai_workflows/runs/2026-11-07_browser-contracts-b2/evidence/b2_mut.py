"""Mutation check for phase B2 (browser contracts 2, 5, 6): each fault alone; the named test must fail.
Every file is restored afterwards and checked by md5. Run from the repository root."""
import subprocess, pathlib, os, hashlib
P = "perception/cdpClient.ts"; Q = "control/actionQueue.ts"; A = "control/browserAgent.ts"; T = "browserContractsB2Test"
J = "control/jarvisChrome.ts"; R = "perception/readTools.ts"
MUTANTS = [
  ("M1 a tab change that times out is 'not running' again (D1)", T, [(P, "    if (timedOut(err)) throw new CdpNoAnswerError(timeoutMs, change);\n", "")]),
  ("M2 a read that times out is 'not running' again (D1)", T, [(P, "    if (timedOut(err)) throw new CdpNoAnswerError(timeoutMs);\n", "")]),
  ("M3 the queue sends a timed-out tab change again (D2)", T, [(Q, "|does not know whether the tab .{1,30}; it was not tried again/i;", "/i;")]),
  ("M4 the final rule also stops a read's retry", T, [(Q, "|does not know whether the tab .{1,30}; it was not tried again/i;", "|Chrome did not answer within/i;")]),
  ("M5 no request ever counts as timed out", T, [(P, "?.name === 'TimeoutError';", "?.name === 'NeverTimeoutError';")]),
  ("M6 every failed request counts as timed out (refused too)", T, [(P, "const timedOut = (err: unknown): boolean => (err as { name?: string } | null)?.name === 'TimeoutError';", "const timedOut = (_err: unknown): boolean => true;")]),
  ("M7 opening a tab names the wrong change", T, [(P, "'PUT', 'opened');", "'PUT', 'changed');")]),
  ("M8 closing a tab names the wrong change", T, [(P, "'GET', 'closed');", "'GET', 'opened');")]),
  ("M9 the time in the reply is wrong", T, [(P, "const seconds = Math.round(timeoutMs / 100) / 10;", "const seconds = timeoutMs;")]),
  ("M10 browser_tab close closes every tab (contract 2)", T, [(A, "      await closeTabKeepingChrome(target.id, port);\n      forgetTab(target.id);", "      for (const p of await listPages(port)) await closeTabKeepingChrome(p.id, port);\n      forgetTab(target.id);")]),
  # Review round 1 (F1): a Chrome slow to say it is running
  ("M11 running() counts a slow Chrome as not running again (F1)", T, [(J, "return (await answeringBrowserPath(active.port)) === active.browserPath", "return (await browserPathAt(active.port)) === active.browserPath")]),
  ("M12 the version check swallows 'did not answer' again (F1)", T, [(J, "    if (err instanceof CdpNoAnswerError) throw err;\n", "")]),
  ("M13 a slow start: JARVIS stops waiting for its new Chrome (F1)", T, [(J, "      const port = await this.runningPort().catch((err) => {\n        if (err instanceof CdpNoAnswerError) return undefined;\n        throw err;\n      });", "      const port = await this.runningPort();")]),
  ("M14 a busy Chrome makes the read tools throw (F1)", T, [(R, "    if (err instanceof CdpNoAnswerError) return { failure: unreadable(err) };\n", "")]),
  ("M15 JARVIS_CDP_PORT: ensure() says 'nothing answers' for a slow Chrome (F1)", T, [(J, "      if ((await answeringBrowserPath(fixed)) !== undefined) return fixed;", "      if ((await browserPathAt(fixed)) !== undefined) return fixed;")]),
  ("M16 JARVIS_CDP_PORT: running() counts a slow Chrome as not running (F1)", T, [(J, "      const browserPath = await answeringBrowserPath(fixed);", "      const browserPath = await browserPathAt(fixed);")]),
  # Review round 2 (F10): Chrome busy as JARVIS closes it
  ("M17 close() counts a busy Chrome as closed again (F10)", T, [(J, "    let now: string | undefined;\n    try {\n      now = await answeringBrowserPath(port);\n    } catch (err) {\n      // Busy, not gone: no close was sent, so it is not reported as closed (phase B2, review F10).\n      if (err instanceof CdpNoAnswerError) {\n        throw new Error(`JARVIS's Chrome is still open: ${err.message.replace(/\\.$/, '')}, so it was not asked to close.`);\n      }\n      throw err;\n    }", "    const now = await browserPathAt(port);")]),
  ("M18 the queue asks again after a busy close (F10)", T, [(Q, "|JARVIS's Chrome is (?:not|still) open|", "|")]),
  ("M19 a busy close says still open but not why (F10)", T, [(J, "throw new Error(`JARVIS's Chrome is still open: ${err.message.replace(/\\.$/, '')}, so it was not asked to close.`);", "throw new Error(`JARVIS's Chrome is still open, so it was not asked to close.`);")]),
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
