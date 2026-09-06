# ROOT_FILE_AUDIT_GUIDE.md — Classification of Root-Level Files

> This file classifies every non-standard file in the project root.
> Do not delete anything. This is an audit-only document.
> Update this file if new root-level files are added.

---

## Active Runtime Files (Do Not Touch)

| File | Category | Notes |
|---|---|---|
| `jarvis.ts` | **runtime entry** | Main process — all voice/CLI routing starts here |
| `index.ts` | **runtime entry** | Secondary entry / re-export barrel |
| `package.json` | **package/config** | Scripts, dependencies, pnpm workspace |
| `pnpm-lock.yaml` | **package/config** | Dependency lockfile — do not hand-edit |
| `tsconfig.json` | **package/config** | TypeScript compiler configuration |
| `.env` | **package/config** | Secret environment variables — never commit, never log |
| `.env.example` | **package/config** | Safe template for .env — can be shared |
| `.gitignore` | **package/config** | Git exclusion rules |
| `pyrightconfig.json` | **package/config** | Pyright type checker config for Python files |
| `requirements.txt` | **package/config** | Python package requirements |

---

## Diagnostic Scripts (Not Runtime — One-Time Use)

These were created for code analysis and should not be imported from runtime code.

| File | Category | Purpose | Safe to Run Again? |
|---|---|---|---|
| `analyze.ts` | **diagnostic script** | Scans codebase, produces `analysis.json` | Yes, read-only |
| `count_modules.ts` | **diagnostic script** | Counts module types across folders | Yes, read-only |
| `debug_imports.ts` | **diagnostic script** | Traces import chains | Yes, read-only |
| `find_importers.ts` | **diagnostic script** | Finds who imports a given module | Yes, read-only |
| `stateMachineVerification.ts` | **diagnostic script** | Verifies state machine transitions | Yes, read-only |
| `test_node_redis.ts` | **diagnostic script** | Tests Redis connectivity from Node.js | Yes, but connects to Redis |
| `tsc_output.txt` | **generated report** | Captured output of `npx tsc` | Read-only artifact |

---

## Refactor Scripts (Dangerous — Verify Before Running)

These scripts modify code. Do NOT run them without understanding what they do.

| File | Category | Risk |
|---|---|---|
| `fix_executor.ts` | **refactor script** | Modifies executor files — verify target before running |
| `fix_imports.ts` | **refactor script** | Modifies import statements — verify before running |
| `refactor_mem.ts` | **refactor script** | Modifies memory files — verify before running |
| `refactor_p2.ts` | **refactor script** | Phase 2 refactor — verify before running |

> ⚠️ Do NOT run refactor scripts without reading their full code first.
> They may modify protected runtime files.

---

## Generated Structure Reports (Large Files — Possible Cleanup)

These are auto-generated tree/structure files. They are reference only.

| File | Category | Size | Notes |
|---|---|---|---|
| `analysis.json` | **generated report** | 52 KB | Output of analyze.ts — re-generable |
| `jarvis_structure.txt` | **generated structure report** | ~11 MB | Full project tree — very large, should be in .gitignore |
| `jarvis_structure_utf8.txt` | **generated structure report** | ~5 MB | UTF-8 version — also large |
| `fresh_structure.txt` | **generated structure report** | 23 KB | Snapshot of folder structure |
| `fresh_structure_utf8.txt` | **generated structure report** | 12 KB | UTF-8 version |
| `folder_structure.txt` | **generated structure report** | ~1 KB | Short folder listing |
| `project_tree.txt` | **generated structure report** | ~11 MB | Full project tree |
| `project-tree-clean.txt` | **generated structure report** | 4.6 KB | Cleaned tree |
| `jarvis-clean-folder-tree.txt` | **generated structure report** | 17 KB | Another clean tree |
| `clean_structure.txt` | **generated structure report** | Unknown | Structure snapshot |

> Recommendation: Add `*_structure.txt`, `*_tree.txt`, `project_tree.txt`, `jarvis_structure*.txt`
> to `.gitignore` to prevent committing large generated files.

---

## Generated Audit/Report Files (Reference Only)

| File | Category | Notes |
|---|---|---|
| `report.md` | **generated audit report** | Output of report.ts — re-generable |
| `jarvis_system_audit.md` | **generated audit report** | System audit report |
| `jarvis_production_hardening_report.md` | **generated audit report** | Production hardening report |
| `jarvis_stability_report_2026-06-11T05-04-59-262Z.json` | **generated audit report** | Timestamped stability JSON report |

---

## Test/Verification Scripts (Should Be in tests/)

These are test scripts living at the root instead of in `tests/`. They are functional but misplaced.

| File | Category | Recommendation |
|---|---|---|
| `stabilityTest.ts` | **active test** | Move to `tests/` in a future cleanup |
| `stateMachineVerification.ts` | **active test** | Move to `tests/` in a future cleanup |
| `test_node_redis.ts` | **active test** | Move to `tests/` in a future cleanup |
| `test_production_hardening.ts` | **active test** | Move to `tests/` in a future cleanup |

> Do not move these files until you have confirmed no scripts reference them by root path.

---

## Backup Files

| File | Category | Notes |
|---|---|---|
| `report.ts.bak` | **backup file** | Old backup of report generator — 5.9 KB |

> Safe to delete later once confirmed no longer needed. Do not delete in this pass.

---

## Temporary Artifacts

| File | Category | Notes |
|---|---|---|
| `temp_stt_1777830229.wav` | **temporary artifact** | 137 KB audio recording from STT — should NOT be committed |

> Add `temp_stt_*.wav` and `*.wav` to `.gitignore` immediately.
> This is a recorded audio file and should not be in version control.

---

## Unknown / Needs Review

| File | Category | Notes |
|---|---|---|
| `architecture of jarvis in antigravity` | **needs human review** | No extension — likely a text/notes file. Review contents. |
| `scaffold.ps1` | **needs human review** | PowerShell scaffold generator — verify what it creates before running |
| `open this one.txt` | **needs human review** | Unusual filename — review contents |

---

## .gitignore Recommendations

Add these patterns if not already present:

```gitignore
# Large generated structure files
*_structure.txt
*_tree.txt
project_tree.txt
jarvis_structure*.txt
fresh_structure*.txt
clean_structure.txt
jarvis-clean-folder-tree.txt
project-tree-clean.txt

# Temporary audio
temp_stt_*.wav
*.wav

# Python
.venv/
__pycache__/
*.pyc

# Node
node_modules/

# Environment
.env
```

> Do not modify .gitignore without understanding current entries first.
