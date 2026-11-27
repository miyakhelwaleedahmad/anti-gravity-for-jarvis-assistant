# Patch Plan — time questions refused (N-PC10)

Tests come first and are run on the current code. Then the change, related tests, typecheck, the full suite, a mutation check and an independent review. Commit and push only with the owner's approval.

| # | Change | Files | Protected? |
|---|---|---|---|
| P1 | The fast time answer covers common wordings (spaces turned out to be collapsed already by `normalizeVoiceInput`; see diagnosis D1). As planned: "what time is it / this / it now", "what's the time (now)", "what is the time (now)", "tell me the time", "tell me (the) time", "tell me what time it is", "tell me what time is", "current time", "the time", "time now", "time please". The patterns are anchored to the whole sentence, so "what time is my meeting", "set a timer", "what time does the shop close", "how long until 5 pm" and "time to close youtube" still go to the planner. The reply is unchanged: "It is 11:22 AM, sir." | `core/deterministicRoutes.ts` (§4 Time) | **yes** |
| P1b | A fast date answer ("Today is Monday, 2 November 2026, sir.") for "what's the date (today)", "what is the date (today)", "what is today's date", "today's date", "what day is it (today)", "what day is today" and "what is today". The owner did not answer whether to include dates; it is in the plan because it is the same failure (D2). | same | **yes** |
| P2 | The planner's clock line gives the local date, time and time zone (for example `[SYS now=Monday 2026-11-02 11:21 local time (UTC+05:00, Asia/Karachi) depth=… budget=…]`). It is made fresh for every request, including on a cache hit, so other time questions ("how long until 5 pm") need no shell. | `memory/unifiedContextBuilder.ts` (`_buildSystemState`, the cache-hit return) | **yes** |
| T | New `tests/timeQuestionsNpc10Test.ts`: each wording reaches the time or date route, and the ones that must not do not; typed end to end through `process()`, the reply is spoken with no model call; the context line has the local date, time and offset (`TZ` set to Asia/Karachi), and it changes on a cache hit when the time zone changes. | tests | — |

As built, after review round 1 (see `change_log.md`): both replies are in English whatever the PC's regional format; a trailing "jarvis" is dropped; bare fragments ("what time", "the date", "what is time") are left to the planner; a few wordings were added ("current date", "what's today", "do you know what time it is", …). The date reply is in en-US form: "Today is Monday, November 2, 2026, sir."

Not changed:
- the command safety rules (D5);
- `core/orchestrator.ts` (D6);
- A3, A4 and B4 code.

Gate 1: approved by the owner on 2026-11-02 ("i approved that"), for the fix as proposed (P1, P2). The owner then approved, the same day:
- the edits to both protected files by name: "Approve both (Recommended)";
- the date answer, P1b: "Include dates (Recommended)".
