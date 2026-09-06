# TEST_MATRIX.md — Required Tests for JARVIS

> Run these tests before and after every change to protected files.
> Do not mark any bug fixed without passing the relevant tests AND live verification.

---

## Step 0 — Inspect package.json First

Before running tests, check what scripts are available:

```powershell
cat package.json
```

Specifically look for:
- `"test:voice-core"` — combined test runner
- `"test:latency"` — latency smoke test alias
- `"dev"` — main runtime starter

Do not invent scripts. Only use what actually exists in package.json.

---

## Required Individual Tests

Run in this order:

### 1. TypeScript Compile Check
```powershell
npx tsc --noEmit
```
**Expected:** 0 errors, 0 warnings that indicate type unsafety  
**Failure:** Any error output = stop, do not proceed

---

### 2. NodeBridge Singleton Test
```powershell
npx tsx tests/nodeBridgeSingletonTest.ts
```
**Expected:** 9/9 PASS  
**Tests:** Singleton identity, globalThis reference, idempotent start(), READY client registry, TTS queue, listen_start queue

---

### 3. Voice Route Mock Test
```powershell
npx tsx tests/voiceRouteMockTest.ts
```
**Expected:** 9/9 PASS  
**Tests:** stt_result forwarding, orchestrator.process() called, deterministic pre-router fires, open_app invoked

---

### 4. Interrupt Gating Test
```powershell
npx tsx tests/interruptGatingTest.ts
```
**Expected:** 3/3 PASS  
**Tests:** speech_detected ignored during PLANNING, ignored during EXECUTING, accepted only during SPEAKING

---

### 5. Open App Smoke Tests
```powershell
npx tsx tests/openAppSmokeTest.ts "youtube"
npx tsx tests/openAppSmokeTest.ts "notepad"
npx tsx tests/openAppSmokeTest.ts "cmd"
```
**Expected:** Each resolves correctly and reports success  
**Note:** This will actually open YouTube/Notepad/CMD on your machine

---

### 6. Latency Smoke Test
```powershell
npx tsx tests/latencySmokeTest.ts "open YouTube for me"
```
**Expected:** Total request processing time under 100ms  
**Target:** Under 60ms preferred (deterministic route bypasses LLM)

---

### 7. Deterministic Command Route Test
```powershell
npx tsx tests/deterministicCommandRouteTest.ts
```
**Expected:** 39/39 PASS  
**Tests:**
- Section 1: 17 valid alias matches (youtube, google, notepad, cmd, etc.)
- Section 2: 12 unsafe/unknown inputs correctly NOT matched
- Section 3: open_app tool execution for safe targets
- Section 4: Security boundary — 4 malicious inputs rejected

⚠️ **CRITICAL:** Section 4 must always include `"launch cmd /c del *"` → null

---

## Combined Test Script (if available in package.json)

If `pnpm test:voice-core` exists in package.json, run:

```powershell
pnpm test:voice-core
```

If it does NOT exist in package.json, do not invent it.
Report it as missing and run tests individually.

**As of last verification, this script exists:**
```json
"test:voice-core": "npx tsc --noEmit && npx tsx tests/nodeBridgeSingletonTest.ts && ..."
```
Verify it still exists before citing it.

---

## Live Runtime Verification

For any voice pipeline bug, mock tests are NOT sufficient.
You must verify with a real voice command:

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

Record results in `stages/05_verification/output/verification.md`:

| Test | Expected | Actual | Status | Notes |
|---|---|---|---|---|
| `npx tsc --noEmit` | 0 errors | ? | ? | |
| `nodeBridgeSingletonTest.ts` | 9/9 | ? | ? | |
| `voiceRouteMockTest.ts` | 9/9 | ? | ? | |
| `interruptGatingTest.ts` | 3/3 | ? | ? | |
| `openAppSmokeTest.ts youtube` | success | ? | ? | |
| `openAppSmokeTest.ts notepad` | success | ? | ? | |
| `openAppSmokeTest.ts cmd` | success | ? | ? | |
| `latencySmokeTest.ts` | <100ms | ? | ? | |
| `deterministicCommandRouteTest.ts` | 39/39 | ? | ? | |
| `pnpm test:voice-core` | all pass | ? | ? | |
| **Live voice test** | YouTube opens | ? | ? | |
