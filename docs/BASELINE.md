# JARVIS — Phase 0 Baseline

**Purpose:** record the repository's measured state *before* any modification, so that
later failures can be classified as PRE-EXISTING, NEW, FIXED, or REGRESSION.

| Field | Value |
|---|---|
| Commit | `f429071` — "Initial upload of Jarvis Assistant" (branch `main`, single commit) |
| Baseline date | 2026-09-06 |
| Host | Linux x86_64 (container), Node v22.22.2, pnpm 10.33.0, Python 3.11.15 |
| TypeScript | 6.0.2 |
| Working tree at capture | clean (`git status --porcelain` empty) |

> **This is a Linux baseline.** The project targets Windows. Eight of the eleven failures
> below are caused by the absent platform/services, not by defects. The **authoritative**
> baseline must be re-captured on the target Windows host before Phase 1 is merged.

## Typecheck

```
npx tsc --noEmit   →  exit 0, zero errors, strict: true
```

## Test census — 56 passed / 11 failed of 67 runnable files

Runner: `npx tsx tests/<file>.ts`, 120 s timeout each. `tests/toolAuditHelper.ts` excluded (helper, not a test).

### Failures classified

| # | Test | Cause | Class | Real defect? |
|---|---|---|---|---|
| 1 | `fileToolWorkspaceSafetyTest` | 3/5 — `C:\Windows\win.ini` read and `C:\Windows\Temp\jarvis.txt` write both permitted | **P0-01** hard-coded workspace root | **YES** |
| 2 | `runCommandSafetyTest` | 10/11 — `workingDir outside workspace is blocked` fails; cwd resolved to `<repo>/C:\Windows` | **P0-01** same root cause | **YES** |
| 3 | `dependencyImportCheck` | `Expected at least one Next import while app/api is present` (next/react/react-dom imports = 0) | orphan `app/` + 5 unused deps | **YES** |
| 4 | `dashboardHealthSystemTest` | `spawn powershell ENOENT` → `system_state.json` never written | needs Windows | no |
| 5 | `processControlSafetyTest` | 6/7 — `listProcesses()` returns 0 (Windows `tasklist`) | needs Windows | no |
| 6 | `windowControlTest` | 7/8 — `closeCurrentWindow()` at L0 | needs Windows | no |
| 7 | `sttReliabilityTest` | `.venv/bin/python3: not found` | needs Python venv | no |
| 8 | `dashboardAccuracyTest` | 6/7 — status stays `offline` | needs Redis | no |
| 9 | `startupPerformanceTest` | `JARVIS_BRIDGE_TOKEN is required` | needs env (bridge **correctly fails closed**) | no |
| 10 | `finalIntegrationSuiteTest` | `GroqProvider: All 3 attempts failed` | needs `GROQ_API_KEY` + network | no |
| 11 | `successfulExecutionLifecycleAuditTest` | `403 Host not in allowlist: api.groq.com` | network egress blocked in this container | no |

**3 real defects, 8 environmental.**

## Environment constraints in this container

- `api.groq.com` is **not** reachable (egress allowlist) → no live LLM verification possible here.
- No Windows, no PowerShell, no Redis, no Neo4j, no Python venv, no microphone/camera.
- Consequence: anything requiring those is **RUNTIME VERIFICATION REQUIRED** on the user's host.

## Test side effects observed (and reverted)

Running the suite mutated the working tree. All reverted; tree returned to clean.

| Artifact | Note |
|---|---|
| `W:\anti gravity for jarvis assistant/` created **inside the checkout** | contained `tests/scratch.txt` and `C:\Windows\Temp\jarvis.txt` — **a write that should have been blocked** |
| `data/goals.json` modified | restored via `git checkout` |
| `data/security/permission_session.json` created | **not covered by `.gitignore`** — new minor finding, see plan |

## Phase 0 backup

Tracked runtime-state files copied outside the repo before any work:
`data/goals.json` (34,785 B), `memory/taskHistory.json`, `memory/userMemory.json`, `environment/systemInfo.json`.

> The **live** `memory/jarvis_memory.json` is correctly untracked and exists only on the
> user's machine. It is **not** in this container and cannot be affected by work done here.
