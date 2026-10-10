"""
tests/python/test_tts_retry_delay.py
─────────────────────────────────────────────────────────────────────────────
tts.py tells JARVIS when a synthesis retry needs more time
(docs/PROVIDER_HEALTH_AUDIT.md §4, item 15).

JARVIS arms its SPEAKING watchdog when it sends the text and allows ~1 s for
synthesis. A first edge-tts attempt that times out plus a retry used that up,
the watchdog fired during normal speech, reopened the mic and logged "TTS may
have crashed". tts.py now sends `speaking_delay` (extra_ms = the retry's own
timeout) before retrying.

Runs without edge-tts, pygame, websockets or the network: stand-ins replace them.
"""
import asyncio
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))

os.environ["JARVIS_TTS_EDGE_TIMEOUT"] = "0.2"
os.environ["JARVIS_TTS_EDGE_RETRY_TIMEOUT"] = "0.3"

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


# edge_tts stand-in: each Communicate.save takes the next delay from `delays`.
delays = []


class Communicate:
    def __init__(self, text, voice=None, rate=None, pitch=None):
        self.text = text

    async def save(self, path):
        d = delays.pop(0) if delays else 0.0
        if isinstance(d, Exception):
            raise d
        await asyncio.sleep(d)


edge = types.ModuleType("edge_tts")
edge.Communicate = Communicate
sys.modules["edge_tts"] = edge

import tts  # noqa: E402


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))


def engine():
    e = tts.TTSEngine()
    e.websocket = FakeWS()
    return e


print("\n=== TTS retry delay ===\n")


async def scenarios():
    print("--- First attempt in time: no delay message ---")
    delays[:] = [0.05]
    e = engine()
    ok("synthesis succeeds", await e._synthesize_with_retry("hello"))
    ok("nothing extra is sent", e.websocket.sent == [], str(e.websocket.sent))

    print("\n--- First attempt times out, the retry works ---")
    delays[:] = [1.0, 0.05]
    e = engine()
    ok("synthesis succeeds on the retry", await e._synthesize_with_retry("hello"))
    kinds = [m["type"] for m in e.websocket.sent]
    ok("one speaking_delay is sent before the retry", kinds == ["speaking_delay"], str(e.websocket.sent))
    payload = e.websocket.sent[0]["payload"] if e.websocket.sent else {}
    ok("it asks for the retry's own timeout (300 ms here), with a reason",
       payload.get("extra_ms") == 300 and payload.get("reason") == "synthesis_retry", str(payload))

    print("\n--- First attempt errors, the retry works ---")
    delays[:] = [RuntimeError("connection reset"), 0.05]
    e = engine()
    ok("synthesis succeeds on the retry", await e._synthesize_with_retry("hello"))
    ok("a speaking_delay is sent for the retry", [m["type"] for m in e.websocket.sent] == ["speaking_delay"], str(e.websocket.sent))

    print("\n--- Both attempts time out ---")
    delays[:] = [1.0, 1.0]
    e = engine()
    ok("synthesis reports failure", not await e._synthesize_with_retry("hello"))
    ok("one delay message only (none after the last attempt)", [m["type"] for m in e.websocket.sent] == ["speaking_delay"], str(e.websocket.sent))

    print("\n--- Interrupted: no delay message ---")
    delays[:] = [1.0, 0.05]
    e = engine()
    e._interrupt_flag = True
    ok("an interrupted synthesis stops", not await e._synthesize_with_retry("hello"))
    ok("and asks for no extra time", e.websocket.sent == [], str(e.websocket.sent))

    print("\n--- No connection to JARVIS: the retry still happens ---")
    delays[:] = [1.0, 0.05]
    e = engine()
    e.websocket = None
    ok("synthesis succeeds without a websocket", await e._synthesize_with_retry("hello"))


asyncio.run(scenarios())
print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
