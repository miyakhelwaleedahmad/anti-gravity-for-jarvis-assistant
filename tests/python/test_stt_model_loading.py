"""
tests/python/test_stt_model_loading.py
─────────────────────────────────────────────────────────────────────────────
BUG-17: importing faster_whisper took 123 s on the owner's PC (STT ready
after 135 s). Whisper already loads in a background thread, but a command
spoken meanwhile waited up to 60 s in _transcribe and was lost.

  1. While Whisper is loading, a command waits JARVIS_STT_MODEL_WAIT_S
     (default 5 s), then Google STT transcribes it.
  2. The result says which engine answered (the dashboard label, BUG-7).
  3. Google STT failing gives '' (the session ends with stt_no_speech).
  4. Once Whisper is loaded, Whisper transcribes as before.

No microphone, Whisper, network or speech_recognition: stand-ins.
"""
import asyncio
import json
import os
import sys
import threading
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))
os.environ["JARVIS_STT_MODEL_WAIT_S"] = "0.3"
sys.modules.setdefault("websockets", types.ModuleType("websockets"))

import stt  # noqa: E402

passed = failed = 0


def ok(label, condition, detail=""):
    global passed, failed
    print(f"  {'PASS' if condition else 'FAIL'}: {label}" + (f" ({detail})" if detail else ""))
    if condition:
        passed += 1
    else:
        failed += 1


GOOGLE = {"text": "open notepad", "fail": False}


class Recognizer:
    def recognize_google(self, audio):
        if GOOGLE["fail"]:
            raise RuntimeError("no network")
        return GOOGLE["text"]


fake_sr = types.ModuleType("speech_recognition")
fake_sr.Recognizer = Recognizer


class Audio:
    def get_raw_data(self, convert_rate=16000, convert_width=2):
        return b"\x00\x00" * 1600


class Socket:
    def __init__(self):
        self.sent = []

    async def send(self, text):
        self.sent.append(json.loads(text))


def timed(fn, limit=3.0):
    """fn() in a thread; (result, seconds), or (None, None) if it is still running after `limit`."""
    box = {}
    t0 = time.time()
    th = threading.Thread(target=lambda: box.setdefault("r", fn()), daemon=True)
    th.start()
    th.join(limit)
    return (box.get("r"), time.time() - t0) if "r" in box else (None, None)


print("\n=== STT while Whisper is loading (BUG-17) ===\n")

stt._imports_ready_event.wait(10)
stt._model_ready_event.wait(10)      # the real loader finds no Whisper here and gives up
stt._model_ready_event.clear()       # as if it were still importing faster_whisper
stt.model = None
stt.sr = fake_sr

engine = stt.STTEngine()
text, secs = timed(lambda: engine._transcribe(Audio()))
ok("a command while Whisper loads is transcribed, not held for 60 s", text == "open notepad", f"{text!r} after {secs if secs is None else round(secs, 2)}s")
ok("…by Google STT, after the configured wait", getattr(engine, "_last_engine", None) == "Google STT" and secs is not None and 0.25 <= secs < 2, f"{getattr(engine, '_last_engine', None)}, {secs}")

engine.websocket = Socket()
engine._last_sent_text = ""
asyncio.run(engine._send_result(text or "open notepad"))
sent = engine.websocket.sent[-1]["payload"] if engine.websocket.sent else {}
ok("the result names the engine that heard it", sent.get("engine") == "Google STT", json.dumps(sent))

GOOGLE["fail"] = True
text, secs = timed(lambda: engine._transcribe(Audio()))
ok("Google STT failing too: '' (the session then ends with stt_no_speech)", text == "", repr(text))
GOOGLE["fail"] = False


class Segment:
    text = " play sanam re"


class Whisper:
    def transcribe(self, audio, **kw):
        return [Segment()], None


stt.model = Whisper()
stt._model_ready_event.set()
text, secs = timed(lambda: engine._transcribe(Audio()))
ok("Whisper loaded: Whisper transcribes, as before", text == "play sanam re" and engine._last_engine == "Whisper", f"{text!r}, {engine._last_engine}")

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
