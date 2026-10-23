"""
tests/python/test_tts_edge_skip.py
─────────────────────────────────────────────────────────────────────────────
BUG-5: edge-tts answered HTTP 403 on every utterance, and each sentence
still tried it twice (~4 s) before the offline voice spoke.
BUG-6: the offline voices were cold every time: pyttsx3 was created per
sentence and the Windows voice started a new PowerShell (20 s seen).

  1. A 403 is not retried within the sentence.
  2. After a 403, edge-tts is skipped for JARVIS_TTS_EDGE_SKIP_S; the next
     sentences go straight to the offline voice.
  3. Other failures (no network) skip it only after two in a row.
  4. A success resets the count.
  5. pyttsx3 is tried before the Windows PowerShell voice, and one engine is
     created for many phrases (on its own thread), not one per phrase.

Runs without edge-tts, pygame, pyttsx3, websockets or the network.
"""
import asyncio
import base64
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))
os.environ["JARVIS_TTS_EDGE_TIMEOUT"] = "0.1"
os.environ["JARVIS_TTS_EDGE_RETRY_TIMEOUT"] = "0.1"
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


EDGE = {"mode": "fail"}   # fail (a 403), slow (a network error), ok
CALLS = {"edge": 0}


class Communicate:   # stand-in edge-tts
    def __init__(self, *a, **k):
        pass

    async def save(self, path):
        CALLS["edge"] += 1
        if EDGE["mode"] == "slow":
            raise RuntimeError("Cannot connect to host speech.platform.bing.com")
        if EDGE["mode"] == "fail":
            raise RuntimeError("403, message='Invalid response status'")
        if EDGE["mode"] == "silent":   # "succeeds" without writing anything
            return
        with open(path, "wb") as f:
            f.write(b"" if EDGE["mode"] == "empty" else b"ID3 audio")


edge = types.ModuleType("edge_tts")
edge.Communicate = Communicate
sys.modules["edge_tts"] = edge

loaded = []


class Music:
    def load(self, path):
        loaded.append(path)

    def play(self):
        pass

    def get_busy(self):
        return False

    def unload(self):
        pass

    def stop(self):
        pass


class Mixer:
    music = Music()

    def init(self):
        pass

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


print("\n=== edge-tts refused: skipped, not retried per sentence (BUG-5); warm offline voice (BUG-6) ===\n")


async def turn(e, text):
    e.websocket.sent.clear()
    e._end_sent_for_current_item = False
    await e.speak(text)
    await e._send_speaking_end("queue_empty", force=True)
    return [m["payload"] for m in e.websocket.sent if m["type"] == "speaking_end"]


async def scenarios():
    used = []

    def good(text, path):
        used.append(text)
        with open(path, "wb") as f:
            f.write(b"RIFF audio")
        return True

    e = tts.TTSEngine()
    e.websocket = FakeWS()
    e._mixer_available = e._mixer_initialized = True
    e._pygame = pg
    e._fallback_engines = [("good", good)]

    EDGE["mode"] = "fail"; CALLS["edge"] = 0
    ends = await turn(e, "First reply, sir.")
    ok("a 403 is tried once, not twice", CALLS["edge"] == 1, f"{CALLS['edge']} edge-tts calls")
    ok("…and the offline voice speaks the sentence", ends and ends[0].get("outcome") == "played" and used == ["First reply, sir."], f"{used} {json.dumps(ends)}")
    CALLS["edge"] = 0
    await turn(e, "Second reply, sir.")
    await turn(e, "Third reply, sir.")
    ok("after a 403 the next sentences skip edge-tts", CALLS["edge"] == 0 and used[-2:] == ["Second reply, sir.", "Third reply, sir."], f"{CALLS['edge']} calls, {used}")

    e2 = tts.TTSEngine()
    e2.websocket = FakeWS()
    e2._mixer_available = e2._mixer_initialized = True
    e2._pygame = pg
    e2._fallback_engines = [("good", good)]
    EDGE["mode"] = "slow"; CALLS["edge"] = 0
    await turn(e2, "One.")
    ok("one network failure does not skip edge-tts yet", e2._edge_skip_until == 0.0)
    EDGE["mode"] = "ok"
    await turn(e2, "Two.")
    ok("a success resets the count", e2._edge_failures == 0 and e2._edge_skip_until == 0.0)
    EDGE["mode"] = "slow"
    await turn(e2, "Three.")
    await turn(e2, "Four.")
    ok("two failures in a row skip edge-tts", e2._edge_skip_until > 0)


asyncio.run(scenarios())

# 5. The offline voices: order and one warm engine.
import importlib.machinery  # noqa: E402
made = []
class FakeEngine:
    def save_to_file(self, text, path):
        self._job = (text, path)
    def runAndWait(self):
        with open(self._job[1], "wb") as f:
            f.write(b"RIFF audio")
fake = types.ModuleType("pyttsx3")
fake.__spec__ = importlib.machinery.ModuleSpec("pyttsx3", None)
def init():
    made.append(1)
    return FakeEngine()
fake.init = init
sys.modules["pyttsx3"] = fake
names = [n for n, _ in tts._offline_voices()]
ok("pyttsx3 comes before the Windows PowerShell voice", names[0] == "pyttsx3" and (os.name != "nt" or names[-1] == "windows-sapi"), str(names))
import tempfile  # noqa: E402
paths = [os.path.join(tempfile.gettempdir(), f"jarvis_tts_warm_{i}.wav") for i in range(3)]
results = [tts._speak_pyttsx3(f"phrase {i}", p) for i, p in enumerate(paths)]
ok("three phrases, one pyttsx3 engine (kept warm on its thread)", all(results) and len(made) == 1, f"results {results}, engines made {len(made)}")
for p in paths:
    try:
        os.remove(p)
    except OSError:
        pass

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
