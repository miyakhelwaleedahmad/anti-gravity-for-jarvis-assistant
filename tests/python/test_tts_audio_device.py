"""
tests/python/test_tts_audio_device.py
─────────────────────────────────────────────────────────────────────────────
VOICE-004: an audio device that fails to open is reported to JARVIS and tried
again, instead of muting speech for the rest of the run in silence.

tts.py marked the mixer "initialised" before trying it, so one failed
pygame.mixer.init() (headphones unplugged at start, the device in exclusive
use, a Bluetooth device not connected yet) disabled audio until JARVIS was
restarted, and the only hardware_error message was sent at connect time,
before the mixer had ever been tried.

Runs without edge-tts, pygame, websockets or the network: stand-ins replace them.
"""
import asyncio
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))
os.environ["JARVIS_TTS_MIXER_RETRY_S"] = "0"   # retry on the next phrase (the default waits 10 s)
sys.modules.setdefault("websockets", types.ModuleType("websockets"))

passed = failed = 0


def ok(label, condition, detail=""):
    global passed, failed
    if condition:
        print(f"  PASS: {label}" + (f" ({detail})" if detail else ""))
        passed += 1
    else:
        print(f"  FAIL: {label}" + (f" ({detail})" if detail else ""))
        failed += 1


class Communicate:
    def __init__(self, *a, **k):
        pass

    async def save(self, path):
        return None


edge = types.ModuleType("edge_tts")
edge.Communicate = Communicate
sys.modules["edge_tts"] = edge

# pygame stand-in: mixer.init() fails while `device_ok` is False.
state = {"device_ok": False, "init_calls": 0, "played": 0}


class Music:
    def load(self, path):
        pass

    def play(self):
        state["played"] += 1

    def get_busy(self):
        return False

    def unload(self):
        pass

    def stop(self):
        pass


class Mixer:
    music = Music()

    def init(self):
        state["init_calls"] += 1
        if not state["device_ok"]:
            raise RuntimeError("WASAPI can't find requested audio endpoint: Element not found.")

    def get_init(self):
        return (44100, -16, 2)


pg = types.ModuleType("pygame")
pg.mixer = Mixer()
sys.modules["pygame"] = pg

import tts  # noqa: E402


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))


print("\n=== TTS audio device failure (VOICE-004) ===\n")


async def scenarios():
    e = tts.TTSEngine()
    e.websocket = FakeWS()
    await e.speak("Opening Chrome, sir.")
    errors = [m for m in e.websocket.sent if m["type"] == "hardware_error"]
    ok("a failed audio device is reported to JARVIS", len(errors) == 1, json.dumps(e.websocket.sent))
    ok("…with the reason", "audio endpoint" in json.dumps(errors), json.dumps(errors))
    ok("…and the speaking turn still ends (no 12 s wait)", any(m["type"] == "speaking_end" for m in e.websocket.sent))

    await e.speak("Still there, sir?")
    ok("the device is tried again on the next phrase", state["init_calls"] == 2, f"init calls: {state['init_calls']}")
    ok("…and a failure that persists is not reported again", len([m for m in e.websocket.sent if m["type"] == "hardware_error"]) == 1)

    state["device_ok"] = True
    await e.speak("Can you hear me now, sir?")
    ok("once the device works, the phrase is played", state["played"] == 1, f"played: {state['played']}")


asyncio.run(scenarios())
print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
