# ARCH_PC_CONTROL.md — Windows, Browser and PC Control Reference

> Topic reference for Windows, desktop, browser and file/dev-tool bugs.
> Paths checked against the repository on 2026-10-23
> (`claude/jarvis-repair`). The code wins. Design docs:
> `docs/upgrade/PC_CONTROL.md`, `BROWSER_CONTROL.md`, `SYSTEM_AWARENESS.md`,
> `FILES_AND_DEV.md`, `SECURITY_MODEL.md`, `PERMISSION_MODEL.md`.

## Control (`control/`) — acting on the PC

| File | Role |
|---|---|
| `pcControlKernel.ts` | The single authority for local PC actions: permission checks and the audit log |
| `permissionSession.ts`, `permissionDenial.ts` | Permission levels (enforced at dispatch and controller layers); how a refusal is explained |
| `actionQueue.ts`, `actionAuditLog.ts`, `rollbackManager.ts` | Serialized actions with timeouts; `logs/jarvis-actions.jsonl`; undo where possible |
| `appController.ts`, `windowController.ts`, `processController.ts`, `systemController.ts`, `adminController.ts`, `fileController.ts` | Apps, windows, processes, system settings, admin functions, files |
| `inputController.ts`, `keyboardController.ts`, `mouseController.ts` | Serialized keyboard and mouse input |
| `uiAutomation.ts`, `uiRefs.ts`, `uia.ps1`, `win_automate.ps1`, `helper.ts` | Windows UI Automation: elements of a window and actions on them |
| `desktopControl.ts`, `desktop.ps1` | Screenshots and the clipboard |
| `browserController.ts`, `browserAgent.ts`, `youtubeControl.ts` | Chrome through the DevTools Protocol; browser actions; YouTube in the owner's Chrome |

## Perception (`perception/`) — reading the PC

| File | Role |
|---|---|
| `cdpClient.ts`, `cdpScripts.ts`, `browserState.ts`, `browserRefs.ts`, `chromeState.ts` | Chrome DevTools client, the fixed page scripts, tabs and page text, element references |
| `windowsState.ts`, `windowsProbe.ts`, `windows_probe.ps1`, `get_windows_state.ps1` | Persistent PowerShell session; Windows readings |
| `systemProbe.ts`, `systemStateObserver.ts`, `jarvisServiceState.ts` | Machine snapshot; observed system state; JARVIS's own services |
| `devProbe.ts`, `gitProbe.ts` | Running dev servers; git state of project folders |

## Policy (`security/`) — what may run

| File | Role |
|---|---|
| `riskEngine.ts`, `approvalGate.ts`, `approvalRequest.ts`, `approvalScope.ts` | Run / ask / refuse per call; human approval |
| `commandValidator.ts`, `commandObfuscation.ts`, `developerCommands.ts`, `permissionManager.ts` | Shell command risk (unknown = high risk), obfuscation, the `run_command` allow-list |
| `openAppPolicy.ts`, `browserPolicy.ts`, `fsPolicy.ts`, `workspacePathPolicy.ts`, `protectedTargets.ts` | What `open_app`, browser and file actions may touch |
| `secretFiles.ts`, `redactor.ts`, `untrustedText.ts` | Secret-named files, credential redaction, untrusted outside text |
| `remoteAccess.ts` | Groundwork only: remote access is not available |

## Tools (`core/tools/`, `tools/`)

`windowsTools.ts`, `browserTools.ts`, `browserActionTools.ts`,
`youtubeTools.ts`, `observationTools.ts`, `diagnosisTools.ts`;
`tools/fsTools.ts` (`files`), `tools/devTools.ts` (`dev`),
`tools/gitTools.ts`, `tools/githubTools.ts`, `tools/terminalTool.ts`,
`tools/webSearchTool.ts`.

## Verification on Windows

- `pnpm test:pc-control` acts on the desktop (Notepad); see the Windows note
  in `TEST_MATRIX.md`. `pnpm verify:windows` (`scripts/verifyWindows.ts`)
  checks the Windows scripts on the owner's PC.
- On other hosts the Windows tests are BLOCKED or SKIPPED, which is not a
  pass. Windows behaviour counts as fixed only after a run on the owner's PC.
