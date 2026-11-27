# Review — browser contracts (phase B2)

Reviewer: a separate agent session (general-purpose), read-only. Not a human.

## Round 1 — CHANGES REQUIRED

The reviewer ran:
- the new test twice: 17/17 both times (about 21 s);
- the typecheck: `TC=0`;
- scratch probes of how Node's `fetch` fails (slow answer, reset, refused), of every classifier against the new wordings, and of a Chrome that is slow on `/json/version`.

Confirmed:
- On this Node, a timeout rejects with `TimeoutError`; a reset or close after Chrome took the request is a `TypeError` (`ECONNRESET`, `UND_ERR_SOCKET`).
- `FINAL_FAILURE` matches the three change wordings and not the read wording; no other classifier (the kernel's `blocked` rule, `isPermissionDenial`, YouTube's `cdpDown`, `tabClose.ts`) matches any new wording.
- The test's timing is deterministic: the client's 3 s and 2 s timers always fire before the fake's 3.5 s answer.
- The records match the evidence, and the contract map names checks that exist and test what is claimed.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| F1 | med | `jarvisChrome.ts` `browserPathAt` swallows every error, `CdpNoAnswerError` included. A Chrome slow on `/json/version` makes `running()` say "not running": the tab tools and read tools say so, and `ensure()` (open a page) **starts Chrome again**. The change log called that code "still right" | Owner: "Fix it in B2". **Fixed** in `jarvisChrome.ts` and `readTools.ts`, tests first (§1b); M11–M16. The change log is corrected |
| F2 | low | A reset after Chrome took the request is still "not reachable", so a tab change is sent again | Already a known limit |
| F3 | info | `FINAL_FAILURE` scoped correctly; no other classifier changes | — |
| F4 | info | `openUrl`'s bring-forward timing out after the tab opened is now final: the tab stays open with no rollback registered | — |
| F5 | low | The old-code row ("6 passed, 10 failed") was the 16-check version; the 17th check would pass on the old code | **Fixed** in the change log |
| F6 | info | Test timing deterministic | — |
| F7 | info | The "no disconnect" regex only checks for absent words; the positive checks (Beta listed, read, clicked and checked) carry the contract | — |
| F8 | info | The test's temporary workspace is not removed (as in other tests); the port-file removal is not in a `finally` | — |
| F9 | info | Records match the evidence, apart from F1 | — |

## Round 2 — APPROVED

The reviewer ran the test (24/24), the typecheck (`TC=0`), a probe of a Chrome slow on `/json/version` (two `ensure()` calls at once, a later call, `close()`), and read every caller of `running()`, `runningPort()`, `ensure()` and `checkedChromePort()` in context.

Confirmed:
- F1 holds on every caller (browser controller, browser agent, YouTube, read tools, self-check, the open-app skill, the tab route reply): each catches the error, and a busy Chrome is "did not answer within 2 s (it may be busy)", not "not running".
- No second Chrome: two `ensure()` calls at once both reject with one `/json/version` request, `pending` is cleared, and a later call gets the port with 0 starts. The "no second Chrome" check cannot pass because autostart is off (the stand-in environment leaves that setting out).
- The kernel's one retry of a busy "open address" or "close Chrome" repeats only a read, before any change and before the question, within the queue's 10 s.
- The new checks fail on the round-1 code or under M11–M16; timing is deterministic; the records match the evidence.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| F10 | low | Chrome busy as `close()` starts: "Closed JARVIS's Chrome" without sending the close, after the owner said yes (also in the base code); the known limit understated it | Owner: fix it in B2. **Fixed**: `close()`'s first check passes "did not answer" on, reported as "JARVIS's Chrome is still open: … so it was not asked to close" (final: not asked again). Tests first (§1c); M17–M19. The wait after the close request is recorded as a known limit |
| F11 | info | `findTab` and `isTabOpen` catch every error: a busy Chrome gives "Tab not found" / no, as "not running" did before B2 | Recorded under known limits |
| F12 | info | Self-check reports a busy Chrome as FAILING; NOT_VERIFIED would also fit | Recorded under known limits |
| F13 | info | The start-up wait can run about 2 s past its limit; a new Chrome busy until the limit gets the profile-window advice | Recorded under known limits |
| F14 | info | YouTube's "not reachable" prefix contradicts the busy reason | Already recorded; the entry now names F14 |

## Round 3 — APPROVED

The reviewer ran the B2 test (28/28), `jarvisChromeTest` (130/130; it closes a real Chromium), the typecheck (`TC=0`), read every caller of `close()` and the reply path through the kernel and the orchestrator, and gave the hash of the tree it reviewed: `488cf8f4a2e19639` (sha256 of `git diff` and the new test, first 16 hex).

Confirmed:
- The F10 fix is correct and minimal. "Still open" is honest: Chrome answered `running()` a moment earlier, and no close was sent.
- The wording is final in the action queue, so there is no retry and no second question. The kernel logs it as a failure, not `blocked`. The spoken reply is "I did not close JARVIS's Chrome, sir." plus the 111-character reason, within the route's 120.
- `close()` has two callers, `browserController.closeBrowser` and `jarvisChromeTest`. Neither is surprised by the new error.
- The §1c checks are sound: on the old code they fail with "Closed JARVIS's Chrome (0 tabs) …"; the version count proves there was no retry; timing is deterministic; M17–M19 are caught.
- The known limits (F10's remaining part, F11–F14) and the records match the code and the evidence.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| F15 | info | The "asked once" part of §1c's last check cannot fail with this fake; the version count of 2 is what proves there was no retry | Recorded in the change log's test description |
| F16 | info | The `throw err` branch in `close()`'s new catch cannot run (`answeringBrowserPath` throws only `CdpNoAnswerError`); harmless and defensive | — |
| F17 | info | For a busy Chrome, the question before closing says "0 tabs" (not new in B2) | Recorded under known limits |
