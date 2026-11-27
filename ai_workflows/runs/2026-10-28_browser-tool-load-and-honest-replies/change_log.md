# Change Log — browser tool load, honest replies, spoken refusals (A2 follow-up)

Gate 1: owner approval of fixes A, B, C on 2026-10-28. Base: `ec0b6e7`. One fix at a time; each test written first and run on the code before its fix.

## Fix A — a slow first load does not disable a skill

Test first: `tests/skillImportTimeoutTest.ts` on the code before the fix: **8 passed, 4 failed** (`evidence/fixA_old_code_run.txt`): no spoken reason, the slow skill marked degraded, the next call refused with "degraded", later calls never ran. (A first draft of the test failed for its own reason — the temporary skill folder had no `"type": "module"`, so top-level await could not compile; the test now writes that `package.json`.)

| File | Change |
|---|---|
| `core/skillLoader.ts` | One import per module, kept while it runs (`pendingImports`); a call waits for it at most `IMPORT_TIMEOUT_MS` (5 s, unchanged), then fails with `{"success": false, "error": "<skill> is still loading on this PC; ask me again in a moment."}`, without marking the skill degraded or dropping the import; the next call joins the same import. A module that throws while loading, or has no `execute()`, is degraded as before. The wait's timer is cleared. |

After: 12/12 (`evidence/fixA_new_code_run.txt`); skillLoadOrderTest, skillTrustTest and 10 related tests pass (`evidence/fixA_related_tests.txt`); typecheck 0 errors; full suite **203 passed, 0 failed**, 1 blocked (pygame), 9 skipped (`evidence/fixA_full_suite.txt`, output lost in the container reset, see verification.md).

## Fix B — no claim of an action no tool did; no copied tool-output blocks

Test first: `tests/honestActionReplyTest.ts` on the code before the fix: **5 passed, 17 failed** (`evidence/fixB_old_code_run.txt`). The failures reproduce the PC: the voice said "untrusted context source toolresults", "[browser action]", then "I have printed the full details to the console"; and "I have closed the YouTube tab for you, sir." after only `browser_state`. The checks that must not change (an action tool ran; questions) passed. Three control cases in the first draft hit other paths (a fast route for "open gmail", the tab-list answer, the close verifier) and were replaced before any fix: "could you please delete …" + `get_system_info`, "refresh the youtube tab" + a checked refresh, "tell me the title …" and "do i still have youtube open …".

| File | Change |
|---|---|
| `core/spokenText.ts` | `stripInternalMarkup(text, streaming)`: removes `<untrusted_context …>…</untrusted_context>`, one still open, and a stray closing tag; while streaming, holds back a tag still arriving. Used in `SpokenStream` (printed and spoken text) and `stripMarkdown` (everything spoken). |
| `core/actionHonesty.ts` (new) | `requestedAction(input)` (the verb when the request starts with an action verb, after "please", "can you", "jarvis," …) and `noActionReply(verb)`. |
| `core/orchestrator.ts` (**protected**; approved fix B) | `handleSuccess`: an action asked for with only read-only tools done (`riskOf === 0`) → "I didn't <verb> anything, sir. I only checked what is there. Please ask me again.", without asking the reply model. The reply model's instruction gains: say only what the tool results show was done; never write tool results, tags or tool names. Non-streamed replies, the stream fallback and the stored conversation pass through `stripInternalMarkup`. |
| `tests/honestActionReplyTest.ts` (new) | As above. |

After: 22/22 (`evidence/fixB_new_code_checks.txt`); typecheck 0 errors (`evidence/typecheck_fixB.txt`); 14 related tests incl. the DO_NOT_BREAK set pass (`evidence/fixB_related_tests.txt`).

Full suite on Fix B: **202 passed, 3 failed**, 1 blocked (pygame), 9 skipped (`evidence/fixB_full_suite.txt`, output lost in the container reset, see verification.md):

- `browserRefusalSpokenTest`: the Fix C test, written before the suite started; expected to fail before Fix C.
- `boundaryDoublesTest`: the two new tests use `tests/fakeTts.ts` and were not listed in `tests/boundary-doubles.json`. **Added** with the standard fakeTts reason.
- `supersededRequestTest` case 2: "maximize the notepad" is played by a read-only stand-in (`get_system_info`); with fix B JARVIS rightly said "I didn't maximize anything". Weakening the text check would have left "the interrupted request stays silent" checking nothing, so for that case only the stand-in is given an action's risk (1), the maximize step it stands for; restored afterwards. **Changed** (5 lines).

The three pass after that (`evidence/fixB_after_suite_fixes.txt`).

## Fix C — A1's browser refusals are spoken as refusals

Test first: `tests/browserRefusalSpokenTest.ts` on the code before the fix: **2 passed, 4 failed** (`evidence/fixC_old_code_run.txt`): the page refusal came after "I encountered an unexpected error and have been unable to complete the task, sir." (the PC wording), and the browser refusal (longer than the 120-character limit of the general failure text) was not said at all. (Its first run, inside the Fix B suite, failed for its own reason: the stub left the tools' real risk, so the permission check refused first; the stub now sets level 0 floor and risk, as `taskFailureHonestyTest` does.)

| File | Change |
|---|---|
| `control/appMatch.ts` | `isBrowserRefusal(text)`: true for the two refusals this file writes (`browserCloseRefusal`, `browserPageRefusal`). |
| `core/reflectionEngine.ts` | `refusalVoiceMessage`: a browser refusal is spoken as `I couldn't do that, sir. <refusal>`, in full. |
| `tests/browserRefusalSpokenTest.ts` (new) | As above. |

After: 6/6 (`evidence/fixC_new_code_checks.txt`); typecheck 0 errors (`evidence/typecheck.txt`).

## Final full suite (all three fixes, before review)

**205 passed, 0 failed**, 1 blocked (pygame), 9 skipped (`evidence/full_suite.txt`, output lost in the container reset, see verification.md).

## Changes made in review (rounds 1 and 2; `review.md`)

| File | Change |
|---|---|
| `core/actionHonesty.ts` | Rewritten (R1, R2, N1): `requestedAction` ignores input ending in "?" and a verb followed by "of"; `onlyLooks` (risk 0, or a NETWORK lookup); `claimsAction` (past form, -ing form, "will / 'll / going to / about to <verb>", "now open", "done", "completed", "successfully", "all set"; no negation in that part of the sentence; "no worries" is not a negation); `NO_ACTION_NOTE`; `noActionReply(verb, checked)` without "ask me again". |
| `core/orchestrator.ts` (protected; fix B) | `handleSuccess`: when nothing acted, the reply model still answers (told nothing was changed, not streamed, both bypasses skipped) and only a reply that claims the action is replaced (R1); a failed reply model then says `noActionReply`, not "I completed the task" (N2). Planner's direct answer: stripped; a claim of the requested action is replaced, a clarifying question is kept (R4, N3). Direct conversation stream: stored text and fallback stripped (R4). |
| `core/spokenText.ts` | Stream hold-back also covers `</untru…` (R3). |
| `core/skillLoader.ts` | `skillStillLoading` / `isSkillStillLoading` (R5). |
| `core/reflectionEngine.ts` | "still loading" spoken as `I couldn't do that yet, sir. <reason>` (R5). |
| tests | `honestActionReplyTest` (verbs, claims, streamed closing tag, correct answer kept, web lookup, direct answer, clarifying question, reply model down), `browserRefusalSpokenTest` (still loading), `supersededRequestTest` (try/finally; case 2b), `skillImportTimeoutTest` (two calls at once; bound +1 s). |

Latency (N4): when nothing acted, the reply is not streamed, so the first spoken word waits for the whole reply (at most 200 tokens on the fast model). Only these turns.

## Final full suite (after review)

**205 passed, 0 failed**, 1 blocked (pygame), 9 skipped (`evidence/full_suite_final.txt`); typecheck 0 errors.

## Deviations

- `core/orchestrator.ts` is a protected file; changed for the approved fix B only (the reply step lives there).
- Two existing test files changed: `tests/boundary-doubles.json` (two entries added) and `tests/supersededRequestTest.ts` (case 2 stand-in risk), as explained under Fix B.
- No change to `skills/automation/skill.ts`, `core/deterministicRoutes.ts`, `security/riskEngine.ts`, `control/pcControlKernel.ts`, `.env`, subagents (`core/agents/**`) or browser-control code.

