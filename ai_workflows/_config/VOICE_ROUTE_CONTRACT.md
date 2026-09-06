# VOICE_ROUTE_CONTRACT.md — Expected Live Runtime Behavior

> This file defines the contractual log output and behavior for the JARVIS voice pipeline.
> If any log line is missing during live testing, that step is a failure point.

---

## Expected Log Sequence — "Jarvis open YouTube for me"

Every live voice command for a deterministic open_app must produce ALL of these log lines:

```
[WakeWord] Wake word matched with inline command: "open YouTube for me"
[NodeBridge] RX type=stt_result role=wakeword text="open YouTube for me"
[NodeBridge] Forwarding STT result to orchestrator.process(...)
[Orchestrator] Processing input [voice]: "open YouTube for me"
[Orchestrator] Deterministic command route: open_app target="youtube"
[ToolRegistry] Executing: open_app
[open_app] target="youtube" resolved="https://www.youtube.com/"
[NodeBridge] → [tts] speak
```

If any line is absent, the corresponding component has failed.

---

## Failure Diagnosis by Missing Log Line

| Missing Log Line | Probable Failure Location |
|---|---|
| `Wake word matched with inline command` | `voice/wakeWords.py` — inline extraction broken or wake word not triggered |
| `RX type=stt_result role=wakeword` | `bridge/nodeBridge.ts` — message not received from wakeword client |
| `Forwarding STT result to orchestrator` | `bridge/nodeBridge.ts` — stt_result handler not firing |
| `Processing input [voice]` | `core/orchestrator.ts` — orchestrator.process() not called |
| `Deterministic command route` | Orchestrator falling back to LLM planner — matchDeterministicCommand() failed |
| `ToolRegistry Executing: open_app` | `core/toolRegistryV2.ts` — tool not registered or not found |
| `open_app target="youtube" resolved` | `skills/automation/skill.ts` — alias not resolved |
| `[NodeBridge] → [tts] speak` | TTS client not READY or speak() was blocked |

---

## Required Client Readiness Conditions

All of the following must be true before voice commands can work:

```
✅ WakeWord client must send client_ready { role: "wakeword" }
✅ STT client must send client_ready { role: "stt" }
✅ TTS client must send client_ready { role: "tts" }

[NodeBridge] ✅ READY client registered: wakeword
[NodeBridge] ✅ READY client registered: stt
[NodeBridge] ✅ READY client registered: tts
```

---

## TTS Queue Behavior Contract

```
If TTS is not yet READY when orchestrator calls speak():
  → TTS message is pushed to pendingTTS[]
  → Log: "[NodeBridge] No READY clients yet — queueing TTS."

When TTS sends client_ready:
  → pendingTTS[] is flushed to the TTS client
  → Log: "[NodeBridge] Flushing N queued TTS message(s)."
```

---

## STT listen_start Queue Contract

```
If STT is not yet READY when listen_start is needed:
  → pendingListenStart = true
  → Log: "[NodeBridge] STT not ready — queued listen_start"

When STT sends client_ready:
  → listen_start is sent immediately
  → Log: "[NodeBridge] STT ready — flushing queued listen_start"
```

---

## Empty STT Result Contract

```
If stt_result.payload.text is empty or undefined:
  → Log: "[JARVIS] Received stt_result message with empty payload text."
  → Command must be ignored (no orchestrator call)
```

---

## Barge-in / Interrupt Contract

```
speech_detected event behavior:

  If JARVIS state is SPEAKING (TTS playing):
    → Accepted as barge-in
    → Log: "[JARVIS] speech_detected accepted as barge-in during SPEAKING"
    → TTS stop command sent
    → agentStateMachine.interrupt() called

  If JARVIS state is ANYTHING ELSE (IDLE, LISTENING, PLANNING, EXECUTING):
    → Ignored
    → Log: "[JARVIS] speech_detected ignored because assistant is not speaking. state=X"
```

---

## Security Contract for open_app

```
open_app MUST:
  ✅ Only resolve known safe aliases (youtube, google, notepad, cmd, etc.)
  ✅ Reject unknown app names by returning null from matchDeterministicCommand()
  ✅ Never pass raw user text directly to shell
  ✅ Use cmd.exe /c start "" <target> format on Windows
  ✅ Reject inputs like "cmd /c del *" (remainder check must prevent this)

open_app MUST NOT:
  ❌ Execute arbitrary shell commands
  ❌ Resolve aliases not in the hardcoded ALIASES map
  ❌ Match prefix-only patterns without verifying empty remainder
```

---

## State Machine Contract During Voice Route

```
Normal path (IDLE → voice command arrives):
  IDLE → PROCESSING_STT → [orchestrator.process()]
  → PLANNING (transition attempt, silent catch)
  → EXECUTING (transition attempt, silent catch)
  → [open_app executes]
  → reset() → IDLE

Arbitrated path (PLANNING/EXECUTING → voice command arrives):
  If command is safe deterministic:
    → bypass state transition entirely
    → call orchestrator.process() directly
    → Log: "[JARVIS] Voice input received during PLANNING; using safe arbitration path."

  If command is complex:
    → push to voiceInputQueue[]
    → Log: "[JARVIS] Queued voice input because assistant is busy: ..."
    → speak: "One moment, sir."
    → drain queue after current task completes
```
