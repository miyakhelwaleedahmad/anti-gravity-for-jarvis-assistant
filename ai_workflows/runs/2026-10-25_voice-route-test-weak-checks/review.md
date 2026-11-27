# Review — voiceRouteMockTest checks that cannot fail

> Stage: 05b_review · Run: `ai_workflows/runs/2026-10-25_voice-route-test-weak-checks/`
> Date: 2026-10-25 · Working tree at `76f4712` plus the uncommitted change (5 files + this run folder, before `verification.md` existed)
> Round 1. The review was read-only on the repository; its experiments ran in
> the reviewer's own scratchpad export. The reviewer is a separate agent
> session, **not a human**. Each report was returned as a message and is saved
> here word for word; the implementer's session added only the headers.
> Decisions: round 1 CHANGES REQUIRED, round 2 CHANGES REQUIRED, **round 3 PASS**.

---

## Reviewer
I am an AI agent (Claude, acting as an independent reviewer), not a human. Read-only on the repository. All mutations ran in my own scratchpad export.

## What Was Inspected
- **Diff:** `git status`, `git diff` and `git diff --numstat`. Only the 5 listed files are modified and the run folder is untracked. **No runtime file is in the diff** (observed).
- **The test:** `tests/voiceRouteMockTest.ts` (new, 219 lines) and the HEAD version (`git show HEAD:…`).
- **Runtime code:**
  - `bridge/nodeBridge.ts` (start, message handler, `sendListenStart`, `stop`)
  - `monitoring/healthLedger.ts`
  - `config/llmconfig.ts` (dotenv runs without override; `BRIDGE_HOST`/`BRIDGE_PORT` names)
  - `core/orchestrator.ts:600-665` (route, `runRoutedTool`)
  - `core/toolRegistryV2.ts` (method list)
  - `skills/automation/skill.ts`
  - opener code in `control/appController.ts`, `control/systemController.ts`, `core/terminalTools.ts`, `control/pcControlKernel.ts`
  - `perception/windowsState.ts`
  - execa 9.6.1 `lib/arguments/shell.js`
- **Boundary guard:** `tests/boundaryDoublesTest.ts`, `tests/boundary-doubles.json`.
- **Config:** key names only from `.env.example`. There is no `.env` in this clone.
- **Run records:** all files in `runs/2026-10-25_voice-route-test-weak-checks/` (including `evidence/*`), plus the prior run's `review.md` R3/R5.
- I opened nothing under `_config/` except the 3 diffed docs, through `git diff`.

## Findings

| ID | Sev | file:line | Finding | Suggested fix |
|---|---|---|---|---|
| V1 | medium | `tests/voiceRouteMockTest.ts:168-175, 198`; header `:21-23`; `TEST_MATRIX.md` row | Tools are recorded only through `toolRegistryV2.execute`. A route that calls `toolRegistryV2.get('browser_state').execute({})` passes all 13 checks. **Observed (X2f):** the marker file showed `found=true result=OK Error: Chrome is not reachable…` and the runner said PASS. The header claims "every tool call … is recorded … another tool … by any path", and TEST_MATRIX says "no other tool". Both overclaim. This is part of approved R5. | Wrap each registered tool's `execute` (via `getAll()`), or wrap `get()` as well. Otherwise narrow the claims to "tools run through `toolRegistryV2.execute`". |
| V2 | medium | `tests/voiceRouteMockTest.ts:181` | `launches.length = 0` throws away every process started before the route, for example during `stt_result` handling. **Observed (X1):** the bridge spawned `xdg-open https://www.youtube.com` when `stt_result` arrived; the test passed and the stand-in opener logged 1 call. | Check `launches.filter(isBrowserLaunch)` over the whole run (the PowerShell session is not flagged), or check before the reset as well. |
| V3 | medium | `tests/voiceRouteMockTest.ts:41-42` | The launch pattern only matches an opener at the start of the command line. **False negatives (regex observed on samples):** `start "" "<url>"` (the exact string `core/terminalTools.ts:93` passes to execa with `shell:true`; execa `shell.js:10` passes it to `spawn` unchanged), `sh -c xdg-open <url>`, `powershell … Start-Process <url>`, `rundll32 url.dll,FileProtocolHandler`, a quoted `"C:\…\explorer.exe"`, `msedge.exe <url>`, and a bare `firefox`. **Survived the test:** X3 (`sh -c xdg-open https://www.google.com`, which ran the opener), X3b (bare `start` string) and X7 (`firefox`). A YouTube URL is still caught by `/youtube/`. **False positives:** `cmd /c dir C:\start`, and any command line containing "youtube" (e.g. `git log youtube-fix`). | Match opener tokens anywhere in the command line: `start`, `Start-Process`, `rundll32`, `xdg-open`, `open`, `explorer`, `chrome`, `msedge`, `firefox`, with `.exe` and quotes allowed. Keep a sample table as checked-in evidence. |
| V4 | medium | `reproduction.md:67`; `change_log.md:73, 80` | Cited evidence does not exist. `evidence/probe_route.txt` and `evidence/launch_pattern_check.txt` are missing (the folder holds only `attack_new_test.txt`, `attack_old_test.txt`, `fix.diff`, `mutate_harness.txt`). The Green step ("13 passed, 0 failed, 0 opener calls") points to `verification.md`, which is not written yet, so it has no recorded output. | Add both files, or drop the claims. Put the raw green output in `evidence/`. |
| V5 | low | `tests/voiceRouteMockTest.ts:157` | "…as sent by the wake-word client" passes when the bridge ignores the sender's role. **Observed (X4):** `if (true) lastTranscriptEngine = "Google STT"` passed. | Also send one `stt_result` from the `stt` client and expect `Whisper`. |
| V6 | low | `tests/voiceRouteMockTest.ts:190-197` | The resolved URL is not checked. **Observed (X5):** `'youtube' → https://www.example.com` passed. TEST_MATRIX says `openAppSmokeTest` covers resolution; I did not run that test. | Optional: assert that the open_app output contains `https://www.youtube.com`. |
| V7 | low | `tests/voiceRouteMockTest.ts:32-38` | The wrapper is not fully transparent: it drops `exec`/`execFile[util.promisify.custom]`. **Observed in plain node:** `promisify(exec)` gives `{"stdout":"hi\n","stderr":""}` before the wrap and `"hi\n"` after. Nothing in the repo or its dependencies (axios, execa, ws, ioredis, …) promisifies `exec` today, so the risk is latent. `this`, arguments, return values and sync variants are forwarded correctly. Nothing imports `child_process` before the patch: the only static imports are `module` and `net`, and ESM named imports are refreshed by `syncBuiltinESMExports`. M5b, M6 and X6 confirm that ESM `import { spawn }` and dynamic `import('child_process')` are both seen. | Copy the real function's properties onto the wrapper: `Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(real))`. |
| V8 | low | `tests/voiceRouteMockTest.ts:195` | "open_app was a dry run" is vacuously true when open_app never ran (`every` on an empty list). Only the check at `:191` covers that case. | Use `openAppResults.length > 0 && …`. |
| V9 | low | `tests/voiceRouteMockTest.ts:44-49` | `freePort` releases the port before the bridge binds it (a race), and two calls could in principle return the same port. A clash on the health port only logs a warning; a clash on the bridge port leaves the 5 s connect retry to fail. Not observed. All waits are bounded (`waitFor` 3 s with a 10 ms poll, connect 5 s, 50 ms backoff), and there are no fixed sleeps. | Optional: assert the two ports differ, or hold the sockets until just before binding. |
| V10 | low | `issue_brief.md` (one-sentence description); `diagnosis.md` (Supporting Evidence) | "7 of the 11 checks" does not match the table, which lists 8 weak checks (3+1+3+1, R3 included). `sendListenStart` is cited as `nodeBridge.ts:719-735`; it is at 720-736. Other line references checked out (HEAD test lines 99-101, 109, 152-154, 166, 170; `orchestrator.ts:628`; `skill.ts:8`; `appController.ts:62,70`; `systemController.ts:92`; `terminalTools.ts:96`; `jarvis.ts:579`). | Correct the count and the line reference. |
| V11 | info | diff | Nothing was weakened. The old checks that read the test's own values ("process() called", "text forwarded", "source voice"), the `\|\| true` check and the loose open_app-in-log check are each replaced by real checks. Going from two `process` calls to one is equivalent, since `length===1` per request replaces `length===2` for two requests. Only consecutive-request behaviour is no longer exercised (minor). B2 is stated honestly as not covered, in the test header, TEST_MATRIX, ARCH_VOICE and the plan. | — |
| V12 | info | `tests/boundary-doubles.json:190-194` | The entry is still correct: the file replaces only `registry:execute`. Wrapping `child_process` is outside the guard's patterns and records rather than replaces, so it needs no entry. `boundaryDoublesTest` and `nodeBridgeSingletonTest` PASS in the export (observed). | Optional: mention the process recorder in the reason text. |
| V13 | info | records | **Windows:** never claimed as verified; marked "missing/not run" (correct). Not measured: the PowerShell process `windowsState` starts at import on Windows, and runtime on the owner's PC (the TEST-05 version took about 70.8 s there, as reported). **`.env`:** every bridge key in `.env.example` is set by the test before import, and dotenv does not override set values. Not exercised here (no `.env`). **Disclosed deviations:** the detailed plan was not shown to the owner before Stage 04, and `BRIDGE_HOST` was pinned as an unplanned change. | — |
| RD1 | info (runtime, report only) | `bridge/nodeBridge.ts:241-264, 758-761` | `stop()` neither closes the health server (it is a local variable) nor sets `wss = null`, so a later `start()` is silently ignored ("already started"). The test is unaffected because it calls `process.exit`. | — |
| RD2 | info (runtime, inferred) | `bridge/nodeBridge.ts:267, 350, 500-503` | After an EADDRINUSE error resets `wss = null`, a retried `start()` registers the `client_ready` and `hardware_error` handlers a second time, so each `client_ready` is handled twice. | — |
| RD3 | info (runtime, inferred) | `bridge/nodeBridge.ts:407` | A whitespace-only `stt_result` text is truthy, so it is recorded as a produced transcript. `jarvis.ts` may filter it later; not checked. | — |

## Experiments
- **Setup:** export at `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06` (HEAD archive, the 5 working-tree files copied over, `node_modules` symlinked).
- **Harness and opener:** `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/mutate.py`, with a recording stand-in `xdg-open` at `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/bin/xdg-open` that logs to `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/opener.log`. Every run went through `pnpm test -- --only=…`.
- **Suite check:** before running anything, `pgrep -af` showed that `runAll.ts -- --ci` (PIDs 5028/5029/5045) had exited. My own wait loop later reported "still running" only because its command line matched its own pattern. Another session was running `voiceRouteMockTest` from `scratchpad/t06/base` at the same time; ports are free per run and opener logs are separate.
- **Restore check:** mutated runtime files were restored from HEAD and checked with `cmp` (restored), and `git status` of the repo was unchanged.

Raw results (`/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/results.txt`):
```
none                         PASS  failing_checks=0 opener_calls=0 wall=5.2s
X1_bridge_spawns_on_stt      PASS  failing_checks=0 opener_calls=1   opener: xdg-open https://www.youtube.com
X2_tool_via_registry_get     PASS  failing_checks=0 opener_calls=0
X3_sh_c_opener_other_url     PASS  failing_checks=0 opener_calls=1   opener: xdg-open https://www.google.com
X3b_bare_start_string        PASS  failing_checks=0 opener_calls=0
X4_engine_any_role           PASS  failing_checks=0 opener_calls=0
X5_wrong_resolved_url        PASS  failing_checks=0 opener_calls=0
X6_timer_deferred_launch     FAIL  failing_checks=1 opener_calls=1
       ❌ FAIL: no browser or opener process was started (started: xdg-open https://www.youtube.com)
X7_browser_exe_no_url        PASS  failing_checks=0 opener_calls=0
```
- **X6:** caught. My guess that a `setTimeout(0)` launch would escape the check was wrong.
- **X2 confirmed by hand:** marker `found=true result=OK Error: Chrome is not reachable for JARVIS on 127.0.0.1:9222.` with `PASS voiceRouteMockTest 1866ms`. An earlier X2f run FAILed with 0 failing checks; that was an escaping bug in my own mutation, not a test result.
- **Baseline check lines:** shown by a scratch copy of the test changed to `exit(1)`, then restored from the working tree. Output: `=== Results: 13 passed, 0 failed ===`, all 13 labels PASS, route line `type="open_app" target="youtube"`, `TOKEN PROTECTED`, `[windowsState] PS spawn error: spawn powershell ENOENT`, 0 opener calls, 1.6-3.3 s per run on Linux.
- **Not repeated:** the author's M1-M8 mutations; I relied on `evidence/attack_new_test.txt`. Typecheck and the full suite were not run by me. Windows: not available.

## Decision
**CHANGES REQUIRED.** Findings A, B1 and R3 are done well: every original check that could not fail now fails on its fault, and nothing was weakened. R5 is in approved scope, and both the test header and TEST_MATRIX say the test fails if the route runs another tool or starts a browser "by any path". Five mutations show that claim is false:
- a tool called through `registry.get().execute` (V1)
- a launch before the route window (V2)
- `sh -c` opener, bare-`start` and browser-executable launches (V3)

In X1 and X3 a real opener ran and the test still passed. Two cited evidence files are missing and the green step has no recorded output (V4). The fixes are small and test-only: widen the tool recorder and the launch pattern, check launches over the whole run, add the missing evidence. Otherwise narrow the claims to what is actually recorded.

---

# Round 2

> Same reviewer (a separate agent session, not a human), after attempt 2
> (`change_log.md`, "Attempt 2"). Saved word for word.

## Reviewer
I am an AI agent (Claude, acting as an independent reviewer), not a human. Round 2 re-review. I stayed read-only on the repository: no edit, stage, commit, stash, reset or checkout, and I opened no token or credential files. All experiments ran in my own scratchpad export.

Before any test run I confirmed the main suite had exited, using `ps -eo args | grep "runAll[.]ts -- --ci"`; the `[.]` keeps the pattern from matching its own shell. That check printed 0 at 10:53 UTC, after waiting about 6 minutes.

## What Was Inspected
- **The test:** `tests/voiceRouteMockTest.ts` (working tree, 257 lines, 13 `assert(` calls).
- **Docs and guard:** `git diff` of `TEST_MATRIX.md`, `boundary-doubles.json`, `ARCH_VOICE.md` and `DO_NOT_BREAK.md` (still 13/13).
- **Records:** `issue_brief.md:11`, `diagnosis.md:34`, `change_log.md` ("Attempt 2" section; it is already updated for round 2), `verification.md` (round-1 numbers), `review.md` header, and every file in `evidence/`.
- **Runtime, read only:**
  - `core/orchestrator.ts:170-215` and `1959-1970`: skills load asynchronously through `skillLoader.loadSkills()`.
  - `core/skillLoader.ts:68-218`: each skill tool registers only after its `import()` finishes.
  - `core/toolRegistryV2.ts:342, 396, 1024`.
  - `perception/windowsState.ts:157-174, 425-440` and `perception/windowsProbe.ts:26-57`: the Windows command lines.
- **Searches:** imports of `child_process`, `worker_threads`, `ChildProcess` and `process.binding` (the runtime uses none of the last three), and captured `tool.execute` references (none).

## Findings

**Round-1 findings: all confirmed fixed.**

| ID | Status | file:line | Evidence |
|---|---|---|---|
| V1 | **fixed** | test `:77-87`, `:231-233` | X2 (`get('browser_state').execute`) now FAILs: `ran: browser_state, open_app`. X10 (a tool registered later and called directly) FAILs with `not watched: x_late_tool`. |
| V2 | **fixed** | test `:238-241` (no reset) | X1 (bridge spawns an opener on `stt_result`) FAILs. |
| V3 | **fixed** | test `:46-56` | X3 (`sh -c xdg-open`), X3b (bare `start` string) and X7 (`firefox`) all FAIL. |
| V4 | **fixed** | `evidence/` | All cited files exist. `verification.md` still holds round-1 numbers; the coordinator says round 2 follows. |
| V5 | **fixed** | test `:187-191` | X4 FAILs: `wakeword: Google STT, stt: Google STT`. |
| V6 | **fixed** | test `:224` | X5 FAILs. |
| V7 | **fixed** | test `:38-40` | Plain-node replica: `promisify(exec)` gives `{"stdout":"hi\n","stderr":""}` and `promisify(execFile)` gives `{"stdout":"x\n",…}`. |
| V8 | **fixed** | test `:228` | Needs `length > 0`. |
| V9 | **fixed** | test `:62-64` | Ports are drawn until they differ. |
| V10 | **fixed** | `issue_brief.md:11`, `diagnosis.md:34` | Count and line reference corrected, with a note. |

**New findings from round 2.**

| ID | Severity | file:line | Finding | Suggested fix |
|---|---|---|---|---|
| N1 | **medium** | test `:82` (with `orchestrator.ts:184` and `skillLoader.ts:218`) | The tool wrap depends on timing. It runs right after the imports, while skill tools (`open_app` among them) register asynchronously in the orchestrator constructor. Nothing in the test waits for them. **Observed (X9):** delaying each skill's registration by 400 ms made the test FAIL with `ran: none; not watched: open_app, cancel_current_action, explain_code, control_app, …`, on correct runtime code. It wins the race on cloud Linux (my 4 runs plus the implementer's 10). On a slower machine, such as the owner's Windows PC where the TEST-05 version took about 70.8 s, this can be a spurious failure of a protected test. It cannot produce a false pass. | Wait for skills before wrapping, e.g. `await (orchestrator as any).skillsReady;` (or `waitForSkills()`) just before line 82. |
| N2 | low | test header `:21-24`; `TEST_MATRIX.md` row; `change_log.md` ("Not recorded by design") | The claims are mostly accurate now, with these exceptions. **Observed (X12b):** a `worker_threads` Worker that calls `require('child_process').spawnSync('xdg-open', ['https://www.youtube.com'])` PASSes the test, and the stand-in opener logged the call. A Worker has its own module instance, so the patch does not reach it. **Observed in plain node:** `new ChildProcess().spawn({...})` is not recorded either. **Observed (X11):** a tool's `execute` captured with `.bind` before the wrap ran during the route (`x11 ran: OK Error: Chrome is not reachable…`) and the test PASSed. The runtime does none of these today (grep). The change log lists only "native addon" and "tools added after the route". | Say "main-thread `child_process` functions" in the header and TEST_MATRIX, and list Worker threads, the `ChildProcess` class and pre-captured `execute` references under "Not recorded". |
| N3 | low | test `:46-47, 53` | The opener and browser list is not exhaustive. **Observed (regex on samples):** not flagged: `google-chrome`, `chromium-browser`, `microsoft-edge`, `firefox-esr`, `brave-browser`, `wslview`, a relative `bin/xdg-open` or `./node_modules/open/xdg-open`, `C:\Windows\explorer` without `.exe`, `Start-Process('url')`, and `-EncodedCommand`. The repo's launch code uses none of these forms (`cmd.exe /c start`, `open`, `xdg-open`, `explorer.exe`, `start "" "url"` are all flagged). **New false positives:** `npm start`, `systemctl start redis` and `git commit -m open app` are flagged, but none is spawned during this test. On Windows, the PowerShell session (`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -`), `powershell.exe … -File <path>.ps1`, `tasklist` and `execa('powershell', [… -File get_windows_state.ps1])` are not flagged (inferred from code; not run on Windows). | Optional: add the Linux browser names, and take the basename of any word containing `/` or `\`. |
| N4 | info | test `:34-41` | Each `exec` is recorded twice ("echo hi","echo hi") because Node's `exec` calls `module.exports.execFile`. The X3b failure message shows the duplicate. This only affects the log, not the check. | Optional: dedupe, or skip recording `execFile` when called from `exec`. |
| N5 | info | test `:83-86` | Edge cases asked about: a frozen tool or a getter-only `execute` makes the assignment throw (strict ESM; the plain-node check gave `TypeError`), so the test crashes and fails, which is safe. A getter returning fresh functions reads as unwatched, so it fails. One object cannot sit under two names, because `register()` keys on `tool.name` (`toolRegistryV2.ts:342`), and `new Set(getAll())` dedupes anyway. | — |
| N6 | info | `boundary-doubles.json` | The reason text ("the tools themselves and child_process are only recorded, not replaced") matches the code. The guard detects only `toolRegistryV2.<method> =`, so the entry is still exactly `registry:execute`. `boundaryDoublesTest` PASS (observed). | — |

## Experiments
- **Setup:** export at `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06b` (HEAD archive, the 5 working-tree files copied in, `node_modules` symlinked).
- **Harness:** `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/mutate.py`, plus `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/x11.sh`. The recording stand-in `xdg-open` logs to `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/opener.log`. Every run went through `pnpm test -- --only=…`.
- **Restore check:** mutated files were restored from HEAD and checked with `cmp` (all restored).

Raw results (`/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/results_round2.txt`, abridged):
```
none                         PASS   opener_calls=0
X1_bridge_spawns_on_stt      FAIL   ❌ no browser or opener process was started during the test (started: xdg-open https://www.youtube.com | …)  opener_calls=2
X2_tool_via_registry_get     FAIL   ❌ the route ran no tool but open_app (ran: browser_state, open_app)
X3_sh_c_opener_other_url     FAIL   ❌ … (started: sh -c xdg-open https://www.google.com)  opener_calls=1
X3b_bare_start_string        FAIL   ❌ … (started: start "" "https://www.google.com" | start "" "https://www.google.com")
X4_engine_any_role           FAIL   ❌ …and took the engine from the sender (wakeword: Google STT, stt: Google STT)
X5_wrong_resolved_url        FAIL   ❌ open_app ran once for "youtube" (https://www.youtube.com)
X6_timer_deferred_launch     FAIL   ❌ … (started: xdg-open https://www.youtube.com)  opener_calls=1
X7_browser_exe_no_url        FAIL   ❌ … (started: firefox)
X9_slow_skill_load           FAIL   ❌ the route ran no tool but open_app (ran: none; not watched: open_app, cancel_current_action, …)   <- spurious failure, runtime correct
X10_late_tool_direct_call    FAIL   ❌ the route ran no tool but open_app (ran: open_app; not watched: x_late_tool)
X11 (x11.sh)                 PASS voiceRouteMockTest 1621ms; marker: x11 ran: OK Error: Chrome is not reachable for JARVIS on 127.0…
X12b worker_threads spawn    PASS voiceRouteMockTest 1692ms; opener log: 10:54:43 xdg-open https://www.youtube.com
```
- My first X12 attempt FAILed with 0 failing checks. That was a crash in my own mutation code, not a test result; X12b is the corrected version.
- **Plain-node checks (not repo tests):** a replica of the new wrapper keeps promisify, records each `exec` twice, and records neither a Worker-thread spawn nor `new ChildProcess().spawn`; assigning to a frozen tool's `execute` throws `TypeError`. The new matcher was run on 19 extra sample lines (results under N3).
- **Related and repeat runs:** in the export, `boundaryDoublesTest`, `nodeBridgeSingletonTest` and `voiceRouteMockTest` all PASS; `voiceRouteMockTest` PASSed 3 more times (1362-1493 ms) with 0 opener calls.
- **Not run:** typecheck, the full suite, Windows.

## Decision
**CHANGES REQUIRED.** All ten round-1 findings (V1-V10) are fixed and confirmed. All eight of my round-1 mutations now fail the test, and the control passes. One reliability problem remains (N1): the test wraps tools before the asynchronously loaded skills are guaranteed to be registered. When skill loading is slower (simulated in X9), the test fails on correct code. That is a real flakiness risk on the owner's slower Windows PC, for a test listed in `DO_NOT_BREAK.md`. The fix is one line: await the orchestrator's `skillsReady` before wrapping. The remaining items (N2-N4) are low: narrow the header, TEST_MATRIX and change-log claims to main-thread `child_process` calls and tools not captured before the wrap, and optionally extend the browser list. With N1 fixed and N2's wording adjusted, I would expect to pass this change.

---

# Round 3

> Same reviewer (a separate agent session, not a human), after attempt 3
> (`change_log.md`, "Attempt 3"). Saved word for word. Afterwards the
> implementer took P4 (the `TEST_MATRIX.md` row now names the same four
> "not seen" cases as the test header) and left P3 as a documented, accepted
> false positive.

## Reviewer
I am an AI agent (Claude, acting as an independent reviewer), not a human. Round 3 confirmation. I stayed read-only on the repository and opened no credential files. Experiments ran only in my own export.

Before any test run I checked with `ps -eo args | grep "runAll[.]ts -- --ci"`. The suite was still running at the end of my read-only pass, so I waited (about 5 minutes, then 136 s more) until that printed 0. I re-checked it before each batch of runs.

## What Was Inspected
- **The test:** `tests/voiceRouteMockTest.ts`. Header lines 21-26; wrapper lines 33-50 (depth counter); matcher lines 52-66; `waitForSkills` and the wrap at lines 85-98.
- **Docs and guard:** the `TEST_MATRIX.md` row (`git diff`). `git status` still lists only the 5 known files plus the run folder.
- **Runtime, read only:** `core/orchestrator.ts:92` (`SKILLS_WAIT_MS = 10_000`) and `:1959-1970` (`waitForSkills`: on a timeout it warns and resolves, it never throws).
- **Round-3 evidence:** `evidence/launch_pattern_round3.txt` (33 cases, the false positives and the false negative it documents) and the evidence file list.

## Findings

**Round-2 findings: all confirmed fixed.**

| ID | Status | file:line | Evidence |
|---|---|---|---|
| N1 | **fixed** | test `:89` `await (orchestrator as any).waitForSkills();` before the wrap at `:90-98` | X9 (400 ms delay per skill, correct runtime code) now **PASSes**; in round 2 it failed spuriously. |
| N2 | **fixed** | test `:21-26`; `TEST_MATRIX.md` row | The header now lists what the test does not see: a worker thread, the `ChildProcess` class used directly, a native addon, and a tool's `execute` captured before the wrap. This matches my X11/X12b results. |
| N3 | **fixed** | test `:52-66` | Plain-node run of the matcher on samples: flagged `google-chrome https://x`, `bin/xdg-open https://x`, `./node_modules/open/xdg-open https://x`, `powershell -Command "Start-Process('https://x')"`, `wslview https://x` and `C:/Program Files/Google/Chrome/Application/chrome.exe`. Not flagged: the PowerShell session line, `node C:/jarvis/tests/x.ts`, `python3 /opt/jarvis/voice/stt.py`, `git -C /home/u/repo --no-pager log`, `cmd /c dir C:\start`. |
| N4 | **fixed** | test `:35-41` | X3b now records `start "" "https://www.google.com"` once (it was twice). Plain-node replica: `promisify(exec)`, `promisify(execFile)`, `exec` with a callback, and `execSync` are each recorded once. |

**New checks of the round-3 change.**

| ID | Severity | file:line | Finding | Suggested fix |
|---|---|---|---|---|
| P1 | info | test `:89`; `orchestrator.ts:1962-1968` | When `waitForSkills` times out, the test does **not** pass silently. **Observed (X9b,** 11 s delay per skill**):** FAIL after 14.4 s with `ran: none; not watched: open_app, …`. The orchestrator's own "Skills still loading" warning goes to stderr, because the console capture starts later. This failure matches the runtime, where `process()` would also run without the skills. | — |
| P2 | info | test `:35-41` | The depth counter does not swallow real launches. Every wrapped call is synchronous, and `finally` brings the counter back down. **Observed (plain-node replica):** two promisified calls in flight at once, a `spawn` inside an `exec` callback, a `spawn(123)` that throws `ERR_INVALID_ARG_TYPE` followed by a `spawnSync`: each one recorded once, and the counter ends at `0`. A launch made synchronously *inside* another `child_process` call would go unrecorded, but only Node internals do that (inferred). | — |
| P3 | low | test `:62` | Taking the basename of any word containing `/` flags URLs whose last segment is an opener name. **Observed:** `curl https://x/open` and `git clone https://github.com/a/start` are flagged. This is documented as accepted, and nothing like it is spawned in this test. Two misses (observed): a trailing slash (`/usr/bin/xdg-open/`) and a backslash-only path without `.exe` (`C:\Windows\explorer`). Both are trivial, and no such form appears in the repo's launch code. | Optional: skip words containing `://` before taking the basename. |
| P4 | info | `TEST_MATRIX.md` row | The row names only "a worker thread or a native addon". The header also names the `ChildProcess` class and a pre-captured `execute`. The row is accurate but shorter than the header. | Optional: make the row match the header. |

## Experiments
- **Setup:** fresh export at `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06c` (HEAD archive, the 5 working-tree files copied in, `node_modules` symlinked).
- **Harness:** `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/mutate.py`, with the recording stand-in `xdg-open` first on PATH. Every run went through `pnpm test -- --only=…`.
- **Restore check:** mutated files were restored from HEAD and checked with `cmp` (no differences).

Raw results (`/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/results_round3.txt`):
```
none                         PASS  opener_calls=0 wall=3.7s
X9_slow_skill_load           PASS  opener_calls=0 wall=4.0s      <- correct code, slow skills: now passes (N1)
X9b_skills_slower_than_wait  FAIL  ❌ the route ran no tool but open_app (ran: none; not watched: open_app, cancel_current_action, …) wall=14.4s
X10_late_tool_direct_call    FAIL  ❌ … (ran: open_app; not watched: x_late_tool)
X1_bridge_spawns_on_stt      FAIL  ❌ no browser or opener process was started during the test (started: xdg-open https://www.youtube.com | xdg-open https://www.youtube.com) opener_calls=2
X2_tool_via_registry_get     FAIL  ❌ … (ran: browser_state, open_app)
X3b_bare_start_string        FAIL  ❌ … (started: start "" "https://www.google.com")
X6_timer_deferred_launch     FAIL  ❌ … (started: xdg-open https://www.youtube.com) opener_calls=1
```
- X1 records two launches because the mutation fires for both non-empty `stt_result` messages (from wakeword and from stt).
- **Repeat runs:** `boundaryDoublesTest` PASS (476 ms), and `voiceRouteMockTest` PASSed 4 times (1471-1958 ms) with 0 opener calls.
- **Plain-node checks (not repo tests):** the depth-counter replica `w3.mjs` and the matcher samples, both in `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review06_tools/plain`.
- **Not run by me:** X11 and X12 (unchanged, and now documented as not seen), typecheck, the full suite, Windows.

## Decision
**PASS.** N1-N4 are fixed and confirmed by experiment.
- **N1:** with slow skill loading the test now passes, and when skills exceed the 10 s wait it fails loudly with "not watched" rather than passing.
- **N4:** the depth counter records each launch once and lost no launch in my overlap tests.
- **N3:** the matcher catches the new browser names and path forms.
- **N2:** the header and TEST_MATRIX claims now match what is actually recorded.

Every earlier mutation (X1-X7, X10) still fails the test, and the control passes repeatedly with no opener calls. What remains is low or info (P3 URL false positives, which are documented and not spawned here; P4 wording) and does not block. Windows behaviour was never run, and the records say so honestly.
