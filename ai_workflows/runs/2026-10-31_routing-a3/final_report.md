# Final Report — routing (phase A3)

Status: **implemented, tested in the cloud, independent review PASS (round 3); not committed**. Not yet checked on the owner's PC (`verification.md`).

## What was wrong (owner's PC, 2026-10-27 to 2026-10-31)

- "close youtube tab" and "close the youtube tab" had no fast route. The planner then read the tab list and closed nothing.
- "enable full controll mode" and "enable fool control mode" had no route, and the planner was not offered the full-control tool for them.
- The fast route for "enable full control mode" asked for approval twice. A refusal was spoken as "Failed to enable full control, sir."
- "close notepad and chrome" could not close Notepad.
- "github.com" lost its dot.

(`diagnosis.md`, D1–D7)

## What changed

- **"close [the] <name> tab"** closes that tab in JARVIS's own Chrome by the fast route.
  - It is not used for filler words ("the", "my", "first"), "all", "this", "current", or URL pieces (www, com). Those go to the planner.
  - A name is 1–3 words; each word is 2–64 characters, and a dot is kept ("github.com").
- **Near-misses of "enable full control mode"** take the same route, and the planner is offered the tool for them. "Disable", "off", questions and extra words never match.
- **Full control asks for approval once.** That one question comes from the tool registry; the skill asks again only when it is called outside that exact approval. A refusal is spoken as not approved.
- **"close notepad and chrome"** is offered the app tools as well as the browser tools.
- **The voice normaliser** keeps a dot between letters or digits.

Files:
- `core/deterministicRoutes.ts` and `core/orchestrator.ts` (both protected; approved).
- `core/fullControlPhrase.ts` (new), `core/planningToolSelection.ts`, `core/voiceInput.ts`, `skills/enable_full_control_session/skill.ts`.
- Tests: `tests/routingA3Test.ts` (new); `tests/boundary-doubles.json`, `tests/fixtures/route-golden.json` and `tests/honestActionReplyTest.ts` (changed).

(`change_log.md`)

## Evidence

- **Before and after:** the test failed on the old code (32 passed, 27 failed). The review-round checks failed before their fixes (16 failed for round 1; 7 failed for N1 in round 2).
- **Now:** 89/89 checks pass.
- **Full suite:** 206 passed, 0 failed, 1 blocked (pygame).
- **Typecheck:** 0 errors.
- **Mutation check:** 16/16 caught.
- **Independent review:** CHANGES REQUIRED in round 1 (R1, medium: "close the tab" used "the" as a tab name). It passed in rounds 2 and 3.

(`verification.md`, `review.md`)

## Owner's PC checks (after the owner approves commit and push)

1. Pull, then run `pnpm test -- --only=routingA3Test,routeGoldenTest,honestActionReplyTest`.
2. "open youtube", then "close the youtube tab". Expected: the tab closes; the log shows `close_browser_tab`, no planner.
3. "enable full controll mode". Expected: one approval box; answer no. Expected: JARVIS says it was not approved.
4. "close notepad and chrome", with Notepad open. Expected: both close, or JARVIS says plainly which one it could not close.
5. "open github.com". Expected: the log's normalised text keeps the dot.

## Follow-ups

- "close this tab" / "close the tab" / "close the current tab": phase A4 (Ctrl+W fallback first).
- N-PC4, N-PC5, N-PC6 (tab-close timing, duplicate YouTube tabs, two permission rules): A4.
- Names with a stop word ("new york times", "google one") go to the planner: slower, still works.
