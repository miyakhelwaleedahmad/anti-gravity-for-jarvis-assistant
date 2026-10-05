# Phase 5 — Observe → act → verify

## Goal
An action counts as done only after a check of its real effect; a failed check
is a failure, reported honestly.

## Current system context
- `toolRegistryV2.execute` returns `success` from the tool's own report
  (`Error:` prefix, `"success": false`).
- `handleSuccess` speaks "Opening X" / the tool's message; nothing re-reads state.

## Required changes
1. Verifier hook on tools; registry runs it after success.
2. Failed verification fails the step.
3. Verifiers for existing platform-independent actions.
4. Replies say when a result was checked.

## Implementation steps
1. `AgentTool.verify?(args, output): Promise<{ status: 'verified' | 'failed' |
   'unverifiable'; evidence: string }>`. Registry: after a successful run, call
   it with a 5 s limit; attach `verification` to `ToolResult`; exceptions →
   `unverifiable` with the reason.
2. Orchestrator executor: `failed` → throw `VERIFICATION_FAILED: <evidence>`;
   taskGraphEngine classifies it fatal; reflection pattern →
   `context_error` / abort with "I tried to X but could not confirm it: …".
3. Verifiers:
   - write_file: file exists, contents hash equals the written text;
   - control_file write/copy/move/rename/create_folder/delete/delete_folder:
     destination exists / source gone / path absent as appropriate;
   - save_relation: `search_memory` finds the relation;
   - ingest_documents: manifest lists the files.
   Tools with no possible check declare `verify` returning `unverifiable` with a reason.
4. `handleSuccess`: for action tools with `verified`, reply "Done and checked, sir…"
   (still short); `unverifiable` → no claim of checking.

## Files to inspect
`core/toolRegistryV2.ts`, `core/orchestrator.ts` (executor, handleSuccess),
`core/reflectionEngine.ts`, `core/taskGraphEngine.ts`, `tools/fileTool.ts`,
`skills/control_file/skill.ts`, `control/fileController.ts`, `core/tools/memoryTool.ts`,
`skills/ingest_documents/*`.

## Files that may be modified
The above, tests, docs.

## Dependencies
P1.

## Tests
`tests/verifyAfterActTest.ts`: real write → verified; a write stub that reports
success without writing → step fails with VERIFICATION_FAILED and the reply
says it could not confirm; copy/move/delete checks on real temp files; a
verifier that throws → unverifiable, step still succeeds; a verifier that hangs
→ cut off at 5 s.

## Acceptance criteria (here)
Every non-Windows action tool has a verifier or a stated reason; tests pass;
suite unchanged.

## Security requirements
Verifiers are read-only and contained to the same folders as the action.

## Failure conditions
A silent no-op reported as success; a verifier with side effects.

## Completion requirements
Gate; checklist; PHASE_STATUS; commit `phase-05-verify`; CI green.
