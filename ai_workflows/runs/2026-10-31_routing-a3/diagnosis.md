# Diagnosis — routing (phase A3)

Read-only. Evidence: `evidence/probe_before.mts` (imports the route matcher, the voice normaliser and the planner's tool selection; runs nothing) and its output `evidence/probe_before.txt`, on `1a5cbee`.

| # | Finding | Evidence |
|---|---|---|
| D1 | Only the exact words "close youtube" (and "close current tab") have a route. "close youtube tab", "close the youtube tab", "close the gmail tab" go to the planner. It is offered `control_browser` and `browser_tab`, but on the PC it chose only `browser_state` (F3), so nothing closed. | probe rows 2–6; `core/deterministicRoutes.ts:205-209` |
| D2 | "enable full controll mode" and "enable fool control mode" have no route, **and** the planner is not offered `enable_full_control_session` for them (it gets open_app, web_search, get_system_info, run_command): JARVIS cannot turn full control on from these words at all. "enable full control" and "turn on full control mode" do reach the planner with the right tool (slower; model-dependent). | probe rows 10–14; `core/deterministicRoutes.ts:240`; `core/planningToolSelection.ts:226` |
| D3 | When the route does run, a failure is spoken as "Failed to enable full control, sir." with no reason (for example that it was not approved). | `core/orchestrator.ts:730-732` |
| D4 | "close notepad and chrome" is offered the browser tools only, so Notepad cannot be closed (A2 review R14). | probe row 15; `core/planningToolSelection.ts:134-139` |
| D5 | "open github.com" reaches the planner as "open githubcom": the voice normaliser removes every dot. Same for "www.google.com". | probe rows 16–17; `core/voiceInput.ts:14,26` |
| D6 | Security boundary holds today: "launch cmd /c del *" and "close the youtube tab; del *" match no route. | probe rows 18–19 |
| D7 | (N-PC3, owner's PC 2026-10-31; added after review round 1) "enable full control mode" by the fast route asked twice. The registry asks first (risk 3), then the skill asks again through `approvalGate.requestApproval`. Inside an approved call that second question is skipped only when `coversNested` matches its subject to an approved value: on the planner path the args held the duration ("15"), which is in the subject "enable_full_control_session for 15 minute(s)"; on the route path the args were `{source: 'cli'}`, so nothing matched and the owner was asked again. | `skills/enable_full_control_session/skill.ts:69-76`; `security/approvalScope.ts` (`coversNested`); routingA3Test section 4 on the old code (2 questions) |

Not in A3 (recorded): "close this tab" / "close the current tab" / "close tab" go to the planner too. The existing route for "close current tab" can press Ctrl+W in whatever browser window is in front when JARVIS's Chrome does not answer (`control/browserController.ts:165-174`) — that window can be the owner's everyday Chrome. Widening that route before phase A4 removes the Ctrl+W fallback would make the risky path easier to reach.

The exact words the speech recogniser heard for "enable full control mode" on 2026-10-27 are not in the records; D2 is shown with the typed typo the owner used and one plausible mishearing.
