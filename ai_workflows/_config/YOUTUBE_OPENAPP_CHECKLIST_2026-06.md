# YOUTUBE_OPENAPP_CHECKLIST_2026-06.md — Investigation Checklist (History)

> The step-by-step checklist of the open YouTube investigation, as written
> in 2026-06 and kept unchanged. Current status and resolution criteria:
> `YOUTUBE_OPENAPP_INVESTIGATION.md`. **Before using it:**
> - Some expected log lines below differ from what the code prints now;
>   compare live logs with the table in `ARCH_VOICE.md`.
> - `matchDeterministicCommand()` now lives in `core/deterministicRoutes.ts`.
> - Adding the temporary debug logs below edits runtime files: that needs a
>   patch plan and the owner's approval (Stage 02 allows it only temporarily,
>   with approval), and they must be removed before any commit.

---

## Expected Log Sequence (Full Voice Path)

When the bug is fixed, ALL of the following must appear in the terminal:

```
Step 1 — Wake word detected with inline command:
[WakeWord] Wake word matched with inline command: "open YouTube for me"

Step 2 — NodeBridge receives STT result:
[NodeBridge] RX type=stt_result role=wakeword text="open YouTube for me"

Step 3 — NodeBridge forwards to orchestrator:
[NodeBridge] Forwarding STT result to orchestrator.process(...)

Step 4 — Orchestrator processes as voice input:
[Orchestrator] Processing input [voice]: "open YouTube for me"

Step 5 — Deterministic route fires (NO LLM):
[Orchestrator] ⚡ Deterministic command route: open_app target="youtube"

Step 6 — Tool registry executes open_app:
[AgentStateMachine] IDLE → PLANNING
[AgentStateMachine] PLANNING → EXECUTING
[ToolRegistry] ⚡ Executing: open_app   ← or similar registry log

Step 7 — Skill resolves and executes:
[open_app] target="youtube" resolved="https://www.youtube.com"
[open_app] platform=win32 command=cmd.exe args=/c,start,,https://www.youtube.com

Step 8 — TTS confirmation:
[NodeBridge] → [tts] speak
[Timing] Total request processing time: Xms

Step 9 — Browser opens YouTube (visual confirmation)
```

If ANY step above is missing from the live logs, that step is the failure point.

---

## Investigation Checklist

Work through this list in order. Stop at the first step that fails.

### Step 1 — Confirm wake word hears inline command
```
Expected log: [WakeWord] Wake word matched with inline command: "open YouTube for me"

If missing:
  → voice/wakeWords.py is not running, not registered, or not extracting inline command
  → Check: selfHealingManager launched wakeWords.py
  → Check: [NodeBridge] ✅ READY client registered: wakeword
  → Check: wakeWords.py inline_command extraction logic
```

### Step 2 — Confirm NodeBridge receives the STT result
```
Expected log: [NodeBridge] RX type=stt_result role=wakeword text="open YouTube for me"

If missing:
  → wakeWords.py sent the message but NodeBridge didn't receive it
  → OR the WebSocket connection dropped before the message arrived
  → Check: wakeword client READY status at moment of trigger
  → Check: nodeBridge.ts stt_result handler registration
```

### Step 3 — Confirm NodeBridge forwards to orchestrator
```
Expected log: [NodeBridge] Forwarding STT result to orchestrator.process(...)

If missing:
  → stt_result handler fired but orchestrator call was skipped
  → Check: text was empty (payload.text === undefined)
  → Check: arbitration logic in jarvis.ts
  → Check: agentStateMachine state at moment of receipt
```

### Step 4 — Confirm orchestrator chooses deterministic route
```
Expected log: [Orchestrator] ⚡ Deterministic command route: open_app target="youtube"

If missing:
  → matchDeterministicCommand("open YouTube for me") returned null
  → Check: input cleaning (toLowerCase + strip non-alphanumeric)
  → Check: after cleaning, does "open youtube for me" → trigger "open" → alias "youtube"?
  → Check: ALIASES map contains "youtube"
  → OR orchestrator is in an unexpected state and planPhase() ran instead
```

### Step 5 — Confirm ToolRegistry executes open_app
```
Expected log: [open_app] target="youtube" resolved="https://www.youtube.com"

If missing:
  → toolRegistryV2.execute('open_app', { target: 'youtube' }) was called but failed
  → Check: open_app is registered (skills/automation/skill.ts loaded by SkillLoader)
  → Check: skill.ts ALIASES map includes 'youtube'
  → Check: for any error thrown in skill.ts execute()
```

### Step 6 — Confirm Windows shell command launches browser
```
Expected log: [open_app] platform=win32 command=cmd.exe args=/c,start,,https://www.youtube.com

If the shell log appears but browser doesn't open:
  → The cmd.exe invocation itself is failing silently
  → Check: quoting/escaping of URL in the shell args
  → Check: default browser association on Windows
  → Check: any Windows security policy blocking the start command
  → Try manually: cmd.exe /c start "" https://www.youtube.com
```

### Step 7 — Confirm TTS speaks after execution
```
Expected log: [NodeBridge] → [tts] speak

If missing:
  → TTS client not READY at time of speak() call
  → Check: [NodeBridge] ✅ READY client registered: tts
  → Check: pendingTTS[] was used and flushed correctly
  → Check: isInterrupted() returning true incorrectly
```

---

## Known Possible Failure Points

| Location | Failure Mode | Diagnostic |
|---|---|---|
| `voice/wakeWords.py` | Inline command strip broken | Check `has_command` flag and `inline_command` extraction |
| `bridge/nodeBridge.ts` stt_result | Empty text guard drops message | Check `if (!text)` — is text actually present? |
| `jarvis.ts` arbitration | Wrong state during receipt | Log `agentStateMachine.currentState` at receipt time |
| `core/orchestrator.ts` | `matchDeterministicCommand()` returns null | Add debug log of `clean` variable |
| `core/toolRegistryV2.ts` | `open_app` not registered | Check `SkillLoader.loadSkills()` completed before first voice command |
| `skills/automation/skill.ts` | ALIASES map missing 'youtube' | Directly inspect ALIASES in skill.ts |
| Windows shell | Browser not opening | Run `cmd /c start "" https://www.youtube.com` manually |
| `bridge/nodeBridge.ts` TTS | TTS not READY | Check READY client list at time of speak() |

---

## Diagnostic Commands to Add Temporarily

If the issue cannot be found from logs alone, add temporary logging:

```typescript
// In core/orchestrator.ts — matchDeterministicCommand():
console.log('[Debug] matchDeterministicCommand input:', input);
console.log('[Debug] matchDeterministicCommand clean:', clean);

// In jarvis.ts — stt_result handler:
console.log('[Debug] stt_result state at receipt:', agentStateMachine.currentState);
console.log('[Debug] stt_result text:', text);

// In bridge/nodeBridge.ts — stt_result block:
console.log('[Debug] stt_result handler fired, text:', text);
```

**Remove all debug logs before committing.**
