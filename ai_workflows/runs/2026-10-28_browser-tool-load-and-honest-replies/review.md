# Review — browser tool load, honest replies, spoken refusals (A2 follow-up)

Reviewer: a separate agent session (general-purpose), read-only, tests through the runner only. Not a human.

## Round 1 — CHANGES REQUIRED

The reviewer ran 14 tests through the runner (14 passed), `tsc --noEmit` (0 errors) and one inline probe of `stripInternalMarkup`, `SpokenStream`, `requestedAction` and `isBrowserRefusal`. Fixes A and C: correct (pending import reuse, timer cleared, no unhandled rejection, degraded kept for real errors; `control_browser` is high risk so "still loading" is not retried; all browser names match; both refusals are 3 sentences). Records: counts match the evidence. The orchestrator change stays within fix B.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R1 | med | The guard replaced **correct** read-only answers ("close the youtube tab" with none open → "I didn't close anything… ask me again", which repeats forever); the verb list matched nouns ("type of cpu", "end of the month") | **Fixed**: when nothing acted, the reply model still answers (told that nothing was changed, not streamed), and only a reply that **claims** the action (`claimsAction`: the verb's past form, "now open", "done", "completed", "successfully", with no negation in that part of the sentence) is replaced; "Please ask me again" dropped; verb followed by "of", or input ending in "?", is not a request. Tests; mutant caught |
| R2 | med | `riskOf > 0` counted web lookups (web_search, get_weather, GitHub reads, all risk 1) as actions | **Fixed**: `onlyLooks` — risk 0, or a NETWORK-category `query` tool without actions. (`browser_click` is also `query`, risk 1, no actions, and does act: it stays an action because it is BROWSER, not NETWORK.) Test; mutant caught |
| R3 | med | Streaming: a closing tag arriving alone was printed and then cut, taking the following text with it (`Done, sir.</untrusted_contextpty.`) | **Fixed**: the hold-back also covers `</untru…`. Streamed test with the reviewer's exact input; mutant caught |
| R4 | low | The planner's text answer (no tool) was printed/stored without `stripInternalMarkup` and could still say "I've closed it" | **Fixed** (same fix B): stripped on that path and in the direct-conversation stream's stored text and fallback; a direct answer that claims the requested action is replaced. Test; mutant caught |
| R5 | low | "still loading" on the planner path came after "unexpected error" | **Fixed** (same fix C): `refusalVoiceMessage` speaks `I couldn't do that yet, sir. <reason>`; `skillStillLoading` / `isSkillStillLoading` in skillLoader.ts. Test; mutant caught |
| R6 | low | supersededRequestTest: meta restored outside `finally`; no case for an interrupted request whose only step reads | **Fixed**: try/finally; case 2b (its "I didn't …" stays silent) |
| R7 | info | No two-calls-at-once case; time bound tight for a slow PC | **Fixed**: case 1b (two calls at once, one load); bound widened by 1 s |
| R8 | info | Guard runs before verification replies | No change needed (it only applies when no acting step ran) |

Mutation check of the fixes (`evidence/review_mut.py`, `evidence/review_mut_run.txt`): 5/6 caught. The sixth (fix A without sharing the pending import) is equivalent: Node's module cache already makes a second `import()` of the same file wait for the first, so no test can tell them apart. Tree restored after the run.

## Round 2 — CHANGES REQUIRED (two small fixes)

The reviewer ran 16 tests and clarificationGoalTest through the runner (all pass), `tsc --noEmit` (0 errors) and an inline probe. R1–R7 fixed; no regression in browser routes, subagents or the state machine. The equivalent-mutant claim holds (Node's ESM loader keeps one module record per URL; the pending map is partly redundant, harmless). Clarifying questions on the synthesis path are kept.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| N1 | med | `claimsAction` missed "Closing the YouTube tab now", "Opening YouTube for you" (JARVIS's own launch wording), "Now playing …", "I will close …"; "No worries sir I have closed …" read as a negation | **Fixed**: -ing form, "will / 'll / going to / about to <verb>", "all set"; "no worries", "no problem", "not to worry" are not negations. Tests; mutants caught |
| N2 | med | When nothing acted the reply is not streamed, so a failed reply-model call reached the old catch: "I completed the task. Here are the results: …" | **Fixed**: in that catch, nothing acted → `noActionReply`. Test (reply model throws a 429); mutant caught |
| N3 | low | Direct answer: a clarifying question with a past form ("Should I open the file you opened yesterday?") was replaced; the replacement said "I only checked" though no tool ran | **Fixed**: clarifying questions are kept; on that path the reply is "I didn't <verb> anything, sir." Test; mutant caught |
| N4 | info | When nothing acted, the first spoken word waits for the whole (≤200-token) reply | Accepted; recorded in change_log.md |
| N5 | info | A tag written with a space can leave a double space | Not changed (cosmetic); follow-up |

Mutation check of the round-2 fixes: 4/4 caught (`evidence/review_mut_run.txt`, the N1–N3 rows); tree restored.

## Round 3 — PASS

The reviewer ran 14 tests through the runner (all pass), `tsc --noEmit` (0 errors) and a 24-phrasing probe of `claimsAction`. N1, N2, N3 fixed. Remaining notes, not changed (recorded as follow-ups):

| ID | Sev. | Finding | Outcome |
|---|---|---|---|
| P1 | low | `claimsAction` flags some truthful read-only answers as claims ("Opening hours are 9 to 5" for open; "the video is done loading" for close). JARVIS then says "I didn't <verb> anything, sir. I only checked what is there." — information lost, nothing false said | **Accepted**; to tighten if it shows on the PC (claim word after a first-person subject) |
| P2 | info | The new catch branch (reply model down, nothing acted) speaks the reply but does not store it in the conversation | **Follow-up** (one line) |
