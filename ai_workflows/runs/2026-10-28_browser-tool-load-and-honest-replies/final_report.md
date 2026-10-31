# Final Report — browser tool load, honest replies, spoken refusals (A2 follow-up)

Status: **implemented and tested in the cloud; not verified on the owner's PC.** Not committed (waiting for the owner's approval).

## What was wrong (owner's PC, 2026-10-28)

The YouTube tab was not closed: the browser skill's first load took over 5 s on the busy PC and the loader disabled it for the session; other wordings went to the planner, which only read the tab list. JARVIS then said it had closed the tab and spoke a made-up tool result. A correct refusal was spoken as "unexpected error". (`diagnosis.md`)

## What changed

- **A** — a slow first load no longer disables a skill; the next call waits for the same load; JARVIS says "<skill> is still loading on this PC; ask me again in a moment" (spoken as "I couldn't do that yet, sir. …" on the planner path).
- **B** — JARVIS's internal tool-output wrapper is never printed, spoken or stored; when an action is asked for and only read-only tools ran (or no tool), a reply that claims the action is replaced by "I didn't <verb> anything, sir. …"; correct answers ("no YouTube tab is open") and clarifying questions are kept.
- **C** — phase A1's refusals are spoken as "I couldn't do that, sir. <refusal>", in full.

Files: `core/skillLoader.ts`, `core/spokenText.ts`, `core/actionHonesty.ts` (new), `core/orchestrator.ts` (protected, fix B only), `core/reflectionEngine.ts`, `control/appMatch.ts`; tests: 3 new, 2 changed (`tests/boundary-doubles.json`, `tests/supersededRequestTest.ts`). (`change_log.md`)

## Evidence

Each test failed on the code before its fix; final full suite 205 passed, 0 failed; typecheck 0 errors; mutation checks 9/10 (1 equivalent); independent review PASS in round 3. (`verification.md`, `review.md`)

## Owner's PC checks (after the owner approves commit and push)

1. Pull, then run the three new tests and the changed one through the runner.
2. Start JARVIS; right after startup (PC busy) say "open youtube", then "close youtube". Expected: the tab closes, or JARVIS says the browser controls are still loading — and the next "close youtube" closes it. Never "degraded" for the rest of the session.
3. Say "close the youtube tab". Expected: either the tab closes, or JARVIS says it did not close anything. Never "I have closed …" with the tab still open; never "untrusted context" spoken.
4. Say "close youtube for me" if the planner picks the window or app tool. Expected: "I couldn't do that, sir. "YouTube" is a page open in Chrome, not an app. Ask me to close the YouTube tab instead." — no "unexpected error".

## Follow-ups

- F3: tab-close wordings beyond "close youtube" go to the planner (phase A3 routing).
- F8: echo of JARVIS's own voice (voice phase).
- P1: `claimsAction` sometimes treats a truthful read-only answer as a claim (safe: JARVIS then says it did nothing).
- P2: the reply-model-down branch does not store its reply in the conversation.
- N5: a tag written with a space can leave a double space (cosmetic).
