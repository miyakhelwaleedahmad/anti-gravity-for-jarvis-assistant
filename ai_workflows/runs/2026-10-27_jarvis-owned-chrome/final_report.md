# Final Report — JARVIS-owned Chrome and "close the browser" (phase A2)

## Verdict

⚠️ **Partially verified.** Implemented, unit and integration tested in the cloud (including a real headless Chromium), independently reviewed (PASS in round 3). Not yet observed on Windows CI or on the owner's PC.

## What changed for the owner

- JARVIS starts a Chrome of its own when it opens a page (`open youtube`, `open chrome` / `open browser`, YouTube and site searches, `control_app` / `control_browser` opens). It has its own profile (`%USERPROFILE%\jarvis-chrome-profile` unless `JARVIS_CHROME_PROFILE` says otherwise) and a debugging port Chrome chooses. JARVIS's tab tools see this Chrome.
- Pages never open in the default browser any more. When JARVIS's Chrome cannot start, JARVIS says why and what to do (for example "Chrome was not found on this PC: install Google Chrome, or set JARVIS_CHROME_PATH to its program").
- "Close the browser" / "close chrome" (needs full control mode) asks every time — "Close JARVIS's Chrome (3 tabs: …)? Your own Chrome stays open." — and closes only JARVIS's Chrome. Answer within about 15 seconds; a later answer closes nothing.
- Start instructions fit the platform JARVIS runs on (TRA-16).

## Deviations for the owner to approve

From `change_log.md`:
1. `core/orchestrator.ts` (protected): the `open_app` route speaks the short reason and fix when JARVIS's Chrome cannot be used. This is how Q2 ("fail and say why") is heard; without it a long reason became "encountered an issue".
2. `control/pcControlKernel.ts` (protected; the plan listed it under "Others"): the `closeBrowser` method and passing the tool's abort signal to it.
3. `control/appController.ts` (not in the plan's list): `control_app open` with a web address or Chrome uses JARVIS's Chrome (review R1).

## Known limits (recorded for later phases)

- A4: with no Chrome of JARVIS's reachable, the read and tab tools still try the port in a stale profile file, or 9222 (R2); "close current tab" / refresh still fall back to Ctrl+W / Ctrl+R in the browser window in front.
- A3: a mixed request such as "close notepad and chrome" is offered only the browser tool (R14).
- B4: a question asked by a tool is inside that tool's 15–20 s budget (A1's questions too) (R3-1).
- R10: a Chrome that takes over 2 s to answer `/json/version` counts as not running.
- Security (accepted): JARVIS's Chrome keeps sign-ins made in it and stays open after JARVIS exits; its debugging port is loopback-only without a password.

## Owner checks on the PC (after pull)

1. `pnpm test -- --only=jarvisChromeTest,taskFailureHonestyTest,closeByNameTest` → all pass.
2. If `.env` has `JARVIS_CDP_PORT`, remove it (otherwise JARVIS only uses a Chrome you start yourself).
3. "open YouTube" → a separate Chrome window (JARVIS's) opens YouTube; the everyday Chrome is not used.
4. "close the YouTube tab" → that tab closes; the window stays.
5. Full control mode on, "close the browser" → JARVIS asks; answer yes within about 15 s → JARVIS's Chrome closes; the everyday Chrome stays open.

## Commit

Committed by name on `claude/jarvis-repair` (see `closure.md`). Not pushed: pushing needs the owner's approval (Gate 2).
