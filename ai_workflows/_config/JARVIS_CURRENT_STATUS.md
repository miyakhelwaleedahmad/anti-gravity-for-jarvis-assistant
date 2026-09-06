# JARVIS_CURRENT_STATUS.md — Current System State

> Last updated: 2026-06-19
> Do not treat this as a permanent record. Update after each verified session.

---

## ⚠️ Active Known Issue

```
"Jarvis open YouTube for me" does not reliably open YouTube in the live voice runtime.
```

**Do not document this as fixed until live logs prove it.**

This is not a test claim. It is not a smoke test claim.
It requires real voice input → real browser opening → captured live runtime logs.

---

## Intended Route

The correct behavior path for `"Jarvis open YouTube for me"` is:

```
Voice
  → WakeWord (voice/wakeWords.py)
    extracts inline command: "open YouTube for me"
  → NodeBridge (bridge/nodeBridge.ts)
    receives: stt_result { text: "open YouTube for me", role: "wakeword" }
    forwards: orchestrator.process("open YouTube for me", "voice")
  → Orchestrator (core/orchestrator.ts)
    matchDeterministicCommand() → returns "youtube"
    SKIPS LLM entirely
  → ToolRegistryV2 (core/toolRegistryV2.ts)
    executes: open_app { target: "youtube" }
  → Automation Skill (skills/automation/skill.ts)
    resolves: "youtube" → "https://www.youtube.com/"
    runs: cmd.exe /c start "" "https://www.youtube.com/"
  → Windows opens browser to YouTube
  → NodeBridge → TTS
    speaks: "Opening youtube for you, sir."
```

---

## Target Behavior

When the user says **"Jarvis open YouTube for me"**:

1. Browser opens `https://www.youtube.com/`
2. TTS speaks a confirmation
3. Total time from wake word to browser: **under 100ms preferred**
4. No LLM call is made (deterministic route)
5. No illegal state machine transitions

---

## Known Safe Rule

> Do NOT use the LLM planner for `open youtube` commands.
> It must always use the deterministic command routing path.

---

## Do Not Claim 46ms Stable

The 46ms figure was measured in a previous session.
**Do not cite this figure as current** unless you have re-run the latency smoke test
and live voice test in this exact runtime session.

To re-verify:
```powershell
npx tsx tests/latencySmokeTest.ts "open YouTube for me"
```

Then verify live:
```
Say: "Jarvis open YouTube for me"
Confirm browser opens.
Capture logs showing deterministic route fired.
```

---

## Git Safety Instructions

Check current state before making any changes:

```powershell
git status
git log --oneline -5
git branch --show-current
```

If a stable voice route has been verified and all tests pass, consider tagging it.
**Do not create the tag automatically.** Ask the user first, then run:

```powershell
git tag stable-voice-openapp-v1
```

If no stable tag exists yet, that is acceptable. Stability must be earned through live verification, not assumed.

---

## Last Known Test Results (Previous Session — NOT Current)

| Test | Result | Notes |
|---|---|---|
| `npx tsc --noEmit` | ✅ | 0 errors (previous session) |
| `nodeBridgeSingletonTest.ts` | ✅ | 9/9 (previous session) |
| `voiceRouteMockTest.ts` | ✅ | 9/9 (previous session) |
| `interruptGatingTest.ts` | ✅ | 3/3 (previous session) |
| `openAppSmokeTest.ts youtube` | ✅ | (previous session) |
| `deterministicCommandRouteTest.ts` | ✅ | 39/39 after security fix (previous session) |
| `latencySmokeTest.ts` | ✅ | 47ms (previous session) |
| **Live voice test** | ⚠️ | **NOT confirmed in current session** |

> Previous session results are reference only. Re-run all tests before claiming stability.
