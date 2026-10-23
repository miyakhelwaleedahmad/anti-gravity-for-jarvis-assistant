"""
tests/python/test_vector_logs.py
─────────────────────────────────────────────────────────────────────────────
BUG-16: the vector service's log.

  1. Each log line names its level, so "Stored: 'Failed task …'" at INFO is
     not shown as an error (tests/vectorLogBudgetTest.ts checks the reader).
  2. uvicorn's access line for /health and /liveness is dropped: the
     supervisor polls them every 300 ms while the model loads. Other
     requests are still logged.

(The planning search that waited 4.4 s behind the rebuild: the rebuild now
runs one write at a time and the search has a time budget, see
tests/vectorLogBudgetTest.ts.)

Runs without sentence-transformers, uvicorn or the network.
"""
import importlib
import logging
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "memory"))
os.environ["JARVIS_VECTOR_STORE_DIR"] = tempfile.mkdtemp(prefix="jarvis-vec-logs-")
os.environ["JARVIS_VECTOR_PERSIST"] = "false"
sys.modules.setdefault("sentence_transformers", types.ModuleType("sentence_transformers"))

mod = importlib.import_module("vectorMemory")

passed = failed = 0


def ok(label, condition, detail=""):
    global passed, failed
    print(f"  {'PASS' if condition else 'FAIL'}: {label}" + (f" ({detail})" if detail else ""))
    if condition:
        passed += 1
    else:
        failed += 1


print("\n=== Vector service log and write queue (BUG-16) ===\n")

fmt = logging.getLogger().handlers[0].formatter._fmt if logging.getLogger().handlers else ""
ok("each log line names its level", "%(levelname)s" in fmt, fmt)
line = logging.getLogger().handlers[0].format(logging.LogRecord("vectorMemory", logging.INFO, "", 0, "Stored: 'Failed task: x' — total: 3", None, None))
ok("…e.g. an INFO line quoting a failed task", line.startswith("[VectorMemory] INFO Stored:"), line)

access = logging.getLogger("uvicorn.access")


def passes(msg, *args):
    rec = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, msg, args, None)
    return all(f.filter(rec) for f in access.filters)


fmt_access = '%s - "%s %s HTTP/%s" %d'
ok("the /health poll is not logged", not passes(fmt_access, "127.0.0.1:5000", "GET", "/health", "1.1", 503))
ok("the /liveness poll is not logged", not passes(fmt_access, "127.0.0.1:5000", "GET", "/liveness", "1.1", 200))
ok("other requests still are", passes(fmt_access, "127.0.0.1:5000", "POST", "/embed", "1.1", 200))


print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
