"""
screen_capture.py — Vision Module for Jarvis
Captures screen, compresses to JPEG, and sends via WebSocket.
"""

import asyncio
import os
import json
import logging
import time
import base64
import ctypes
import traceback
import mss
import cv2
import numpy as np
import websockets

try:
    import pytesseract
    HAS_TESSERACT = True
except ImportError:
    HAS_TESSERACT = False

# ─── Config ───────────────────────────────────────────────────────────────────

WS_URI = os.environ.get("BRIDGE_WS_URI", "ws://127.0.0.1:9000")
BRIDGE_TOKEN = os.environ.get("JARVIS_BRIDGE_TOKEN", "")
BRIDGE_DEV_MODE = os.environ.get("JARVIS_BRIDGE_DEV_MODE", "").lower() == "true"
FPS = int(os.environ.get("VISION_FPS", 1))
TARGET_WIDTH = 640
TARGET_HEIGHT = 360

logging.basicConfig(level=logging.INFO, format="[Vision] %(message)s")
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

# ─── Helper Functions ─────────────────────────────────────────────────────────

def get_active_window_title() -> str:
    try:
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
        buff = ctypes.create_unicode_buffer(length + 1)
        ctypes.windll.user32.GetWindowTextW(hwnd, buff, length + 1)
        return buff.value
    except Exception:
        return "Unknown"

def capture_and_encode(sct, monitor):
    """
    Synchronous function to capture screen, downscale, encode to base64,
    and optionally run OCR. Runs in a separate thread.
    """
    try:
        # 1. Capture screen
        screenshot = sct.grab(monitor)
        img_np = np.array(screenshot)
        
        # mss returns BGRA, convert to BGR for cv2
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_BGRA2BGR)
        
        # 2. Downscale frame to reduce payload size and CPU usage
        img_resized = cv2.resize(img_bgr, (TARGET_WIDTH, TARGET_HEIGHT), interpolation=cv2.INTER_AREA)
        
        # 3. Optional OCR
        ocr_text = ""
        if HAS_TESSERACT:
            try:
                # Basic OCR on the downscaled image
                ocr_text = str(pytesseract.image_to_string(img_resized)).strip()
            except Exception:
                pass
                
        # 4. Compress to JPEG
        encode_param = [cv2.IMWRITE_JPEG_QUALITY, 70]
        success, encoded_img = cv2.imencode('.jpg', img_resized, encode_param)
        
        if success:
            # 5. Base64 encode
            base64_str = base64.b64encode(encoded_img.tobytes()).decode('utf-8')
            active_window = get_active_window_title()
            return base64_str, active_window, ocr_text
            
    except Exception as e:
        log.error(f"Error during capture/encode: {e}")
        # traceback.print_exc()
        
    return None, "Unknown", ""

# ─── Vision Engine ────────────────────────────────────────────────────────────

class VisionEngine:
    def __init__(self):
        self.websocket = None
        self.sct = mss.MSS()
        # Use primary monitor (index 1 in mss is usually the primary, 0 is all monitors)
        self.monitor = self.sct.monitors[1] if len(self.sct.monitors) > 1 else self.sct.monitors[0]
        self.is_active = False  # Start in IDLE MODE

    async def capture_loop(self):
        """Continuously capture and send frames at target FPS."""
        while True:
            start_time = time.time()
            
            if self.websocket and not getattr(self.websocket, "closed", False) and self.is_active:
                # Run capture synchronously but in a thread to avoid blocking asyncio
                result = await asyncio.to_thread(capture_and_encode, self.sct, self.monitor)
                if result:
                    base64_str, active_window, ocr_text = result
                    if base64_str:
                        payload = {
                            "type": "vision_frame",
                            "timestamp": time.time(),
                            "payload": {
                                "data": base64_str,
                                "width": TARGET_WIDTH,
                                "height": TARGET_HEIGHT,
                                "active_window": active_window,
                                "ocr_text": ocr_text
                            }
                        }
                        try:
                            await self.websocket.send(json.dumps(payload))
                            log.info("[Vision] Frame sent (ACTIVE mode)")
                        except websockets.exceptions.ConnectionClosed:
                            log.warning("WebSocket closed while sending frame. Reconnecting...")
                            self.websocket = None
                        except Exception as e:
                            log.error(f"Failed to send frame: {e}")
            
            # Maintain FPS limit
            elapsed = time.time() - start_time
            sleep_time = max(0.01, (1.0 / FPS) - elapsed)
            await asyncio.sleep(sleep_time)

    async def run(self):
        """Connect to NodeBridge and manage WebSocket lifecycle."""
        # Start capture loop in the background
        asyncio.create_task(self.capture_loop())
        
        while True:
            try:
                log.info(f"Connecting to {WS_URI}…")
                async with websockets.connect(WS_URI, max_size=None) as ws:
                    self.websocket = ws
                    log.info("Vision module connected to NodeBridge.")
                    
                    ready_msg = json.dumps({"type": "client_ready", "payload": _bridge_ready_payload("vision")})
                    await self.websocket.send(ready_msg)
                    log.info("Sent READY handshake.")
                    
                    # Keep connection alive and handle incoming messages if any
                    async for raw_msg in ws:
                        try:
                            msg = json.loads(raw_msg)
                            msg_type = msg.get("type")
                            if msg_type == "vision_start":
                                log.info("[Vision] Received vision_start. Switching to ACTIVE mode.")
                                self.is_active = True
                            elif msg_type == "vision_stop":
                                log.info("[Vision] Received vision_stop. Switching to IDLE mode.")
                                self.is_active = False
                        except json.JSONDecodeError:
                            pass
                            
            except (ConnectionRefusedError, OSError) as e:
                log.warning(f"Connection failed: {e}. Retrying in 5s…")
                self.websocket = None
                await asyncio.sleep(5)
            except websockets.exceptions.ConnectionClosed as e:
                log.warning(f"Connection closed: {e}. Retrying in 5s…")
                self.websocket = None
                await asyncio.sleep(5)
            except Exception as e:
                log.error(f"Unexpected WS error: {e}")
                self.websocket = None
                await asyncio.sleep(5)

# ─── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    engine = VisionEngine()
    try:
        asyncio.run(engine.run())
    except KeyboardInterrupt:
        log.info("Vision engine stopped.")
