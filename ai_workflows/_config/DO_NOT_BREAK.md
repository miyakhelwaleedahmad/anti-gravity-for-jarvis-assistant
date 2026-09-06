# DO_NOT_BREAK.md — Invariants That Must Never Be Violated

> If any change causes any of these behaviors to break, the change must be reverted immediately.

---

## Voice Pipeline Invariants

### 🔴 Do not break wake word detection

`voice/wakeWords.py` must:
- Detect the wake word ("Jarvis" or configured phrase)
- Extract inline commands correctly: `"Jarvis open YouTube for me"` → `"open YouTube for me"`
- Send `stt_result { type: "stt_result", payload: { text: "open YouTube for me", role: "wakeword" } }` to NodeBridge
- Resume after JARVIS finishes speaking

---

### 🔴 Do not break STT result forwarding

`bridge/nodeBridge.ts` `stt_result` handler must:
- Receive the WebSocket message from wakeword/stt clients
- Log: `[NodeBridge] RX type=stt_result role=wakeword text="..."`
- Log: `[NodeBridge] Forwarding STT result to orchestrator.process(...)`
- Call `orchestrator.process(text, 'voice')`
- NOT drop empty text silently (must warn and return)

---

### 🔴 Do not break NodeBridge singleton behavior

- `nodeBridge` is a module singleton via `globalThis.__nodeBridge__`
- Calling `nodeBridge.start()` twice must be safe (second call logs and returns)
- All imports of `nodeBridge` must resolve to the same object instance
- Port 9000 EADDRINUSE must reset `this.wss = null` so restart is possible

---

### 🔴 Do not break TTS ready/queue behavior

- If TTS is not READY: message goes into `pendingTTS[]`
- When TTS sends `client_ready`: `pendingTTS[]` is flushed immediately
- Log: `[NodeBridge] Flushing N queued TTS message(s).`
- TTS messages must NOT be permanently dropped

---

### 🔴 Do not break deterministic open_app route

- `"open YouTube for me"` must always match → target `"youtube"`
- `"launch YouTube"` must always match → target `"youtube"`
- `"open notepad"` must always match → target `"notepad"`
- `"open cmd"` must always match → target `"cmd"`
- Result must be under 100ms (no LLM call on this path)
- `matchDeterministicCommand()` must fire BEFORE `planPhase()` in `runAgentLoop()`

---

### 🔴 Do not break Notepad open_app route

- `"open notepad"` must resolve to `notepad.exe`
- `cmd.exe /c start "" notepad.exe` must execute successfully

---

### 🔴 Do not break CMD open_app route

- `"open cmd"` / `"open command prompt"` / `"open terminal"` must resolve to `cmd.exe`
- Must NOT allow shell injection: `"open cmd /c del *"` must NOT match

---

## Memory / Cache Invariants

### 🟡 Do not break Redis graceful fallback

- If Redis is unavailable: `redisCache.ts` must catch errors and return null/empty
- Redis unavailability must NOT crash the orchestrator
- Redis unavailability must NOT block the deterministic voice route
- Log must mention Redis failure but not throw unhandled exception

---

### 🟡 Do not break vector memory supervisor startup

- `vectorMemorySupervisor.start()` must be async and non-blocking
- If `vectorMemory.py` fails to start: JARVIS continues without vector search
- Circuit breaker in `memoryManager.ts` must activate on repeated failures
- After restart: circuit breaker must reset

---

## Build Invariant

### 🔴 Do not break TypeScript compilation

```powershell
npx tsc --noEmit
```

Must always return 0 errors. No exceptions.
If a change introduces a type error, revert or fix before committing.

---

## Test Invariants

### 🔴 Do not break existing smoke tests

All of the following must remain green after any change:

```
tests/nodeBridgeSingletonTest.ts    → 9/9 PASS
tests/voiceRouteMockTest.ts         → 9/9 PASS
tests/interruptGatingTest.ts        → 3/3 PASS
tests/openAppSmokeTest.ts youtube   → PASS
tests/openAppSmokeTest.ts notepad   → PASS
tests/openAppSmokeTest.ts cmd       → PASS
tests/latencySmokeTest.ts           → under 100ms
tests/deterministicCommandRouteTest.ts → 39/39 PASS (especially Section 4)
```

If any test breaks: stop, revert, diagnose before proceeding.

---

## State Machine Invariants

### 🔴 No illegal state machine transitions

Valid transitions are defined in `core/agentStateMachine.ts`.
The following must NEVER appear in runtime logs:

```
[AgentStateMachine] ⛔ ILLEGAL TRANSITION REJECTED: ...
```

If this appears: check jarvis.ts arbitration logic, check orchestrator state transition calls,
do not blindly add new transitions without understanding the full state graph.
