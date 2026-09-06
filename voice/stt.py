"""
voice/stt.py — Speech-to-Text (STT) for Jarvis
─────────────────────────────────────────────────────────────────────────────
Uses faster-whisper (Tiny, CPU-only) for ultra-fast, offline transcription.

Phase 4 — Voice Pipeline Reliability:
  - Per-session energy auto-calibration: on every listen_start, a 0.5s ambient
    noise sample is taken (instead of the fixed 300 threshold). The calibrated
    energy_threshold is propagated back to subsequent recognizer instances so
    the STT adapts to room noise without manual tuning.
  - Voice Activity Gate (VAD): before handing audio to Whisper, we compute a
    simple RMS energy check. If the audio is below the estimated noise floor × 1.5,
    it's treated as silence and dropped immediately without invoking the model.
    This prevents phantom transcriptions from electronic noise and saves ~200ms
    of Whisper inference time per false positive.
  - Configurable minimum voice energy: JARVIS_STT_MIN_ENERGY_RATIO env var
    controls the VAD sensitivity (default 1.5 × noise floor).
  - dedup reset on new session: _last_sent_text is cleared when a new listen_start
    arrives so back-to-back identical commands from different wake cycles are
    processed correctly.

Original fixes preserved:
  B: STT debug logging to data/logs/stt_debug.log
  C: STT normalization
  D: Dropped STT command queue — pending queue retry
  E: Echo filter logging

STARTUP-PERF (2026-07-25): lazy-load heavy libraries, fast reconnect.
"""

print("[STT] Starting STT module...")
_stt_boot_time = __import__("time").time()

# ─── Lightweight stdlib imports only ──────────────────────────────────────────
# Heavy third-party imports (pyaudio, speech_recognition, faster_whisper) are
# loaded in a background thread so the WS connection happens IMMEDIATELY.
import asyncio
import json
import logging
import time
import os
import re
import threading
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import websockets  # lightweight — no native init

def fail(msg):
    print("[STT CRITICAL]:", msg)
    raise Exception(msg)

# ─── Lazy-loaded references ──────────────────────────────────────────────────
# These are populated by the background loader thread. None until loaded.
sr: Any = None       # speech_recognition
model: Any = None    # WhisperModel instance

import threading as _threading
_model_ready_event = _threading.Event()   # set once Whisper is loaded
_imports_ready_event = _threading.Event() # set once pyaudio + sr are loaded


def _load_all_bg() -> None:
    """Background thread: import heavy libraries + load Whisper model.
    This runs IN PARALLEL with the WebSocket connection to NodeBridge.
    Total time: ~5-15s (import ~3-5s + model load ~5-10s).
    Without lazy loading, this blocked the main thread for the entire duration.
    """
    global sr, model

    # Phase 1: Import heavy native libraries
    t0 = time.time()
    try:
        import pyaudio as _pa  # noqa: F401 — needed by speech_recognition
        import speech_recognition as _sr
        sr = _sr
        print(f"[STT] pyaudio + speech_recognition imported in {time.time()-t0:.1f}s")
    except ImportError as e:
        print(f"[STT] WARNING: Could not import audio libraries: {e}")
    finally:
        _imports_ready_event.set()

    # Phase 2: Import faster_whisper and load model
    t1 = time.time()
    try:
        from faster_whisper import WhisperModel as _WhisperModelClass
        print(f"[STT] faster_whisper imported in {time.time()-t1:.1f}s")
        t2 = time.time()

        device = "cpu"
        compute_type = "int8"
        try:
            import torch
            if torch.cuda.is_available():
                device = "cuda"
                compute_type = "float16"
                print("[STT] CUDA detected. Attempting Whisper model load on GPU (float16)...")
        except Exception:
            pass

        try:
            model = _WhisperModelClass("tiny", device=device, compute_type=compute_type)
            print(f"[STT] Whisper model loaded on {device} ({compute_type}) in {time.time()-t2:.1f}s")
        except Exception as gpu_err:
            if device != "cpu":
                print(f"[STT] GPU load failed ({gpu_err}), falling back to CPU (int8)...")
                t3 = time.time()
                model = _WhisperModelClass("tiny", device="cpu", compute_type="int8")
                print(f"[STT] Whisper model loaded on CPU (int8) in {time.time()-t3:.1f}s")
            else:
                raise gpu_err
    except Exception as e:
        print(f"[STT] ERROR loading Whisper model: {e}")
    finally:
        _model_ready_event.set()  # always unblock, even on error

    total = time.time() - t0
    print(f"[STT] Background init complete in {total:.1f}s")


_threading.Thread(target=_load_all_bg, daemon=True, name="STT-BackgroundLoader").start()

# ─── Config ───────────────────────────────────────────────────────────────────

WS_URI = os.environ.get("BRIDGE_WS_URI", "ws://127.0.0.1:9000")
BRIDGE_TOKEN = os.environ.get("JARVIS_BRIDGE_TOKEN", "")
BRIDGE_DEV_MODE = os.environ.get("JARVIS_BRIDGE_DEV_MODE", "").lower() == "true"
CHANNELS = 1
CHUNK = 1024
RECORD_SECONDS = 4  # max 3-4 seconds as requested

# ── STT Recording Tuning ───────────────────────────────────────────────────────
STT_PAUSE_THRESHOLD    = float(os.environ.get("JARVIS_STT_PAUSE_THRESHOLD", "0.8"))
STT_LISTEN_TIMEOUT     = float(os.environ.get("JARVIS_STT_LISTEN_TIMEOUT", "5.0"))
STT_PHRASE_TIME_LIMIT  = float(os.environ.get("JARVIS_STT_PHRASE_TIME_LIMIT", "20.0"))

# Phase 4: Per-session ambient noise calibration window (seconds).
# Shorter = faster startup, slightly less accurate on very noisy environments.
STT_CALIBRATION_DURATION = float(os.environ.get("JARVIS_STT_CALIBRATION_DURATION", "0.5"))

# Phase 4: Voice Activity Gate — minimum RMS ratio over noise floor to pass to Whisper.
# 1.0 = pass everything above noise floor (loose); 2.5 = require clear speech (strict).
STT_MIN_ENERGY_RATIO = float(os.environ.get("JARVIS_STT_MIN_ENERGY_RATIO", "1.5"))

# Phase 4: Shared calibrated energy threshold — updated per-session by calibrate_energy()
_calibrated_energy: float = 300.0  # fallback if calibration hasn't run yet

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO), format="[STT] %(message)s")
log = logging.getLogger(__name__)

stt_lock = threading.Lock()

# ─── Per-session Energy Calibration ──────────────────────────────────────────

def _calibrate_energy() -> float:
    """
    Phase 4: Take a short ambient noise sample and return a calibrated energy
    threshold. Called at the start of every listen session so STT adapts to
    room acoustics (air conditioning, fans, street noise, etc.).
    
    Thread-safe — runs inside the stt_lock recording section.
    Returns the calibrated threshold value.
    """
    global _calibrated_energy
    if sr is None:
        return _calibrated_energy
    try:
        _recognizer = sr.Recognizer()
        _recognizer.energy_threshold = _calibrated_energy  # start from last known value
        _recognizer.dynamic_energy_threshold = True
        with sr.Microphone() as source:
            _recognizer.adjust_for_ambient_noise(source, duration=STT_CALIBRATION_DURATION)
        _calibrated_energy = _recognizer.energy_threshold
        log.info(f"[STT] Calibrated energy threshold: {_calibrated_energy:.0f}")
        return _calibrated_energy
    except Exception as e:
        log.warning(f"[STT] Energy calibration failed ({e}) — using last known: {_calibrated_energy:.0f}")
        return _calibrated_energy


def _vad_gate(audio_data, noise_floor: float) -> bool:
    """
    Phase 4: Voice Activity Gate — simple RMS energy check.
    Returns True if the audio passes (is likely real speech).
    Returns False if the audio is below the noise floor × STT_MIN_ENERGY_RATIO,
    indicating silence or electronic noise.
    """
    try:
        import numpy as np
        raw = audio_data.get_raw_data(convert_rate=16000, convert_width=2)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
        rms = float(np.sqrt(np.mean(samples ** 2))) if len(samples) > 0 else 0.0
        threshold = noise_floor * STT_MIN_ENERGY_RATIO
        passes = rms >= threshold
        if not passes:
            log.info(f"[STT] VAD gate rejected audio: RMS={rms:.0f} < threshold={threshold:.0f} (noise_floor={noise_floor:.0f}×{STT_MIN_ENERGY_RATIO}). Suppressing Whisper call.")
        return passes
    except Exception as e:
        log.debug(f"[STT] VAD gate error ({e}) — passing audio through.")
        return True  # fail-open: if numpy is unavailable, don't block transcription


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

# ─── STT Debug Logger ─────────────────────────────────────────────────────────
# Part B: Log raw and normalized transcripts to data/logs/stt_debug.log

def _resolve_log_path() -> Path:
    """Resolve data/logs/stt_debug.log relative to project root."""
    # voice/stt.py is at <project>/voice/stt.py — go up one level
    script_dir = Path(__file__).parent.resolve()
    project_root = script_dir.parent
    log_dir = project_root / "data" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "stt_debug.log"

STT_DEBUG_LOG = _resolve_log_path()


def _resolve_temp_audio_path() -> str:
    script_dir = Path(__file__).parent.resolve()
    project_root = script_dir.parent
    temp_dir = project_root / "data" / "temp"
    try:
        temp_dir.mkdir(parents=True, exist_ok=True)
        return str(temp_dir / f"stt_{int(time.time() * 1000)}.wav")
    except Exception:
        return str(Path(tempfile.gettempdir()) / f"jarvis_stt_{int(time.time() * 1000)}.wav")

def stt_log(event: str, raw: str, normalized: str = "", note: str = "") -> None:
    """Write a concise entry to the STT debug log. Safe – never crashes."""
    try:
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        entry = {
            "ts": ts,
            "event": event,
            "raw": raw[:200],           # cap at 200 chars to avoid log bloat
            "normalized": normalized[:200] if normalized else "",
        }
        if note:
            entry["note"] = note[:120]
        with open(STT_DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # logging must never crash the pipeline

# ─── STT Normalization ────────────────────────────────────────────────────────
# Part C: Normalize transcript before routing.

# Wake prefixes to strip (ordered longest-first for correct matching)
_WAKE_PREFIXES = [
    "hey jarvis",
    "jarvis",
]

# Harmless punctuation to remove (preserve apostrophes in contractions)
_PUNCT_RE = re.compile(r"[.,!?;:\"()\[\]{}<>@#$%^&*+=|\\~`]")
_MULTI_SPACE_RE = re.compile(r"\s{2,}")

# ── FIX: Split-word normalization ────────────────────────────────────────────
# Whisper sometimes transcribes brand names as two words, e.g. "You Tube".
# Map these back to their canonical single-word form before alias lookup.
_SPLIT_WORD_MAP: list[tuple[str, str]] = [
    ("you tube.com", "youtube"),
    ("you tubecom",  "youtube"),
    ("you tube",     "youtube"),
    ("you-tube",     "youtube"),
    ("git hub",      "github"),
]


def normalize_stt(text: str) -> str:
    """
    Normalize a raw STT transcript for deterministic command routing.

    Steps:
      1. Strip whitespace
      2. Lowercase
      3. Remove harmless punctuation
      4. Collapse multiple spaces
      5. Remove wake-word prefix (hey jarvis / jarvis)
      6. Fix Whisper split-word brand names (you tube → youtube)

    Preserved:  open, launch, start, youtube, chrome, notepad
                (and all other content words)
    """
    if not text:
        return ""

    result = text.strip().lower()
    result = _PUNCT_RE.sub("", result)
    result = _MULTI_SPACE_RE.sub(" ", result).strip()

    # Strip wake prefix
    for prefix in _WAKE_PREFIXES:
        if result.startswith(prefix):
            result = result[len(prefix):].strip()
            break

    # Fix split-word brand names that Whisper may produce
    for split_form, canonical in _SPLIT_WORD_MAP:
        if split_form in result:
            result = result.replace(split_form, canonical)
            stt_log("STT_NORMALIZE_SPLIT", result,
                    note=f"split-word '{split_form}' → '{canonical}'")

    return result


# ─── Echo Filter Helpers ──────────────────────────────────────────────────────
# Part E: Log echo filter decisions, protect clear command keywords.

# If transcript contains these words, be extra cautious before discarding as echo
_COMMAND_KEYWORDS = {"open", "launch", "start", "close", "run", "stop", "play", "search"}


def _has_command_keyword(text: str) -> bool:
    """Return True if the normalized text contains a strong command keyword."""
    words = set(text.lower().split())
    return bool(words & _COMMAND_KEYWORDS)


def is_echo(stt_text: str, last_tts_text: str) -> bool:  # noqa: ARG001
    """Disabled: echo filtering is handled on the TypeScript side (jarvis.ts)."""
    return False


# ─── STT Engine ───────────────────────────────────────────────────────────────

class STTEngine:
    def __init__(self) -> None:
        self.websocket = None
        self._hardware_ok = True
        # PHASE1-STT-1: model may still be loading; use the global (None until ready)
        self.session_lock = asyncio.Lock()
        # Part D: pending STT queue for dropped commands
        self._pending_stt_queue: list[str] = []
        self._last_sent_text: str = ""       # dedup guard
        self._reconnect_delay: float = 2.0   # PHASE1-STT-2: exponential backoff base

    def _record_audio(self, filename: str = "temp_stt.wav"):
        """
        Records audio dynamically until the user stops speaking using VAD.
        Phase 4: Uses per-session calibrated energy threshold instead of fixed 300.
        Phase 4: Returns (audio_data, noise_floor) tuple so _transcribe can apply
        the VAD gate without a second calibration round.
        """
        if not stt_lock.acquire(blocking=False):
            log.warning("STT is already recording. Ignoring duplicate request.")
            return None

        if sr is None:
            log.error("speech_recognition is not installed — cannot record audio.")
            stt_lock.release()
            return None

        try:
            recognizer = sr.Recognizer()
            # Phase 4: use calibrated threshold (updated at start of each session)
            recognizer.energy_threshold = _calibrated_energy
            recognizer.dynamic_energy_threshold = True
            recognizer.pause_threshold = STT_PAUSE_THRESHOLD
            log.info(f"[STT] Recording with energy={_calibrated_energy:.0f} pause={STT_PAUSE_THRESHOLD}s timeout={STT_LISTEN_TIMEOUT}s")

            with sr.Microphone() as source:
                log.info("🎙️ Listening (instantly)...")
                audio_data = recognizer.listen(
                    source,
                    timeout=STT_LISTEN_TIMEOUT,
                    phrase_time_limit=STT_PHRASE_TIME_LIMIT,
                )

            log.info("Recording complete.")
            # Return both audio and current noise floor for VAD gate
            return (audio_data, _calibrated_energy)
        except sr.WaitTimeoutError:
            log.info("Listen timeout, no speech detected.")
            self._timed_out = True
            return None
        except Exception as e:
            log.error(f"CRITICAL Audio/Microphone error: {e}")
            self._hardware_ok = False
            return None
        finally:
            stt_lock.release()

    def _transcribe(self, audio_input) -> str:
        """✅ FIXED: Force English transcription.
        OPT-STT-4: Accepts either a filename (str) or an AudioData object.
        If AudioData is provided, transcribes in-memory via numpy without
        writing to disk — eliminates one file write + read per command.
        Waits up to 60s for Whisper model to finish loading, with late fallback.
        """
        global model
        # Block until the background loader has finished (max 60s)
        if not _model_ready_event.wait(timeout=60):
            log.warning("[STT] Whisper model did not load within 60s deadline — attempting direct load...")

        if model is None:
            try:
                from faster_whisper import WhisperModel
                print("[STT] Synchronous fallback load for Whisper model...")
                model = WhisperModel("tiny", device="cpu", compute_type="int8")
                _model_ready_event.set()
            except Exception as load_err:
                log.error(f"[STT] Whisper model load failed completely: {load_err}")
                return ""

        try:
            import numpy as np

            if hasattr(audio_input, 'get_raw_data'):
                # AudioData in-memory path (no disk I/O)
                raw = audio_input.get_raw_data(convert_rate=16000, convert_width=2)
                audio_np = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                segments, _ = model.transcribe(
                    audio_np,
                    beam_size=1,
                    language="en",
                    condition_on_previous_text=False
                )
                log.info("[STT] OPT-STT-4: Transcribed from in-memory numpy (no disk write).")
            else:
                # Fallback: file path (original behaviour)
                segments, _ = model.transcribe(
                    audio_input,
                    beam_size=1,
                    language="en",
                    condition_on_previous_text=False
                )

            text = ""
            for segment in segments:
                text += segment.text
            text = text.strip()

            # Retry logic: if primary beam_size=1 returned empty, retry with beam_size=3
            if not text:
                log.info("[STT] Initial transcription returned empty; retrying with beam_size=3...")
                if hasattr(audio_input, 'get_raw_data'):
                    raw = audio_input.get_raw_data(convert_rate=16000, convert_width=2)
                    audio_np = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                    segments, _ = model.transcribe(audio_np, beam_size=3, language="en", condition_on_previous_text=False)
                else:
                    segments, _ = model.transcribe(audio_input, beam_size=3, language="en", condition_on_previous_text=False)
                for segment in segments:
                    text += segment.text
                text = text.strip()

            return text
        except Exception as e:
            log.error(f"Whisper transcription failed: {e}")
            return ""

    async def _send_result(self, text: str) -> None:
        """
        Send normalized STT result to NodeBridge.
        Part B: log raw and normalized.
        Part C: normalize before sending.
        Part D: dedup — do not send the same text twice in a row.
        Never send empty strings.
        """
        raw = text
        normalized = normalize_stt(text) if text else ""

        if not normalized and not raw:
            log.info("[STT] Suppressed empty STT result — voice commands must never produce empty text.")
            stt_log("STT_EMPTY_SUPPRESSED", raw="", note="empty result suppressed")
            return

        stt_log("STT_RESULT", raw=raw, normalized=normalized)

        # Part D: skip sending if this is a duplicate of the last command
        if normalized and normalized == self._last_sent_text:
            log.warning(f"[STT] Duplicate STT result suppressed: '{normalized}'")
            stt_log("STT_DUPLICATE_SUPPRESSED", raw=raw, normalized=normalized)
            return

        if normalized:
            self._last_sent_text = normalized

        if self.websocket:
            # Send the NORMALIZED text to keep routing deterministic (Part C)
            msg = json.dumps({
                "type": "stt_result",
                "payload": {"text": normalized if normalized else text}
            })
            try:
                await self.websocket.send(msg)
                log.info(f"STT result sent. raw='{raw[:80]}' normalized='{normalized[:80]}'")
            except Exception as exc:
                log.error(f"Send error: {exc}")
                # Part D: if we failed to send, queue it for retry
                if normalized:
                    self._pending_stt_queue.append(normalized)
                    log.warning(f"[STT] Result queued for retry: '{normalized}'")

    async def _flush_pending_queue(self) -> None:
        """
        Part D: Attempt to drain the pending STT queue.
        Called after state may have recovered.
        Deduplicates before sending.
        """
        while self._pending_stt_queue and self.websocket:
            text = self._pending_stt_queue.pop(0)
            if text == self._last_sent_text:
                log.warning(f"[STT] Pending queue duplicate skipped: '{text}'")
                stt_log("STT_PENDING_DUPLICATE", raw=text, note="dedup skipped in queue flush")
                continue
            try:
                msg = json.dumps({
                    "type": "stt_result",
                    "payload": {"text": text}
                })
                await self.websocket.send(msg)
                self._last_sent_text = text
                log.info(f"[STT] Pending queue item sent: '{text}'")
                stt_log("STT_PENDING_SENT", raw=text)
                await asyncio.sleep(0.3)  # small gap between retries
            except Exception as exc:
                log.error(f"[STT] Pending queue flush error: {exc}")
                self._pending_stt_queue.insert(0, text)  # put back for next attempt
                break

    async def listen_and_transcribe(self) -> None:
        """
        Record audio, transcribe, normalize, and send result.
        Phase 4: Runs energy calibration before recording; applies VAD gate
        before invoking Whisper to eliminate phantom transcriptions.
        """
        self._timed_out = False

        try:
            # Phase 4: calibrate energy threshold in the recording thread
            await asyncio.to_thread(_calibrate_energy)

            result = await asyncio.to_thread(self._record_audio)

            if result is None:
                if getattr(self, '_timed_out', False):
                    log.info("[STT] Listen timed out (no speech detected) — suppressing empty transcript.")
                    stt_log("STT_TIMEOUT", raw="", note="no speech detected within timeout")
                elif not self._hardware_ok and self.websocket:
                    try:
                        msg = json.dumps({"type": "hardware_error", "payload": {"device": "stt"}})
                        await self.websocket.send(msg)
                        stt_log("STT_HARDWARE_ERROR", raw="", note="microphone unavailable")
                    except Exception:
                        pass
                return

            audio_data, noise_floor = result

            # Phase 4: Voice Activity Gate — reject electronic/ambient noise
            if not _vad_gate(audio_data, noise_floor):
                stt_log("STT_VAD_REJECTED", raw="", note=f"below noise floor×{STT_MIN_ENERGY_RATIO}")
                return

            text = await asyncio.to_thread(self._transcribe, audio_data)

            if not text:
                log.info("[STT] Empty transcription from Whisper — suppressing empty result.")
                stt_log("STT_EMPTY", raw="", note="Whisper returned empty string")
            else:
                log.debug(f"Whisper raw result: '{text}'")
                normalized = normalize_stt(text)
                log.debug(f"Normalized result:  '{normalized}'")
                stt_log("STT_TRANSCRIBED", raw=text, normalized=normalized)
                await self._send_result(text)

        except Exception as e:
            log.error(f"Exception in listen_and_transcribe: {e}")
            
    async def _locked_listen(self) -> None:
        if self.session_lock.locked():
            return
        async with self.session_lock:
            await self.listen_and_transcribe()
            # Part D: after each listen attempt, try to flush any queued retries
            await asyncio.sleep(0.5)
            await self._flush_pending_queue()

    async def run(self) -> None:
        """Connect to NodeBridge and wait for activation signals.

        STARTUP-PERF: Uses fast 0.5s retry for the first 30s after boot,
        then falls back to exponential backoff. This ensures STT connects
        to NodeBridge within ~0.5s of it becoming available, instead of
        burning 60-120s in exponential backoff sleep.
        """
        _startup_deadline = time.time() + 30.0  # fast-retry window

        while True:
            try:
                log.info(f"Connecting to {WS_URI}…")
                async with websockets.connect(WS_URI) as ws:
                    self.websocket = ws
                    elapsed = time.time() - _stt_boot_time
                    print(f"[STT] Connected to NodeBridge ({elapsed:.1f}s after boot)")

                    ready_msg = json.dumps({"type": "client_ready", "payload": _bridge_ready_payload("stt")})
                    await self.websocket.send(ready_msg)
                    print("[STT] READY handshake sent")
                    print("[STT] Listening loop started")
                    # Reset reconnect delay on successful connect
                    self._reconnect_delay = 2.0

                    # Part D: flush any queued commands from previous session
                    await self._flush_pending_queue()

                    async for raw_msg in ws:
                        try:
                            msg = json.loads(raw_msg)
                            if msg.get("type") == "listen_start":
                                # Phase 4: reset dedup on new listen session so
                                # back-to-back identical commands from different
                                # wake cycles aren't silently dropped.
                                self._last_sent_text = ""
                                if self.session_lock.locked():
                                    log.warning("🎤 STT is already recording, ignoring new request.")
                                    continue
                                log.info("🎤 listen_start received — recording…")
                                asyncio.create_task(self._locked_listen())
                        except json.JSONDecodeError:
                            pass
                        except Exception as e:
                            print("[STT] Loop error:", e)

            except (ConnectionRefusedError, OSError) as e:
                self.websocket = None
                # STARTUP-PERF: Fast retry during first 30s, then exponential backoff
                if time.time() < _startup_deadline:
                    delay = 0.5  # fast retry — catch NodeBridge as soon as it's ready
                else:
                    delay = self._reconnect_delay
                    self._reconnect_delay = min(self._reconnect_delay * 1.5, 30.0)
                print(f"[STT] NodeBridge not ready, retrying in {delay}s...")
                await asyncio.sleep(delay)
            except websockets.exceptions.ConnectionClosed as e:
                print(f"[STT] Connection closed: {e}. Retrying in {self._reconnect_delay}s...")
                self.websocket = None
                await asyncio.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 1.5, 30.0)
            except Exception as e:
                print(f"[STT] Unexpected WS error: {e}")
                self.websocket = None
                await asyncio.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 1.5, 30.0)

# ─── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        engine = STTEngine()
        asyncio.run(engine.run())
    except Exception as e:
        fail(f"FATAL CRASH in STT process: {e}")
