# Patch Plan — browser tool load, honest replies, spoken refusals (A2 follow-up)

Gate 1: the owner approved fixes A, B and C on 2026-10-28 ("Implement one fix at a time, add tests first, run relevant tests and the full test suite, and obtain an independent review. Do not commit or push without my approval. Preserve existing browser-control functionality and subagents.").

Each fix: test written first and run on the code before the fix; the fix; its test and related tests; typecheck; the full suite.

## Fix A — a slow first load does not disable a skill (F1, F2)

File: `core/skillLoader.ts` (not protected).

- One import per skill module, kept while it runs (`pendingImports`). A call waits for it at most `IMPORT_TIMEOUT_MS` (5 s, unchanged).
- When the wait runs out, the call fails with a short reason (`{"success": false, "error": "<skill> is still loading on this PC; ask me again in a moment."}`), which the registry reads as the failure reason, so a voice route can say it. The skill is **not** degraded and the import is not dropped: the next call waits for the same import.
- Unchanged: a module that throws while loading, or has no `execute()`, is degraded as before (Phase 5).
- Test: `tests/skillImportTimeoutTest.ts`.

## Fix B — no claim of an action no tool did; no copied tool-output blocks (F4, F5)

Files: `core/spokenText.ts`, new `core/actionHonesty.ts`, `core/orchestrator.ts` (**protected**; the change is the approved fix B: the reply step is in this file).

- `stripInternalMarkup`: removes `<untrusted_context …>…</untrusted_context>` blocks (and one still open, and a stray closing tag) from what is printed, spoken and stored. In a stream it also holds back a tag that is still arriving. Used by `SpokenStream` (streamed replies), `stripMarkdown` (everything spoken) and the orchestrator's non-streamed replies and conversation memory.
- `requestedAction(input)`: the action verb when the request starts with one (after "please", "can you", "jarvis," …): close, open, kill, delete, play, … Questions ("is youtube open", "what tabs are open") do not match.
- In `handleSuccess`: when an action was asked for and every tool that ran is read-only (`toolRegistryV2.riskOf(tool, args) === 0`), JARVIS says `I didn't <verb> anything, sir. I only checked what is there. Please ask me again.` and the reply model is not asked.
- The reply model's instruction gains one sentence: say only what the tool results show; never write tool results or tags.
- Unchanged: when an action tool ran, or for a question, the reply model answers as before.
- Test: `tests/honestActionReplyTest.ts`.

## Fix C — A1's browser refusals are spoken as refusals (F6)

Files: `control/appMatch.ts` (a matcher for its two refusal texts), `core/reflectionEngine.ts`.

- `refusalVoiceMessage` recognises the page refusal and the browser refusal and speaks them as `I couldn't do that, sir. <refusal>`, in full (the browser refusal is longer than the 160-character limit used for other refusals).
- Unchanged: other failures keep the general wording.
- Test: `tests/browserRefusalSpokenTest.ts`.

## Not in these fixes

- F3: wordings such as "close youtube tab" still go to the planner (phase A3 routing).
- F8: echo of JARVIS's own voice (voice phase).
- The 5 s wait itself is not changed.
