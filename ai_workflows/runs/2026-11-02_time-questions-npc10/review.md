# Review — time questions refused (N-PC10)

Reviewer: a separate agent session (general-purpose), read-only; tests run through the runner only. Not a human.

## Round 1 — CHANGES REQUIRED

The reviewer ran 20 tests through the runner (20 passed) and `pnpm -s typecheck` (exit 0).

Confirmed correct:
- **Route order is safe.** It enumerated all 220 strings the first patterns accept and ran them through the base router (`3ed4baf`). None reached any route other than `time`, and nothing before §4 catches them.
- **Look-alikes still go to the planner:** timers, reminders, "what is today's weather", "what time is it in london".
- **The orchestrator's generic branch speaks the `date` reply.**
- **The cache-hit rebuild is correct** (T9).

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| T1 | med | The cache check expected London at `UTC+00:00`; it would fail every summer | **Fixed**: Asia/Tokyo (`UTC+09:00`, no summer time) |
| T2 | med | The date (and time) reply followed the PC's regional format: Urdu or Arabic text, or Arabic digits, for an English voice | **Fixed**: `en-US` for both replies; a child process with an Arabic locale checks it. Test first; M10, M11 |
| T3 | med | "What's the time, Jarvis?" and "what time is it jarvis" went to the planner | **Fixed**: a trailing "jarvis" is dropped in §4. Test first; M12. "OK Jarvis, …" is recorded as a shared gap |
| T4 | low | Missed wordings: "current date", "what's today", "tell me what day it is", "what time it is", "do you know what time it is", "give me the time" | **Fixed** (added, test first) |
| T5 | low | Over-matches: "what is time", "whats time", and the fragments "what time", "what day", "date", "the date", which could be JARVIS's own words heard back; the "please" alternatives could never match | **Fixed**: removed, test first; M13 |
| T6 | low | The time reply was not checked against the local clock; a look-alike phrase could never occur; a misleading comment | **Fixed** |
| T7 | med | Records stale: space collapse, "pending" rows, the "20 of 26" count, the date format | **Fixed** (`change_log.md` rewritten, `patch_plan.md` amended) |
| T8 | low | "Get-Date" was stated as fact | **Fixed**: marked as an inference |
| T9 | info | Cache-hit rebuild correct. Minor, older: `budgetOverride` is not in the cache key; there is no warning if the line were missing | Recorded in `change_log.md` |

## Round 2 — PASS

The reviewer enumerated the 63 strings the new patterns accept, each also with " jarvis" appended: 126 in all. None reached another route on the base router, and all reach `time` or `date` now. The base's three exact phrases still answer. The trailing-"jarvis" strip affects §4 only. 18 tests passed through the runner, and the new test also passed with the host locale set to ar_SA and to ur_PK. Typecheck exit 0.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| T10 | low | On Windows, where the locale does not come from `LC_ALL`, the child locale check passes without proving anything (it cannot fail falsely) | **Fixed**: the child reports its locale; where it is not Arabic the check prints "not proven on this platform" and counts neither way |
| T11 | low | The change log claimed the locale check without that limit | **Fixed**: Known limits |
| T12 | low | "what day is it" had no idle check; the plan's date example was not the en-US form | **Fixed** |
| T13 | info | Bare "time" (base behaviour, kept) can still be an echo; "what's today" answers with the date, though a user might mean "what's on today" | Owner's scope; no change |
