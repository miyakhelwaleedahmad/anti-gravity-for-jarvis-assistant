# Patch Plan — voiceRouteMockTest launches a real browser

> Stage: 03_patch_plan · Run: `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/`
> Status: [ ] Awaiting Approval / [x] Approved / [ ] Rejected
> Date: 2026-10-23 · Base commit: `0117a56`

---

## Summary

Make `open_app` a dry run inside `tests/voiceRouteMockTest.ts`, using the
project's existing stand-in convention (`tests/boundary-doubles.json`). The
orchestrator, deterministic router, tool registry, risk engine and
`open_app` skill still run for real; the skill stops at its own `dryRun`
branch instead of spawning the browser. Add assertions so that a future
real launch from this test fails it, and list the stand-in where
`boundaryDoublesTest` requires it. No runtime file changes.

---

## Proposed Changes

### Change 1 — record `open_app` calls and make them dry runs

**File:** `tests/voiceRouteMockTest.ts` (protected test)
**Lines:** imports (19–21); before the "stt_result → orchestrator.process()" section (≈ line 110); after the deterministic-route assertions (≈ line 160)

**Before (imports):**
```typescript
import { nodeBridge } from '../bridge/nodeBridge.js';
import { orchestrator } from '../core/orchestrator.js';
import { agentStateMachine, AgentState } from '../core/agentStateMachine.js';
```

**After (imports):**
```typescript
import { nodeBridge } from '../bridge/nodeBridge.js';
import { orchestrator } from '../core/orchestrator.js';
import { agentStateMachine, AgentState } from '../core/agentStateMachine.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
```

**Before (≈ line 110):**
```typescript
  // ── Test: stt_result → orchestrator.process() ─────────────────────────────
  origLog('\n--- Test: stt_result "open YouTube for me" ---');
```

**After (≈ line 110):**
```typescript
  // open_app is a dry run: the route, risk engine and skill run for real, but
  // the skill stops before launching the browser (this test used to open
  // YouTube twice on every run).
  const openAppResults: { target: unknown; success: boolean; output: string }[] = [];
  const originalExecute = toolRegistryV2.execute.bind(toolRegistryV2);
  (toolRegistryV2 as any).execute = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    if (name !== 'open_app') return originalExecute(name, args, signal);
    const result = await originalExecute(name, { ...args, dryRun: true }, signal);
    openAppResults.push({ target: args['target'], success: result.success, output: String(result.output) });
    return result;
  };

  // ── Test: stt_result → orchestrator.process() ─────────────────────────────
  origLog('\n--- Test: stt_result "open YouTube for me" ---');
```

**Before (after the two existing deterministic-route assertions, ≈ line 160):**
```typescript
  assert(
    logContains('open_app') || logContains('Executing'),
    'open_app tool was invoked'
  );

  // ── Summary ───────────────────────────────────────────────────────────────
```

**After:**
```typescript
  assert(
    logContains('open_app') || logContains('Executing'),
    'open_app tool was invoked'
  );
  (toolRegistryV2 as any).execute = originalExecute;
  assert(
    openAppResults.length === 2 && openAppResults.every((r) => r.target === 'youtube' && r.success),
    'open_app ran for "youtube" once per request'
  );
  assert(
    openAppResults.every((r) => /"dryRun":\s*true/.test(r.output)),
    'open_app was a dry run (no browser launched)'
  );

  // ── Summary ───────────────────────────────────────────────────────────────
```

**Reason:** Removes the launch at its cause (no `dryRun` on the routed call)
without touching the route. The new assertions fail if the dry run is
lost, which the old checks (log text only) could not detect.

### Change 2 — list the stand-in

**File:** `tests/boundary-doubles.json`, after the `tests/voiceApprovalTest.ts` entry

```json
    "tests/voiceRouteMockTest.ts": {
      "replaces": [
        "registry:execute"
      ],
      "reason": "wraps execute only to make open_app a dry run, so the test opens no browser on the test machine; the deterministic route, risk engine and open_app skill still run. The real launch is checked live (TEST_MATRIX.md, Live Runtime Verification)"
    },
```

**Reason:** `tests/boundaryDoublesTest.ts` fails on any test that replaces
a registry method without an entry.

---

## Files That Will Change

| File | Protected? | Change Description |
|---|---|---|
| `tests/voiceRouteMockTest.ts` | Yes (Protected Tests) | Dry-run stand-in for `open_app`; 2 new assertions; all existing assertions kept unchanged |
| `tests/boundary-doubles.json` | No | One entry for the stand-in |
| `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/*` | No | Run records (Stages 04–07) |
| `docs/remediation/REMEDIATION_TRACKER.md` | No | One new row at Stage 07, ID agreed with the owner |

Not changed: `core/orchestrator.ts`, `core/deterministicRoutes.ts`,
`skills/automation/skill.ts`, `security/*`, `core/toolRegistryV2.ts`,
`core/toolCatalog.ts`, any agent, memory, voice or PC-control file.

---

## Reproduction (from Stage 02b)

- Label: REPRODUCED (2 opener calls with `https://www.youtube.com`; controls 0)
- Regression test: the two new assertions in `tests/voiceRouteMockTest.ts`
- Exception: none

---

## Tests to Run After Implementation

Red then green, in Stage 04:
1. Add the recording wrapper and the two assertions **without** `dryRun: true`:
   `pnpm test -- --only=voiceRouteMockTest` must FAIL on "open_app was a dry
   run", and the stand-in opener must record 2 calls.
2. Add `dryRun: true`: the same command must PASS, and the stand-in opener
   must record 0 calls.

Then, in Stage 05:

```powershell
pnpm run typecheck
pnpm test -- --only=voiceRouteMockTest,boundaryDoublesTest,noGroqForLocalCommandsTest,simpleNoGoalTest,voiceYouTubeIntegrationTest,openAppSmokeTest,deterministicCommandRouteTest
pnpm test:voice-core
pnpm test -- --ci
```

Plus the stand-in-opener probe over the voice-core tests (expect 0 calls).
Tests run through the runner only; never `npx tsx tests/<name>.ts`.

---

## Live Voice Verification Required?

- [ ] Yes — this change affects the voice pipeline
- [x] No — test-only change; the live route is untouched

Optional owner check (PowerShell, JARVIS folder): `pnpm test -- --only=voiceRouteMockTest`.
After the fix, no YouTube tab should open.

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| The test no longer exercises a real `open_app` launch | Certain (by design) | A real launch is never wanted in an isolated test; `openAppSmokeTest` and live verification cover resolution and launch |
| With `dryRun`, the risk engine takes its level-0 branch, not the normal `open_app` branch | Certain | "youtube" never needed approval, so the normal branch also allowed it; risk rules are covered by their own tests (unchanged) |
| Wrapper left installed if the test throws | Low | Each test is its own process (runner); the wrapper is restored before the summary |
| `boundaryDoublesTest` rejects the entry | Low | Same `registry:execute` form as `noGroqForLocalCommandsTest`; checked in Stage 05 |
| A protected test is weakened | Low | Every existing assertion is kept as is; two stricter ones are added; the review checks this |

Protected behaviour that must stay unchanged: orchestrator and deterministic
routing, the seven specialist roles, agent permissions and spawn limits,
browser and Windows control, voice/TTS/wake-word, tool registry and risk
levels, approval gates and typed code-repair approval, self-healing and the
issue store, memory and Obsidian. None of their files is in this plan.

## Rollback

`git revert <fix commit>`: a new commit, no history rewrite.

## Acceptance Criteria

1. Red-then-green shown for the new assertions (Stage 04).
2. 0 stand-in opener calls during `voiceRouteMockTest` (it was 2).
3. `voiceRouteMockTest`, `boundaryDoublesTest` and the rest of the test area pass.
4. `pnpm run typecheck` 0 errors; `pnpm test -- --ci` 200 passed / 0 failed /
   1 blocked (`realTtsHandoffTest`) / 9 skipped, as at baseline.
5. Independent review (separate session) returns PASS.

## What This Fix Cannot Prove

- That no tab opens on Windows: inferred from code; only the owner's PC or a
  Windows CI run can show it (and Windows CI has the unrelated VOICE-003 failure).
- Anything about the live voice route: untouched, still owed a live run.
- Other weaknesses in the same test (always-true STT assertion, forwarding
  checks that bypass NodeBridge): listed as follow-ups, not fixed here.

---

## Approval

**Status:** [x] Approved for Stage 04 only (see below)

> This plan must NOT be implemented until the user explicitly approves.
> Write "approved" or "proceed" in the conversation to unlock Stage 04.
> Silence, a report, a test result or an automated agent is never approval.

Human approval recorded: [x] Yes — Date: 2026-10-23
Owner's words: "Approved for Stage 04 only, using the exact test-only fix in
the Stage 03 patch plan. … Keep the change limited to
tests/voiceRouteMockTest.ts and tests/boundary-doubles.json, as proposed.
First prove that the new regression assertions detect the original
behavior, then apply the dry-run fix and verify that the browser-opening
attempts are zero. … Stop after implementation and verification for the
required independent review. Do not push anything without my explicit approval."
Reproduction exception accepted (if any): [x] N/A
Tracker ID for the new row: the owner allowed PC-17 "if it matches the
existing tracker convention". It does not, for two reasons:
1. PC-17 is already assigned: `docs/audit/JARVIS_REPAIR_CHECKLIST.md:226`
   ("PC-17: PowerShell 7 installed, but the tests still found none"); for an
   ID in both files the checklist wins (`SOURCES_OF_TRUTH.md`). This reason
   was missing until review finding R2 pointed it out.
2. PC-nn rows come from the owner's PC runs; test-quality findings use
   TEST-nn (TEST-01…04).

The owner then approved **TEST-05** (new; not tracked under any ID before
this run). Tracker: `docs/remediation/REMEDIATION_TRACKER.md`, one row,
added at Stage 07 only.
