# Change Log — Close by name; tab requests close whole windows; process kill reports success unchecked

> Stage: 04_implementation
> Status: [x] Complete
> Date: 2026-10-25 · Base `e394a26`

## Changed Files
| File | Change |
|---|---|
| `control/appMatch.ts` (new) | One matching rule for app and window tools; browser rule (D3); refusal texts |
| `control/appController.ts` | Injectable `{ windows, automate, approve }`; `closeApp` via `planAppClose`; question for several windows; `focusApp`/`isAppOpen` via `matchAppWindows` |
| `control/windowController.ts` | Same injectable dependencies; `findHwnd` via `matchAppWindows`; `closeWindow` by name refuses browsers; one window-list read per close |
| `control/processController.ts` | Injectable `{ powershell, approve }`; exact name first; browser processes refused; Stop-Process exit code checked; gone-check (3 × 300 ms) |
| `core/planningToolSelection.ts` | A close request naming a tab gets `control_browser`, `browser_tab`, not `control_app`/`control_window` |
| `core/verifiers.ts` | `appWindowMatcher` moved to `control/appMatch.ts`, imported and re-exported (same behaviour) |
| `tests/closeByNameTest.ts` (new) | 39 checks: names, browsers, several windows, kill, planner, kernel |
| `package.json` | `test:pc-control` includes `closeByNameTest` |
| `ai_workflows/_config/TEST_MATRIX.md` | pc-control group: 17 → 18 named tests |
| `ai_workflows/_config/ARCH_PC_CONTROL.md` | Row for `appMatch.ts` |

## Change Details
### `control/appMatch.ts`
- `programKey`: lower case, `.exe` removed. `programFor`: "google chrome" → `chrome`, "edge"/"microsoft edge" → `msedge`, "command prompt" → `cmd`.
- `matchAppWindows`: program name first (exact before substring, so "notepad" is not "notepad++"), else window title or program via `appWindowMatcher` (Calculator by title). An empty name matches nothing (it matched every window before: `''.includes`).
- `planAppClose`: `none`; `browser` (the browser named as the app); `browser-page` (only browser windows carry the name in their titles); `close` (non-browser windows only).

### Controllers
- The real defaults (`getWindowsState`, `runAutomateScript`, `approvalGate.requestApproval`, `execa('powershell', …)`) are the same calls as before; `approvalGate.requestApproval` is looked up at call time, so tests that replace it (`adminControlTest`) still reach it.
- The kill approval text is unchanged (`approvalScope.coversNested` reads it).
- The "No open application matches" error text is unchanged (`restartApp` depends on it).

## Round 2 (after review round 1, `review.md` R1–R15)
| File | Change |
|---|---|
| `control/appMatch.ts` | More browsers (R8); partial program match only ≥3 characters and when it leaves one program, reported as `partial` (R10); the title stage tests program names only for `APP_WINDOWS` apps (found while testing R10); `ClosePlan.close.exact`; `appWindowsLeft`, `isBrowserWindow` |
| `control/appController.ts` | No handle at all → failure (R12); matched windows checked for protection (R11); several windows or a non-exact match → one question, asked outside an approved call (`withoutApproval`, R2, R10); the reply names the closed handles `(windows 0x…)` for the check (R7) |
| `control/windowController.ts` | Close by name takes the handle from the plan (R1); a browser handle is refused unless it is "close current window" (R9) |
| `control/processController.ts` | `chooseProcess` shared by kill and restart (R3); restart starts through an injectable `start` that waits for `spawn`/`error` (R3); the gone-check prints `running`/`gone` and anything else fails (R5); `findProcess` drops ".exe" (R13) |
| `control/actionQueue.ts` | Browser refusals, "still running", "Could not terminate", "could not confirm it ended" are final (no retry, no second question) (R14) |
| `core/planningToolSelection.ts` | The window branch no longer excludes tab requests: `control_window` whenever "window", minimize or maximize is said (R4) |
| `core/verifiers.ts` | `control_app close` checks exactly the handles the close named; without them, the controller's rule (R7); uses `windowChecks.onWindows()` like `control_window` |
| `tests/closeByNameTest.ts` | 72 checks after round 4, 81 after round 5, 83 after round 6 (39 at first): a case per finding; the shared-rule check imports `control/appMatch.js` itself so the test runs on the old code too |

## Round 7 (owner's decision, 2026-10-26)
| File | Change |
|---|---|
| `control/windowController.ts` | "close current window" with a browser in front: a question naming that browser window, outside any approval; no → nothing closed |
| `tests/closeByNameTest.ts` | 85 checks |

## Round 8 (after review round 7, PASS)
| File | Change |
|---|---|
| `control/windowController.ts` | A window whose program is unknown is looked up in every visible window; the front window still unknown → a confirmation question; refusals cut to fit the spoken reply (R7-1, R7-2) |
| `tests/closeByNameTest.ts` | 88 checks |

## Round 6 (after review round 5, PASS)
| File | Change |
|---|---|
| `control/windowController.ts` | Protected-window question outside the approved call, naming the program (R5-1) |
| `control/appMatch.ts` | "windows terminal", "windows powershell" names (R5-2) |
| `tests/closeByNameTest.ts` | 83 checks |

## Round 5 (after review round 4)
| File | Change |
|---|---|
| `control/appMatch.ts` | cmd pattern without Windows Terminal; `APP_HOSTS` per host with an optional title rule (Windows Terminal/conhost: "Command Prompt"/"cmd.exe"; ApplicationFrameHost: exactly "Calculator"/"Settings"); listed-app stage before the partial stage (R4-1, R4-2, R4-3) |
| `control/appController.ts` | Plan first; one protected question (target or matched window) outside the approved call, naming the windows (R4-1, R4-5) |
| `control/windowController.ts` | "close current window" checks protection with the active-window reading when the window is not in the app list (R4-4) |
| `tests/closeByNameTest.ts` | 81 checks |

## Rounds 3 and 4 (after review rounds 2 and 3)
| File | Change |
|---|---|
| `control/windowController.ts` | `allWindows` dependency; owner of a handle from the app list, else from every visible window; unknown/unreadable refused; protection on that owner (R2-1, R3-3, R3-4) |
| `control/appMatch.ts` | `APP_HOSTS`: a listed app counts as the app only in its own program's window (R2-5, R3-1, R3-2) |
| `control/appController.ts` | Protected-window question outside the approved call; question titled "Close Matching Windows" (R2-4, R2-5) |
| `control/processController.ts` | `terminate(chosen)` shared; restart checks permission, chooses once, reports "Ended X, but could not start it again" (R2-2, R2-8) |
| `control/actionQueue.ts` | "could not start it again", "was not closed: " final (R2-2, R2-1) |
| `core/verifiers.ts` | Handle list read from the end of the reply (R2-3) |

## TypeScript Compile Check
`pnpm run typecheck` → `tsc --noEmit`, 0 errors (cloud Linux, after the round-2 edits).

## Unplanned Changes
- `control/actionQueue.ts` was not in the plan; changed in round 2 for R14 (listed in `patch_plan.md`).
- Self-review after the first green run (before review): `closeWindow` reads the window list once (was three times); the kill's gone-check retries up to 3 times, 300 ms apart (a terminated process can stay listed for a moment); two test cases added (Notepad++, an entry without a handle) and one for an empty name. All inside the plan's scope; listed here for the owner.

## Ready to Advance to Verification?
- [x] All approved changes applied
- [x] No unplanned changes made (beyond the self-review items listed above)
- [x] pnpm run typecheck → 0 errors
- [x] Change log complete
