# ARCH_VOICE.md — Voice Pipeline Reference

> Topic reference for voice bugs. Paths checked against the repository on
> 2026-10-23 (`claude/jarvis-repair`). The code wins over this file; the
> pipeline overview is in the root `ARCHITECTURE.md`.

## Files

| File | Role |
|---|---|
| `jarvis.ts` | Entry point: voice state machine, mic arbitration, echo filter, barge-in, watchdogs, starts the Python services |
| `voice/wakeWords.py` | Wake word service and inline command extraction (spawned by `self_healing/selfHealingManager.ts`) |
| `voice/stt.py` | Speech-to-text service |
| `voice/tts.py` | Text-to-speech service |
| `bridge/nodeBridge.ts` | WebSocket server between Node and the Python services: READY client registry, TTS and `listen_start` queues, `stt_result` routing |
| `core/agentStateMachine.ts` | States IDLE → LISTENING → … → PLANNING → EXECUTING; `core/stateShim.ts` is a compatibility proxy |
| `core/conversationBus.ts` | Speaking state and idle/busy events |
| `core/deterministicRoutes.ts` | Deterministic router (`matchDeterministicCommand`): known commands run with no LLM call |
| `skills/automation/skill.ts` | `open_app`: resolves `youtube`, `notepad`, `cmd`, … and runs the Windows shell command |
| `core/voiceInput.ts`, `voiceContinuation.ts`, `voiceEchoFilter.ts`, `voiceSettings.ts`, `voiceSummaries.ts`, `listenSession.ts`, `spokenText.ts` | Voice input handling, follow-ups, echo rejection, settings, short spoken summaries, Markdown-free speech |

The old stub `voice/wakeWord.py` is in `_legacy/voice/wakeWord.py`
(commit fd72ce1); see `ARCH_LEGACY_PATHS.md`.

## Voice route (critical path)

```
User speaks
  → voice/wakeWords.py detects the wake word
  → extracts an inline command, or NodeBridge sends listen_start to voice/stt.py
  → stt_result WebSocket message to NodeBridge (bridge/nodeBridge.ts)
  → NodeBridge forwards to orchestrator.process(text, 'voice')
  → core/orchestrator.ts asks matchDeterministicCommand(input) (core/deterministicRoutes.ts)
  → if matched: runs open_app directly (NO LLM)
  → skills/automation/skill.ts resolves the target → Windows shell command
  → YouTube / Notepad / … opens
  → NodeBridge sends the reply to TTS
  → voice/tts.py speaks it
```

## Expected live log lines (checked against the code on 2026-10-23)

`VOICE_ROUTE_CONTRACT.md` lists the log sequence written in 2026-06. Its
wording differs from what the code prints now:

| Contract line | What the code prints now | Where |
|---|---|---|
| `[WakeWord] Wake word matched with inline command: "…"` | `<time> [WakeWord] INFO     Wake word + inline command: "…"` | `voice/wakeWords.py` (logging format) |
| `[NodeBridge] RX type=stt_result role=wakeword text="…"` | same | `bridge/nodeBridge.ts` |
| `[NodeBridge] Forwarding STT result to orchestrator.process(...)` | same | `bridge/nodeBridge.ts` |
| `[Orchestrator] Processing input [voice]: "…"` | same | `core/orchestrator.ts` |
| `[Orchestrator] Deterministic command route: open_app target="youtube"` | `[Orchestrator] ⚡ Deterministic command route: type="open_app" target="youtube"` | `core/orchestrator.ts` |
| `[ToolRegistry] Executing: open_app` | no such line found in `core/toolRegistryV2.ts` | — |
| `[open_app] target="youtube" resolved="https://www.youtube.com/"` | `[open_app] target="…" resolved="…"` | `skills/automation/skill.ts` |
| `[NodeBridge] → [tts] speak` | same | `bridge/nodeBridge.ts` |

`tests/voiceRouteMockTest.ts` runs the real bridge with stand-in Python
clients, but not `jarvis.ts`'s `stt_result` handler, and it prints no
imitation lines since TEST-06. A passing test still does not show what the
live runtime prints. Match live logs against the right-hand column.

## Contracts and tests

- Behaviour contract (readiness, queues, barge-in, security, states):
  `VOICE_ROUTE_CONTRACT.md`. Invariants: `DO_NOT_BREAK.md`.
- Isolated tests and the live procedure: `TEST_MATRIX.md`
  (`pnpm test:voice-core` runs 12 voice tests).
- Open investigation: `YOUTUBE_OPENAPP_INVESTIGATION.md`.
- Design and history: `docs/upgrade/VOICE.md`,
  `docs/audit/VOICE_AUDIT_CHECKLIST.md`.

## Rules for voice work

- A voice bug is fixed only after a live run on the owner's PC.
- `open youtube` must stay on the deterministic route, never the LLM planner.
- Broadening router aliases needs security boundary tests
  (`SECURITY_RULES.md`); `launch cmd /c del *` must not match `cmd`.
