# Diagnosis — voiceRouteMockTest checks that cannot fail

> Stage: 02_diagnosis · Run: `ai_workflows/runs/2026-10-25_voice-route-test-weak-checks/`
> Status: [x] Complete
> Date: 2026-10-25 · Commit: `76f4712`

---

## Root Cause (confirmed by reproduction, see reproduction.md)

The test never starts the bridge. It puts mock socket objects straight into
NodeBridge's private maps (`readyClients`, `clientRoles`) and calls
`orchestrator.process` itself. So:

- the `client_ready` handshake, the `stt_result` handling and the handler
  dispatch never run, and the checks about them read the test's own values;
- the `listen_start` send runs, but `|| true` throws its result away;
- the route checks look for words in the log, and the route line alone
  satisfies "open_app tool was invoked";
- only `open_app` is observed, so another tool or a direct process launch is
  invisible.

This is a test defect. No JARVIS runtime defect was found.

---

## Supporting Evidence

- `bridge/nodeBridge.ts:367-440`: the message handler authenticates, then for
  `stt_result` records a transcript in the health ledger (only when `text`
  is non-empty), sets `lastTranscriptEngine` from the sender's role ("Google
  STT" for `wakeword`), emits `stt_text`, and calls every registered
  `stt_result` handler. None of this runs in the test.
- `bridge/nodeBridge.ts:720-736` (first written as 719-735; corrected after review finding V10): `sendListenStart` sends
  `{"type":"listen_start"}` and returns `true` when STT is ready.
- `core/orchestrator.ts:628`: the route line is
  `⚡ Deterministic command route: type="open_app" target="youtube"`, so
  `logContains('open_app')` holds whenever the route line exists.
- `skills/automation/skill.ts:8, 26-47`: the opener is started with `spawn`
  (`cmd.exe /c start`, `open`, `xdg-open`). Other launch paths exist
  (`control/appController.ts:62,70`, `control/systemController.ts:92`,
  `core/terminalTools.ts:96`).

---

## Control Flow Trace

```
Python client ──ws──▶ NodeBridge.connection ─▶ message handler
  client_ready + token ─▶ authenticatedClients, readyClients.set(role)     (not run by the old test)
  stt_result {text}    ─▶ healthLedger.record(stt) · lastTranscriptEngine
                          · emit stt_text · handlers('stt_result')          (not run by the old test)
                             └─ jarvis.ts:579 handler ─▶ orchestrator.process(text,'voice')   (B2: not testable)
orchestrator.process ─▶ runAgentLoop ─▶ matchDeterministicCommand ─▶ route line
                     ─▶ runRoutedTool('open_app') ─▶ toolRegistryV2.execute ─▶ risk engine ─▶ skill (dryRun)   (run by the test)
```

---

## Alternative Hypotheses

| Hypothesis | Verdict |
|---|---|
| The `\|\| true` hides a known-flaky send | Rejected: the mock was always open (`readyState: 1`); nothing explains it (initial upload `f429071`) |
| The bypass is deliberate because `jarvis.ts` cannot be imported | Partly: that explains not testing `jarvis.ts` (B2), not skipping the bridge, which is importable and is started by `healthLedgerTest` and `bridgeSecurityTest` |
| The route legitimately runs other tools or processes | Rejected on Linux by the probe (only `open_app`, no child process during the route). At import, `windowsState` starts a PowerShell session; that is not during the route and is not an opener |

---

## Files That Would Need to Change

- `tests/voiceRouteMockTest.ts`
- `tests/boundary-doubles.json` (reason text only: the wrapper now also records tool names)
- Docs that describe the test: `ai_workflows/_config/DO_NOT_BREAK.md` (count), `ARCH_VOICE.md`, `TEST_MATRIX.md`

No runtime file.

---

## Evidence Labels

| Claim | Label |
|---|---|
| Weak checks | observed (code + mutation) |
| Route tools and processes on Linux | observed (probe) |
| Windows: no opener process during the dry-run route | inferred from code; not run |

---

## Proposed Reproduction (for Stage 02b)

Mutation testing in a scratchpad export of HEAD (`git archive`, with
`node_modules` linked), never the working tree: break one behaviour per
mutation, run the test through the runner, restore the file from
`git show HEAD:<file>`.

---

## Ready to Advance to Reproduction?

- [x] Root cause traced in code
- [x] Alternatives considered
- [x] No code edits made during this stage
