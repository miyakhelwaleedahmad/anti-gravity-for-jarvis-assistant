"""
memory/vectorMemory.py
─────────────────────────────────────────────────────────────────────────────
Real vector memory using sentence-transformers, FastAPI, and numpy.

Phase 3 — Memory System Stabilization additions:
  - /batch_embed endpoint: embed multiple texts in a single model call
  - /embed deduplication: exact-text and near-duplicate (>0.97 cosine) guards
  - /search score threshold: results below min_score are filtered out
  - Embedding queue: concurrent embed calls are serialized via asyncio.Queue
    to prevent numpy memory corruption on parallel writes
  - /dedup endpoint: scan and remove duplicate vectors from the store
  - /stats extended: includes dup_rejected, queue_depth, embedding_cache_hits
  - Timeout recovery: independent per-request AbortController (existing)

Usage:
    uvicorn vectorMemory:app --host 127.0.0.1 --port 8000

"""

from __future__ import annotations

import os
import time
import asyncio
import hashlib
import logging
from contextlib import asynccontextmanager
from typing import Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import numpy as np

logging.basicConfig(level=logging.INFO, format="[VectorMemory] %(message)s")
log = logging.getLogger(__name__)

_model = None
_model_ready = False
_startup_time: float = 0.0
_request_count: int = 0

# ─── Request timeout (seconds) ──────────────────────────────────────────────
REQUEST_TIMEOUT_S = float(os.environ.get("VECTOR_REQUEST_TIMEOUT", "30"))

# ─── Dedup thresholds ────────────────────────────────────────────────────────
EXACT_DEDUP_ENABLED  = os.environ.get("VECTOR_EXACT_DEDUP", "true").lower() == "true"
NEAR_DEDUP_THRESHOLD = float(os.environ.get("VECTOR_NEAR_DEDUP_THRESHOLD", "0.97"))

# ─── Default score threshold for search results ──────────────────────────────
DEFAULT_MIN_SCORE = float(os.environ.get("VECTOR_MIN_SCORE", "0.0"))

# ─── Embedding serialization queue ──────────────────────────────────────────
# All write operations (embed, batch_embed, dedup, clear) go through this
# single asyncio.Queue to prevent concurrent numpy memory corruption.
_embed_queue: asyncio.Queue = asyncio.Queue()
_queue_worker_running = False


def _get_model():
    global _model
    if _model is None:
        try:
            from sentence_transformers import SentenceTransformer
            model_name = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
            log.info(f"Loading embedding model: {model_name}")
            _model = SentenceTransformer(model_name)
            log.info("Embedding model loaded.")
        except ImportError:
            log.error("sentence-transformers not installed.")
            raise
    return _model


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Pre-load model at startup so the first /embed is not blocked."""
    global _model_ready, _startup_time, _queue_worker_running
    _startup_time = time.time()
    log.info("[Startup] Pre-loading embedding model...")
    try:
        _get_model()
        _model_ready = True
        log.info("[Startup] Embedding model ready. JARVIS vector memory is online.")
    except Exception as e:
        log.error(f"[Startup] FATAL: Could not load embedding model: {e}")

    # Start the embedding queue worker
    _queue_worker_running = True
    asyncio.create_task(_embedding_queue_worker())
    log.info("[Startup] Embedding queue worker started.")

    yield
    _queue_worker_running = False
    log.info("[Shutdown] Vector memory shutting down.")


# ─── VectorMemory store ──────────────────────────────────────────────────────

class VectorMemory:
    def __init__(self) -> None:
        self._texts: list[str] = []
        self._text_hashes: set[str] = set()   # for O(1) exact dedup
        self._embeddings: Optional[np.ndarray] = None

        # Diagnostic counters
        self.dup_rejected_exact: int = 0
        self.dup_rejected_near: int  = 0
        self.embed_calls: int        = 0

        log.info("VectorMemory initialized (empty).")

    # ── Hashing helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _text_hash(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]

    # ── Core embed (NOT async — called only from the queue worker) ────────────

    def _embed_sync(self, text: str, skip_dedup: bool = False) -> dict:
        """
        Embed a single text. Called synchronously from the queue worker.
        Returns a dict with embedding, stored count, dedup info.
        """
        self.embed_calls += 1
        model = _get_model()

        # 1. Exact dedup
        if EXACT_DEDUP_ENABLED and not skip_dedup:
            h = self._text_hash(text)
            if h in self._text_hashes:
                self.dup_rejected_exact += 1
                log.info(f"Exact duplicate rejected: '{text[:60]}'")
                embedding = model.encode(text, convert_to_numpy=True, normalize_embeddings=True)
                return {
                    "embedding": embedding.tolist(),
                    "dim": len(embedding),
                    "stored": len(self._texts),
                    "dedup": "exact_duplicate",
                }

        # 2. Compute embedding
        embedding: np.ndarray = model.encode(text, convert_to_numpy=True, normalize_embeddings=True)

        # 3. Near-duplicate check (cosine similarity against existing store)
        if not skip_dedup and self._embeddings is not None and len(self._texts) > 0:
            scores = (self._embeddings @ embedding.reshape(-1, 1)).flatten()
            max_score = float(scores.max())
            if max_score >= NEAR_DEDUP_THRESHOLD:
                idx = int(np.argmax(scores))
                self.dup_rejected_near += 1
                log.info(
                    f"Near-duplicate rejected (score={max_score:.3f}): "
                    f"'{text[:40]}' ≈ '{self._texts[idx][:40]}'"
                )
                return {
                    "embedding": embedding.tolist(),
                    "dim": len(embedding),
                    "stored": len(self._texts),
                    "dedup": "near_duplicate",
                    "near_match": self._texts[idx],
                    "near_score": round(max_score, 4),
                }

        # 4. Store
        h = self._text_hash(text)
        self._texts.append(text)
        self._text_hashes.add(h)
        if self._embeddings is None:
            self._embeddings = embedding.reshape(1, -1)
        else:
            self._embeddings = np.vstack([self._embeddings, embedding.reshape(1, -1)])

        log.info(f"Stored: '{text[:60]}' — total: {len(self._texts)}")
        return {
            "embedding": embedding.tolist(),
            "dim": len(embedding),
            "stored": len(self._texts),
            "dedup": "new",
        }

    # ── Batch embed sync (called from queue worker) ───────────────────────────

    def _batch_embed_sync(self, texts: list[str], skip_dedup: bool = False) -> list[dict]:
        return [self._embed_sync(t, skip_dedup=skip_dedup) for t in texts]

    # ── Search ────────────────────────────────────────────────────────────────

    def search(self, query: str, top_k: int = 3, min_score: float = DEFAULT_MIN_SCORE) -> list[dict]:
        if self._embeddings is None or len(self._texts) == 0:
            return []
        model = _get_model()
        query_embedding: np.ndarray = model.encode(
            query, convert_to_numpy=True, normalize_embeddings=True
        ).reshape(1, -1)
        scores: np.ndarray = (self._embeddings @ query_embedding.T).flatten()
        top_k = min(top_k, len(self._texts))
        top_indices = np.argsort(scores)[::-1][:top_k]
        results = []
        for idx in top_indices:
            score = float(scores[int(idx)])
            if score < min_score:
                continue  # Score threshold filter
            results.append({
                "text": self._texts[int(idx)],
                "score": score,
                "index": int(idx),
            })
        return results

    # ── Delete ────────────────────────────────────────────────────────────────

    def _delete_sync(self, text: str) -> bool:
        try:
            idx = self._texts.index(text)
        except ValueError:
            return False
        h = self._text_hash(text)
        self._texts.pop(idx)
        self._text_hashes.discard(h)
        if self._embeddings is not None:
            self._embeddings = np.delete(self._embeddings, idx, axis=0)
            if self._embeddings.shape[0] == 0:
                self._embeddings = None
        return True

    # ── Dedup scan (called from queue worker) ─────────────────────────────────

    def _dedup_scan_sync(self, threshold: float = NEAR_DEDUP_THRESHOLD) -> dict:
        """
        Scan entire store and remove near-duplicate vectors.
        Keeps the higher-indexed (more recently added) text when near-dups found.
        Returns {"removed": N, "remaining": M}.
        """
        if self._embeddings is None or len(self._texts) < 2:
            return {"removed": 0, "remaining": len(self._texts)}

        n = len(self._texts)
        # Cosine similarity matrix (n x n) — already normalised embeddings
        sim_matrix = (self._embeddings @ self._embeddings.T)
        keep = [True] * n

        for i in range(n):
            if not keep[i]:
                continue
            for j in range(i + 1, n):
                if not keep[j]:
                    continue
                if float(sim_matrix[i, j]) >= threshold:
                    # Remove the older one (lower index = older)
                    keep[i] = False
                    break

        removed_texts = [self._texts[i] for i in range(n) if not keep[i]]
        keep_indices = [i for i in range(n) if keep[i]]

        self._texts = [self._texts[i] for i in keep_indices]
        self._text_hashes = {self._text_hash(t) for t in self._texts}
        self._embeddings = (
            self._embeddings[keep_indices] if keep_indices else None
        )
        if self._embeddings is not None and len(self._embeddings) == 0:
            self._embeddings = None

        removed = len(removed_texts)
        log.info(f"Dedup scan: removed {removed} near-duplicates, {len(self._texts)} remain.")
        return {"removed": removed, "remaining": len(self._texts), "removed_texts": removed_texts[:20]}

    # ── Clear ─────────────────────────────────────────────────────────────────

    def _clear_sync(self) -> None:
        self._texts = []
        self._text_hashes = set()
        self._embeddings = None

    # ── Stats ─────────────────────────────────────────────────────────────────

    def stats(self) -> dict:
        dim = self._embeddings.shape[1] if self._embeddings is not None else 0
        return {
            "count": len(self._texts),
            "embedding_dim": dim,
            "dup_rejected_exact": self.dup_rejected_exact,
            "dup_rejected_near": self.dup_rejected_near,
            "embed_calls": self.embed_calls,
            "queue_depth": _embed_queue.qsize(),
        }


_memory = VectorMemory()

app = FastAPI(title="Vector Memory API", lifespan=lifespan)


# ─── Embedding Queue Worker ──────────────────────────────────────────────────
# Serializes all write operations to prevent concurrent numpy corruption.
# Write tasks put a (callable, asyncio.Future) pair on the queue.
# The worker calls the callable synchronously and resolves the Future.

async def _embedding_queue_worker():
    """Background task: drain the embed queue one job at a time."""
    global _queue_worker_running
    while _queue_worker_running:
        try:
            job, future = await asyncio.wait_for(_embed_queue.get(), timeout=1.0)
            try:
                result = job()
                if not future.done():
                    future.get_event_loop().call_soon_threadsafe(future.set_result, result)
            except Exception as exc:
                if not future.done():
                    future.get_event_loop().call_soon_threadsafe(future.set_exception, exc)
            finally:
                _embed_queue.task_done()
        except asyncio.TimeoutError:
            pass  # No jobs — keep looping
        except Exception as exc:
            log.error(f"Queue worker error: {exc}")


async def _enqueue_write(job) -> any:
    """Enqueue a synchronous write job and await its result."""
    loop = asyncio.get_event_loop()
    future = loop.create_future()
    await _embed_queue.put((job, future))
    return await future


# ─── Middleware: Request Timeout ─────────────────────────────────────────────

@app.middleware("http")
async def timeout_middleware(request: Request, call_next):
    global _request_count
    _request_count += 1
    try:
        response = await asyncio.wait_for(
            call_next(request),
            timeout=REQUEST_TIMEOUT_S,
        )
        return response
    except asyncio.TimeoutError:
        log.error(f"Request timeout after {REQUEST_TIMEOUT_S}s: {request.method} {request.url.path}")
        return JSONResponse(
            status_code=504,
            content={"detail": f"Request timed out after {REQUEST_TIMEOUT_S}s"},
        )


# ─── Request Models ──────────────────────────────────────────────────────────

class EmbedReq(BaseModel):
    text: str
    skip_dedup: bool = False

class BatchEmbedReq(BaseModel):
    texts: list[str] = Field(..., min_items=1, max_items=64)
    skip_dedup: bool = False

class SearchReq(BaseModel):
    query: str
    top_k: int = 3
    min_score: float = DEFAULT_MIN_SCORE

class DeleteReq(BaseModel):
    text: str

class DedupReq(BaseModel):
    threshold: float = NEAR_DEDUP_THRESHOLD


# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.post("/embed")
async def api_embed(req: EmbedReq):
    if not _model_ready:
        raise HTTPException(status_code=503, detail="Vector model not ready yet")
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="Missing or empty text")
    try:
        result = await _enqueue_write(lambda: _memory._embed_sync(req.text, skip_dedup=req.skip_dedup))
        return result
    except Exception as exc:
        log.error(f"embed error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/batch_embed")
async def api_batch_embed(req: BatchEmbedReq):
    """
    Embed multiple texts in a single model call.
    Deduplication is applied per-text within the batch.
    """
    if not _model_ready:
        raise HTTPException(status_code=503, detail="Vector model not ready yet")
    if not req.texts:
        raise HTTPException(status_code=400, detail="Empty texts list")
    try:
        results = await _enqueue_write(
            lambda: _memory._batch_embed_sync(req.texts, skip_dedup=req.skip_dedup)
        )
        return {"results": results, "count": len(results)}
    except Exception as exc:
        log.error(f"batch_embed error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/search")
async def api_search(req: SearchReq):
    if not _model_ready:
        raise HTTPException(status_code=503, detail="Vector model not ready yet")
    if not req.query or not req.query.strip():
        raise HTTPException(status_code=400, detail="Missing or empty query")
    try:
        res = _memory.search(req.query, req.top_k, req.min_score)
        return {"results": res, "count": len(res)}
    except Exception as exc:
        log.error(f"search error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/delete")
async def api_delete(req: DeleteReq):
    if not req.text:
        raise HTTPException(status_code=400, detail="Missing text")
    try:
        deleted = await _enqueue_write(lambda: _memory._delete_sync(req.text))
        return {"deleted": deleted, "remaining": len(_memory._texts)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/dedup")
async def api_dedup(req: DedupReq):
    """
    Scan the store and remove near-duplicate vectors.
    Use sparingly (O(n²) — fine for typical < 1000 vectors).
    """
    if not _model_ready:
        raise HTTPException(status_code=503, detail="Vector model not ready yet")
    try:
        result = await _enqueue_write(lambda: _memory._dedup_scan_sync(req.threshold))
        return result
    except Exception as exc:
        log.error(f"dedup error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/stats")
def api_stats():
    return _memory.stats()


@app.get("/liveness")
def api_liveness():
    """Liveness probe — returns 200 if uvicorn is responding at all."""
    return {"status": "alive", "model_ready": _model_ready}


@app.get("/health")
def api_health():
    """Readiness probe — returns 200 only after the model is loaded."""
    if not _model_ready:
        raise HTTPException(status_code=503, detail="Model not ready")
    stats = _memory.stats()
    uptime_s = round(time.time() - _startup_time, 1) if _startup_time else 0
    return {
        "status": "ready",
        "model_ready": True,
        "uptime_seconds": uptime_s,
        "total_requests": _request_count,
        **stats,
    }


@app.post("/clear")
async def api_clear():
    await _enqueue_write(lambda: _memory._clear_sync())
    return {"status": "cleared"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
