# Change Log — browser contracts (phase B2)

Base commit: `f8b1c8d`. Owner's Gate 1, 2026-11-06: "Approve B2 (Recommended)"; slow Chrome: "Say it, don't repeat (Recommended)". After review round 1, the owner approved two more files for F1: "Fix it in B2 (Recommended)" (`control/jarvisChrome.ts`, `perception/readTools.ts`). After review round 2, the owner approved fixing F10 in B2 ("I approve fixing F10 before committing B2"), in `control/jarvisChrome.ts`.

## The change

| File | Change |
|---|---|
| `perception/cdpClient.ts` | A request to Chrome that times out is no longer "Chrome is not reachable … JARVIS's own Chrome is not running". `CdpNoAnswerError`: for a tab change (open, close, bring forward), "Chrome did not answer within 3 s (it may be busy), so JARVIS does not know whether the tab opened; it was not tried again." (or "closed", "came to the front"); for a read (tab list, version), "Chrome did not answer within 2 s (it may be busy)." A refused connection (nothing listens) keeps `CdpUnavailableError` and its wording (D3) |
| `control/actionQueue.ts` | The tab-change wording is a final failure: the kernel's queue does not send the change again. Before, one "open this address" to a slow Chrome opened two tabs (D2). A slow read is still tried a second time: a read is safe to repeat |
| `control/jarvisChrome.ts` (review F1) | "Is JARVIS's Chrome running?" reads `/json/version`, and a late answer was counted as "not running": the tab and read tools said so, and opening a page started Chrome a second time. `running()` and `ensure()` now pass the "did not answer" error on (`answeringBrowserPath`), so they say Chrome may be busy and start nothing. JARVIS's own start still waits through a late first answer from the Chrome it just started. Review F10: `close()`'s first check, before the close is sent, also passes it on. "Close JARVIS's Chrome" with Chrome busy at that moment (after the owner said yes) said "Closed JARVIS's Chrome … (port … no longer answers)" without sending the close; it now says "JARVIS's Chrome is still open: Chrome did not answer within 2 s (it may be busy), so it was not asked to close." That wording is final in the action queue, so the owner is not asked again. The wait after the close request still counts no answer as gone (`browserPathAt`) |
| `perception/readTools.ts` (review F1) | A busy Chrome is a read failure, "JARVIS's Chrome did not list its tabs: Chrome did not answer within 2 s (it may be busy)." with the existing "I could not read my Chrome's tabs, sir.", not a crash and not "not running" |

Other code that reads these messages, unchanged:
- `youtubeControl.ts:122` opens YouTube another way only on "not reachable", "connect" or "debugging port". The new wording has none of them, so a slow Chrome does not start a second opening there either.
- `core/verifiers.ts` catches any error and reports the check as not possible.
- `core/selfCheck.ts` catches the error from `running()`: a busy Chrome is "FAILING: the check failed: Chrome did not answer within 2 s (it may be busy)".
- The first version of this change called `jarvisChrome.ts`'s `browserPathAt` "still right". It was not: it hid the new error (review F1, fixed above).

## Tests

| File | Change |
|---|---|
| `tests/browserContractsB2Test.ts` (new) | 17 checks, then 24 after review round 1, then 28 after review round 2. §1, contracts 5 and 6, a fake Chrome that makes each change at once and answers after 3.5 s: open, close and bring forward are each sent once and say "did not answer … does not know whether the tab …; it was not tried again"; "open this address" end to end through the kernel, with the fake found as JARVIS's own Chrome (its profile's port file, no `JARVIS_CDP_PORT`, as on the owner's PC): one tab, not two; a slow read says "did not answer within 2 s" and is still tried a second time; a closed port is still "not reachable … not running". §1b (review F1), a Chrome slow on `/json/version`: opening a page starts no second Chrome and says it did not answer; the tab tools and the read tools say so (the read tools as a failure, not a crash); the same with `JARVIS_CDP_PORT`; and JARVIS's own start waits through a late first answer. §1c (review F10), "close JARVIS's Chrome" through the browser controller and the action queue, with Chrome answering "running?" and then busy: no "Closed", "still open … did not answer", no DevTools connection (so no close sent), the owner asked once and the close not tried again. Of these, the count of 2 `/json/version` requests is what proves there was no retry: a retry's `running()` would meet the busy Chrome and stop before the question, so "asked once" would hold either way (review F15). §2, contract 2, a real headless Chromium: `browser_tab close` of one tab is done and checked, the reply says nothing about the browser closing or a lost connection, Chrome is still running with the other tab, and that tab is read (`browser_page_structure`) and acted on (`browser_click`, checked) |

The contracts already covered (1, 3, 4, 7, and 6 for "not running") are mapped to their existing checks in `diagnosis.md`, so no check is duplicated.

## Evidence

| Check | Result | File |
|---|---|---|
| MB, MD, ME on the base code | **3/3 caught** (A4's script) | `evidence/b2_mbmdme_on_f8b1c8d.txt` |
| Diagnosis probes | which browser failures the queue retries; a slow Chrome: 2 tabs for one request, "not running" | `evidence/b2_probe_retry.*`, `b2_probe_slow_chrome.*` |
| New test on the base code (the 16-check version) | 6 passed, **10 failed** (every slow-Chrome check, the kernel's end to end included; the contract-2 and "refused" checks pass, as they should). The 17th check, added later, would pass on the base code too (review F5) | `evidence/b2_old_code_checks.txt` |
| New test after the change | **16/16**, then **17/17** with the check that a read is still retried (added so that M4 has a check) | `evidence/b2_new_code_checks.txt` |
| Typecheck | `TC=0`, on the first change and again after the round-1 fix (the file holds the last run) | `evidence/b2_typecheck.txt` |
| Mutation check, 10 mutants | **10/10 caught**, tree restored (md5) | `evidence/b2_mut.py` (M1–M10), `b2_mut_run.txt` |
| Related tests (25: every test that imports the changed files, the browser, tab and YouTube tests, `openAppHonestA5dTest`, `verifyAfterActTest`, `routeGoldenTest`) | **25 passed, 0 failed**, 0 skipped | `evidence/b2_related_list.txt`, `b2_related_tests.txt` |
| Full suite | **217 passed, 0 failed**, 1 blocked (no pygame), 9 skipped; exit 1 for the blocked test | `evidence/b2_full_suite.txt` |
| Independent review, round 1 | CHANGES REQUIRED (F1 med; F2, F5 low; F3, F4, F6–F9 info) | `review.md` |
| Round-1 checks (§1b, first five) on the round-1 code | 18 passed, **4 failed** (the start-wait check passes on that code, as it should: it guards the fix) | `evidence/b2_review_r1_old_code_checks.txt` |
| Test after the round-1 fix | **22/22**, then **24/24** with the two `JARVIS_CDP_PORT` checks (added after the run above; M15 and M16 show they can fail). The file holds the 24-check run | `evidence/b2_review_r1_new_code_checks.txt` |
| Mutation check after round 1, 16 mutants (M1–M10 again, new M11–M16) | **16/16 caught**, tree restored (md5) | `evidence/b2_mut.py`, `b2_mut_run_r1.txt` |
| Related tests after round 1 (the 25, plus `selfCheckTest` and `selfCheckA5bTest`, which read `running()`) | **27 passed, 0 failed**, 0 skipped | `evidence/b2_related_list_r1.txt`, `b2_related_tests_r1.txt` |
| Full suite after round 1 | **217 passed, 0 failed**, 0 timed out, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped (Windows-only, live-provider, Redis, `.venv`, bridge token, PowerShell 7); exit 1 for the blocked test | `evidence/b2_full_suite_r1.txt` |
| Independent review, round 2 | **APPROVED** (F10 low; F11–F14 info) | `review.md` |
| Round-2 checks (§1c) on the round-2 code | 26 passed, **2 failed**: the reply was "Closed JARVIS's Chrome (0 tabs) (port … no longer answers)." with 0 connections to Chrome. The "no close sent" and "asked once, not tried again" checks pass on that code: they guard the fix | `evidence/b2_review_r2_old_code_checks.txt` |
| Test after the F10 fix | **28/28** | `evidence/b2_review_r2_new_code_checks.txt` |
| Typecheck after the F10 fix | `TC=0` (the file holds this run) | `evidence/b2_typecheck.txt` |
| Mutation check after round 2, 19 mutants (M1–M16 again, new M17–M19) | **19/19 caught**, tree restored (md5) | `evidence/b2_mut.py`, `b2_mut_run_r2.txt` |
| Related tests after round 2 (the 27 of round 1) | **27 passed, 0 failed**, 0 skipped | `evidence/b2_related_list_r1.txt`, `b2_related_tests_r2.txt` |
| Full suite after round 2 | **217 passed, 0 failed**, 0 timed out, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped; exit 1 for the blocked test | `evidence/b2_full_suite_r2.txt` |
| Independent review, round 3 | **APPROVED** (F15–F17 info); reviewed tree `488cf8f4a2e19639` (sha256 of the source diff and the new test, first 16 hex), the same as the tree proposed for commit | `review.md` |

## Deviations from the plan

- Two files outside Gate 1, `control/jarvisChrome.ts` and `perception/readTools.ts`, were changed after review round 1 (F1), with the owner's approval; `jarvisChrome.ts` again after review round 2 (F10), with the owner's approval.
- The end-to-end case first set `JARVIS_CDP_PORT`. That error wording is already final, so the case passed on the base code and did not show the bug. It now finds the fake Chrome through the profile's port file, as JARVIS finds its own Chrome on the owner's PC, and fails on the base code (2 tabs).

## Known limits (recorded, not changed)

- Only a timeout counts as "did not answer". A connection that resets after Chrome took the request (Chrome crashing mid-request) is still "not reachable", and a tab change is then tried again.
- A tab change that timed out is not checked afterwards: JARVIS says it does not know (owner's choice, "Say it, don't repeat"). The tab may be open.
- `control/browserAgent.ts` checks the port with `checkedChromePort()` and then calls `cdpPort()`; both read the same port today (diagnosis).
- A dropped page connection is still worded "the tab closed the connection" (diagnosis).
- After the close request is sent, `close()` waits up to 5 s for the port to stop answering and still counts a late answer as "gone" (`browserPathAt`). A Chrome that got `Browser.close`, did not close, and was too busy to answer would be reported as closed (review F10 fixed the check before the close is sent, not this wait).
- `browserController.findTab` and `isTabOpen` catch every error: for a busy Chrome, the kernel's "find a tab" answers "Tab not found" and "is it open?" answers no, as they already did for a Chrome that is not running (review F11).
- Self-check reports a busy Chrome as FAILING ("the check failed: Chrome did not answer within 2 s (it may be busy)"). Honest, though NOT_VERIFIED would also fit a Chrome that runs but is slow (review F12).
- JARVIS's start-up wait keeps polling through a late answer; each poll can take up to 2 s, so the wait can run about 2 s past its limit, and a new Chrome busy until the limit gets the "close any Chrome window with JARVIS's profile" advice (review F13).
- For a busy Chrome, the question before closing JARVIS's Chrome says "0 tabs": the tab list is read with any failure counted as no tabs (`browserController.ts`, `listPages(...).catch(() => [])`), before the question. Not new in B2 (review F17).
- `youtubeControl.ts:184` puts "Chrome's debugging port is not reachable" in front of any error, a busy Chrome's included, which contradicts the reason that follows in brackets (review F14).
- The fake Chrome stands in for a busy one; how long Chrome on the owner's PC takes to answer when it is busy is not known.
