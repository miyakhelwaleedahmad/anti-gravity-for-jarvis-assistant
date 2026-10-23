"""
tests/python/test_wakeword_followup.py
─────────────────────────────────────────────────────────────────────────────
BUG-3: follow-ups without the wake word were dropped in silence.

NodeBridge opens the follow-up window (context_active) when the reply is
handed to TTS, often before speech starts. With a slow voice the window ran
out while JARVIS was still talking, and Google STT's clear transcripts of
what the owner said next ("why you are not responding to my voice") were
neither routed nor logged.

  1. A window nobody used yet reopens in full when the mic resumes after
     the reply.
  2. While the owner keeps talking, each follow-up keeps the window open.
  3. A clear sentence outside the window is logged as ignored, not dropped
     silently.
  4. A wake word uses the window up: a later resume does not reopen it.

Google STT is replaced; no microphone or network.
"""
import asyncio
import logging
import os
import sys
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))

sr = types.ModuleType("speech_recognition")
class _Err(Exception): pass
sr.UnknownValueError = type("UnknownValueError", (_Err,), {})
sr.RequestError = type("RequestError", (_Err,), {})
sr.WaitTimeoutError = type("WaitTimeoutError", (_Err,), {})
sr.AudioData = object
sr.Microphone = object
HEARD = {"text": ""}
class Recognizer:
    def __init__(self, *a, **k):
        self.energy_threshold = 300
    def recognize_google(self, audio):
        return HEARD["text"]
sr.Recognizer = Recognizer
sys.modules["speech_recognition"] = sr
ws = types.ModuleType("websockets")
wse = types.ModuleType("websockets.exceptions")
wse.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
wse.WebSocketException = type("WebSocketException", (Exception,), {})
ws.exceptions = wse
sys.modules["websockets"] = ws
sys.modules["websockets.exceptions"] = wse

import wakeWords  # noqa: E402

passed = failed = 0
def ok(label, condition, detail=""):
    global passed, failed
    print(f"  {'PASS' if condition else 'FAIL'}: {label}" + (f" ({detail})" if detail else ""))
    if condition:
        passed += 1
    else:
        failed += 1

records = []
class Grab(logging.Handler):
    def emit(self, record):
        records.append(record.getMessage())
wakeWords.log.addHandler(Grab())
wakeWords.log.setLevel(logging.DEBUG)

def hear(det, text):
    HEARD["text"] = text
    records.clear()
    asyncio.run(det._recognize(object()))
    return list(records)

print("\n=== Wake word follow-up window (BUG-3) ===\n")
det = wakeWords.WakeWordDetector()

# 1. Window opened while the reply is still being synthesised, then it runs out.
det._activate_context_capture(2)
det.active_until = time.time() - 5          # the slow voice took longer than the window
det._reopen_unused_context()                 # the mic resumes after the reply
ok("an unused window reopens in full after the reply", det.active_until > time.time() + 1.5, f"{det.active_until - time.time():.1f}s")

# 2. Follow-ups keep it open.
before = det.active_until
time.sleep(0.2)
logs = hear(det, "change the song to Sanam Re")
ok("a follow-up inside the window is taken (Context chunk)", any("Context chunk" in m for m in logs), str(logs))
ok("…and keeps the window open (conversation mode)", det.active_until > before, f"{det.active_until - before:.2f}s later")
det._reopen_unused_context()
ok("a window that was used is not reopened on the next resume", det.active_until < time.time() + 2.5)

# 3. Outside the window: logged, not silent.
det.active_until = time.time() - 3
logs = hear(det, "why you are not responding to my voice")
ok("a clear sentence outside the window is logged as ignored", any(m.startswith("Ignored (no wake word") and "why you are not responding" in m for m in logs), str(logs))

# 4. A wake word uses the window up.
det2 = wakeWords.WakeWordDetector()
det2._activate_context_capture(2)
det2._send_wake_event = lambda *a, **k: asyncio.sleep(0)
det2.active_until = time.time() - 1
hear(det2, "jarvis")
det2._reopen_unused_context()
ok("after a wake word, the old window is not reopened", det2.active_until < time.time())

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
