# Reproduction — voiceRouteMockTest checks that cannot fail

> Stage: 02b_reproduction · Run: `ai_workflows/runs/2026-10-25_voice-route-test-weak-checks/`
> Date: 2026-10-25 · Machine: cloud Linux (Node 22.22.2, pnpm 10.33.0), commit `76f4712`

---

## Failure Being Reproduced

The test passes while the behaviour its checks name is broken.

---

## Method

1. Export HEAD to the session scratchpad (`git archive HEAD | tar -x`), link
   `node_modules`. The working tree is never changed.
2. A recording stand-in `xdg-open` first on PATH counts opener calls (the
   cloud machine has no real one).
3. `evidence/mutate_harness.txt` (a Python script) applies one mutation to
   one file of the export, runs `pnpm test -- --only=voiceRouteMockTest`,
   records the runner verdict, the failing checks and the opener calls, and
   restores the file from `git show HEAD:<file>`. After the runs, each
   mutated file was compared with HEAD (`cmp`): all restored.

| Mutation | File | What it breaks |
|---|---|---|
| M1 | `bridge/nodeBridge.ts` | `sendListenStart` never sends `listen_start` |
| M2 | `bridge/nodeBridge.ts` | `stt_result` is never dispatched to handlers |
| M3 | `bridge/nodeBridge.ts` | `client_ready` never registers the role |
| M4 | `core/orchestrator.ts` | the route runs no tool (fakes success) |
| M5a | `core/orchestrator.ts` | the route also calls `browser_state` |
| M5b | `core/orchestrator.ts` | the route launches the browser itself (`xdg-open` / `cmd /c start`) |
| M6 | `skills/automation/skill.ts` | the skill ignores `dryRun` |
| M7 | `bridge/nodeBridge.ts` | the sender's role is not used (`lastTranscriptEngine`) |

A probe (scratchpad only) wrapped `child_process` and `toolRegistryV2.execute`
during two `orchestrator.process('open YouTube for me', 'voice')` calls on
unchanged code.

---

## Commands and Output

Mutation results on the current test (`evidence/attack_old_test.txt`, raw):

```
none                       PASS     opener_calls=0 failing_checks=0
M1_no_listen_send          PASS     opener_calls=0 failing_checks=0
M2_no_handler_dispatch     PASS     opener_calls=0 failing_checks=0
M3_no_ready_register       PASS     opener_calls=0 failing_checks=0
M4_route_skips_tool        FAIL     opener_calls=0 failing_checks=2
       ❌ FAIL: open_app ran for "youtube" once per request
M5a_extra_tool             PASS     opener_calls=0 failing_checks=0
M5b_direct_spawn           PASS     opener_calls=2 failing_checks=0
M6_skill_ignores_dryrun    FAIL     opener_calls=2 failing_checks=2
       ❌ FAIL: open_app was a dry run (no browser launched)
M7_engine_not_set          PASS     opener_calls=0 failing_checks=0
```

(The harness then counted each FAIL line twice because the runner prints it
twice; it was changed to de-duplicate before the runs on the new test.)

M4 also shows R3: "open_app tool was invoked" still passed when the route ran
no tool.

Probe output (`evidence/probe_route.txt`):

```
SPAWNED_AT_IMPORT ["spawn powershell [\"-NoProfile\",\"-NonInteractive\",\"-ExecutionPolicy\",\"Bypass\",\"-Command\",\"-\"]"]
TOOLS ["open_app","open_app"]
SPAWNED_DURING_ROUTE []
```

With the dry run removed in the probe, `SPAWNED_DURING_ROUTE` recorded
`spawn xdg-open ["https://www.youtube.com"]` twice and the stand-in opener
logged 2 calls: the `child_process` wrapper sees the skill's ESM
`import { spawn }` once `syncBuiltinESMExports()` has run.

---

## Result Label (choose one)

- [x] **REPRODUCED**: 6 of 8 faults pass the current test (automated, Linux)
- [ ] REPRODUCED-MANUAL · [ ] MOCK-ONLY · [ ] FLAKY · [ ] INFERRED · [ ] NOT REPRODUCED · [ ] BLOCKED

---

## Exception

None. Windows was not used: the weakness is in test code that runs the same
way on every platform, except the launch commands, which differ (see
`diagnosis.md`).

---

## Ready for Patch Plan?

- [x] Reproduced with recorded output
- [x] No change to the working tree
