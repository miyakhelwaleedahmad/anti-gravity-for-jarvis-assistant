"""
tests/python/test_vector_service_startup.py
─────────────────────────────────────────────────────────────────────────────
The vector service's startup and write path, as seen in a real Windows log:

  - The model loaded inside FastAPI's startup hook, and uvicorn accepts no
    connections until that returns: on a slow PC, three and a half minutes of
    refused connections. The model now loads in the background; /liveness
    answers at once and the endpoints report 503 until it is ready.
  - The write queue resolved its futures with future.get_event_loop(), which
    asyncio.Future does not have. Every write raised in the worker, its future
    was never resolved, and the request hung until the 30 s timeout.
  - Every start made ~25 requests to huggingface.co although the model was
    cached. The cache is tried first (local_files_only), with a download only
    when that fails, and a plain load on sentence-transformers < 2.3.
  - BatchEmbedReq used Pydantic v1's min_items / max_items.

Runs without sentence-transformers or the network: a stand-in module with a
slow constructor replaces it.
"""
import asyncio
import importlib
import logging
import os
import sys
import tempfile
import time
import types
import warnings

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "memory"))

passed = failed = 0


def ok(label, condition, detail=""):
    global passed, failed
    if condition:
        print(f"  PASS: {label}" + (f" ({detail})" if detail else ""))
        passed += 1
    else:
        print(f"  FAIL: {label}" + (f" ({detail})" if detail else ""))
        failed += 1


LOAD_SECONDS = 1.0
calls = []  # kwargs of every SentenceTransformer(...) construction


class _Encoder:
    DIM = 16

    def encode(self, text, convert_to_numpy=True, normalize_embeddings=True, **_):
        if isinstance(text, list):
            return np.vstack([self.encode(t) for t in text])
        rng = np.random.default_rng(abs(hash(text)) % (2**32))
        v = rng.standard_normal(self.DIM).astype(np.float32)
        return v / np.linalg.norm(v)

    def get_sentence_embedding_dimension(self):
        return self.DIM


def install_fake_sentence_transformers(behaviour):
    """behaviour: 'cached' | 'not_cached' | 'old_version'."""
    calls.clear()

    if behaviour == "old_version":
        class SentenceTransformer(_Encoder):  # no local_files_only parameter
            def __init__(self, model_name_or_path=None, modules=None, device=None):
                calls.append({})
                time.sleep(LOAD_SECONDS)
    else:
        class SentenceTransformer(_Encoder):
            def __init__(self, model_name_or_path=None, local_files_only=False, **kwargs):
                calls.append({"local_files_only": local_files_only})
                if behaviour == "not_cached" and local_files_only:
                    raise OSError("model not found in the local cache")
                time.sleep(LOAD_SECONDS)

    fake = types.ModuleType("sentence_transformers")
    fake.SentenceTransformer = SentenceTransformer
    sys.modules["sentence_transformers"] = fake


def fresh_module():
    os.environ["JARVIS_VECTOR_STORE_DIR"] = tempfile.mkdtemp(prefix="jarvis-vec-start-")
    os.environ["JARVIS_VECTOR_PERSIST"] = "false"
    sys.modules.pop("vectorMemory", None)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        mod = importlib.import_module("vectorMemory")
    return mod, caught


async def wait_ready(mod, limit=10.0):
    t0 = time.time()
    while not mod._model_ready and time.time() - t0 < limit:
        await asyncio.sleep(0.05)
    return time.time() - t0


async def status_of(coro, limit=5.0):
    """HTTP status an endpoint coroutine would produce (200 on success).

    A call that does not finish within `limit` counts as 504, so a write that
    hangs (the get_event_loop bug) fails the test instead of hanging it.
    """
    from fastapi import HTTPException
    try:
        await asyncio.wait_for(coro, limit)
        return 200
    except HTTPException as exc:
        return exc.status_code
    except asyncio.TimeoutError:
        return 504


print("\n=== Vector Service Startup Test ===\n")

print("--- Cached model: server answers while the model loads ---")
install_fake_sentence_transformers("cached")
mod, import_warnings = fresh_module()


async def cached_scenario():
    t0 = time.time()
    cm = mod.lifespan(mod.app)
    await cm.__aenter__()
    entered = time.time() - t0
    ok("startup returns before the model has loaded", entered < LOAD_SECONDS / 2, f"{entered:.2f}s")
    ok("/liveness answers at once, model not ready", mod.api_liveness() == {"status": "alive", "model_ready": False})
    ok("/health is 503 while loading", (await status_of(asyncio.to_thread(mod.api_health))) == 503)
    ok("/embed is 503 while loading", (await status_of(mod.api_embed(mod.EmbedReq(text="early")))) == 503)

    waited = await wait_ready(mod)
    ok("the model becomes ready in the background", mod._model_ready, f"{waited:.2f}s")
    ok("/health is 200 once ready", (await status_of(asyncio.to_thread(mod.api_health))) == 200)

    # Before the fix this hung until the 30 s request timeout.
    t1 = time.time()
    try:
        result = await asyncio.wait_for(mod.api_embed(mod.EmbedReq(text="my favourite food is biryani", fact_id="f1")), 3)
        ok("a write completes instead of hanging", True, f"{time.time() - t1:.3f}s → {str(result)[:60]}")
    except asyncio.TimeoutError:
        ok("a write completes instead of hanging", False, "no answer within 3 s")

    found = await mod.api_search(mod.SearchReq(query="my favourite food is biryani", top_k=1))
    hit = (found.get("results") or [{}])[0]
    ok("the written fact is searchable, with its id", hit.get("fact_id") == "f1", str(hit)[:80])

    batch = await asyncio.wait_for(mod.api_batch_embed(mod.BatchEmbedReq(texts=["alpha", "beta"])), 3)
    ok("a batch write completes", batch.get("count") == 2, str(batch)[:60])

    await cm.__aexit__(None, None, None)


asyncio.run(cached_scenario())
ok("the cached copy was tried first (local_files_only=True)", calls[:1] == [{"local_files_only": True}], str(calls))
ok("and nothing else was needed", len(calls) == 1, f"{len(calls)} construction(s)")
ok("importing emits no Pydantic deprecation warnings",
   not any("Deprecated" in type(w.message).__name__ or "deprecated" in str(w.message) for w in import_warnings),
   "; ".join(str(w.message)[:60] for w in import_warnings))
ok("per-request HTTP logging from the HF client is silenced", logging.getLogger("httpx").level >= logging.WARNING)

print("\n--- Batch size limits (Pydantic v2 names) ---")
from pydantic import ValidationError  # noqa: E402

for label, texts, valid in (("empty batch rejected", [], False), ("65 texts rejected", ["x"] * 65, False), ("64 texts accepted", ["x"] * 64, True)):
    try:
        mod.BatchEmbedReq(texts=texts)
        ok(label, valid)
    except ValidationError:
        ok(label, not valid)

print("\n--- Model not cached yet: downloaded once ---")
install_fake_sentence_transformers("not_cached")
mod, _ = fresh_module()


async def not_cached_scenario():
    cm = mod.lifespan(mod.app)
    await cm.__aenter__()
    await wait_ready(mod)
    ok("the model still loads", mod._model_ready)
    await cm.__aexit__(None, None, None)


asyncio.run(not_cached_scenario())
ok("cache first, then a normal (downloading) load", calls == [{"local_files_only": True}, {"local_files_only": False}], str(calls))

print("\n--- sentence-transformers < 2.3 (no local_files_only) ---")
install_fake_sentence_transformers("old_version")
mod, _ = fresh_module()


async def old_version_scenario():
    cm = mod.lifespan(mod.app)
    await cm.__aenter__()
    await wait_ready(mod)
    ok("the model loads with the old signature", mod._model_ready)
    await cm.__aexit__(None, None, None)


asyncio.run(old_version_scenario())
ok("one plain load after the TypeError", len(calls) == 1, str(calls))

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
