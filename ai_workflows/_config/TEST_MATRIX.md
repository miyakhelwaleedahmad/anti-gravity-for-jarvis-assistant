# TEST_MATRIX.md — Required Tests for JARVIS

> Run these tests before and after every change to protected files.
> Do not mark any bug fixed without passing the relevant tests AND live verification.
> Commands below were checked against `package.json` and `tests/runAll.ts` on 2026-10-23.
> Check them again before citing them; do not invent scripts.

---

## How tests must be run

Always through the runner, `tests/runAll.ts` (`pnpm test`). It runs each test
file as its own process with its own empty data folder (`JARVIS_DATA_ROOT` and
the vector store), removed afterwards.

**Prohibited:** running a test file directly (`npx tsx tests/<name>.ts`). Run
that way, a test uses JARVIS's real data folder: `noThinkMemoryTest` wrote
`memory/jarvis_memory.json`, `data/runtime/goals.json` and
`data/episodes.jsonl` (see `tests/testScriptIsolationTest.ts`).

| Purpose | Command (CMD or PowerShell) |
|---|---|
| Type check | `pnpm run typecheck` |
| Named tests only | `pnpm test -- --only=nameA,nameB` (file names without `.ts`; an unknown name is an error) |
| Tests whose name contains a word | `pnpm test -- --filter=word` |
| Whole suite, skipping what this PC lacks | `pnpm test -- --ci` |
| Voice core group | `pnpm test:voice-core` (type check, then 12 named tests) |
| PC control group | `pnpm test:pc-control` (type check, then 18 named tests; see Windows note) |
| Live provider tests | `pnpm test:live` (only when asked: needs an API key and the network, acts on this PC) |

The runner reports one line per file: PASS, FAIL, TIMEOUT, BLOCKED (its
environment is missing; never a pass) or SKIPPED (a prerequisite this host
lacks, or a live test not asked for). Report all of them, not only passes.

---

## Required tests for voice-pipeline changes

All run isolated through the runner; none opens an app or speaks:

```
pnpm run typecheck
pnpm test -- --only=nodeBridgeSingletonTest,voiceRouteMockTest,interruptGatingTest,openAppSmokeTest,latencySmokeTest,deterministicCommandRouteTest
```

| Test | What it checks |
|---|---|
| `nodeBridgeSingletonTest` | one NodeBridge, idempotent start(), READY registry, TTS and listen_start queues |
| `voiceRouteMockTest` | stand-in clients on the real bridge: client_ready, listen_start, stt_result delivered → orchestrator → deterministic open_app (dry run). Fails if the route runs any other registered tool, or if a browser or URL opener is started through the main thread's `child_process` functions during the test. Not seen: a worker thread, the `ChildProcess` class used directly, a native addon, a tool's `execute` saved before the test wraps it. Not `jarvis.ts`'s handler |
| `interruptGatingTest` | speech_detected accepted only while SPEAKING |
| `openAppSmokeTest` | open_app resolves "youtube" in dry-run mode (nothing is opened) |
| `latencySmokeTest` | one request ("hello", answered by the fixed greeting route) through the orchestrator |
| `deterministicCommandRouteTest` | safe aliases match, unsafe input such as `launch cmd /c del *` does not |

`pnpm test:voice-core` runs these plus six more voice tests.

**Not covered by the runner:** `openAppSmokeTest` with "notepad" or "cmd",
and `latencySmokeTest` with "open YouTube for me". These need command-line
arguments, which the runner does not pass. The test files must not be
run directly to get them. "open YouTube for me" through the orchestrator
really opens YouTube, so it belongs to live verification below.

---

## Windows note (PC control group)

On Windows, `pnpm test:pc-control` acts on the desktop: `appControlTest` starts
and closes its own Notepad, and `processControlSafetyTest` asks to kill
`notepad`, which the permission check is expected to refuse. Save any open
Notepad work first. On other systems the Windows-only tests are BLOCKED or
SKIPPED, which is not a pass.

---

## Live Runtime Verification

For any voice pipeline bug, mock tests are NOT sufficient. Live checks open
apps, use the microphone and speakers, and may call the LLM: run them only
when the owner is at the PC and agrees.

```
1. Start JARVIS:
   pnpm run dev

2. Wait for all READY messages:
   [NodeBridge] ✅ READY client registered: wakeword
   [NodeBridge] ✅ READY client registered: stt
   [NodeBridge] ✅ READY client registered: tts

3. Say: "Jarvis open YouTube for me"

4. Confirm:
   a. Terminal shows deterministic route log
   b. Browser opens https://www.youtube.com/
   c. TTS speaks confirmation

5. Capture full terminal output from wake word to TTS speak.

6. Save captured logs to the verification report.
```

**Do NOT call the issue fixed without completing steps 1–6 above.**

---

## Test Result Recording

Record results in `stages/05_verification/output/verification.md`, with the
exact command, the machine (Windows PC or other), and the runner's output:

| Test | Command | Expected | Actual | Status | Notes |
|---|---|---|---|---|---|
| Type check | `pnpm run typecheck` | 0 errors | ? | ? | |
| Voice tests | `pnpm test -- --only=…` (list above) | all PASS | ? | ? | |
| Voice core group | `pnpm test:voice-core` | all PASS | ? | ? | |
| Whole suite | `pnpm test -- --ci` | 0 FAIL; SKIPPED/BLOCKED listed | ? | ? | |
| **Live voice test** | steps 1–6 above | YouTube opens | ? | ? | |
