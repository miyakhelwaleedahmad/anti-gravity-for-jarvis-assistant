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
        self.is_listening = True
        self.recognizer   = sr.Recognizer()
        self.recognizer.energy_threshold = ENERGY_THRESHOLD
        self.recognizer.dynamic_energy_threshold = True
        self.recognizer.pause_threshold  = PAUSE_THRESHOLD
        self.mic = None

    def stop(self) -> None:
        self._stop_event.set()
        self.force_pause()

    def force_pause(self):
        log.debug("Forcing audio capture to pause and release microphone...")
        self.is_listening = False
        try:
            if self.mic is not None and getattr(self.mic, 'stream', None) is not None:
                self.mic.stream.stop_stream()
        except Exception:
            pass

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
                    while self.is_listening and not self._stop_event.is_set():
                        try:
                            audio = self.recognizer.listen(
                                source,
                                timeout=LISTEN_TIMEOUT,
                                phrase_time_limit=PHRASE_TIME_LIMIT,
                            )
                            if self.is_listening:
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
        self._speech_buffer = []
        self._last_speech_time = time.time()
        if self._capture_thread:
            self._capture_thread.is_listening = True
        log.info(f"Command continuation active for {duration} seconds.")

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
            return

        if matched:
            now = time.time()
            last_wake = getattr(self, '_last_wake_time', 0)
            if now - last_wake < 5.0:
                log.debug("Wake word debounce active. Ignoring duplicate trigger.")
                return

            log.info(f'🚀 Wake word matched: "{word}" in "{text}"')
            self._last_wake_time = now

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
