"""
tests/python/test_stt_vad_gate.py
─────────────────────────────────────────────────────────────────────────────
VOICE-009: the STT energy gate judged a recording by one RMS over all of it.

A recording holds the pause the recogniser waits for after speech (and some
silence before it). A short, soft "yes" followed by that pause averaged below
the threshold and was dropped before Whisper heard it; a single loud click in
silence averaged above it and was sent to Whisper.

Now the gate looks at 20 ms frames: it passes when at least 100 ms of frames
are above the threshold. Synthetic 16 kHz audio; no microphone, Whisper or
speech_recognition needed.
"""
import math
import os
import struct
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))
sys.modules.setdefault("websockets", types.ModuleType("websockets"))
os.environ["JARVIS_STT_MIN_ENERGY_RATIO"] = "1.5"

import stt  # noqa: E402

RATE = 16000
passed = failed = 0


def ok(label, condition, detail=""):
    global passed, failed
    print(f"  {'PASS' if condition else 'FAIL'}: {label}" + (f" ({detail})" if detail else ""))
    if condition:
        passed += 1
    else:
        failed += 1


def tone(seconds, amplitude, freq=220.0):
    return [amplitude * math.sin(2 * math.pi * freq * i / RATE) for i in range(int(seconds * RATE))]


def hiss(seconds, amplitude):
    # Deterministic low-level noise.
    return [amplitude * math.sin(i * 12.9898) for i in range(int(seconds * RATE))]


class Audio:   # the part of speech_recognition.AudioData the gate uses
    def __init__(self, samples):
        self.raw = b"".join(struct.pack("<h", max(-32768, min(32767, int(s)))) for s in samples)

    def get_raw_data(self, convert_rate=None, convert_width=None):
        return self.raw


NOISE_FLOOR = 300.0   # threshold 450 with the 1.5 ratio
print("\n=== STT energy gate (VOICE-009) ===\n")

soft_yes = hiss(0.4, 60) + tone(0.3, 1000) + hiss(1.8, 60)   # tone RMS ~707, whole-clip RMS ~250
ok('a short, soft "yes" with the pause after it passes', stt._vad_gate(Audio(soft_yes), NOISE_FLOOR))

speech = hiss(0.2, 60) + tone(1.2, 2500) + hiss(0.8, 60)
ok("ordinary speech passes", stt._vad_gate(Audio(speech), NOISE_FLOOR))

silence = hiss(2.0, 100)
ok("room noise alone is rejected", not stt._vad_gate(Audio(silence), NOISE_FLOOR))

click = hiss(1.0, 60) + tone(0.02, 8000) + hiss(1.0, 60)   # whole-clip RMS ~570
ok("a single 20 ms click in silence is rejected", not stt._vad_gate(Audio(click), NOISE_FLOOR))

ok("empty audio is rejected", not stt._vad_gate(Audio([]), NOISE_FLOOR))

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
