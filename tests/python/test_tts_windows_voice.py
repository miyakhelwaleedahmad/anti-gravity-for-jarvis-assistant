"""
tests/python/test_tts_windows_voice.py
─────────────────────────────────────────────────────────────────────────────
VOICE-003 on Windows: the offline fallback voice really writes audio.

Runs Windows' built-in voice (System.Speech through PowerShell) the way
tts.py does when edge-tts gives no audio, and checks that a WAV file comes
out. No speaker or network is needed. On other systems there is no such
voice; the test says so and does nothing.
"""
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))
sys.modules.setdefault("websockets", types.ModuleType("websockets"))

import tts  # noqa: E402

if os.name != "nt":
    print("SKIP: not Windows; the Windows voice is checked on the Windows CI job.")
    sys.exit(0)

passed = failed = 0


def ok(label, condition, detail=""):
    global passed, failed
    print(f"  {'PASS' if condition else 'FAIL'}: {label}" + (f" ({detail})" if detail else ""))
    if condition:
        passed += 1
    else:
        failed += 1


print("\n=== Windows offline voice (VOICE-003) ===\n")
names = [n for n, _ in tts._offline_voices()]
ok("windows-sapi is the first fallback voice", names[:1] == ["windows-sapi"], str(names))

path = os.path.join(tempfile.mkdtemp(prefix="jarvis tts "), "fallback.wav")   # a space in the path on purpose
text = "Opening Chrome, sir. It's done; $(no) `code` here."
wrote = tts._speak_windows_sapi(text, path)
ok("the Windows voice reports success", wrote)
head = open(path, "rb").read(12) if os.path.exists(path) else b""
size = os.path.getsize(path) if os.path.exists(path) else 0
ok("…and wrote a WAV file with audio", head[:4] == b"RIFF" and head[8:12] == b"WAVE" and size > 10_000, f"{size} bytes")

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
