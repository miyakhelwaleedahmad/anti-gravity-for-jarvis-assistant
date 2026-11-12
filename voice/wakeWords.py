"""
wakeWords.py — Jarvis Wake Word Detection  (Production-Grade Rewrite)

HIGH-6: Added offline fallback — on Google STT RequestError (network down),
falls back to recognize_sphinx() if pocketsphinx is installed,
otherwise skips the audio chunk gracefully without crashing or freezing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import queue
import threading
import time
from typing import Optional, Any

import speech_recognition as sr
import websockets
from websockets.exceptions import ConnectionClosed, WebSocketException

# ─── Configuration ───────────────────────────────────────────────────────────

WS_URI             = os.getenv("BRIDGE_WS_URI", "ws://127.0.0.1:9000")
BRIDGE_TOKEN       = os.getenv("JARVIS_BRIDGE_TOKEN", "")
BRIDGE_DEV_MODE    = os.getenv("JARVIS_BRIDGE_DEV_MODE", "").lower() == "true"
WAKE_WORDS         = [
    "jarvis", "hey jarvis", "ok jarvis", "hi jarvis", "hello jarvis", "wake up jarvis"
]
RECONNECT_DELAY    = 3
MAX_RECONNECT_WAIT = 30
ENERGY_THRESHOLD   = 300
# COMMAND-SEG-FIX: Increased from 0.6s → 1.2s.
# 0.6s was too aggressive — natural speech has ~0.3-0.5s pauses between words
# (especially between the wake word and the command). This caused the recognizer
# to cut audio mid-sentence, returning only "Jarvis open" instead of
# "Jarvis open YouTube for me". 1.2s captures complete sentences while still
# being responsive enough for real-time wake word detection.
PAUSE_THRESHOLD    = float(os.getenv("JARVIS_WW_PAUSE_THRESHOLD", "1.2"))
LISTEN_TIMEOUT     = 8
# COMMAND-SEG-FIX: Increased from 5s → 8s.
# With inline commands like "Jarvis open YouTube for me and play some music",
# 5s was cutting off longer commands. 8s gives ample room for natural speech.
PHRASE_TIME_LIMIT  = int(os.getenv("JARVIS_WW_PHRASE_TIME_LIMIT", "8"))
HEARTBEAT_INTERVAL = 20
FUZZY_THRESHOLD    = 80
COMMAND_PREFIXES   = {"open", "launch", "start"}
COMMAND_CONTEXT_SECONDS = 10

# HIGH-6: Detect if pocketsphinx is available for offline fallback
try:
    import pocketsphinx  # noqa: F401
    _SPHINX_AVAILABLE = True
except ImportError:
    _SPHINX_AVAILABLE = False

# INFO by default; JARVIS_WAKEWORD_LOG_LEVEL=DEBUG brings the detail back.
# With the root logger at DEBUG, the websockets library logged every frame —
# heartbeats, handshake headers, and the READY message carrying the bridge
# token — so it stays at WARNING whatever the level.
logging.basicConfig(
    level=getattr(logging, os.environ.get("JARVIS_WAKEWORD_LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s [WakeWord] %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("websockets").setLevel(logging.WARNING)
log = logging.getLogger("wakeword")


def _bridge_ready_payload(role: str) -> dict:
    if BRIDGE_TOKEN:
        return {"role": role, "token": BRIDGE_TOKEN}
    if BRIDGE_DEV_MODE:
        log.debug("JARVIS_BRIDGE_TOKEN missing; using explicit insecure bridge dev mode.")
        return {"role": role}
    raise RuntimeError(
        "JARVIS_BRIDGE_TOKEN is required for NodeBridge authentication. "
        "Set it in .env, or set JARVIS_BRIDGE_DEV_MODE=true only for local insecure development."
    )

# ─── Fuzzy matching ──────────────────────────────────────────────────────────

def _fuzzy_score(a: str, b: str) -> float:
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio() * 100


def _is_wake_word(text: str) -> tuple[bool, str]:
    lower = text.lower().strip()
    for w in WAKE_WORDS:
        if w in lower:
            return True, w
        if _fuzzy_score(lower, w) >= FUZZY_THRESHOLD:
            return True, w
    return False, ""


# ─── Blocking Worker Thread ───────────────────────────────────────────────────

class AudioCaptureThread(threading.Thread):
    def __init__(self, audio_queue: queue.Queue) -> None:  # type: ignore[type-arg]
        super().__init__(daemon=True, name="AudioCapture")
        self._audio_queue = audio_queue
        self._stop_event  = threading.Event()
        self._listening   = True
        # Voice echo (N-PC1): pauses so far, and when capture last went from
        # paused to listening (time.monotonic()). See _recorded_across_pause.
        self._pause_count = 0
        self._resumed_at  = 0.0
        self.recognizer   = sr.Recognizer()
        self.recognizer.energy_threshold = ENERGY_THRESHOLD
        self.recognizer.dynamic_energy_threshold = True
        self.recognizer.pause_threshold  = PAUSE_THRESHOLD
        self.mic = None

    @property
    def is_listening(self) -> bool:
        return self._listening

    @is_listening.setter
    def is_listening(self, on: bool) -> None:
        # Every resume sets this (the bridge's resume, context_active), so the
        # moment capture comes back is recorded here, in one place.
        if on and not self._listening:
            self._resumed_at = time.monotonic()
        self._listening = on

    def stop(self) -> None:
        self._stop_event.set()
        self.force_pause()

    def force_pause(self):
        # A pause cannot stop a recording that listen() has already begun:
        # self.mic.stream is SpeechRecognition's MicrophoneStream wrapper, which
        # has only read() and close(). The stop_stream() call that was here
        # raised AttributeError, hidden by its except, so JARVIS's reply kept
        # being recorded (owner's PC, SpeechRecognition 3.16.0). Stopping the
        # PyAudio stream from this thread while listen() reads it is not safe.
        # Instead the pause is counted, and the recording is dropped when
        # listen() returns (_recorded_across_pause).
        # Listening stops before the pause is counted, and the capture loop
        # notes the count before it checks is_listening: a pause between the
        # loop's check and listen() is then either seen by the check or counted
        # (review finding 2).
        log.debug("Pausing audio capture; a recording in progress will be dropped.")
        self.is_listening = False
        self._pause_count += 1

    def _speech_began(self, audio: Any, returned_at: float) -> Optional[float]:
        """
        When the speech in a recording began (time.monotonic()), worked out
        from how SpeechRecognition's listen() builds it (_listen, 3.16/3.17),
        in buffers of mic.CHUNK samples: up to non_speaking_duration of quiet
        before the speech, counting the buffer that crossed the energy
        threshold; the speech; then listen() returns after pause_threshold of
        quiet and keeps non_speaking_duration of it. A phrase cut off by
        phrase_time_limit has no quiet wait at the end. None if the length of
        the recording cannot be read.
        """
        try:
            rate = float(audio.sample_rate)
            seconds = len(audio.frame_data) / (rate * float(audio.sample_width))
        except Exception:
            return None
        quiet = float(getattr(self.recognizer, "non_speaking_duration", 0.5) or 0.0)
        pause = float(getattr(self.recognizer, "pause_threshold", PAUSE_THRESHOLD) or 0.0)
        chunk = getattr(self.mic, "CHUNK", None)
        if chunk and rate > 0:
            per_buffer = float(chunk) / rate
            quiet_buffers = math.ceil(quiet / per_buffer)
            before = (quiet_buffers - 1) * per_buffer
            after = quiet_buffers * per_buffer
            waited = (math.ceil(pause / per_buffer) + 1) * per_buffer
        else:
            before, after, waited = quiet, quiet, pause
        if PHRASE_TIME_LIMIT and seconds >= PHRASE_TIME_LIMIT:
            return returned_at - seconds + before
        return returned_at - waited - (seconds - before - after)

    def _recorded_across_pause(self, audio: Any, pauses_before: int, returned_at: float) -> bool:
        """
        Whether this recording overlaps a pause (voice echo, N-PC1): a pause
        came while listen() was recording, and the speech in it began before
        capture was resumed. The bridge resumes about 0.15 s after JARVIS stops
        talking, before listen() ends the phrase (PAUSE_THRESHOLD of silence),
        so the check cannot rely on is_listening alone. Speech that began after
        the resume, in the same listen() call, is the owner's and is kept.
        """
        if self._pause_count == pauses_before:
            return False
        if not self._listening:
            return True
        began = self._speech_began(audio, returned_at)
        if began is None:
            return True   # length unknown: drop rather than risk sending JARVIS's own words
        return began < self._resumed_at

    def run(self) -> None:
        log.info("AudioCaptureThread started.")
        self.mic = sr.Microphone()

        while not self._stop_event.is_set():
            if not self.is_listening:
                time.sleep(0.05)
                continue

            try:
                with self.mic as source:
                    if getattr(self, '_first_run', True):
                        log.info("Adjusting for ambient noise (1 s)…")
                        self.recognizer.adjust_for_ambient_noise(source, duration=1)
                        log.info(f"Energy threshold → {self.recognizer.energy_threshold:.0f}")
                        log.info(f"Listening for wake words: {WAKE_WORDS}")
                        self._first_run = False

                    # Inner loop: stay connected to mic while listening
                    while True:
                        # Noted before the check (see force_pause).
                        pauses_before = self._pause_count
                        if not self.is_listening or self._stop_event.is_set():
                            break
                        try:
                            audio = self.recognizer.listen(
                                source,
                                timeout=LISTEN_TIMEOUT,
                                phrase_time_limit=PHRASE_TIME_LIMIT,
                            )
                            returned_at = time.monotonic()
                            if self._recorded_across_pause(audio, pauses_before, returned_at):
                                log.info("Dropped a phrase recorded while capture was paused (JARVIS speaking, or the mic handed to STT).")
                            elif self.is_listening:
                                self._audio_queue.put_nowait(audio)
                                log.debug("Audio chunk captured → queued for recognition.")
                        except sr.WaitTimeoutError:
                            log.debug("Silence window elapsed — still listening.")
                        except Exception as e:
                            log.debug(f"Stream interrupted (likely paused): {e}")
                            break
            except Exception as exc:
                if self.is_listening:
                    log.error(f"AudioCaptureThread listen error: {exc}")
                time.sleep(0.1)

        log.info("AudioCaptureThread exited.")


# ─── Wake Word Detector (Async Core) ─────────────────────────────────────────

class WakeWordDetector:
    def __init__(self) -> None:
        self._audio_queue: queue.Queue = queue.Queue(maxsize=10)  # type: ignore[type-arg]
        self._capture_thread: Optional[AudioCaptureThread] = None
        self._ws: Any = None
        self._running = False
        # BUG-3: the follow-up window. NodeBridge sends context_active when the
        # reply is handed over, often before TTS has even started; with a slow
        # voice the window ran out while JARVIS was still talking, and what the
        # owner said next was dropped without a word in the log.
        self.active_until = 0.0
        self._context_duration = 0.0
        self._context_unused = False   # opened, and nothing said in it yet

    def _ws_open(self) -> bool:
        return self._ws is not None and getattr(self._ws, "open", True)

    async def _send_wake_event(self, has_command=False, partial_command="") -> None:
        if not self._ws_open():
            log.warning("WebSocket is not open — wake event dropped.")
            return
        msg = json.dumps({
            "type": "wake_word",
            "payload": {
                "detected": True,
                "time": time.time(),
                "has_command": has_command,
                "partial_command": partial_command,
            },
        })
        try:
            await self._ws.send(msg)  # type: ignore[union-attr]
            log.info("✅ Wake event sent to NodeBridge.")
        except (ConnectionClosed, WebSocketException) as exc:
            log.error(f"WebSocket send failed: {exc}")

    def _activate_context_capture(self, duration: int = COMMAND_CONTEXT_SECONDS) -> None:
        self.active_until = time.time() + duration
        self._context_duration = float(duration)
        self._context_unused = True
        self._speech_buffer = []
        self._last_speech_time = time.time()
        if self._capture_thread:
            self._capture_thread.is_listening = True
        log.info(f"Command continuation active for {duration} seconds.")

    def _reopen_unused_context(self) -> None:
        """
        After the mic resumes (JARVIS finished speaking), a follow-up window
        that nobody used yet starts again in full: it counts from the end of
        the reply, not from when the reply was handed to TTS (BUG-3).
        """
        if self._context_unused and self._context_duration:
            self.active_until = time.time() + self._context_duration
            log.info(f"Follow-up window reopened for {self._context_duration:.0f}s (counted from the end of the reply).")

    async def _recognize(self, audio: sr.AudioData) -> None:
        """
        Offload recognition to a thread. Tries Google STT first.
        HIGH-6: On RequestError (network down), falls back to sphinx (offline)
        if available, otherwise skips gracefully.

        NOTE: We intentionally do NOT send speech_detected here.
        The wake-word detector must not trigger barge-in interrupts.
        speech_detected is only meaningful from the STT module
        during active TTS playback. Sending it unconditionally on
        every audio chunk caused IDLE → INTERRUPTED state corruption.
        """
        recognizer: Any = sr.Recognizer()
        text: str | None = None

        # Primary: Google STT (online)
        try:
            text = await asyncio.to_thread(recognizer.recognize_google, audio)
            log.info(f"🎤 Google STT: \"{text}\"")
        except sr.UnknownValueError:
            # Audio not understood — normal, skip silently
            return
        except sr.RequestError as exc:
            # HIGH-6: Network failure — attempt offline fallback
            log.warning(f"Google STT unavailable: {exc}. Trying offline fallback…")
            if _SPHINX_AVAILABLE:
                try:
                    text = await asyncio.to_thread(recognizer.recognize_sphinx, audio)
                    log.info(f"🎤 Sphinx (offline) STT: \"{text}\"")
                except Exception as sphinx_exc:
                    log.warning(f"Sphinx fallback also failed: {sphinx_exc}. Skipping chunk.")
                    return
            else:
                log.warning("No offline STT available (pocketsphinx not installed). Skipping chunk.")
                return
        except Exception as exc:
            log.error(f"Recognition error: {exc}")
            return

        if text is None:
            return

        matched, word = _is_wake_word(text)
        is_active = getattr(self, 'active_until', 0) > time.time()

        if is_active and not matched:
            log.info(f"Context chunk: '{text}'")
            if not hasattr(self, '_speech_buffer'):
                self._speech_buffer = []
            self._speech_buffer.append(text.strip())
            self._last_speech_time = time.time()
            # Conversation mode: while the owner keeps talking, the window stays open.
            self._context_unused = False
            if self._context_duration:
                self.active_until = max(self.active_until, time.time() + self._context_duration)
            return

        if not matched and self._context_duration:
            # Heard clearly, but no wake word and the follow-up window is closed.
            log.info(f"Ignored (no wake word; follow-up window closed {time.time() - self.active_until:.0f}s ago): '{text}'")

        if matched:
            now = time.time()
            last_wake = getattr(self, '_last_wake_time', 0)
            if now - last_wake < 5.0:
                log.debug("Wake word debounce active. Ignoring duplicate trigger.")
                return

            log.info(f'🚀 Wake word matched: "{word}" in "{text}"')
            self._last_wake_time = now
            self._context_unused = False   # a new command: the old follow-up window is used up

            # ── COMMAND-SEG-FIX: Extract the COMPLETE command after the wake word ──
            # Strategy: strip the wake word prefix from the full transcript.
            # We try all known wake words (longest first) to find the best match.
            # This handles: "hey jarvis open YouTube" → "open YouTube"
            #               "jarvis open YouTube for me" → "open YouTube for me"
            lower_text = text.lower().strip()
            command = ""

            # Sort wake words longest-first so "hey jarvis" matches before "jarvis"
            sorted_wakes = sorted(WAKE_WORDS, key=len, reverse=True)
            for wake in sorted_wakes:
                wake_idx = lower_text.find(wake)
                if wake_idx != -1:
                    # Extract everything AFTER the wake word
                    after_wake = text[wake_idx + len(wake):].strip()
                    # Strip leading punctuation/comma that Google STT sometimes adds
                    after_wake = after_wake.lstrip(",.!? ")
                    if after_wake:
                        command = after_wake
                    break

            has_command = len(command.split()) >= 1 if command else False

            log.info(f'  full transcript: "{text}"')
            log.info(f'  extracted command: "{command}" (has_command={has_command})')

            # Send wake event FIRST — NodeBridge needs to transition state
            await self._send_wake_event(has_command=has_command, partial_command="")

            if has_command:
                # ── COMPLETE inline command captured ──
                # Send the FULL command text to NodeBridge as stt_result.
                log.info(f'Wake word + inline command: "{command}"')
                msg = json.dumps({
                    "type": "stt_result",
                    "payload": {"text": command}
                })
                log.info(f'> stt_result text="{command}"')
                ws = self._ws
                if ws is not None and self._ws_open():
                    await ws.send(msg)

                # COMMAND-SEG-FIX: Pause mic AFTER sending the command.
                # Previously force_pause() was called BEFORE extraction,
                # which could kill the audio stream mid-capture.
                if self._capture_thread:
                    self._capture_thread.force_pause()
            else:
                # ── Wake word only (no inline command) ──
                # NodeBridge will send listen_start to STT for the user to speak.
                # Pause mic to release it for STT's exclusive use.
                log.info("Wake word only (no inline command) — STT listen_start will fire from NodeBridge.")
                if self._capture_thread:
                    self._capture_thread.force_pause()
        else:
            log.debug(f'No wake word in: "{text}"')

    async def _consumer_loop(self) -> None:
        log.info("Consumer loop started.")
        while self._running:
            try:
                audio = self._audio_queue.get_nowait()
                asyncio.create_task(self._recognize(audio))
            except queue.Empty:
                await asyncio.sleep(0.05)
            except Exception as exc:
                log.error(f"Consumer loop error: {exc}")
                await asyncio.sleep(0.1)
        log.info("Consumer loop exited.")

    async def _heartbeat(self) -> None:
        while self._running:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            if self._ws_open():
                try:
                    await self._ws.ping()  # type: ignore[union-attr]
                    log.debug("💓 Heartbeat ping sent.")
                except Exception as exc:
                    log.warning(f"Heartbeat ping failed: {exc}")
                    break
            else:
                log.debug("Heartbeat skipped — WebSocket not open.")
                break

    async def _ws_receiver(self, ws: Any) -> None:
        last_action_time = 0
        async for raw_msg in ws:
            try:
                msg = json.loads(raw_msg)
                if msg.get("type") == "command":
                    action = msg.get("payload", {}).get("action")
                    if action == "pause":
                        log.info("Received pause command — pausing capture.")
                        if self._capture_thread:
                            self._capture_thread.force_pause()
                    elif action == "resume":
                        log.info("Received resume command — resuming capture.")
                        if self._capture_thread:
                            self._capture_thread.is_listening = True
                        self._reopen_unused_context()
                    elif action == "clear" or action == "reset":
                        log.info("Received clear/reset command — clearing buffer and queue.")
                        self._speech_buffer = []
                        while not self._audio_queue.empty():
                            try:
                                self._audio_queue.get_nowait()
                            except Exception:
                                break
                    elif action == "context_active":
                        duration = msg.get("payload", {}).get("duration", 15)
                        self._activate_context_capture(duration)
                        log.info(f"Context active for {duration} seconds. Listening without wake word.")
            except Exception:
                pass

    async def _run_session(self, ws: Any) -> None:
        self._ws = ws
        self._running = True

        self._capture_thread = AudioCaptureThread(self._audio_queue)
        self._capture_thread.start()

        consumer  = asyncio.create_task(self._consumer_loop())
        heartbeat = asyncio.create_task(self._heartbeat())
        receiver  = asyncio.create_task(self._ws_receiver(ws))
        flusher   = asyncio.create_task(self._buffer_flusher())

        try:
            done, pending = await asyncio.wait(
                [consumer, heartbeat, receiver, flusher],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in done:
                if task.exception():
                    raise task.exception()  # type: ignore[misc]
        finally:
            self._running = False
            if self._capture_thread is not None:
                self._capture_thread.stop()
            self._ws = None
            log.info("Session cleaned up.")

    async def _buffer_flusher(self) -> None:
        while True:
            await asyncio.sleep(0.3)
            if hasattr(self, '_speech_buffer') and self._speech_buffer:
                # PHASE1-WW-2: Reduced silence timeout 1.5s → 0.8s to match STT
                # pause_threshold. Previously a 1.5s gap was required before the
                # buffer would flush — causing commands to be delayed by 700ms.
                if time.time() - getattr(self, '_last_speech_time', 0) > 0.8:
                    final_text = " ".join(self._speech_buffer)
                    self._speech_buffer = []
                    ws = self._ws
                    if final_text.strip() and ws is not None and self._ws_open():
                        log.info(f"Flushing buffered context command: '{final_text}'")
                        try:
                            await ws.send(json.dumps({
                                "type": "stt_result",
                                "payload": {"text": final_text.strip()}
                            }))
                        except Exception:
                            pass

    async def run(self) -> None:
        delay = RECONNECT_DELAY
        _startup_deadline = time.time() + 30.0  # STARTUP-PERF: fast-retry window
        while True:
            try:
                log.info(f"Connecting to {WS_URI}…")
                async with websockets.connect(
                    WS_URI,
                    ping_interval=None,
                    close_timeout=5,
                ) as ws:
                    log.info("✔ Connected to NodeBridge.")
                    delay = RECONNECT_DELAY

                    ready_msg = json.dumps({"type": "client_ready", "payload": _bridge_ready_payload("wakeword")})
                    await ws.send(ready_msg)
                    log.info("Sent READY handshake.")

                    await self._run_session(ws)

            except (ConnectionRefusedError, OSError) as exc:
                log.warning(f"Could not connect: {exc}")
            except (ConnectionClosed, WebSocketException) as exc:
                log.warning(f"WebSocket closed unexpectedly: {exc}")
            except Exception as exc:
                log.error(f"Unhandled session error: {exc}")

            # STARTUP-PERF: Fast retry during first 30s, then exponential backoff
            if time.time() < _startup_deadline:
                actual_delay = 0.5
            else:
                actual_delay = delay
                delay = min(delay * 2, MAX_RECONNECT_WAIT)
            log.info(f"Reconnecting in {actual_delay}s…")
            await asyncio.sleep(actual_delay)

    def stop(self) -> None:
        self._running = False
        if self._capture_thread:
            self._capture_thread.stop()
        log.info("WakeWordDetector stop requested.")


# ─── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    detector = WakeWordDetector()
    try:
        asyncio.run(detector.run())
    except KeyboardInterrupt:
        detector.stop()
        log.info("Shutdown complete.")
