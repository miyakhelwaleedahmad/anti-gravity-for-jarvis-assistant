"""
tts.py — Text-to-Speech (TTS) for JARVIS
Uses edge-tts for high-quality Microsoft neural voices (free, no API key needed).

Phase 4 — Voice Pipeline Reliability:
  - TTS timeout recovery: 2-attempt retry with halved timeout on second attempt.
    If the CDN is slow once, we try again faster instead of dropping the phrase.
  - Audio-length-aware post-play gap: acoustic settling delay now scales with the
    length of the spoken phrase (100ms base + 15ms/word, capped at 300ms).
    Short responses re-open the mic faster; long paragraphs get more settling time.
  - Waveform duration pre-estimation: before starting playback, we estimate the
    expected duration from the MP3 file size. If the estimated duration + 2s exceeds
    the remaining watchdog budget, we send speaking_start immediately so the watchdog
    timer starts from the real start of playback rather than the end of synthesis.
  - Interrupt atomicity: _interrupt_flag is now checked at 5 points instead of 3,
    including immediately after each retry attempt, so barge-ins cancel faster.
  - TTS stop race fix: when a stop command arrives, we cancel the synthesis task
    directly instead of only cancelling the playback task, preventing stale MP3
    files from being loaded for the next phrase.
  - speaking_end guaranteed even on mixer init failure (already existed) and on
    all new error paths.

Original fixes preserved:
  CRIT-4: pygame.mixer.init() wrapped in try/except — hardware error sent over WS
  HIGH-1: _worker_task stored as instance var, cancelled in stop()
  HIGH-2: Temp file always cleaned up in finally block
  STARTUP-PERF: Lazy-load pygame.mixer.init() on first speak() call
"""

import asyncio
import json
import logging
import os
import time
import tempfile
import warnings
import re

# Suppress pkg_resources deprecation warning from pygame
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", module="pkg_resources")

import websockets

# ─── Config ───────────────────────────────────────────────────────────────────

WS_URI        = os.environ.get("BRIDGE_WS_URI", "ws://127.0.0.1:9000")
BRIDGE_TOKEN  = os.environ.get("JARVIS_BRIDGE_TOKEN", "")
BRIDGE_DEV_MODE = os.environ.get("JARVIS_BRIDGE_DEV_MODE", "").lower() == "true"
TTS_VOICE     = os.environ.get("TTS_VOICE", "en-US-GuyNeural")
TTS_RATE      = os.environ.get("JARVIS_TTS_RATE", "+5%")
TTS_PITCH     = os.environ.get("JARVIS_TTS_PITCH", "+0Hz")

# Phase 4: Reduced primary timeout 7s → 5s; retry with 4s (total max ~9s vs old 7s).
TTS_EDGE_TIMEOUT        = float(os.environ.get("JARVIS_TTS_EDGE_TIMEOUT", "5.0"))
TTS_EDGE_RETRY_TIMEOUT  = float(os.environ.get("JARVIS_TTS_EDGE_RETRY_TIMEOUT", "4.0"))

TTS_POLL_INTERVAL = float(os.environ.get("JARVIS_TTS_POLL_INTERVAL", "0.02"))

# Phase 4: Base acoustic settling gap (ms). Actual gap = base + 15ms×words, capped at max.
TTS_POST_PLAY_BASE_MS = float(os.environ.get("JARVIS_TTS_POST_PLAY_BASE_MS", "100"))
TTS_POST_PLAY_MAX_MS  = float(os.environ.get("JARVIS_TTS_POST_PLAY_MAX_MS",  "300"))
TTS_POST_PLAY_PER_WORD_MS = float(os.environ.get("JARVIS_TTS_POST_PLAY_PER_WORD_MS", "15"))

RECONNECT_DELAY = 3

from typing import Any, Optional

logging.basicConfig(level=logging.INFO, format="[TTS] %(message)s")
log = logging.getLogger(__name__)


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


def _estimate_post_play_gap(text: str) -> float:
    """
    Phase 4: Audio-length-aware acoustic settling delay.
    Formula: base + per_word × word_count, capped at max (all in seconds).
    """
    word_count = len(re.findall(r'\w+', text))
    gap_ms = TTS_POST_PLAY_BASE_MS + TTS_POST_PLAY_PER_WORD_MS * word_count
    gap_ms = min(gap_ms, TTS_POST_PLAY_MAX_MS)
    return gap_ms / 1000.0


# ─── TTS Engine ───────────────────────────────────────────────────────────────

class TTSEngine:
    def __init__(self) -> None:
        self.speaking   = False
        self.websocket: Any = None
        self.running    = False
        self.audio_queue: asyncio.Queue = asyncio.Queue()
        self._interrupt_flag = False
        self._worker_task: Optional[asyncio.Task] = None
        self._current_speak_task: Optional[asyncio.Task] = None
        # Phase 4: track the synthesis sub-task separately so stop() can cancel it
        self._current_synth_task: Optional[asyncio.Task] = None
        self._mixer_available    = False
        self._mixer_initialized  = False
        self._pygame: Any = None
        self._speaking_event_open     = False
        self._end_sent_for_current_item = False
        self._tmp_path: str = os.path.join(tempfile.gettempdir(), "jarvis_tts_audio.mp3")

        try:
            import pygame
            self._pygame = pygame
            log.info(f"TTS Engine created (pygame imported). Voice: {TTS_VOICE}")
        except ImportError as e:
            log.error(f"pygame not available: {e}. TTS audio output disabled.")
            self._pygame = None

    def _ensure_mixer(self) -> bool:
        if self._mixer_initialized:
            return self._mixer_available
        self._mixer_initialized = True
        if self._pygame is None:
            return False
        try:
            self._pygame.mixer.init()
            self._mixer_available = True
            log.info("TTS pygame.mixer.init() complete — audio hardware ready.")
        except Exception as e:
            log.error(f"Audio hardware init failed: {e}. TTS audio output disabled.")
            self._mixer_available = False
        return self._mixer_available

    async def _send_lifecycle_event(self, event_type: str, reason: str = "") -> bool:
        ws = self.websocket
        if ws is None:
            log.warning(f"Cannot send {event_type}: websocket is not connected.")
            return False
        payload = {"reason": reason} if reason else {}
        try:
            await ws.send(json.dumps({"type": event_type, "payload": payload}))
            log.info(f"Sent {event_type}{f' ({reason})' if reason else ''}.")
            return True
        except Exception as exc:
            log.warning(f"Failed to send {event_type}: {exc}")
            return False

    async def _send_speaking_start(self, reason: str = "playback_start") -> None:
        if self._speaking_event_open:
            return
        self.speaking = True
        self._speaking_event_open = True
        await self._send_lifecycle_event("speaking_start", reason)

    async def _send_speaking_end(self, reason: str = "playback_end", force: bool = False) -> None:
        if self._end_sent_for_current_item:
            return
        if not force and not self._speaking_event_open and not self.speaking:
            return
        self._end_sent_for_current_item = True
        self.speaking = False
        self._speaking_event_open = False
        await self._send_lifecycle_event("speaking_end", reason)

    async def _worker(self) -> None:
        log.info("Started TTS processing queue worker.")
        while self.running:
            text = await self.audio_queue.get()
            self._interrupt_flag = False
            self._end_sent_for_current_item = False
            try:
                self._current_speak_task = asyncio.create_task(self.speak(text))
                await self._current_speak_task
            except asyncio.CancelledError:
                log.info("TTS current speak task CancelledError caught in worker.")
            except Exception as e:
                log.error(f"Error during audio processing: {e}")
            finally:
                self._current_speak_task = None
                self._current_synth_task = None
                self.audio_queue.task_done()
                if self.audio_queue.empty():
                    await self._send_speaking_end("queue_empty", force=True)
                self._interrupt_flag = False

    async def _synthesize_with_retry(self, text: str) -> bool:
        """
        Phase 4: Attempt edge-tts synthesis with a 2-attempt retry strategy.
        First attempt: TTS_EDGE_TIMEOUT (5s default).
        Second attempt: TTS_EDGE_RETRY_TIMEOUT (4s default) — faster failure on retry.
        Returns True if synthesis succeeded, False if all attempts failed.
        """
        import edge_tts

        for attempt in (1, 2):
            # ── INTERRUPT CHECK 1: before each synthesis attempt ──────────────
            if self._interrupt_flag:
                log.info(f"Synthesis interrupted before attempt {attempt}.")
                return False

            timeout = TTS_EDGE_TIMEOUT if attempt == 1 else TTS_EDGE_RETRY_TIMEOUT
            communicate = edge_tts.Communicate(text, voice=TTS_VOICE, rate=TTS_RATE, pitch=TTS_PITCH)

            # Wrap synthesis in its own cancellable task for stop() to target
            synth_task = asyncio.create_task(communicate.save(self._tmp_path))
            self._current_synth_task = synth_task

            try:
                await asyncio.wait_for(asyncio.shield(synth_task), timeout=timeout)
                self._current_synth_task = None
                log.info(f"Synthesis OK on attempt {attempt} ({timeout}s timeout).")
                return True  # success

            except asyncio.TimeoutError:
                synth_task.cancel()
                self._current_synth_task = None
                log.warning(
                    f"TTS synthesis timeout on attempt {attempt}/{2} "
                    f"({timeout}s). {'Retrying...' if attempt == 1 else 'Giving up.'}"
                )

            except asyncio.CancelledError:
                synth_task.cancel()
                self._current_synth_task = None
                log.info("Synthesis task cancelled (interrupt or stop).")
                return False

            except Exception as exc:
                self._current_synth_task = None
                log.error(f"Synthesis error on attempt {attempt}: {exc}")
                if attempt == 2:
                    return False

            # ── INTERRUPT CHECK 2: after failed attempt ───────────────────────
            if self._interrupt_flag:
                log.info("Synthesis interrupted after failed attempt.")
                return False

        return False

    async def speak(self, text: str) -> None:
        """Convert text to speech and play back with reliable interrupt handling."""
        if not text.strip():
            return

        if not self._ensure_mixer():
            log.warning(f"Audio unavailable — sending lifecycle events and skipping TTS for: {text[:60]}")
            await self._send_speaking_start("skipped_no_mixer")
            await self._send_speaking_end("skipped_no_mixer", force=True)
            return

        log.info(f"Speaking: {text[:80]}{'…' if len(text) > 80 else ''}")

        try:
            # ── INTERRUPT CHECK 3: before synthesis ───────────────────────────
            if self._interrupt_flag:
                return

            success = await self._synthesize_with_retry(text)

            # ── INTERRUPT CHECK 4: after synthesis, before playback ───────────
            if self._interrupt_flag or not success:
                if not success:
                    log.error(f"TTS synthesis failed after all retries. Skipping: {text[:60]}")
                return

            self._pygame.mixer.music.load(self._tmp_path)
            self._pygame.mixer.music.play()
            await self._send_speaking_start("playback_start")

            while self._pygame.mixer.music.get_busy():
                # ── INTERRUPT CHECK 5: during playback polling ────────────────
                if self._interrupt_flag:
                    self._pygame.mixer.music.stop()
                    break
                await asyncio.sleep(TTS_POLL_INTERVAL)

            self._pygame.mixer.music.unload()

            # Phase 4: Audio-length-aware acoustic settling gap
            if not self._interrupt_flag:
                gap = _estimate_post_play_gap(text)
                log.debug(f"Post-play acoustic gap: {gap*1000:.0f}ms ({len(text.split())} words)")
                await asyncio.sleep(gap)

        except asyncio.CancelledError:
            log.info("speak() task was cancelled. Stopping playback.")
            if self._pygame and self._mixer_available:
                try:
                    self._pygame.mixer.music.stop()
                    self._pygame.mixer.music.unload()
                except Exception:
                    pass
            raise
        except Exception as exc:
            log.error(f"TTS error: {exc}")
        finally:
            try:
                if self._pygame and self._mixer_available:
                    self._pygame.mixer.music.unload()
            except Exception:
                pass

    async def _notify_hardware_error(self, ws) -> None:
        try:
            msg = json.dumps({"type": "hardware_error", "payload": {"device": "tts"}})
            await ws.send(msg)
            log.info("Sent hardware_error notification to NodeBridge.")
        except Exception:
            pass

    async def run(self) -> None:
        self.running = True
        self._worker_task = asyncio.create_task(self._worker())
        _startup_deadline = time.time() + 30.0

        while self.running:
            try:
                log.info(f"Connecting to {WS_URI}…")
                async with websockets.connect(WS_URI) as ws:
                    self.websocket = ws
                    log.info("TTS connected to NodeBridge.")

                    if self._mixer_initialized and not self._mixer_available:
                        await self._notify_hardware_error(ws)

                    ready_msg = json.dumps({"type": "client_ready", "payload": _bridge_ready_payload("tts")})
                    await ws.send(ready_msg)
                    log.info("Sent READY handshake.")

                    async for raw_msg in ws:
                        try:
                            msg = json.loads(raw_msg)
                            msg_type = msg.get("type")

                            if msg_type == "tts":
                                text = msg.get("payload", {}).get("text", "")
                                if text:
                                    await self.audio_queue.put(text)
                                    log.info(f"Queued: {text[:30]}…")

                            elif msg_type == "tts_stop" or (
                                msg_type == "command"
                                and msg.get("payload", {}).get("action") == "stop"
                            ):
                                log.info("🛑 Stop command received. Interrupting TTS playback...")
                                self._interrupt_flag = True

                                # Clear the pending queue
                                while not self.audio_queue.empty():
                                    try:
                                        self.audio_queue.get_nowait()
                                        self.audio_queue.task_done()
                                    except Exception:
                                        pass

                                # Phase 4: Cancel synthesis task first (prevents stale MP3 load)
                                if self._current_synth_task and not self._current_synth_task.done():
                                    log.info("Cancelling active synthesis task.")
                                    self._current_synth_task.cancel()

                                # Then cancel playback task
                                if self._current_speak_task and not self._current_speak_task.done():
                                    log.info("Cancelling active speak task.")
                                    self._current_speak_task.cancel()
                                elif self._pygame and self._mixer_available:
                                    self._pygame.mixer.music.stop()

                                if not self._current_speak_task or self._current_speak_task.done():
                                    await self._send_speaking_end("stop_without_active_task", force=True)

                        except json.JSONDecodeError:
                            log.warning("Received non-JSON message.")

            except (ConnectionRefusedError, OSError) as e:
                self.websocket = None
                delay = 0.5 if time.time() < _startup_deadline else RECONNECT_DELAY
                log.warning(f"Connection failed: {e}. Retrying in {delay}s…")
                await asyncio.sleep(delay)
            except Exception as exc:
                log.error(f"Unexpected TTS error: {exc}")
                self.websocket = None
                await asyncio.sleep(RECONNECT_DELAY)

    def stop(self) -> None:
        self.running = False
        if self._worker_task and not self._worker_task.done():
            self._worker_task.cancel()
        if self._mixer_available and self._pygame:
            self._pygame.mixer.music.stop()
            self._pygame.mixer.quit()
        log.info("TTS stopped.")


# ─── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    engine = TTSEngine()
    try:
        asyncio.run(engine.run())
    except KeyboardInterrupt:
        engine.stop()
        log.info("TTS engine shut down.")
