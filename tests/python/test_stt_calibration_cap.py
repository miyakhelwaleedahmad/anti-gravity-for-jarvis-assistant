"""
tests/python/test_stt_calibration_cap.py
─────────────────────────────────────────────────────────────────────────────
BUG-2: the STT calibration runs right after the wake word, so its sample can
hold the owner's voice. In the owner's log it measured 580; the VAD gate then
needed 580 × 1.5 = 870 and the owner's loudest frame was 688: rejected, and
JARVIS heard nothing.

Now a session's level is capped at the room baseline (the quietest level
seen, rising at most 10% a session) × JARVIS_STT_MAX_FLOOR_RISE (2.0). The
numbers below are the log's.

The startup sample (the first baseline) is taken once the audio libraries
have loaded, in the background: run() started it before they loaded, when it
did nothing, and before connecting to NodeBridge.
"""
import os
import sys
import threading
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))
sys.modules.setdefault("websockets", types.ModuleType("websockets"))
os.environ["JARVIS_STT_MIN_ENERGY_RATIO"] = "1.5"

import stt  # noqa: E402

passed = failed = 0


def ok(label, condition, detail=""):
    global passed, failed
    print(f"  {'PASS' if condition else 'FAIL'}: {label}" + (f" ({detail})" if detail else ""))
    if condition:
        passed += 1
    else:
        failed += 1


print("\n=== STT calibration is capped by the room baseline (BUG-2) ===\n")
stt._ambient_baseline = None
quiet = stt._bounded_energy(162.0)          # startup sample: nobody talking
ok("a quiet room's level is used as it is", quiet == 162.0, f"{quiet}")
voiced = stt._bounded_energy(580.0)          # the sample after the wake word held the owner's voice
gate = voiced * stt.STT_MIN_ENERGY_RATIO
ok("a sample with speech in it is capped at baseline × 2", abs(voiced - 162.0 * 1.1 * 2) < 1 or voiced <= 162.0 * 2.2, f"{voiced:.0f}")
ok("the owner's loudest frame (688) now passes the gate", 688 > gate, f"gate {gate:.0f}")
ok("the baseline itself did not jump to the voiced sample", stt._ambient_baseline < 200, f"{stt._ambient_baseline:.0f}")
for _ in range(20):
    stt._bounded_energy(400.0)                # the room really got louder (a fan)
ok("a room that really gets louder is followed, slowly", stt._ambient_baseline > 390, f"{stt._ambient_baseline:.0f}")
ok("a nonsense measurement (0) does not reset the baseline", stt._bounded_energy(0.0) == stt._ambient_baseline)

print("\n--- The startup sample ---")


class Mic:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Recognizer:
    energy_threshold = 300

    def adjust_for_ambient_noise(self, source, duration=0.5):
        samples.append(duration)
        self.energy_threshold = 150.0


samples = []
fake_sr = types.ModuleType("speech_recognition")
fake_sr.Recognizer = Recognizer
fake_sr.Microphone = Mic
stt._imports_ready_event.wait(10)
stt._imports_ready_event.clear()            # the audio libraries are still loading
stt.sr = None
stt._ambient_baseline = None
th = threading.Thread(target=getattr(stt, "_startup_calibration", lambda *a: None), args=(5.0,), daemon=True)
th.start()
th.join(0.3)
ok("(setup) the startup sample waits for the audio libraries", th.is_alive() and not samples, f"alive={th.is_alive()} samples={samples}")
stt.sr = fake_sr
stt._imports_ready_event.set()
th.join(3)
ok("…then takes one ambient sample: the room baseline", samples and stt._ambient_baseline == 150.0, f"samples={samples} baseline={stt._ambient_baseline}")
samples.clear()
stt.stt_lock.acquire()
try:
    stt._startup_calibration(1.0)
finally:
    stt.stt_lock.release()
ok("a listen session holding the mic: no startup sample", samples == [], str(samples))
src = open(os.path.join(ROOT, "voice", "stt.py"), encoding="utf-8").read()
run_body = src[src.index("    async def run(self)"):src.index("websockets.connect(WS_URI)")]
ok("run() does not wait for it before connecting", "await asyncio.to_thread(_calibrate_energy)" not in run_body and "create_task(asyncio.to_thread(_startup_calibration))" in run_body)

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
