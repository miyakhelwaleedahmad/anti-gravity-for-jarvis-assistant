"""
tests/python/test_stt_session_end.py
─────────────────────────────────────────────────────────────────────────────
BUG-1: every listen session ends with a message to NodeBridge.

The owner said "Jarvis" and nothing more. STT calibrated, the VAD gate
rejected the audio, and listen_and_transcribe returned without a word to
NodeBridge: the state stayed LISTENING, STT kept the mic and the wake word
stayed paused for 15 minutes.

Now each session that produces no transcript sends stt_no_speech with the
reason (vad_rejected, timeout, empty_transcript, error, not_sent,
hardware_error); one with a transcript sends stt_result only. No microphone,
Whisper or speech_recognition needed: the recording, gate and transcriber are
replaced and the websocket records what was sent.
"""
import asyncio
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))
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


class Socket:
    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    async def send(self, text):
        if self.fail:
            raise ConnectionError("closed")
        self.sent.append(json.loads(text))


def session(record=None, gate=True, transcript="", raises=None, last_sent="", hardware_ok=True):
    """Run one listen session with the given stand-ins; return what was sent."""
    engine = stt.STTEngine()
    engine.websocket = Socket()
    engine._last_sent_text = last_sent
    engine._hardware_ok = hardware_ok

    def fake_record():
        if raises:
            raise raises
        if record == "timeout":
            engine._timed_out = True
            return None
        if record is None:
            return None
        return (object(), 300.0)

    engine._record_audio = fake_record
    engine._transcribe = lambda audio: transcript
    stt._calibrate_energy = lambda: 300.0
    stt._vad_gate = lambda audio, floor: gate
    asyncio.run(engine.listen_and_transcribe())
    return engine.websocket.sent


def types_of(sent):
    return [m["type"] for m in sent]


def reason(sent):
    return next((m["payload"]["reason"] for m in sent if m["type"] == "stt_no_speech"), None)


print("\n=== STT: every listen session ends with a message (BUG-1) ===\n")

sent = session(record="audio", gate=False)
ok("VAD gate rejects the audio → stt_no_speech (vad_rejected)", types_of(sent) == ["stt_no_speech"] and reason(sent) == "vad_rejected", str(sent))

sent = session(record="timeout")
ok("nobody speaks before the timeout → stt_no_speech (timeout)", types_of(sent) == ["stt_no_speech"] and reason(sent) == "timeout", str(sent))

sent = session(record="audio", gate=True, transcript="")
ok("Whisper returns nothing → stt_no_speech (empty_transcript)", types_of(sent) == ["stt_no_speech"] and reason(sent) == "empty_transcript", str(sent))

sent = session(raises=RuntimeError("device busy"))
ok("an exception while recording → stt_no_speech (error)", types_of(sent) == ["stt_no_speech"] and reason(sent) == "error", str(sent))

sent = session(record=None, hardware_ok=False)
ok("no microphone → hardware_error, then stt_no_speech", types_of(sent) == ["hardware_error", "stt_no_speech"] and reason(sent) == "hardware_error", str(sent))

sent = session(record="audio", gate=True, transcript="open notepad")
ok("a real transcript → stt_result only, no stt_no_speech", types_of(sent) == ["stt_result"] and sent[0]["payload"]["text"], str(sent))

sent = session(record="audio", gate=True, transcript="open notepad", last_sent="open notepad")
ok("a repeat that is suppressed as a duplicate still ends the session", types_of(sent) == ["stt_no_speech"] and reason(sent) == "not_sent", str(sent))

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
