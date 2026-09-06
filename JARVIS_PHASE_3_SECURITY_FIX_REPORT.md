# JARVIS Phase 3 Security Fix Report

Date: 2026-07-07
Scope: Phase 3 only - dangerous local security risks before more features
Status: COMPLETE

## Phase 1 and Phase 2 Confirmation

- Phase 1 security gate report found: `JARVIS_STEP_1_SECURITY_FIX_REPORT.md`
- Phase 2 YouTube voice report found: `JARVIS_PHASE_2_YOUTUBE_VOICE_FIX_REPORT.md`
- Phase 1 fixes confirmed in the security gate, command validator, terminal tool, and audit logger.
- Phase 2 fixes confirmed in voice normalization, deterministic YouTube routing, `open_app` dry-run support, and STT echo-filter delegation.

## Files Changed

- `skills/automation/skill.ts`
- `skills/automation/description.json`
- `bridge/nodeBridge.ts`
- `voice/wakeWords.py`
- `voice/stt.py`
- `voice/tts.py`
- `security/approvalGate.ts`
- `security/permissionManager.ts`
- `security/securityAuditLogger.ts`
- `core/commandSafety.ts`
- `core/orchestrator.ts`
- `control/permissionSession.ts`
- `skills/enable_full_control_session/skill.ts`
- `skills/enable_full_control_session/description.json`
- `.env.example`
- `tests/securityGateUnitTest.ts`
- `tests/openAppSecurityTest.ts`
- `tests/bridgeAuthUnitTest.ts`

## Security Risks Fixed

- Blocked arbitrary `open_app` targets from reaching `cmd.exe /c start`.
- Removed shell metacharacter injection paths from `open_app`.
- Added authenticated WebSocket bridge handshakes.
- Kept the bridge localhost-only and fail-closed when `JARVIS_BRIDGE_TOKEN` is missing outside explicit dev mode.
- Added voice-aware approval feedback and short timeout for high-risk voice approvals.
- Removed broad dev tools from safe read-only command classification.
- Forced full-control sessions through explicit approval, with bounded duration and audit logging.

## open_app Safety Changes

- Added strict allowlist:
  - `youtube` -> `https://www.youtube.com`
  - `google` -> `https://www.google.com`
  - `gmail` -> `https://mail.google.com`
  - `github` -> `https://github.com`
  - `chrome` -> `chrome.exe`
  - `notepad` -> `notepad.exe`
  - `calculator` / `calc` -> `calc.exe`
- `cmd` / `command prompt` now require explicit approval and are rejected in dry-run without approval.
- Rejected raw URLs unless exactly allowlisted.
- Rejected absolute paths, UNC paths, script/executable extensions, and shell metacharacters.
- Added audit log event for every attempt with timestamp, requested target, resolved target, allowed/rejected, source, and reason.
- Windows spawn remains `spawn('cmd.exe', ['/c', 'start', '', resolvedTarget], { shell: false })`, but only after validation.

## WebSocket Auth Changes

- Added `JARVIS_BRIDGE_TOKEN` and `JARVIS_BRIDGE_DEV_MODE` to `.env.example`.
- `NodeBridge.start()` refuses non-localhost bind hosts.
- `NodeBridge.start()` fails clearly if token is missing and dev mode is not explicitly enabled.
- First client message must be `client_ready` with a valid token unless `JARVIS_BRIDGE_DEV_MODE=true`.
- Unauthenticated clients are closed with policy violation code `1008`.
- Python clients now send the bridge token in `client_ready`:
  - `voice/wakeWords.py`
  - `voice/stt.py`
  - `voice/tts.py`

## Approval Gate Changes

- Console/text approvals still require explicit `YES`, `APPROVE`, or `CONFIRM`.
- Voice-mode high-risk approvals speak the request first.
- Voice-mode approvals accept spoken confirmation through STT or typed confirmation.
- Voice-mode timeout defaults to about 10 seconds.
- On timeout, the action is denied and JARVIS speaks that it was cancelled.

## Command Classification Changes

- `SAFE_READ_ONLY` is now limited to:
  - `dir`
  - `ls`
  - `type ...`
  - `cat ...`
  - `git status`
  - `git diff`
- `npm`, `pnpm`, `npx`, `python`, `python3`, `node`, and `tsx` are now `MEDIUM_RISK`.
- `npm run ...` is not classified as safe.
- Legacy `core/commandSafety.ts` now only permits exact read-only commands through its old allowlist path.

## Tests Added/Updated

- Added `tests/openAppSecurityTest.ts`
  - Dry-run allowlist tests.
  - Rejection tests for raw URLs, UNC paths, absolute paths, scripts/executables, shell metacharacters, and unapproved `cmd`.
- Added `tests/bridgeAuthUnitTest.ts`
  - Valid token accepted.
  - Missing/wrong tokens rejected.
- Updated `tests/securityGateUnitTest.ts`
  - Verifies narrow read-only allowlist.
  - Verifies broad dev tools are `MEDIUM_RISK`.

## Commands Run

```powershell
npx tsc --noEmit
npx tsx tests/securityGateUnitTest.ts
npx tsx tests/openAppSecurityTest.ts
npx tsx tests/bridgeAuthUnitTest.ts
npx tsx tests/permissionSessionTest.ts
npx tsx tests/voiceYouTubeIntegrationTest.ts
```

Note: PowerShell blocked the `npx.ps1` shim via execution policy, so the successful runs used `npx.cmd` with the same arguments.

## Passed Checks

- `npx.cmd tsc --noEmit` passed.
- `tests/securityGateUnitTest.ts`: 36 passed, 0 failed.
- `tests/openAppSecurityTest.ts`: 15 passed, 0 failed.
- `tests/bridgeAuthUnitTest.ts`: 5 passed, 0 failed.
- `tests/permissionSessionTest.ts`: 15 passed, 0 failed.
- `tests/voiceYouTubeIntegrationTest.ts`: 35 passed, 0 failed.

## Skipped by Phase 3 Safety Scope

- Real app-opening tests.
- Microphone/camera tests.
- Paid API tests.
- Full assistant startup.
- Remote/network exposure tests.

## Remaining Security Risks

- WebSocket token is a shared secret, not per-client or rotating.
- Audit logs are local JSON lines and are not tamper-evident or encrypted.
- Full-control expiry is in-memory and resets on process restart.
- Some high-risk tools outside this Phase 3 list may still need deeper per-action approval checks.
- `write_file` and other control skills still deserve a dedicated path/path-policy review.
- Health endpoint remains local-only by host config, but has no separate auth.

## Exact Next Recommended Phase

Phase 4: high-risk tool permission review and filesystem safety.

Recommended focus:
- `tools/fileTool.ts`
- `skills/control_file`
- `skills/control_system`
- `skills/control_process`
- `skills/control_keyboard`
- `skills/control_mouse`
- path traversal prevention
- protected-directory policies
- per-action approval gates for mutating tools

Stop after Phase 3.
