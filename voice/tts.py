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

VOICE-003 — offline fallback voice: when both edge-tts attempts give no audio,
  the phrase is spoken by Windows' built-in voice (System.Speech, through
  PowerShell, text passed as base64 data) or pyttsx3 if installed, written to a
  WAV file and played the same way. JARVIS_TTS_FALLBACK=off turns it off.

Original fixes preserved:
  CRIT-4: pygame.mixer.init() wrapped in try/except — hardware error sent over WS
  HIGH-1: _worker_task stored as instance var, cancelled in stop()
  HIGH-2: Temp file always cleaned up in finally block
  STARTUP-PERF: Lazy-load pygame.mixer.init() on first speak() call
"""

import asyncio
import base64
import json
import logging
import os
import queue
import subprocess
import threading
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
# After the audio device fails to open, how long before a later phrase tries it again (VOICE-004).
TTS_MIXER_RETRY_S = float(os.environ.get("JARVIS_TTS_MIXER_RETRY_S", "10"))
# The longest an offline voice may take to write one phrase (VOICE-003).
TTS_FALLBACK_TIMEOUT = float(os.environ.get("JARVIS_TTS_FALLBACK_TIMEOUT", "20"))
# BUG-5: after edge-tts is refused (HTTP 403) or fails twice running, it is
# skipped for this long instead of costing ~4 s on every sentence.
TTS_EDGE_SKIP_S = max(0.0, float(os.environ.get("JARVIS_TTS_EDGE_SKIP_S", "600")))

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


def _ps_literal(value: str) -> str:
    """A PowerShell expression for value, carried as base64 so it is data, never code."""
    blob = base64.b64encode(value.encode("utf-8")).decode("ascii")
    return f"[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{blob}'))"


def _sapi_command(text: str, path: str) -> list:
    """Windows' built-in voice (System.Speech) writing text to a WAV file at path."""
    script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"$s.SetOutputToWaveFile({_ps_literal(path)}); "
        f"$s.Speak({_ps_literal(text)}); "
        "$s.Dispose()"
    )
    return ["powershell", "-NoProfile", "-NonInteractive", "-Command", script]


def _has_audio(path: str) -> bool:
    try:
        return os.path.getsize(path) > 0
    except OSError:
        return False


def _speak_windows_sapi(text: str, path: str) -> bool:
    try:
        r = subprocess.run(
            _sapi_command(text, path), capture_output=True, timeout=TTS_FALLBACK_TIMEOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.error(f"Windows voice fallback failed: {exc}")
        return False
    if r.returncode != 0:
        log.error(f"Windows voice fallback failed: {r.stderr.decode(errors='replace').strip()[:300]}")
        return False
    return _has_audio(path)


class _WarmPyttsx3:
    """
    One pyttsx3 engine, kept on its own thread (BUG-6). It was created for
    every sentence (the first use also generated the comtypes wrappers), and
    the mic waited 36-79 s per reply. SAPI's COM objects must stay on the
    thread that made them, so every phrase goes through this one thread.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._jobs: "queue.Queue" = queue.Queue()
        self._ready = threading.Event()
        self._failed = ""

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._ready.clear()
            self._failed = ""
            self._jobs = queue.Queue()
            self._thread = threading.Thread(target=self._loop, args=(self._jobs,), name="pyttsx3-voice", daemon=True)
            self._thread.start()

    def _loop(self, jobs: "queue.Queue") -> None:
        t0 = time.time()
        try:
            import pyttsx3
            engine = pyttsx3.init()
        except Exception as exc:
            self._failed = str(exc) or type(exc).__name__
            log.error(f"pyttsx3 could not start: {self._failed}")
            self._ready.set()
            return
        log.info(f"Offline voice pyttsx3 ready in {time.time() - t0:.1f}s (kept warm).")
        self._ready.set()
        while True:
            job = jobs.get()
            if job is None:
                return
            text, path, done, result = job
            try:
                engine.save_to_file(text, path)
                engine.runAndWait()
                result.append(_has_audio(path))
            except Exception as exc:
                log.error(f"pyttsx3 fallback failed: {exc}")
                result.append(False)
            done.set()

    def speak(self, text: str, path: str, timeout: float) -> bool:
        self.start()
        if not self._ready.wait(timeout) or self._failed:
            return False
        done, result = threading.Event(), []
        jobs = self._jobs
        jobs.put((text, path, done, result))
        if not done.wait(timeout):
            log.error(f"pyttsx3 took longer than {timeout:.0f}s; a fresh engine is started for the next phrase.")
            with self._lock:
                self._thread = None   # the stuck thread is a daemon; it is left behind
            return False
        return bool(result and result[0])


_warm_pyttsx3 = _WarmPyttsx3()


def _speak_pyttsx3(text: str, path: str) -> bool:
    return _warm_pyttsx3.speak(text, path, TTS_FALLBACK_TIMEOUT)


def _offline_voices() -> list:
    """
    Offline voices to try, in order, when edge-tts gives no audio (VOICE-003):
    (name, fn(text, wav_path) -> bool). JARVIS_TTS_FALLBACK=off turns them off.
    """
    if os.environ.get("JARVIS_TTS_FALLBACK", "auto").strip().lower() == "off":
        return []
    engines = []
    # BUG-6: the warm pyttsx3 engine first; the Windows voice through a new
    # PowerShell per phrase (a 20 s cold start was seen) is the last resort.
    try:
        import importlib.util
        if importlib.util.find_spec("pyttsx3") is not None:
            engines.append(("pyttsx3", _speak_pyttsx3))
    except (ImportError, ValueError):
        pass
    if os.name == "nt":
        engines.append(("windows-sapi", _speak_windows_sapi))
    return engines


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
        self._mixer_next_try     = 0.0
        self._mixer_error        = ""
        self._pending_hardware_error = False
        # What happened to this speaking turn's phrases, sent on speaking_end
        # (VOICE-005): played, synthesis_failed, no_audio_device, playback_failed, interrupted.
        self._turn_outcome = ""
        self._turn_detail = ""
        # The bridge's ids of the replies in this turn, and the voice that played
        # them, sent on speaking_end so each outcome belongs to its reply.
        self._turn_ids: list = []
        self._turn_engine = ""
        self._pygame: Any = None
        self._speaking_event_open     = False
        self._end_sent_for_current_item = False
        self._tmp_path: str = os.path.join(tempfile.gettempdir(), "jarvis_tts_audio.mp3")
        self._fallback_path: str = os.path.join(tempfile.gettempdir(), "jarvis_tts_fallback.wav")
        self._fallback_engines = _offline_voices()
        # BUG-5: edge-tts refused or failing: skip it until this time (epoch s).
        self._edge_failures = 0
        self._edge_forbidden = False
        self._edge_skip_until = 0.0
        if self._fallback_engines:
            log.info(f"Offline fallback voice(s): {', '.join(n for n, _ in self._fallback_engines)}")
        else:
            log.info("No offline fallback voice (JARVIS_TTS_FALLBACK=off, or none available).")

        try:
            import pygame
            self._pygame = pygame
            log.info(f"TTS Engine created (pygame imported). Voice: {TTS_VOICE}")
        except ImportError as e:
            log.error(f"pygame not available: {e}. TTS audio output disabled.")
            self._pygame = None

    def _ensure_mixer(self) -> bool:
        """
        Open the audio device, trying again on a later phrase after a failure
        (VOICE-004: one failed init used to mute speech for the whole run).
        The first failure of a run of failures is reported to JARVIS.
        """
        if self._mixer_available:
            return True
        if self._pygame is None:
            self._mixer_initialized = True
            return False
        if self._mixer_initialized and time.time() < self._mixer_next_try:
            return False
        self._mixer_initialized = True
        try:
            self._pygame.mixer.init()
            self._mixer_available = True
            self._mixer_error = ""
            log.info(f"TTS pygame.mixer.init() complete — audio hardware ready: {self._pygame.mixer.get_init()}.")
        except Exception as e:
            first = not self._mixer_error
            self._mixer_error = str(e)[:200]
            self._mixer_next_try = time.time() + TTS_MIXER_RETRY_S
            self._mixer_available = False
            log.error(f"Audio hardware init failed: {e}. Trying again in {TTS_MIXER_RETRY_S:.0f} s, on the next phrase.")
            if first:
                self._pending_hardware_error = True
        return self._mixer_available

    async def _send_lifecycle_event(self, event_type: str, reason: str = "", extra: Optional[dict] = None) -> bool:
        ws = self.websocket
        if ws is None:
            log.warning(f"Cannot send {event_type}: websocket is not connected.")
            return False
        payload = {"reason": reason} if reason else {}
        if extra:
            payload.update(extra)
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
        extra = {"outcome": self._turn_outcome} if self._turn_outcome else {}
        if extra and self._turn_detail:
            extra["detail"] = self._turn_detail
        if extra and self._turn_engine:
            extra["engine"] = self._turn_engine
        if self._turn_ids:
            extra["ids"] = list(self._turn_ids)
        self._turn_outcome = ""
        self._turn_detail = ""
        self._turn_ids = []
        self._turn_engine = ""
        extra = extra or None
        await self._send_lifecycle_event("speaking_end", reason, extra)

    def _note_outcome(self, outcome: str, detail: str = "") -> None:
        """A phrase's outcome for this turn's speaking_end; a failure in the turn is kept."""
        failed = ("synthesis_failed", "no_audio_device", "playback_failed")
        if self._turn_outcome in failed and outcome not in failed:
            return
        self._turn_outcome = outcome
        self._turn_detail = detail[:200]

    async def _worker(self) -> None:
        log.info("Started TTS processing queue worker.")
        while self.running:
            item = await self.audio_queue.get()
            text, req_id = item if isinstance(item, tuple) else (item, "")
            if req_id:
                self._turn_ids.append(req_id)
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
            # The audio file is reused for every phrase: remove the last one, so
            # an attempt that writes nothing cannot replay the previous reply.
            try:
                os.remove(self._tmp_path)
            except OSError:
                pass
            communicate = edge_tts.Communicate(text, voice=TTS_VOICE, rate=TTS_RATE, pitch=TTS_PITCH)

            # Wrap synthesis in its own cancellable task for stop() to target
            synth_task = asyncio.create_task(communicate.save(self._tmp_path))
            self._current_synth_task = synth_task

            try:
                await asyncio.wait_for(asyncio.shield(synth_task), timeout=timeout)
                self._current_synth_task = None
                if _has_audio(self._tmp_path):
                    log.info(f"Synthesis OK on attempt {attempt} ({timeout}s timeout).")
                    return True  # success
                # VOICE-003: an empty file is no audio; it used to count as spoken.
                log.error(f"edge-tts wrote no audio on attempt {attempt}.")
                if attempt == 2:
                    return False

            except asyncio.TimeoutError:
                synth_task.cancel()
                self._current_synth_task = None
                log.warning(
                    f"TTS synthesis timeout on attempt {attempt}/{2} "
                    f"({timeout}s). {'Retrying...' if attempt == 1 else 'Giving up.'}"
                )
                if attempt == 1:
                    # JARVIS armed its speaking watchdog when it sent the text,
                    # allowing ~1 s for synthesis. It restarts the deadline from
                    # this message, so the extra time is the retry's own limit.
                    await self._send_lifecycle_event(
                        "speaking_delay", "synthesis_retry",
                        {"extra_ms": int(TTS_EDGE_RETRY_TIMEOUT * 1000)},
                    )

            except asyncio.CancelledError:
                synth_task.cancel()
                self._current_synth_task = None
                log.info("Synthesis task cancelled (interrupt or stop).")
                return False

            except Exception as exc:
                self._current_synth_task = None
                log.error(f"Synthesis error on attempt {attempt}: {exc}")
                if "403" in str(exc):
                    # Refused, not slow: a retry gets the same answer (BUG-5).
                    self._edge_forbidden = True
                    return False
                if attempt == 2:
                    return False
                await self._send_lifecycle_event(
                    "speaking_delay", "synthesis_retry", {"extra_ms": int(TTS_EDGE_RETRY_TIMEOUT * 1000)},
                )

            # ── INTERRUPT CHECK 2: after failed attempt ───────────────────────
            if self._interrupt_flag:
                log.info("Synthesis interrupted after failed attempt.")
                return False

        return False

    def _note_edge_result(self, ok: bool) -> None:
        """Skip edge-tts for TTS_EDGE_SKIP_S after a 403 or two failures running (BUG-5)."""
        if ok:
            self._edge_failures = 0
            self._edge_forbidden = False
            return
        if self._interrupt_flag:
            return
        self._edge_failures += 1
        if (self._edge_forbidden or self._edge_failures >= 2) and TTS_EDGE_SKIP_S > 0:
            self._edge_skip_until = time.time() + TTS_EDGE_SKIP_S
            why = ("edge-tts was refused (HTTP 403): update it with  pip install -U edge-tts"
                   if self._edge_forbidden else f"edge-tts failed {self._edge_failures} times running")
            log.warning(f"{why}. Using the offline voice for the next {TTS_EDGE_SKIP_S / 60:.0f} min.")
            self._edge_failures = 0
            self._edge_forbidden = False

    async def _synthesize_fallback(self, text: str) -> str:
        """Try each offline voice; the name of the one that wrote audio, or ""."""
        for name, fn in self._fallback_engines:
            if self._interrupt_flag:
                return ""
            try:
                os.remove(self._fallback_path)
            except OSError:
                pass
            log.warning(f"edge-tts gave no audio; trying the offline voice {name}.")
            # The speaking watchdog allowed for edge-tts; give it this voice's limit.
            await self._send_lifecycle_event(
                "speaking_delay", "synthesis_fallback", {"extra_ms": int(TTS_FALLBACK_TIMEOUT * 1000)},
            )
            try:
                if await asyncio.to_thread(fn, text, self._fallback_path):
                    if _has_audio(self._fallback_path):
                        return name
                    log.error(f"Offline voice {name} reported success but wrote no audio.")
            except Exception as exc:
                log.error(f"Offline voice {name} failed: {exc}")
        return ""

    async def speak(self, text: str) -> None:
        """Convert text to speech and play back with reliable interrupt handling."""
        if not text.strip():
            return

        if not self._ensure_mixer():
            log.warning(f"Audio unavailable — sending lifecycle events and skipping TTS for: {text[:60]}")
            self._note_outcome("no_audio_device", self._mixer_error or "audio output unavailable")
            if self._pending_hardware_error and self.websocket is not None:
                self._pending_hardware_error = False
                await self._notify_hardware_error(self.websocket)
            await self._send_speaking_start("skipped_no_mixer")
            await self._send_speaking_end("skipped_no_mixer", force=True)
            return

        log.info(f"Speaking: {text[:80]}{'…' if len(text) > 80 else ''}")

        play_path = ""
        try:
            # ── INTERRUPT CHECK 3: before synthesis ───────────────────────────
            if self._interrupt_flag:
                return

            if time.time() < self._edge_skip_until:
                success = False   # edge-tts is being skipped (BUG-5); straight to the offline voice
            else:
                success = await self._synthesize_with_retry(text)
                self._note_edge_result(success)
            play_path, voice = self._tmp_path, ""
            if not success and not self._interrupt_flag:
                voice = await self._synthesize_fallback(text)
                success = bool(voice)
                play_path = self._fallback_path

            # ── INTERRUPT CHECK 4: after synthesis, before playback ───────────
            if self._interrupt_flag or not success:
                if self._interrupt_flag:
                    self._note_outcome("interrupted")
                else:
                    log.error(f"TTS synthesis failed after all retries and fallbacks. Skipping: {text[:60]}")
                    self._note_outcome("synthesis_failed", "edge-tts gave no audio, and no offline voice did")
                return

            self._pygame.mixer.music.load(play_path)
            self._pygame.mixer.music.play()
            await self._send_speaking_start("playback_start")

            while self._pygame.mixer.music.get_busy():
                # ── INTERRUPT CHECK 5: during playback polling ────────────────
                if self._interrupt_flag:
                    self._pygame.mixer.music.stop()
                    break
                await asyncio.sleep(TTS_POLL_INTERVAL)
            self._note_outcome("interrupted" if self._interrupt_flag else "played", f"fallback: {voice}" if voice else "")
            if not self._interrupt_flag:
                self._turn_engine = voice or "edge-tts"

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
            # Before, this ended the turn with no outcome, and JARVIS kept
            # showing speech as healthy (found by tests/realTtsHandoffTest.ts).
            self._note_outcome("playback_failed", str(exc))
        finally:
            try:
                if self._pygame and self._mixer_available:
                    self._pygame.mixer.music.unload()
            except Exception:
                pass
            # The fallback voice's WAV is per phrase; remove it once played.
            if play_path == self._fallback_path:
                try:
                    os.remove(self._fallback_path)
                except OSError:
                    pass

    async def _notify_hardware_error(self, ws) -> None:
        try:
            payload = {"device": "tts"}
            if self._mixer_error:
                payload["error"] = self._mixer_error
            msg = json.dumps({"type": "hardware_error", "payload": payload})
            await ws.send(msg)
            log.info("Sent hardware_error notification to NodeBridge.")
        except Exception:
            pass

    async def run(self) -> None:
        self.running = True
        # BUG-6: start the offline voice now, so the first fallback reply does not wait for it.
        if any(name == "pyttsx3" for name, _ in self._fallback_engines):
            _warm_pyttsx3.start()
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
                                req_id = str(msg.get("payload", {}).get("id", "") or "")
                                if text:
                                    await self.audio_queue.put((text, req_id) if req_id else text)
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
