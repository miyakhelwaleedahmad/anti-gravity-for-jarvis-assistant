# JARVIS — Final Engineering Report

**Repository:** `miyakhelwaleedahmad/anti-gravity-for-jarvis-assistant`
**Base commit:** `f429071` — "Initial upload of Jarvis Assistant"
**Branch:** `claude/jarvis-repair` · 22 commits: 14 repair + 8 post-validation (§8, §10)
**Spec:** `JARVIS_COMPLETE_TECHNICAL_AUDIT.md` (Claude Cowork), verified rather than trusted

---

## 1. Executive summary

Thirteen phases, each implemented, tested, regression-checked and committed
separately. The audit was treated as a specification to verify, not to obey —
and verification found three places where following it literally would have
broken working functionality.

| | Before | After |
|---|---|---|
| Tests passing | 56 / 67 | **69 / 77** |
| Real code defects | 3 | **0** |
| Environment-only failures | 8 | 8 (unchanged, all explained) |
| `tsc --noEmit` | clean | clean |
| Live non-test source files | 169 | **119** (112 after the quarantine; document RAG added 7) |
| Repository size | 46 MB | **3.7 MB** |
| Regressions introduced | — | **zero**, verified at every phase |

Nothing was rewritten. The orchestrator loop, the tool registry, the permission
model, the voice pipeline and the context builder — the parts the audit rated as
genuinely well engineered — were left alone except where a specific defect
required a change.

## 2. Where the audit was wrong

Verification mattered. Three findings would have caused harm if implemented as written.

### 2.1 The headline P0 fix does not work (JARVIS-001)

The audit said: derive the workspace root portably and `fileToolWorkspaceSafetyTest`
goes 5/5. Measured on a POSIX host:

```
path.isAbsolute('C:\Windows\win.ini')            → false
path.resolve(<correct root>, 'C:\Windows\win.ini') → <root>/C:\Windows\win.ini
   systemFolderBlocked: false   outsideWorkspace: false   → STILL ALLOWED
```

A Windows drive path is silently demoted to a *relative* path and lands **inside**
the workspace. Correcting the root changes *where* a bad write goes, not *whether*
it is blocked. The fix needed host-independent absolute-path detection as well.

### 2.2 A misattributed failure (JARVIS-001)

The audit blamed `runCommandSafetyTest` on the hard-coded root. `tools/terminalTool.ts`
already derived its root correctly with `path.resolve(__dirname, '..')` and never
touched `workspacePathPolicy` — and it is not in the audit's file list for that
fix. Same root cause as 2.1, different file.

### 2.3 The dispatch-authz default would deadlock the system (JARVIS-005)

The audit specified `riskLevel → requiredLevel` as low→0, medium→1, high→2.
Applied literally:

| Tool | riskLevel | Would become | Consequence |
|---|---|---|---|
| `enable_full_control_session` | high | L2 | **Permanent deadlock** — this is the tool that *grants* L2 |
| `open_app` | medium | L1 | Denied at the default L0, violating the audit's own stated constraint |
| `run_command` | high | L2 | Denied at L0, where it legitimately serves allow-listed commands |

Implemented instead: `requiredLevel` is explicit, defaults to 0, and each floor is
**min(level that tool's own controller enforces)** — a floor, never a ceiling.

## 3. Defects found beyond the audit

| Finding | Where |
|---|---|
| System-directory patterns required a trailing separator, so a bare `C:\Windows` slipped past **even on Windows** | `tools/terminalTool.ts` |
| Containment used a `startsWith` prefix test, accepting `<home>/Desktop-evil` as inside `<home>/Desktop` | `control/fileController.ts` |
| Approved folders were lower-cased then passed to `fs.readdir`, so `searchFiles()` silently matched nothing on a case-sensitive filesystem | `control/fileController.ts` |
| `resetReplanCount()` had **zero callers** — the replan guard never cleared, worse than the audit described | `core/taskGraphEngine.ts` |
| `data/security/` (permission-session state) was untracked but not gitignored | `.gitignore` |
| Atomic-write temp files (`*.json.tmp`) were not gitignored | `.gitignore` |

## 4. Phase-by-phase

| Phase | Work | Tests |
|---|---|---|
| 0 | Baseline: 56/67, 3 real defects isolated from 8 environmental | — |
| 1 | Portable, host-independent file containment | 3→5, 10→11, +26 new |
| 2 | Conditional tool spacing (**503 ms → 2 ms**); replan guard no longer poisons goals | +10 new |
| 3 | Dispatch-layer authorization as defence in depth | +23 new |
| 4 | `fallback_tool` actually switches tools; low-confidence plans actually replan; fast path reports real outcomes | +8 new |
| 5 | Vector store and episodic memory survive restart, **zero fact loss** | +23 python, +8 new |
| 6 | Orphan Redis route deleted; Neo4j default password removed; OCR injection surface closed | +13 new |
| 7 | Startup config validation; full-payload cache key; provider failover | +13 new |
| 8 | Structured tracing — one correlation id per request | +13 new |
| 9 | Self-healing maps point at files that exist; name collision ended | — |
| 10 | 57 unreachable modules quarantined to `_legacy/` | — |
| 11 | Real `npm test` runner + GitHub Actions CI | — |
| 12 | Repo 46 MB → 3.7 MB; README + ARCHITECTURE. Its untracking of runtime files deleted them on merge — reversed in §10 | — |
| 13 | Document RAG: ingest → chunk → embed → cited retrieval | +28 new |

## 5. Data safety

No database was reset, no migration run, no fact deleted.

- `memory/jarvis_memory.json` — the live fact store — exists only on your machine and was never touched here.
- **Correction.** An earlier version of this report said these four files were "untracked, not deleted" and that "the local files remain on disk". That was true only for the working copy that made commit `ccf6118`. `git rm --cached` records a deletion, and validation proved that merging it into a clone of `main` **deleted** `data/goals.json` (100 goal records) and the other three files.
- **Now:** `data/goals.json`, `memory/taskHistory.json`, `memory/userMemory.json` and `environment/systemInfo.json` are tracked again, **byte-identical to `main`**, so a merge does not touch them. The app no longer writes to any of them: live goals go to `data/runtime/goals.json` (gitignored), seeded once from `data/goals.json` by a copy that can never overwrite. Only `data/goals.json` is read by any live code; the other three are referenced nowhere. A merge simulation with a 100-record dataset kept all 100 records byte-identical in three working-copy states (uncommitted edits, committed edits, unmodified) — see §10.
- Vector-store loading **refuses** rather than corrupts: a dimension mismatch, row-count mismatch or unreadable file leaves memory untouched and falls back to rebuilding from LowDB.
- The episode log is append-only and never rewritten from memory, so in-memory pruning cannot delete history already on disk.

## 6. NOT VERIFIED — required on your hardware

This container has no Windows, no PowerShell, no Redis, no Neo4j, no Python
virtualenv, no microphone or camera, and **no network route to any LLM API**.
The following are implemented and unit-tested but not proven end to end:

1. **`test:pc-control` on Windows**, before and after the dispatch-authz change. The audit asks for this specifically; it is the change with the widest blast radius.
2. **The path policy on a real `W:` drive.** Run `fileToolWorkspaceSafetyTest` and `runCommandSafetyTest` there.
3. **Vector persistence against a real sentence-transformers model.** Every test here stubbed the model. **Back up `memory/jarvis_memory.json` and `data/` before the first run.**
4. **Provider failover against live endpoints.**
5. **Prompt-injection resistance** — that the model actually refuses instructions inside `<untrusted_context>`. Only static structure is proven.
6. **RAG end to end** — ingest a document, ask a question only it answers, confirm a grounded answer.
7. **Voice latency** wake → STT → plan → tool → TTS, and whether the 12 s SPEAKING watchdog fires mid-utterance.
8. **MiniFASNet / anti-spoofing** — not part of this repository at all. Unrelated to this work, and still unverified.

Start with `pnpm test` in PowerShell. On Windows it runs the three Windows-only
tests too and counts their failures as real; the five that need Redis, a
virtualenv, a bridge token or an LLM API are still listed as "environment"
until you provide those — run each of them directly with `npx tsx tests\<name>.ts`
and treat a non-zero exit as a failure.

## 7. Deliberately not done

- **Hierarchical planning** (audit P3): a capability change, not a repair. The current single-shot planner is functional.
- **Deleting `_legacy/`**: moved, not deleted. One release should not both change behaviour and destroy code. Delete after the system runs on real hardware without it.
- **A PDF parser**: `.pdf` is refused with a clear message rather than adding a dependency on your behalf.
- **Touching** `toolRegistryV2` beyond authz, the voice FSM, `permissionSession`/`approvalGate`, `unifiedContextBuilder`, or the `handleSuccess()` optimisation tiers.

## 8. Commits

```
(this)   test: let the test runner start tests on Windows
f486d4f  docs: sync the report with the final commit list
25285ed  fix: restore data/logs/.gitkeep deleted by accident
77e07b1  docs: correct documentation found inaccurate in validation
65b22cb  fix: authorize tool calls before validating their arguments
efa1a48  test: make adminControlTest able to detect a broken command blocklist
4be9a13  ci: let package.json pin the pnpm version
a0f2326  fix: stop merges deleting runtime data by never writing live state to tracked files
8606d36  docs: add the final engineering report
8cf2ae6  feat: add document RAG — ingestion, chunking, and cited retrieval
ccf6118  docs: add a README, correct the architecture, stop tracking runtime state
d31849d  test: add a real test runner and CI
c39ca7b  refactor: quarantine 57 unreachable modules into _legacy/
4cf5c1a  fix: point self-healing at files that exist, end the systemController clash
e0c69d4  feat: join the structured logger to execution so a request has one trace
0f9d7a7  feat: validate config at startup, stop the LLM being a single point of failure
b7f1393  fix: close three security gaps
b9f861c  feat: make semantic and episodic memory survive a restart
5251787  fix: make the repair strategies do what they claim
1cb3b49  feat: enforce tool authorization at the dispatch layer
b19e8d5  fix: make per-tool spacing conditional, stop the replan guard poisoning goals
655a330  fix: make the file containment boundary portable and host-independent
```

## 9. Getting started after unpacking

```bash
pnpm install
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env        # set GROQ_API_KEY and JARVIS_BRIDGE_TOKEN

pnpm run typecheck
pnpm test                     # full census
pnpm dev                      # start JARVIS
```

See `README.md` for detail, `IMPLEMENTATION_PLAN.md` for the verification table,
`docs/BASELINE.md` for the measured starting point, and `_legacy/README.md` for
what was quarantined.

## 10. Post-validation fixes

A later validation of this branch found seven problems. All are fixed on the
branch. Each code fix (DATA-01, SEC-01, SEC-02) has a test shown to fail
without it; CI-01 and the documentation fixes were verified as the table says.
Two more were found while fixing them: the accidental `.gitkeep` deletion and
a test runner that could not run on Windows (last two rows).

| ID | Problem | Fix | Verified by |
|---|---|---|---|
| DATA-01 | Merging deleted `data/goals.json` and three other files (see §5 correction) | Files restored byte-identical to `main`; live goals moved to gitignored `data/runtime/goals.json` with a copy-only migration | `goalRuntimeMigrationTest` 16/16; merge simulation below |
| CI-01 | CI never ran a test: `pnpm/action-setup` refused both `version: 10` and `packageManager` | Removed `version:`; `package.json` is authoritative | All CI steps pass locally; GitHub Actions run on push |
| SEC-01 | `adminControlTest` could not fail (`blocked = blocked \|\| true`, and it accepted any "cancel" error) | Asserts the validator's own refusal and that the approval gate is never reached; a spy gate makes the test unable to execute anything | 30/30; against a weakened blocklist it fails 12 assertions, and the original test passed 7/7 |
| SEC-02 | Schema validation ran before authorization, so unauthorized callers learned argument names | Authorization moved ahead of schema validation | `dispatchAuthzTest` 32/32; 3 assertions fail with the old order |
| DOC-01 | `ARCHITECTURE.md` said document RAG did not exist | Added a Document RAG section; also corrected the dispatch order, skill count, and an overstated claim that tool output is wrapped as untrusted | Checked against the code |
| DOC-02/03/04 | README said 31 tools, 24 skills, 112 TypeScript files | 33, 26, 119 — counted from the live registry and `git ls-files` | Counted, not copied |
| DOC-05 | This report said the untracked files "remain on disk" | Corrected in §5 | Merge simulation |
| — | `data/logs/.gitkeep` deleted by accident in `4cf5c1a` (a cleanup `rm -rf data/logs` removed the tracked placeholder) | Restored byte-identical to `main` | Net diff against `main` is empty |
| — | `pnpm test` could not start a single test on Windows: it ran `spawn('npx')` without a shell, and `npx` is a `.cmd` shim there. On Windows it would also have excused failures of the three Windows-only tests as "environment" | Tests start as `node <tsx cli> <file>`; a test that cannot start fails instead of crashing the runner; on Windows the Windows-only tests always run and count | All three reproduced on Linux before the fix (`npx` off `PATH` → runner crash; `process.platform` faked to `win32` → Windows test skipped or excused) and gone after it; Linux results unchanged. **Not yet run on Windows** |

### Merge simulation (DATA-01)

A clone of GitHub `main` was given a synthetic 100-record `data/goals.json`, then
the branch was merged in, for each of three working-copy states:

| Working copy | Previous branch head `8606d36` | Fixed branch |
|---|---|---|
| Uncommitted edits to `data/goals.json` | merge refused ("would be overwritten") | 100 → 100, identical |
| Edits committed | modify/delete conflict; other three files deleted | 100 → 100, identical |
| Unmodified | `data/goals.json` deleted | 100 → 100, identical |

After the merge, starting `goalManager` migrated all 100 records into
`data/runtime/goals.json`, left `data/goals.json` untouched, and added nothing
to `git status`.

### Observation, not changed

With the vector service unavailable, `search_documents` reports that nothing
matched; it cannot yet distinguish "no match" from "search unavailable".
Recorded in `ARCHITECTURE.md`; behaviour left as is.
