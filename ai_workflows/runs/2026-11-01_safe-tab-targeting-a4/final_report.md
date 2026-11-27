# Final Report — safe tab targeting (phase A4)

Status: **implemented and tested in the cloud; independent review PASS in round 3; not committed.** It has not been checked on the owner's PC (`verification.md`, "Owner's PC test plan").

## What was wrong

On the owner's PC on 2026-11-01:
- "close youtube tab" closed the tab, but JARVIS said it was still open.
- Closing the last tab shut JARVIS's Chrome down.
- Each "open youtube" added another tab.
- The fast route and the planner's tab tool followed different permission rules.

The audit found more (TRA-01/02/11):
- two tab finders with different rules;
- an empty name that matched every tab;
- no question when several tabs matched;
- "the first listed" tab when none was on screen;
- Ctrl+W and Ctrl+R pressed into whatever browser window was in front;
- a port taken from a stale file or guessed (9222).

The diagnosis is in `diagnosis.md`, D1–D12.

## What changed

- **One tab finder for every tool.** A name matching several tabs closes the one on screen. If none of them is on screen, or two are, JARVIS asks which (Q1). With no name, JARVIS takes the tab on screen, or asks when there isn't one.
- **One rule for closing a tab, decided from the tab that was found.** A YouTube or blank tab closes at the normal level; any other tab needs full control. A GitHub or Antigravity tab asks first. This applies to both tools (Q2).
- **The close check waits** up to 2 s for Chrome to finish closing the tab.
- **The last tab:** a blank tab opens first, so JARVIS's Chrome stays open (Q4). Closes run one at a time.
- **"open youtube"** brings an open YouTube tab to the front, matched on the same scheme, host and port (Q3).
- **Only JARVIS's checked Chrome:** the tab tools and the page tools that act never use a stale profile port or 9222. No key presses are sent into other windows.
- **New fast routes** for "close this tab", "close the tab" and "close the current tab". They need full control.
- **Spoken replies** (the owner approved two lines in `core/orchestrator.ts`):
  - the question alone, without "encountered an issue";
  - "My Chrome is not running, sir, so I did not change any tab."
- **YouTube pause and play with Chrome minimised** go to the most recently used video tab.

The full list is in `change_log.md`.

Files changed:
- Protected, owner-approved: `core/deterministicRoutes.ts` (P8), `security/riskEngine.ts` (P5) and `core/orchestrator.ts` (two lines).
- New: `perception/tabResolver.ts` and `control/tabClose.ts`.
- Changed: `control/browserController.ts`, `control/browserAgent.ts`, `control/jarvisChrome.ts`, `control/actionQueue.ts`, `control/youtubeControl.ts`, `perception/browserState.ts` and `core/verifiers.ts`.
- Tests: `tabTargetingA4Test` and `tabRouteReplyA4Test` (new); `browserControlTest` check 4 and `tests/boundary-doubles.json` (changed).

## Evidence

- Each new check failed on the code before its fix:
  - the first A4 test, 15 passed and 37 failed;
  - review round 1, 11 failed;
  - round 2, 1 failed;
  - the spoken replies, 7 failed;
  - round 3, 2 failed.
- Now: `tabTargetingA4Test` 72/72 and `tabRouteReplyA4Test` 17/17.
- Mutation check: 28 mutants, all caught, including the audit's MB, MD and ME.
- Full suite, final run after R18: **208 passed, 0 failed**, 1 blocked (pygame), 9 skipped. Typecheck 0 errors.
- Independent review: CHANGES REQUIRED in rounds 1 and 2, then PASS in round 3.

## Follow-ups

- The read tools (`browser_state`, `browser_read_page`, `browser_page_structure`) still use `cdpPort()`. They change nothing; follow-up in A5.
- `searchYouTube` reads the oldest results tab (R17), and playback's `tabQuery` keeps its own matcher.
- Page titles are spoken inside the "which tab" question; they are redacted and short (R19).
- Voice phase: echo and noise. B4: typed input while JARVIS is listening.
