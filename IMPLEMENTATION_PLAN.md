# JARVIS — Implementation Plan

**Source spec:** `JARVIS_COMPLETE_TECHNICAL_AUDIT.md` (Claude Cowork, 2026-09-06, commit `f429071`)
**Baseline:** `docs/BASELINE.md`
**Governing rule:** preserve working functionality. Never reset the database, never delete
`memory/jarvis_memory.json`, never delete registered facts. Move dead code, do not delete it.

---

## A. Audit findings — independent verification

Every finding below was re-checked against the actual code in this checkout. Line numbers are
**as measured here**, and differ slightly from the audit where noted (harmless drift).

| ID | Finding | Status | Evidence gathered |
|---|---|---|---|
| **P0-01** | Hard-coded workspace root breaks file containment | **VERIFIED** | `security/workspacePathPolicy.ts:4`. Reproduced at runtime: a write to `C:\Windows\Temp\jarvis.txt` **succeeded**, landing at `<repo>/W:\anti gravity for jarvis assistant/C:\Windows\Temp\jarvis.txt`. 2 tests fail. |
| **P0-01b** | *(new — audit's fix is incomplete)* | **AUDIT INCOMPLETE** | Proven with `path.isAbsolute('C:\\Windows\\win.ini') === false` on POSIX. Fixing only the root leaves **both** failing assertions still failing. See §B. |
| **P1-01** | Vector store has no persistence | **VERIFIED** | Zero `np.save`/`np.load`/`pickle`/`json.dump`/`open(` in `memory/vectorMemory.py`. Rebuild cap `.slice(0, 10)` at `memoryManager.ts:347` (audit said 341). |
| **P1-02** | Two divergent file-path policies | **VERIFIED** | `control/fileController.ts:18` has its own `path.resolve('W:\\…')`; does not call `resolveWorkspacePath()`. |
| **P1-03** | Unconditional 500 ms sleep per node | **VERIFIED** | `core/taskGraphEngine.ts:416` — `await sleep(500)` inside the per-tool promise chain, with no last-invocation timestamp. Runs before the *first* call to a tool. |
| **P1-04** | No authorization at the dispatch point | **VERIFIED** | `core/toolRegistryV2.ts` contains **zero** references to `checkPermission`/`permissionSession`/`approvalGate`/`requiredLevel`. |
| **P2-02** | Replan guard keyed by goal string | **VERIFIED — worse than stated** | `_graphRetryCount` keyed by goal (`taskGraphEngine.ts:261`). `resetReplanCount()` (line 568) has **zero callers** → the guard never clears on success. `MAX_GRAPH_RETRIES = 2`. |
| **P2-04** | Groq cache key truncated to 200 chars | **VERIFIED** | `bridge/groqProvider.ts` — `.slice(0, 200)` per message inside `hashRequest`. |
| **P2-06** | Neo4j default password literal | **VERIFIED** | `memory/graphMemory.ts:28` — `process.env.NEO4J_PASSWORD \|\| "password"`. |
| **P2-11** | `fallback_tool` ≡ `retry_same` | **VERIFIED** | `orchestrator.ts` 1296–1300 vs 1281–1285 — byte-identical bodies; no tool substitution. |
| **P2-12** | Orphan Next route = unauthenticated Redis | **VERIFIED** | `app/api/memory/route.ts` — `GET ?key=` reads *any* key, `POST {key,value}` writes *any* key. No auth. Dead only because no Next server runs. |
| — | `core/brain.ts` is dead | **VERIFIED** | Imported by nothing (repo-wide grep). |
| — | `tsc --noEmit` clean | **VERIFIED** | exit 0, TS 6.0.2. |
| — | 57/67 tests pass | **NOT REPRODUCED — 56/67 here** | The extra failure is `successfulExecutionLifecycleAuditTest`, caused by this container's egress block on `api.groq.com`. Environmental, not a code difference. |
| — | 33 `checkPermission` + 17 `approvalGate` sites | **VERIFIED (counts differ)** | Measured **36** and **14** in `control/`. Conclusion unchanged: controller-layer authz is comprehensive. |
| — | 5 hard-coded `W:\` sites | **PARTIALLY CORRECTED** | Audit lists 3 security-relevant files — correct. Two **additional** cosmetic occurrences exist in `control/browserController.ts:26` and `perception/chromeState.ts:69` (Chrome-profile hint strings, not boundaries). |
| — | `data/security/` untracked but **not gitignored** | **NEW FINDING** | Created by the test suite; would be committed by a careless `git add -A`. Contains permission-session state. |

**Not yet independently verified** (deferred, lower risk, will verify at the phase that touches them):
the 63-module dead-code census, RAG absence, Obsidian absence, dependency-usage census, 559 `console.*`.

---

## B. Correction to the audit — JARVIS-001 as written cannot meet its own acceptance criteria

The audit's fix is *"derive `WORKSPACE_ROOT` from `path.resolve(__dirname,'..')` or `JARVIS_WORKSPACE_ROOT`"*,
with acceptance *"`fileToolWorkspaceSafetyTest` 5/5 on Linux **and** Windows."*

Measured on this host:

```
path.isAbsolute('C:\\Windows\\win.ini')  →  false        (POSIX: no leading '/')
path.resolve(<correct root>, 'C:\\Windows\\win.ini')
        →  <repo>/C:\Windows\win.ini      (inside the workspace)
   systemFolderBlocked: false      outsideWorkspace: false
   VERDICT: ALLOWED — the assertion still fails
```

Because `WINDOWS_SYSTEM_FOLDERS` is tested against the **resolved** path and is `^`-anchored, and
because containment is judged by `path.relative`, a Windows drive path on a POSIX host is silently
demoted to a *relative* path and lands **inside** the workspace. Correcting the root alone changes
*where* the misdirected write goes, not *whether* it is blocked.

**Therefore the fix must also**, platform-independently:
1. recognise Windows-style absolute paths (`X:\…`, `X:/…`) and UNC (`\\server\share`) as absolute on **any** host; and
2. run the system-folder patterns against that recognised form, before resolution.

This is added to the plan as **JARVIS-001b** and is a prerequisite for JARVIS-001's acceptance criteria.

---

## C. Phase plan

Ordering follows the audit's §38 with two changes: JARVIS-001b is folded into Phase 1, and
dead-code quarantine (JARVIS-017) is deferred out of Phase 1 to keep the P0 commit reviewable.

| Phase | Scope | Items | Risk | Gate to proceed |
|---|---|---|---|---|
| **0** | Safety baseline | backup, census, this plan | none | ✅ **DONE** — `docs/BASELINE.md` |
| **1** | **P0 file containment** | JARVIS-001, **001b**, 012 | Med | `fileToolWorkspaceSafetyTest` 5/5, `runCommandSafetyTest` 11/11, `fileControlSafetyTest` pass, `tsc` clean, no other test regresses |
| **2** | Latency + guard bugs | JARVIS-004, 008 | Low-Med | latency tests pass; new repeated-goal test passes |
| **3** | Dispatch authorization | JARVIS-005 | **Med-High** | new `dispatchAuthzTest`; **all** control tests still pass |
| **4** | Repair correctness | JARVIS-006, 007, 019 | Med | new fallback + replan tests |
| **5** | Memory durability | JARVIS-002, 003, 009 | **High — touches memory** | vector survives restart; **zero fact loss**; backup taken |
| **6** | Security hardening | JARVIS-013, 020, 014 | Med | injection test; `securityGateUnitTest` 36/36 held |
| **7** | Config + provider | JARVIS-011, 010, 016 | Low | fail-fast on missing key; cache-collision test |
| **8** | Observability | JARVIS-015, 027 | Low | one request → one joinable trace |
| **9** | Self-healing maps | JARVIS-018, 022 | Low | `faultInjectionTest` passes |
| **10** | Dead-code quarantine | JARVIS-017 | Med | `tsc` clean; suite ≥ baseline |
| **11** | Test runner + CI | JARVIS-025 | Low | one command → full census |
| **12** | Hygiene + docs | JARVIS-023, 024, 021 | Low | repo < 5 MB; README exists |
| **13** | RAG ingestion | JARVIS-026 | Low (additive) | ingest → retrieve → grounded answer |

### Deliberately deferred / not doing

- **JARVIS-026 (RAG)** is last: it is additive, and it *depends* on Phase 5 persistence.
  Building it before the vector store is durable would produce an index that dies on restart.
- **Hierarchical planning** (audit §35, P3): not scheduled. It is a capability change, not a
  repair, and the audit itself rates the current single-shot planner as functional.
- **Do not touch:** `toolRegistryV2` beyond adding authz; the voice FSM; `permissionSession` /
  `approvalGate` / `permissionManager`; `unifiedContextBuilder`; the `handleSuccess()` optimisation
  tiers; the bounded-loop guarantees.

---

## D. Blocked in this environment — RUNTIME VERIFICATION REQUIRED on the user's Windows host

These cannot be proven here and must not be reported as verified:

1. Windows-side behaviour of the corrected path policy (needs a real `W:` drive).
2. `test:pc-control` before/after Phase 3 — the authz change's true regression surface.
3. Any live LLM path — `api.groq.com` is egress-blocked in this container.
4. Redis, Neo4j, PowerShell, Python venv, microphone, camera, Chrome DevTools paths.
5. End-to-end voice latency; the 12 s SPEAKING watchdog (P3-04).

---

## E. Progress log

| Phase | Status | Commit | Notes |
|---|---|---|---|
| 0 | ✅ Complete | — | Baseline captured, 3 real defects isolated from 8 environmental failures |
| 1 | ✅ Complete | `phase-1` | JARVIS-001/001b/012. Suite **56→60 pass**, 11→8 fail, **zero regressions**. All 8 remaining failures are the baseline's environmental ones. New `workspaceRootPortabilityTest` 26/26. |
