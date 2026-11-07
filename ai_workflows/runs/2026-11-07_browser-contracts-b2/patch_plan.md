# Patch Plan — browser contracts (phase B2)

Tests first, run on the current code; then the change; related tests, typecheck, full suite, mutation check, independent review. Commit and push only with the owner's approval.

| ID | Change | Files |
|---|---|---|
| P1 (D1, D2; contracts 5, 6) | A timeout gets its own wording, not "not running": for a change (open, close, bring forward a tab) "Chrome did not answer within 3 s (it may be busy), so JARVIS does not know whether the tab opened; it was not tried again." That wording is final in the action queue, so the request is not sent twice. A read that times out says "Chrome did not answer within 2 s (it may be busy)" and may be retried (a read is safe to repeat). "Connection refused" keeps today's wording and its one retry (D3) | `perception/cdpClient.ts`, `control/actionQueue.ts` |
| P2 (contract 2) | Test only: in a real headless Chromium, close one tab, then read and act on another tab; both work, Chrome is still running, and the close reply says nothing about the browser closing or a lost connection | `tests/browserContractsB2Test.ts` (new) |
| P3 | The contract map in `diagnosis.md`: the existing check behind each covered contract, so nothing is duplicated | records |

Not protected: none of these files is in `ai_workflows/_config/RUNTIME_PROTECTED_FILES.md`.

## Added after review rounds 1 and 2 (owner's approvals)

| ID | Change | Files |
|---|---|---|
| P4 (review F1) | "Is JARVIS's Chrome running?" passes on a late answer instead of counting it as "not running": the tab and read tools say Chrome did not answer, and opening a page starts no second Chrome. JARVIS's own start keeps waiting through a late first answer | `control/jarvisChrome.ts`, `perception/readTools.ts` |
| P5 (review F10, owner: "I approve fixing F10 before committing B2") | `close()`'s first check passes "did not answer" on: a busy Chrome is reported still open and not asked to close, not "closed" | `control/jarvisChrome.ts` |

## Gate 1 (owner, 2026-11-06)

- "Approve B2 (Recommended)": tests first, then P1–P3, related tests, full suite, mutation check, independent review; no commit or push without separate approval.
- Slow Chrome: "Say it, don't repeat (Recommended)": the smallest change, no check of the tab list after the timeout.
