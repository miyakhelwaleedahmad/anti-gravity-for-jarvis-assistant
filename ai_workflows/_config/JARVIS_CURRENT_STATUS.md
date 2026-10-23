# JARVIS_CURRENT_STATUS.md — Pointer to Current Status

> Updated: 2026-10-23, branch `claude/jarvis-repair`.
> This file holds no live status of its own. It says where status lives
> (`_config/SOURCES_OF_TRUTH.md`) and keeps dated snapshots below.

---

## Where to look

| Question | Source |
|---|---|
| What is failing at runtime now? | The issue store on the PC that runs JARVIS (`data/repairs/issues.json`), or ask JARVIS "show the repair report" |
| Status of an audit finding (SEC-, REL-, ARCH-, …) | `docs/audit/JARVIS_REPAIR_CHECKLIST.md`; PC-nn and other IDs: `docs/remediation/REMEDIATION_TRACKER.md` |
| What the 2026-10-23 log audit changed (BUG-1 to BUG-24) | `git log --grep=BUG-` on `claude/jarvis-repair` |
| Latest test evidence | The run's `verification.md` (command, machine, output); see below for the last recorded run |
| How tests are run | `_config/TEST_MATRIX.md` |

---

## Last recorded test evidence (2026-10-23)

Host: cloud Linux, Node 22, Redis running, at commit 27d74aa.
**Not the owner's Windows PC.** A pass here is not a live voice,
microphone, speaker or Windows check.

| Command | Result |
|---|---|
| `pnpm run typecheck` | 0 errors |
| `pnpm test -- --ci` | 200 passed, 0 failed, 1 blocked, 9 skipped (exit code 1: blocked is not a pass) |
| `pnpm test -- --only=docsHygieneTest,testScriptIsolationTest` | 2 passed |

Blocked: realTtsHandoffTest (needs a Python with pygame and websockets).
Skipped: Windows-only, live-provider, `.venv`, bridge-token and
PowerShell 7 tests; the runner prints each reason.

---

## "Jarvis open YouTube for me" (voice route)

Current status: **not established.** The 2026-06-19 snapshot below recorded
it as not reliably working live; no live log since then confirms it fixed
or still failing. Do not call it either until a live run says so.

- Investigation: `_config/YOUTUBE_OPENAPP_INVESTIGATION.md` (marked OPEN).
- Expected live log lines: `_config/VOICE_ROUTE_CONTRACT.md`.
- Live procedure: `_config/TEST_MATRIX.md`, Live Runtime Verification.

Rules kept from that snapshot:
- `open youtube` must use the deterministic route, never the LLM planner.
- Do not cite the 46 ms / 47 ms timings: they are from a previous session.
  There is no isolated test for this timing (through the runner,
  latencySmokeTest sends "hello" only; "open YouTube for me" really opens
  YouTube). Never run `npx tsx tests/latencySmokeTest.ts` directly. Re-verify
  live, with the owner: say "Jarvis open YouTube for me", confirm the browser
  opens, capture the logs showing the deterministic route.
- Create a stable tag (e.g. `stable-voice-openapp-v1`) only after live
  verification and only when the owner asks.

---

## Snapshot: 2026-06-19 (history, not current)

Known issue then: "Jarvis open YouTube for me" did not reliably open YouTube
in the live voice runtime. Intended route: wake word (`voice/wakeWords.py`)
→ NodeBridge `stt_result` → `orchestrator.process()` → deterministic route
`open_app { target: "youtube" }` → `skills/automation/skill.ts` →
`https://www.youtube.com/` in the browser → spoken confirmation, with no LLM
call and no illegal state transition.

Test results recorded then (previous session, not re-run as written):
type check 0 errors; nodeBridgeSingletonTest 9/9; voiceRouteMockTest 9/9;
interruptGatingTest 3/3; openAppSmokeTest youtube passed;
deterministicCommandRouteTest 39/39; latencySmokeTest 47 ms; live voice test
not confirmed.
