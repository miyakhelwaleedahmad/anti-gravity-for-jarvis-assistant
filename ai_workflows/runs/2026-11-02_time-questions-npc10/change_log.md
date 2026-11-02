# Change Log — time questions refused (N-PC10)

Base commit: `3ed4baf`. On 2026-11-02 the owner approved:
- the fix ("i approved that");
- the edits to both protected files: "Approve both (Recommended)";
- the date answer: "Include dates (Recommended)".

This log describes the **final** code. The history is in "How it got here".

## The change

| File (protected) | Change |
|---|---|
| `core/deterministicRoutes.ts` | §4 now tests two lists of whole-sentence patterns, `TIME_QUESTION` and `DATE_QUESTION`. They run on the cleaned input after `normalizeVoiceInput` (which already collapses spaces and drops a leading "jarvis", "can you" and a trailing "please"). A trailing "jarvis" is dropped first. **Time** (reply "It is 11:22 AM, sir."): "what time is it / this (now)", "what time it is", "do you know what time it is", "what's / what is the (current) time (now)", "tell me (the) (current) time", "tell me what time it is / is", "give me the time", "current time", "time now", "time". **Date** (new route type `date`, "Today is Monday, November 2, 2026, sir."): "what's / what is the (current) date (today)", "what day is it (today)", "what day is today", "tell me what day it is", "what's / what is today's date", "what's / what is today", "today's date", "current date", "tell me (the) date". Both replies are in English (`en-US`), whatever the PC's regional format. Fragments are left to the planner: "what time", "what is time", "the time", "date", "the date", "what day". No orchestrator change: the generic branch speaks the reply (`core/orchestrator.ts:851`). |
| `memory/unifiedContextBuilder.ts` | The planner's clock line was `[SYS t=10:33:35 …]` (UTC). It is now `[SYS now=Monday 2026-11-02 16:31 local time (UTC+05:00, Asia/Karachi) …]`. On a cache hit the line is rebuilt, both in `systemState` and in the context sent to the model, so a cached context never carries an old time. |

Unchanged:
- command safety: `powershell` stays refused;
- the orchestrator;
- A3, A4 and B4 code.

One existing behaviour changes: "what time is it" now always answers in English 12-hour form. Before, it used the PC's regional format. The owner's PC already gave "It is 11:22 AM, sir." in that form.

## Tests

| File | Change |
|---|---|
| `tests/timeQuestionsNpc10Test.ts` (new) | 84 checks, run with `TZ=Asia/Karachi` (the owner's UTC+5). Each time reply must equal the Karachi clock in en-US form. **Time:** 27 wordings, including the owner's three and the trailing "jarvis"; 14 sentences that must stay with the planner (meetings, timers, other cities, fragments). **Date:** 16 wordings, each reply equal to the Karachi date; 9 look-alikes ("what is today's weather", "what day is tomorrow", fragments). **Locale:** a child process with an Arabic (Saudi) regional format (`LC_ALL`) still gets English replies. Where the child does not take that locale (Windows reads the user's settings instead), the check prints a note and counts neither way. **End to end:** three wordings typed through `process()`, each spoken with no model call and JARVIS ending idle. **Planner:** "how long until 5 pm" sends the model the local date, time and `UTC+05:00`. **Clock line:** it changes on a cache hit when the time zone changes (to Asia/Tokyo, which has no summer time). The model stand-in's reply cannot pass for a time or date reply. |
| `tests/boundary-doubles.json` | An entry for the new test (`installFakeTts`). |

## Evidence

| Check | Result | File |
|---|---|---|
| Reproduction, read-only, on the base code | 22 of 26 wordings to the planner; 4 reach the time route: the three exact ones plus "jarvis what time is it" | `evidence/probe_before.mts`, `evidence/probe_before.txt` |
| First test on the base code | 22 passed, **37 failed** | `evidence/old_code_checks.txt` |
| First test after the first change | 59/59 | (overwritten; see "How it got here") |
| Review round 1 checks on the code before their fixes | 62 passed, **21 failed** | `evidence/review_r1_old_code_checks.txt` |
| Test after review round 1 fixes | 83/83 | `evidence/review_r1_new_code_checks.txt` |
| Final test (after round 2: the locale note, one more idle check) | **84/84** | `evidence/final_checks.txt` |
| M10, M11 again on the final test | **2/2 caught**; tree restored | `evidence/npc10_mut_run_r2.txt` |
| Related tests (26: routing golden set, A3 routing, B4, echo filter, voice normaliser, memory, planner, docs hygiene) | **26 passed** | `evidence/related_tests.txt` |
| Typecheck | 0 errors | `evidence/typecheck.txt` |
| Mutation check, 12 mutants | **12/12 caught**; tree restored (md5 unchanged) | `evidence/npc10_mut.py`, `evidence/npc10_mut_run.txt` |
| Full suite | **210 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame on this machine), 9 skipped; runner exit 1 comes from the blocked test only. The round-2 test edit was made before the suite reached this test, so it ran the final version | `evidence/full_suite.txt` |

## Known limits (recorded, not changed)

- **Not verified with the real model:** whether Gemini now answers time questions that have no fast route ("how long until 5 pm") from the clock line, instead of calling `run_command`. The test uses a stand-in model; this is for the PC test.
- The time in another place ("what time is it in London") still goes to the planner, which may still reach for a shell.
- The locale check proves the English replies only where the runtime takes its locale from `LC_ALL` (Linux, macOS). On Windows, CI included, it is reported as not proven (review T10, T11). M10 and M11 were caught on Linux.
- Wordings outside the lists still go to the planner. "OK Jarvis, what time is it?" is one: `normalizeVoiceInput` drops only a leading "jarvis" / "hey jarvis", a gap shared by every route (review T3).
- Review T9 (info), not changed:
  - the cache key leaves out `budgetOverride`, which no caller passes today;
  - nothing warns if the clock line were ever missing from a cached context, which cannot happen today.

## How it got here

1. **First change:** the time and date patterns, the local clock line, and its refresh on a cache hit. The test went from 22/37 to 59/59.
2. **First mutation run** (`evidence/npc10_mut_run_first.txt`): 8/9. M2, which removed a space-collapse, was equivalent, because `normalizeVoiceInput` already collapses spaces. The redundant line was removed and diagnosis D1 corrected. 8/8 on the next run.
3. **Review round 1, CHANGES REQUIRED** (`review.md`). Fixed with tests first:
   - T1: the cache test no longer depends on London's summer time;
   - T2: replies in English whatever the regional format;
   - T3: a trailing "jarvis" is dropped;
   - T4: more wordings;
   - T5: fragments are left to the planner;
   - T6: exact local-time checks, real look-alike phrases;
   - T7 and T8: these records.
4. **Review round 2, PASS:** no code change. T10 (the locale check reports "not proven" where the child ignores `LC_ALL`), T11 and T12 (records, one more idle check) fixed; T13 is info.
