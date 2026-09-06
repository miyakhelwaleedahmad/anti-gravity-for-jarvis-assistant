"""
tests/python/test_vector_persistence.py
─────────────────────────────────────────────────────────────────────────────
JARVIS-002 / JARVIS-003 — the vector store must survive a restart with no fact
loss, and search hits must carry the LowDB fact id.

Runs without sentence-transformers: `_get_model` is stubbed with a deterministic
hash-based encoder, so the test exercises the persistence and id-join logic
rather than the embedding model.
"""
import importlib
import os
import shutil
import sys
import tempfile

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


class FakeModel:
    """Deterministic 16-dim unit-norm encoder derived from the text."""
    DIM = 16

    def encode(self, text, convert_to_numpy=True, normalize_embeddings=True):
        if isinstance(text, list):
            return np.vstack([self.encode(t) for t in text])
        rng = np.random.default_rng(abs(hash(text)) % (2**32))
        v = rng.standard_normal(self.DIM).astype(np.float32)
        return v / np.linalg.norm(v)


def fresh_module(store_dir):
    """Import vectorMemory with a clean module state pointed at store_dir."""
    os.environ["JARVIS_VECTOR_STORE_DIR"] = store_dir
    os.environ["JARVIS_VECTOR_PERSIST"] = "true"
    os.environ["JARVIS_VECTOR_PERSIST_EVERY"] = "2"
    sys.modules.pop("vectorMemory", None)
    mod = importlib.import_module("vectorMemory")
    mod._get_model = lambda: FakeModel()
    return mod


print("\n=== Vector Persistence & Fact-ID Test ===\n")

store = tempfile.mkdtemp(prefix="jarvis-vec-")
try:
    FACTS = [
        ("the user's favourite language is TypeScript", "fact_001"),
        ("the entry camera is on the ground floor", "fact_002"),
        ("JARVIS runs on the main PC", "fact_003"),
        ("the exit camera faces the car park", "fact_004"),
        ("attendance is recorded in PostgreSQL", "fact_005"),
    ]

    # ── Session 1: store facts ────────────────────────────────────────────
    m1 = fresh_module(store)
    mem1 = m1.VectorMemory()
    for text, fid in FACTS:
        mem1._embed_sync(text, fact_id=fid)

    ok("all facts stored", len(mem1._texts) == len(FACTS), f"{len(mem1._texts)}")
    ok("fact ids aligned with texts", len(mem1._fact_ids) == len(FACTS))

    query = "which language does the user prefer"
    before = mem1.search(query, top_k=3)
    ok("search returns hits before restart", len(before) > 0, f"{len(before)} hits")
    ok("search hits carry fact_id", all("fact_id" in r for r in before))

    mem1.save()
    ok("texts.json written", os.path.exists(os.path.join(store, "texts.json")))
    ok("embeddings.npy written", os.path.exists(os.path.join(store, "embeddings.npy")))

    # ── Session 2: simulate a full restart ────────────────────────────────
    m2 = fresh_module(store)
    mem2 = m2.VectorMemory()
    ok("a fresh store starts empty", len(mem2._texts) == 0)

    result = mem2.load()
    ok("load reported success", result.get("reason") == "ok", str(result))
    ok("NO FACT LOST across restart", len(mem2._texts) == len(FACTS), f"{len(mem2._texts)}/{len(FACTS)}")
    ok("fact ids restored", mem2._fact_ids == [f[1] for f in FACTS])
    ok("dedup hashes rebuilt", len(mem2._text_hashes) == len(FACTS))

    after = mem2.search(query, top_k=3)
    ok("identical search results after restart",
       [r["text"] for r in after] == [r["text"] for r in before],
       f"{[r['text'][:20] for r in after]}")
    ok("identical scores after restart",
       all(abs(a["score"] - b["score"]) < 1e-6 for a, b in zip(after, before)))
    ok("fact_id survives the round trip",
       after[0]["fact_id"] == before[0]["fact_id"], str(after[0]["fact_id"]))

    # ── Fact id resolves even when the text is later edited ──────────────
    top_id = after[0]["fact_id"]
    ok("top hit resolves to a real LowDB id",
       top_id in [f[1] for f in FACTS], str(top_id))

    # ── A dimension change must NOT wipe anything ────────────────────────
    m3 = fresh_module(store)
    class BigModel(FakeModel):
        DIM = 32
    m3._get_model = lambda: BigModel()
    mem3 = m3.VectorMemory()
    mem3._embed_sync("a pre-existing in-memory fact", fact_id="fact_live")
    res3 = mem3.load()
    ok("dimension mismatch is refused, not crashed", res3.get("reason") == "dim_mismatch", str(res3))
    ok("refusing to load left existing memory intact", len(mem3._texts) == 1, f"{len(mem3._texts)}")

    # ── A corrupt store must be refused, not loaded ──────────────────────
    bad = tempfile.mkdtemp(prefix="jarvis-vec-bad-")
    shutil.copy(os.path.join(store, "texts.json"), os.path.join(bad, "texts.json"))
    np.save(os.path.join(bad, "embeddings.npy"), np.zeros((2, 16), dtype=np.float32))  # wrong row count
    m4 = fresh_module(bad)
    mem4 = m4.VectorMemory()
    res4 = mem4.load()
    ok("inconsistent store is refused", res4.get("reason") == "inconsistent", str(res4))
    ok("nothing loaded from a corrupt store", len(mem4._texts) == 0)
    shutil.rmtree(bad, ignore_errors=True)

    # ── Delete keeps the three lists aligned ─────────────────────────────
    m5 = fresh_module(store)
    mem5 = m5.VectorMemory()
    mem5.load()
    n_before = len(mem5._texts)
    mem5._delete_sync(FACTS[1][0])
    ok("delete removed one row", len(mem5._texts) == n_before - 1)
    ok("delete kept fact_ids aligned", len(mem5._fact_ids) == len(mem5._texts))
    ok("delete kept embeddings aligned", mem5._embeddings.shape[0] == len(mem5._texts))
    ok("the right fact id was removed", FACTS[1][1] not in mem5._fact_ids)

finally:
    shutil.rmtree(store, ignore_errors=True)

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
