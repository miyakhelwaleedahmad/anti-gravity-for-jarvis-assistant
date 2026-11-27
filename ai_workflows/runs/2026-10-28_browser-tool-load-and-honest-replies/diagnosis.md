# Diagnosis — the YouTube tab was not closed (phase A2, PC step 3)

Owner's PC, 2026-10-28, branch `claude/jarvis-repair` at `ec0b6e7`. Read-only: no file was changed for this diagnosis. Quoted lines are from the owner's console log (kept outside the repository; it contains personal data).

## What the owner saw

- After "open youtube", YouTube opened in JARVIS's Chrome (port 57363).
- "close YouTube for me", "close youtube tab", "close the youtube tab": JARVIS said the tab was closed at least once; the tab stayed open.
- PC check afterwards (`/json/list` on port 57363): `https://www.youtube.com/` still open, page ID `8CEED9E106F03BF248D24D6DCD473BD6`; two `browser_ui` entries "Omnibox Popup" (Chrome's own address-bar popups, not pages).

## Findings

| # | Finding | Evidence |
|---|---|---|
| F1 | **The browser tool stopped working for the rest of the session after one slow load.** "close youtube" took the fast route `close_browser_tab` → `control_browser`. Its module is loaded on first use, with a 5 s limit. On the owner's PC it took longer: `[SkillLoader] Control Browser: failed to import skill module: Error: import timeout after 5000ms`. `core/skillLoader.ts` then adds the skill to `degradedSkills` (line 159), and every later call returns at once with "Skill … is degraded and cannot execute" (line 206) until JARVIS restarts. The import itself is not cancelled and probably finished a moment later, but its result is thrown away. | log lines 946–957; `core/skillLoader.ts:150-160, 204-208` |
| F2 | **Why the load was slow:** at the same moment the PC was busy — the PowerShell session had hung and was being restarted (`PowerShell has not finished a query in 30s — restarting the session`, same second), and the memory model was still loading (`Embedding model ready after 211.4s`). In the cloud the same import takes about 0.3–0.5 s (0.4–0.5 s on 2026-10-28; 0.3 s when re-run on 2026-10-31, `evidence/import_time.txt`). The PC's exact load time is not known: the log only shows it was over 5 s. | log lines 953–957, 1590; `evidence/import_time.txt` |
| F3 | **"close youtube tab" never reached a close tool.** Only the exact words "close youtube" have a fast route. "close youtube tab" and "close the youtube tab" went to the AI planner, which was offered `control_browser` and `browser_tab` but chose only `browser_state` (reads the tab list). The plan is made in one step, so nothing closed the tab. (Had it chosen `control_browser`, F1 would still have stopped it.) | log lines 1269, 1503 (`Model called 1 tool(s): browser_state`); `core/planningToolSelection.ts:134-137` |
| F4 | **False success claim.** After only `browser_state` ran, the reply step (a second, small AI model) said "I have closed the YouTube tab for you, sir." Nothing in the reply step checks whether an action tool ran. | log lines 1283–1299, 1321; `core/orchestrator.ts` (handleSuccess / streamSynthesis) |
| F5 | **Made-up tool output was printed and spoken.** The reply model copied the format JARVIS uses to hand it tool results (`<untrusted_context source="toolresults">` + `[tool]: …`) and invented `[browser_action]: {"success": true, "closedTabId": "8CEED9E1…"}`. No code in the repository, now or in its history, produces `closedTabId` or a `browser_action` tool (`git log --all -S closedTabId` is empty). The ID is the real YouTube tab's ID, which `browser_state` had just returned. The reply was streamed to the voice sentence by sentence, so it was spoken ("untrusted context source toolresults…") and then cut with "I have printed the full details to the console". | log lines 1537–1547; `grep -rn closedTabId` (none) |
| F6 | **The right refusal was spoken as "unexpected error".** For "I just say to you that close youtube" the planner chose `control_window`, and later `control_app`; both refused correctly with phase A1's message (`"YouTube" is a page open in Chrome, not an app. Ask me to close the YouTube tab instead.`). The spoken reply began with "I encountered an unexpected error and have been unable to complete the task, sir." because `reflectionEngine.refusalVoiceMessage` does not know A1's browser refusals, so the generic failure text was used. | log lines 1192, 1254, 1417, 1484; `core/reflectionEngine.ts:741-771`; `control/appMatch.ts:184-192` |
| F7 | **"Another Chrome."** The window was JARVIS's own Chrome (separate profile), started because the one from the earlier run had closed: `Starting Chrome … JARVIS's Chrome answers on 127.0.0.1:57363` (the earlier run used 57170). This is the designed behaviour (D1, Q1). | log lines 901–902 |
| F8 | Echo (JARVIS hearing its own "Opening youtube, sir." as a command) — seen in an earlier log; not part of these fixes, recorded for the voice phase. | earlier log |

## Root cause (proved from the log and the code)

The tab was not closed because (F1) the one fast route that would close it hit the 5 s first-load limit on a busy PC and the loader then disabled the browser tool for the whole session, and (F3) the other wordings went to the planner, which only read the tab list. JARVIS then said it had closed the tab (F4, F5) although no close ran.

## Not proved

- How long the import took on the PC (only "over 5 s").
- Whether the import would have finished: the code does not log it.
- Why the planner chose `browser_state` (model choice; not deterministic).

## Fixes approved by the owner (2026-10-28)

- A: a slow first load no longer disables the tool for the session (F1).
- B: no claim of an action that no tool did; copied tool-output blocks are not printed or spoken (F4, F5).
- C: the refusal is spoken as written (F6).
- Not in these fixes: F3 (wordings for closing a tab: phase A3 routing), F8 (voice phase).
