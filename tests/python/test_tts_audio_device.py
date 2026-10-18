"""
tests/python/test_tts_audio_device.py
─────────────────────────────────────────────────────────────────────────────
VOICE-004: an audio device that fails to open is reported to JARVIS and tried
again, instead of muting speech for the rest of the run in silence.
VOICE-005: every speaking_end says what happened (played, synthesis_failed,
no_audio_device, interrupted), so JARVIS can tell a reply that was heard.

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
os.environ["JARVIS_TTS_FALLBACK"] = "off"   # these checks are about edge-tts; the offline voice has its own test
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

    async def turn(text):
        """One speaking turn, as the worker runs it: the phrase, then speaking_end when the queue is empty."""
        e.websocket.sent.clear()
        e._end_sent_for_current_item = False
        e._interrupt_flag = False
        await e.speak(text)
        await e._send_speaking_end("queue_empty", force=True)
        return list(e.websocket.sent)

    sent = await turn("Opening Chrome, sir.")
    errors = [m for m in sent if m["type"] == "hardware_error"]
    ok("a failed audio device is reported to JARVIS", len(errors) == 1, json.dumps(sent))
    ok("…with the reason", "audio endpoint" in json.dumps(errors), json.dumps(errors))
    ok("…and the speaking turn still ends (no 12 s wait)", any(m["type"] == "speaking_end" for m in sent))

    sent = await turn("Still there, sir?")
    ok("the device is tried again on the next phrase", state["init_calls"] == 2, f"init calls: {state['init_calls']}")
    ok("…and a failure that persists is not reported again", not [m for m in sent if m["type"] == "hardware_error"])
    ends = [m["payload"] for m in sent if m["type"] == "speaking_end"]
    ok("VOICE-005: a turn with no audio device ends with outcome no_audio_device", ends and ends[0].get("outcome") == "no_audio_device", json.dumps(ends))

    state["device_ok"] = True
    sent = await turn("Can you hear me now, sir?")
    ok("once the device works, the phrase is played", state["played"] == 1, f"played: {state['played']}")
    ends = [m["payload"] for m in sent if m["type"] == "speaking_end"]
    ok("VOICE-005: a turn that played ends with outcome played", ends and ends[0].get("outcome") == "played", json.dumps(ends))

    async def no_audio(text):
        return False
    e._synthesize_with_retry = no_audio
    sent = await turn("This will not synthesise, sir.")
    ends = [m["payload"] for m in sent if m["type"] == "speaking_end"]
    ok("VOICE-005: a phrase edge-tts could not synthesise ends with outcome synthesis_failed", ends and ends[0].get("outcome") == "synthesis_failed", json.dumps(ends))

    # A device that stays broken: with the real retry delay, phrases in a row
    # do not each try to open it again (no retry storm), and each still ends.
    broken = tts.TTSEngine()
    broken.websocket = FakeWS()
    state["device_ok"] = False
    tts.TTS_MIXER_RETRY_S = 10.0
    calls_before = state["init_calls"]
    ends_seen = 0
    for i in range(6):
        broken.websocket.sent.clear()
        broken._end_sent_for_current_item = False
        await broken.speak(f"Phrase {i}, sir.")
        await broken._send_speaking_end("queue_empty", force=True)
        ends_seen += sum(1 for m in broken.websocket.sent if m["type"] == "speaking_end")
    ok("a device that stays broken is tried once in 10 s, not on every phrase", state["init_calls"] - calls_before == 1, f"{state['init_calls'] - calls_before} tries for 6 phrases")
    ok("…and every one of those turns still ends", ends_seen == 6, f"{ends_seen} speaking_end")
    tts.TTS_MIXER_RETRY_S = 0.0


asyncio.run(scenarios())
print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
