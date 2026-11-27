"""
tests/python/test_wakeword_pause_drops_echo.py
─────────────────────────────────────────────────────────────────────────────
Voice phase, echo (owner's PC N-PC1 / F8): JARVIS heard its own reply and ran
it as a command. The owner's stt_debug.log (2026-10-03 to 2026-11-01) shows
the WHOLE reply coming back without a wake word: "close in YouTube Sir" for
"Closing YouTube, sir.", "opening YouTube search" for "Opening youtube, sir.".

Cause: a pause did not stop the recording in progress. force_pause() called
self.mic.stream.stop_stream(), but self.mic.stream is SpeechRecognition's
MicrophoneStream wrapper, which has only read() and close() (owner's PC:
SpeechRecognition 3.16.0, hasattr(..., 'stop_stream') == False). The
AttributeError was hidden. listen() kept recording JARVIS's reply, and the
resume after speaking_end arrived before listen() returned (a 145 ms gap
against 1.2 s of silence), so the reply was queued and sent as a follow-up.

Fix: a pause is counted; a recording whose speech began before capture was
resumed after a pause is dropped, even when capture was resumed before
listen() returned. Speech that began after the resume is kept. When the
speech began is worked out from how SpeechRecognition's listen() builds a
recording (_listen in 3.16/3.17): up to non_speaking_duration of quiet before
the speech (counting the buffer that crossed the threshold), the speech, then
listen() returns after pause_threshold of quiet and keeps non_speaking_duration
of it; a phrase cut by phrase_time_limit has no quiet wait at the end. The
recordings below are built the same way, at 16 kHz with 1024-sample buffers.

Each check waits for the capture loop's actual decision (the phrase queued,
or the "Dropped a phrase" line), with a 5 s limit, instead of a fixed sleep.

SpeechRecognition and websockets are replaced; no microphone or network.
"""
import asyncio
import json
import logging
import math
import os
import queue
import sys
import threading
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))

RATE, WIDTH, CHUNK = 16000, 2, 1024
SPB = CHUNK / RATE                      # one buffer: 64 ms
DECISION_TIMEOUT = 5.0

sr = types.ModuleType("speech_recognition")
class _Err(Exception): pass
sr.UnknownValueError = type("UnknownValueError", (_Err,), {})
sr.RequestError = type("RequestError", (_Err,), {})
sr.WaitTimeoutError = type("WaitTimeoutError", (_Err,), {})

class AudioData:
    def __init__(self, label, seconds):
        self.label = label
        self.sample_rate = RATE
        self.sample_width = WIDTH
        self.frame_data = b"\0" * (int(round(seconds / SPB)) * CHUNK * WIDTH)
sr.AudioData = AudioData

class NoLength:
    """A recording whose length cannot be read."""
    label = "no length"


class Ctl:
    """Lets the test decide when listen() records a phrase and when it returns."""
    def __init__(self):
        self.armed = threading.Event()      # the next listen() call records a phrase
        self.in_listen = threading.Event()  # that call has begun recording
        self.release = threading.Event()    # listen() may return the phrase
        self.audio = None
CTL = Ctl()


class Recognizer:
    def __init__(self, *a, **k):
        self.energy_threshold = 300
        self.dynamic_energy_threshold = True
        self.pause_threshold = 0.8          # wakeWords sets PAUSE_THRESHOLD (1.2)
        self.non_speaking_duration = 0.5    # SpeechRecognition's default
    def adjust_for_ambient_noise(self, source, duration=1):
        pass
    def listen(self, source, timeout=None, phrase_time_limit=None):
        if not CTL.armed.wait(0.05):
            raise sr.WaitTimeoutError("silence")
        CTL.armed.clear()
        CTL.in_listen.set()
        CTL.release.wait(10)
        CTL.release.clear()
        CTL.in_listen.clear()
        return CTL.audio
    def recognize_google(self, audio):
        return HEARD["text"]
sr.Recognizer = Recognizer
HEARD = {"text": ""}


STREAM_ATTEMPTS = []
class MicrophoneStream:
    """Shaped like SpeechRecognition's wrapper: read() and close() only."""
    def read(self, size):
        return b""
    def close(self):
        pass
    def __getattr__(self, name):
        STREAM_ATTEMPTS.append(name)
        raise AttributeError(name)

class Microphone:
    CHUNK = CHUNK
    SAMPLE_RATE = RATE
    def __init__(self, *a, **k):
        self.stream = None
    def __enter__(self):
        self.stream = MicrophoneStream()
        return self
    def __exit__(self, *exc):
        self.stream = None
        MIC_EXITED.set()            # the capture loop has left the microphone (check 15)
        return False
MIC_EXITED = threading.Event()
sr.Microphone = Microphone
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


# ── The capture loop's decision: queued, or the "Dropped a phrase" line ──────
DECIDED = threading.Event()
DROPS = []
records = []
class Grab(logging.Handler):
    def emit(self, record):
        msg = record.getMessage()
        records.append(msg)
        if msg.startswith("Dropped a phrase"):
            DROPS.append(msg)
            DECIDED.set()
wakeWords.log.addHandler(Grab())
wakeWords.log.setLevel(logging.DEBUG)

class WatchedQueue(queue.Queue):
    def put_nowait(self, item):
        super().put_nowait(item)
        DECIDED.set()


# ── Recordings shaped like SpeechRecognition's listen() output ───────────────
PAUSE_T = wakeWords.PAUSE_THRESHOLD
N = math.ceil(0.5 / SPB)                 # non_speaking_duration in buffers
P = math.ceil(PAUSE_T / SPB)             # pause_threshold in buffers
PRE = (N - 1) * SPB                      # quiet kept before the speech
KEPT_AFTER = N * SPB                     # quiet kept after it
QUIET_WAIT = (P + 1) * SPB               # listen() returns this long after the speech ends

def ended_on_silence(label, speech_s):
    return AudioData(label, PRE + speech_s + KEPT_AFTER)

def cut_by_limit(label, limit_s):
    return AudioData(label, PRE + limit_s)


class FakeWS:
    """The bridge's commands to the wake-word service, as _ws_receiver reads them."""
    def __init__(self, actions):
        self._msgs = [json.dumps({"type": "command", "payload": {"action": a}}) for a in actions]
        self.sent = []
        self.open = True
    def __aiter__(self):
        return self
    async def __anext__(self):
        if not self._msgs:
            raise StopAsyncIteration
        return self._msgs.pop(0)
    async def send(self, msg):
        self.sent.append(json.loads(msg))


def bridge(det, *actions):
    asyncio.run(det._ws_receiver(FakeWS(list(actions))))

def start(cls=None):
    q = WatchedQueue(maxsize=10)
    cap = (cls or wakeWords.AudioCaptureThread)(q)
    cap.start()
    det = wakeWords.WakeWordDetector()
    det._capture_thread = cap
    return q, cap, det

def stop(cap):
    cap.stop()
    CTL.release.set()
    cap.join(3)
    CTL.release.clear()
    CTL.armed.clear()
    CTL.in_listen.clear()

SETUP = []   # whether each scripted recording began (check 14)

def recording_began(where):
    """Waits for listen() to start the scripted recording; a FAIL here means the
    check that follows is not meaningful."""
    began = CTL.in_listen.wait(2)
    SETUP.append(began)
    if not began:
        ok(f"{where}: listen() started the scripted recording within 2 s", False)
    return began

def begin_recording():
    """The next listen() call starts recording (its result is set later)."""
    CTL.audio = None
    CTL.armed.set()
    return recording_began("begin_recording()")

def finish(audio):
    """listen() returns `audio`; waits for the capture loop to queue or drop it."""
    CTL.audio = audio
    DECIDED.clear()
    del DROPS[:]
    CTL.release.set()
    return DECIDED.wait(DECISION_TIMEOUT)

def labels(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait().label)
    return out

def reply_heard(det, cap, label, reply_s, gap_s=0.15):
    """JARVIS speaks for reply_s while listen() records it: pause at speaking_start,
    resume and context_active gap_s after it ends (speaking_end, then idle), and
    listen() returns pause_threshold of quiet after the reply."""
    begin_recording()
    bridge(det, "pause")
    time.sleep(reply_s + gap_s)
    bridge(det, "resume")
    det._activate_context_capture(10)
    time.sleep(max(0.0, QUIET_WAIT - gap_s))
    return finish(ended_on_silence(label, reply_s))

def expect_dropped(tag, q, decided, label):
    got = labels(q)
    ok(f"{tag} \"{label}\" is dropped, not queued", decided and got == [] and len(DROPS) == 1,
       f"decided={decided}, queued={got}, drops={len(DROPS)}")

def expect_kept(tag, q, decided, label):
    got = labels(q)
    ok(f"{tag} \"{label}\" is queued", decided and got == [label] and not DROPS,
       f"decided={decided}, queued={got}, drops={len(DROPS)}")


print("\n=== A pause drops the recording in progress (voice echo N-PC1) ===\n")
print(f"(recordings: {SPB*1000:.0f} ms buffers; quiet kept {PRE:.3f}s before / {KEPT_AFTER:.3f}s after; "
      f"listen() returns {QUIET_WAIT:.2f}s after the speech)\n")

print("--- 1. The logged echo: a 1.3 s reply, resumed before listen() returns ---")
q, cap, det = start()
decided = reply_heard(det, cap, "Closing YouTube, sir.", 1.3)
ok("1a. capture was listening again before listen() returned", cap.is_listening is True)
expect_dropped("1b.", q, decided, "Closing YouTube, sir.")
stop(cap)

print("\n--- 2. Short replies (under 0.6 s), as heard on the PC ---")
for reply_s in (0.6, 0.4, 0.3):
    q, cap, det = start()
    decided = reply_heard(det, cap, f"Done, sir. ({reply_s}s)", reply_s)
    expect_dropped(f"2. {reply_s}s:", q, decided, f"Done, sir. ({reply_s}s)")
    stop(cap)

print("\n--- 3. Normal speech with no pause is kept ---")
q, cap, det = start()
begin_recording()
decided = finish(ended_on_silence("jarvis open youtube", 1.4))
expect_kept("3.", q, decided, "jarvis open youtube")
stop(cap)

print("\n--- 4. A phrase that ended before the pause is kept; one during it is not ---")
q, cap, det = start()
begin_recording()
decided = finish(ended_on_silence("jarvis close youtube", 1.4))
expect_kept("4a.", q, decided, "jarvis close youtube")
begin_recording()
bridge(det, "pause")
decided = finish(ended_on_silence("Closing YouTube, sir.", 1.3))
expect_dropped("4b. still paused:", q, decided, "Closing YouTube, sir.")
stop(cap)

print("\n--- 5. The owner's follow-up after the reply, in the same listen() call, is kept ---")
for after_resume in (0.3, 0.15):
    q, cap, det = start()
    begin_recording()
    bridge(det, "pause")
    time.sleep(1.0 + 0.15)                       # the reply, then the post-play gap
    bridge(det, "resume")
    det._activate_context_capture(10)
    time.sleep(after_resume + 0.6 + QUIET_WAIT)  # the owner speaks 0.6 s
    decided = finish(ended_on_silence("close youtube", 0.6))
    expect_kept(f"5. speech {after_resume}s after the resume:", q, decided, "close youtube")
    stop(cap)

print("\n--- 6. A long follow-up cut by phrase_time_limit is kept ---")
saved_limit = wakeWords.PHRASE_TIME_LIMIT
wakeWords.PHRASE_TIME_LIMIT = 1.5
q, cap, det = start()
begin_recording()
bridge(det, "pause")
time.sleep(0.5)
bridge(det, "resume")
time.sleep(0.3 + 1.5)                            # the owner talks on until the limit
decided = finish(cut_by_limit("play some music on youtube and then", 1.5))
expect_kept("6.", q, decided, "play some music on youtube and then")
stop(cap)
wakeWords.PHRASE_TIME_LIMIT = saved_limit

print("\n--- 7. A second resume (context_active while listening) does not move the resume time ---")
q, cap, det = start()
begin_recording()
bridge(det, "pause")
time.sleep(0.3)
bridge(det, "resume")
time.sleep(0.3)                                  # the owner starts speaking (0.768 s)
time.sleep(0.4)
det._activate_context_capture(10)                # is_listening = True again, while the owner speaks
time.sleep(0.368 + QUIET_WAIT)
decided = finish(ended_on_silence("close youtube", 0.768))
expect_kept("7.", q, decided, "close youtube")
stop(cap)

print("\n--- 8. After a dropped recording, the next one is kept ---")
q, cap, det = start()
reply_heard(det, cap, "Opening youtube, sir.", 1.3)
labels(q)
begin_recording()
decided = finish(ended_on_silence("close youtube", 0.8))
expect_kept("8.", q, decided, "close youtube")
stop(cap)

print("\n--- 9. A recording whose length cannot be read, after a pause, is dropped ---")
q, cap, det = start()
begin_recording()
bridge(det, "pause", "resume")
decided = finish(NoLength())
expect_dropped("9.", q, decided, "no length")
stop(cap)

print("\n--- 10. The wake word's own pauses (_recognize) drop what was recorded meanwhile ---")
for heard, what in (("jarvis open youtube", "inline command"), ("jarvis", "wake word only")):
    q, cap, det = start()
    det._ws = FakeWS([])
    begin_recording()                            # the owner's next words are being recorded
    HEARD["text"] = heard
    before = cap._pause_count
    asyncio.run(det._recognize(object()))
    ok(f"10. {what}: _recognize paused capture", cap._pause_count == before + 1 and cap.is_listening is False,
       f"pauses {before}->{cap._pause_count}, listening={cap.is_listening}")
    time.sleep(0.2)
    bridge(det, "resume")                        # stt_result handled, or the STT session ended
    decided = finish(ended_on_silence("jarvis open youtube", 1.4))
    expect_dropped(f"10. {what}:", q, decided, "jarvis open youtube")
    stop(cap)
HEARD["text"] = ""

print("\n--- 11. The pause race: a pause between the loop's check and listen() ---")
SPY = []
INJECT = {"on": False}
class Spy(wakeWords.AudioCaptureThread):
    @property
    def is_listening(self):
        on = self._listening
        if INJECT["on"] and on and threading.current_thread() is self:
            INJECT["on"] = False
            self.force_pause()                   # speaking_start lands right after the check
            self.is_listening = True             # the resume is back before listen() returns
            CTL.armed.set()
        return on
    @is_listening.setter
    def is_listening(self, on):
        SPY.append((on, self._pause_count))
        wakeWords.AudioCaptureThread.is_listening.fset(self, on)

q, cap, det = start(Spy)
time.sleep(0.2)
del SPY[:]
cap.force_pause()
ok("11a. force_pause stops listening before it counts the pause",
   SPY and SPY[-1] == (False, cap._pause_count - 1), f"setter saw {SPY}, count now {cap._pause_count}")
cap.is_listening = True
time.sleep(0.2)
INJECT["on"] = True
recording_began("11b. after the injected pause")
decided = finish(ended_on_silence("Opening youtube, sir.", 1.3))
expect_dropped("11b.", q, decided, "Opening youtube, sir.")
stop(cap)

print("\n--- 12. The pause does not call the wrapper's missing stop_stream() ---")
ok("12. no attempt to use stop_stream", "stop_stream" not in STREAM_ATTEMPTS, str(sorted(set(STREAM_ATTEMPTS))))

print("\n--- 13. _speech_began(): the buffer model, checked value by value ---")
# Expected values are counted in buffers from SpeechRecognition's _listen():
# N = ceil(non_speaking_duration / buffer) buffers are kept before the speech,
# counting the trigger buffer, and N after it; listen() returns P + 1 quiet
# buffers after the speech, P = ceil(pause_threshold / buffer). So the speech
# began (P + 1 + speech buffers) buffers before listen() returned. A phrase cut
# by phrase_time_limit began (recording - (N - 1)) buffers before. listen()
# returns at 100.0 in every row.
def rec(buffers, rate=RATE, chunk=CHUNK):
    a = types.SimpleNamespace(sample_rate=rate, sample_width=WIDTH)
    a.frame_data = b"\0" * (buffers * chunk * WIDTH)
    return a

def thread_for(chunk=CHUNK, pause=1.2):
    cap = wakeWords.AudioCaptureThread(queue.Queue())
    cap.mic = Microphone() if chunk is not None else types.SimpleNamespace()
    if chunk is not None:
        cap.mic.CHUNK = chunk
    cap.recognizer.pause_threshold = pause
    cap.recognizer.non_speaking_duration = 0.5
    return cap

saved_limit = wakeWords.PHRASE_TIME_LIMIT
wakeWords.PHRASE_TIME_LIMIT = 8
B16, B44, B48 = 1024 / 16000, 1024 / 44100, 1024 / 48000   # N, P: 8, 19 | 22, 52 | 24, 57
TABLE = [
    # label, thread, recording, expected start
    ("16 kHz, 10 speech buffers, ended on silence (B1, B2, A16)",
     thread_for(), rec(7 + 10 + 8), 100.0 - (19 + 1 + 10) * B16),
    ("44.1 kHz, 40 speech buffers, ended on silence",
     thread_for(), rec(21 + 40 + 22, rate=44100), 100.0 - (52 + 1 + 40) * B44),
    ("48 kHz, 30 speech buffers, ended on silence",
     thread_for(), rec(23 + 30 + 24, rate=48000), 100.0 - (57 + 1 + 30) * B48),
    ("16 kHz, pause_threshold 0.8 (P = 13), 10 speech buffers",
     thread_for(pause=0.8), rec(7 + 10 + 8), 100.0 - (13 + 1 + 10) * B16),
    ("16 kHz, longest phrase that ends on silence: 7.68 s (120 buffers)",
     thread_for(), rec(120), 100.0 - (19 + 1 + 105) * B16),
    # SpeechRecognition adds 0.064 to its elapsed time buffer by buffer; the float
    # drift ends the 8 s phrase after 124 reads, so the longest limit-cut
    # recording at 16 kHz is 8 + 124 buffers (8.448 s).
    ("16 kHz, cut by the 8 s limit while speaking: 8.448 s (8 + 124 buffers)",
     thread_for(), rec(8 + 124), 100.0 - (124 + 1) * B16),
    # No phrase that ends on silence is this long (7.68 s at most, row above), so
    # an 8.0 s recording was cut by the limit, with quiet buffers past N popped.
    # The limit branch puts the start up to N buffers late (toward keeping the
    # owner's speech); the silence branch would put it 0.32 s early.
    ("16 kHz, exactly 8.0 s (125 buffers): cut by the limit, not ended on silence (A15)",
     thread_for(), rec(125), 100.0 - (125 - 7) * B16),
    ("no CHUNK: whole-second fallback, 1.6 s ended on silence",
     thread_for(chunk=None), rec(25), 100.0 - 1.2 - (1.6 - 0.5 - 0.5)),
    ("no CHUNK: whole-second fallback, 8.448 s cut by the limit",
     thread_for(chunk=None), rec(132), 100.0 - 8.448 + 0.5),
]
for label, cap_t, audio, expected in TABLE:
    got = cap_t._speech_began(audio, 100.0)
    ok(f"13. {label}", got is not None and abs(got - expected) < 1e-6,
       f"expected {expected:.4f}, got {'None' if got is None else f'{got:.4f}'}")
got = thread_for()._speech_began(NoLength(), 100.0)
ok("13. a recording whose length cannot be read gives None", got is None, str(got))
wakeWords.PHRASE_TIME_LIMIT = saved_limit

print("\n--- 14. Every scripted recording in checks 1-11 actually began ---")
# 1: 1, 2: 3, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1, 8: 2, 9: 1, 10: 2, 11: 1.
ok("14. listen() started exactly 17 scripted recordings, each within 2 s",
   len(SETUP) == 17 and all(SETUP), f"{sum(SETUP)} began of {len(SETUP)} scripted")

print("\n--- 15. A pause half-done when listen() returns: nothing is queued (B5) ---")
# force_pause() stops listening first and counts the pause second. If listen()
# returns between the two steps, the count still matches, so the phrase is not
# dropped as overlapping a pause; it must still not be queued, because capture
# is paused. The subclass puts the first step exactly there; the second step is
# done once the capture loop has left the microphone. No sleeps.
HALF_PAUSE = {"on": False}
class HalfPause(wakeWords.AudioCaptureThread):
    def _recorded_across_pause(self, audio, pauses_before, returned_at):
        if HALF_PAUSE["on"]:
            HALF_PAUSE["on"] = False
            self.is_listening = False        # force_pause(), first step
        return super()._recorded_across_pause(audio, pauses_before, returned_at)

q, cap, det = start(HalfPause)
began = begin_recording()                    # counted after check 14, asserted below
HALF_PAUSE["on"] = True
MIC_EXITED.clear()
CTL.audio = ended_on_silence("Opening youtube, sir.", 1.3)
CTL.release.set()
left = MIC_EXITED.wait(DECISION_TIMEOUT)
pauses = cap._pause_count
cap._pause_count += 1                        # force_pause(), second step
got = labels(q)
ok("15. the phrase is not queued, and the loop leaves the microphone",
   began and left and got == [] and pauses == 0, f"began={began}, left mic={left}, pauses before step 2={pauses}, queued={got}")
stop(cap)

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
