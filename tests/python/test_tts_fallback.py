"""
tests/python/test_tts_fallback.py
─────────────────────────────────────────────────────────────────────────────
VOICE-003: when edge-tts gives no audio, tts.py speaks with an offline voice.

edge-tts needs the network and Microsoft's service (which has refused
outdated clients with HTTP 403). When both attempts failed, the phrase was
dropped: the self-healing "fallback_tts: pyttsx3" action only changed a
label, and tts.py had no second engine.

Now a failed edge-tts synthesis falls back to pyttsx3 (if installed) or, on
Windows, the built-in voice through PowerShell System.Speech, written to a
WAV file and played through the same pygame path. JARVIS_TTS_FALLBACK=off
turns it off. The text reaches PowerShell base64-encoded, never as code.

Edge cases: an empty file from edge-tts or a fallback is no audio; a voice
that throws is skipped once; a stop during fallback synthesis plays nothing;
the engine that played is named; the fallback's WAV is removed after use.

Runs without edge-tts, pygame, websockets, PowerShell or the network.
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


EDGE = {"mode": "fail"}   # fail (no network or a 403), empty (a 0-byte file), ok


class Communicate:   # stand-in edge-tts
    def __init__(self, *a, **k):
        pass

    async def save(self, path):
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


print("\n=== Offline TTS fallback (VOICE-003) ===\n")


async def turn(e, text):
    e.websocket.sent.clear()
    e._end_sent_for_current_item = False
    await e.speak(text)
    await e._send_speaking_end("queue_empty", force=True)
    return [m["payload"] for m in e.websocket.sent if m["type"] == "speaking_end"]


async def scenarios():
    calls = []

    def stand_in(text, path):
        calls.append((text, path))
        with open(path, "wb") as f:   # an empty file would be "no audio"
            f.write(b"RIFF audio")
        return True

    e = tts.TTSEngine()
    e.websocket = FakeWS()
    ok("(setup) the engine has a fallback list", hasattr(e, "_fallback_engines"), "no _fallback_engines on TTSEngine")
    e._fallback_engines = [("stand-in", stand_in)]
    ends = await turn(e, "Opening Chrome, sir.")
    ok("edge-tts failing: the fallback voice is asked for the same text", calls and calls[0][0] == "Opening Chrome, sir.", str(calls))
    ok("…and its audio is what is played", loaded and calls and loaded[-1] == calls[0][1], f"loaded {loaded[-1:]}")
    ok("…and the turn reports played, by the fallback", ends and ends[0].get("outcome") == "played" and "stand-in" in ends[0].get("detail", ""), json.dumps(ends))

    def broken(text, path):
        return False
    e._fallback_engines = [("broken", broken)]
    ends = await turn(e, "Second phrase, sir.")
    ok("the fallback failing too: reported as synthesis_failed", ends and ends[0].get("outcome") == "synthesis_failed", json.dumps(ends))

    import importlib.machinery
    fake = types.ModuleType("pyttsx3")
    fake.__spec__ = importlib.machinery.ModuleSpec("pyttsx3", None)
    sys.modules["pyttsx3"] = fake
    names = [n for n, _ in tts.TTSEngine()._fallback_engines]
    ok("pyttsx3 installed: it is one of the fallback voices", "pyttsx3" in names, str(names))
    os.environ["JARVIS_TTS_FALLBACK"] = "off"
    off = tts.TTSEngine()
    ok("JARVIS_TTS_FALLBACK=off: no fallback engines", getattr(off, "_fallback_engines", None) == [], str(getattr(off, "_fallback_engines", "missing")))
    del os.environ["JARVIS_TTS_FALLBACK"]
    del sys.modules["pyttsx3"]

    print("\n--- Edge cases ---")
    used = []

    def good(text, path):
        used.append("good")
        with open(path, "wb") as f:
            f.write(b"RIFF audio")
        return True

    def claims_but_empty(text, path):
        used.append("empty")
        open(path, "wb").close()
        return True

    def raises(text, path):
        used.append("raises")
        raise OSError("voice not installed")

    e = tts.TTSEngine()
    e.websocket = FakeWS()
    EDGE["mode"] = "empty"
    e._fallback_engines = [("good", good)]
    ends = await turn(e, "Empty file, sir.")
    ok("edge-tts writing an empty file counts as no audio: the fallback speaks", used == ["good"] and ends and ends[0].get("outcome") == "played", f"{used} {json.dumps(ends)}")
    EDGE["mode"] = "fail"

    used.clear()
    e._fallback_engines = [("empty", claims_but_empty)]
    ends = await turn(e, "Claims success, sir.")
    ok("a fallback that says yes but wrote nothing is synthesis_failed, not played", ends and ends[0].get("outcome") == "synthesis_failed", json.dumps(ends))

    used.clear()
    e._fallback_engines = [("raises", raises), ("good", good)]
    ends = await turn(e, "First voice broken, sir.")
    ok("a fallback that throws is tried once, then the next one speaks", used == ["raises", "good"] and ends and ends[0].get("outcome") == "played", f"{used} {json.dumps(ends)}")
    ok("…and the engine that played is named on speaking_end", ends and ends[0].get("engine") == "good", json.dumps(ends))
    ok("the fallback's audio file is removed after playback", not os.path.exists(e._fallback_path), e._fallback_path)

    used.clear()

    def stopped_meanwhile(text, path):
        used.append("stopped")
        e._interrupt_flag = True   # the user's stop arrives while the voice works
        with open(path, "wb") as f:
            f.write(b"RIFF audio")
        return True
    e._fallback_engines = [("stopped", stopped_meanwhile), ("good", good)]
    before = len(loaded)
    ends = await turn(e, "Stop me, sir.")
    ok("a stop during fallback synthesis: nothing is played, no other voice tried", len(loaded) == before and used == ["stopped"], f"{used}, played {len(loaded) - before}")
    ok("…and the turn is not reported as played", not ends or ends[0].get("outcome") != "played", json.dumps(ends))
    e._interrupt_flag = False

    used.clear()
    EDGE["mode"] = "ok"
    e._fallback_engines = [("good", good)]
    # The cases above failed edge-tts on purpose, so it is being skipped now
    # (BUG-5, tests/python/test_tts_edge_skip.py); this case is about a working edge-tts.
    e._edge_skip_until = 0.0
    ends = await turn(e, "Normal reply, sir.")
    ok("normal playback names edge-tts and does not touch the fallback", used == [] and ends and ends[0].get("engine") == "edge-tts", f"{used} {json.dumps(ends)}")
    EDGE["mode"] = "fail"

    used.clear()
    EDGE["mode"] = "ok"
    await turn(e, "First reply, sir.")          # leaves its audio file behind
    EDGE["mode"] = "silent"
    e._fallback_engines = []
    ends = await turn(e, "Second reply, sir.")
    ok("edge-tts writing nothing does not replay the last reply's file", ends and ends[0].get("outcome") == "synthesis_failed", json.dumps(ends))
    EDGE["mode"] = "fail"

    none = tts.TTSEngine()
    none.websocket = FakeWS()
    none._fallback_engines = []   # e.g. Linux without pyttsx3, or a Windows voice that is missing
    ends = await turn(none, "No voices, sir.")
    ok("no fallback voice available: synthesis_failed, saying so", ends and ends[0].get("outcome") == "synthesis_failed" and "no offline voice" in ends[0].get("detail", ""), json.dumps(ends))

    print("\n--- The Windows voice gets the text as data, not as code ---")
    nasty = "Done'; Remove-Item C:\\\\ -Recurse; $(calc) `whoami` \"x\""
    argv = tts._sapi_command(nasty, "C:\\\\Temp\\\\jarvis tts.wav") if hasattr(tts, "_sapi_command") else []
    script = " ".join(argv)
    ok("(setup) a PowerShell command is built", bool(argv), str(argv[:3]))
    ok("the text does not appear in the command", argv and "Remove-Item" not in script and "calc" not in script, script[:160])
    blobs = [part for part in script.replace("'", " ").split() if len(part) > 20]
    decoded = []
    for b in blobs:
        try:
            decoded.append(base64.b64decode(b).decode("utf-8"))
        except Exception:
            pass
    ok("…it is passed base64-encoded and decodes back exactly", nasty in decoded, str(decoded)[:200])


asyncio.run(scenarios())
print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
