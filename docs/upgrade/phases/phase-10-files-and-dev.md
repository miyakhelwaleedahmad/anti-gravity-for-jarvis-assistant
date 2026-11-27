# Phase 10 — Files and development actions

## Goal
Structured tools for files, git, tests, builds and development servers, each
with a risk level and a check of its effect, so none of this needs a free-text
shell command.

## Current system context
- read_file / write_file inside the project; control_file in approved folders
  (search is one folder level deep).
- run_command with a developer allowlist (git status, npm/pnpm scripts on a
  list) and the command validator.
- After P6: git and port probes.

## Required changes
1. `tools/fsTools.ts`: list, search (recursive, bounded), compare (line diff),
   create, modify (replace text), rename, move, delete (to a JARVIS trash).
2. `tools/gitTools.ts`: status, diff, branches, log (0); add+commit (2);
   switch branch (2); push (3; to main/master 4); force push refused.
3. `tools/devTools.ts`: run_tests / run_build (package scripts on an allowlist),
   start_dev_server (1) and stop_dev_server (2, only servers JARVIS started).
4. Verifiers for every action (P5 hook).

## Implementation steps
1. All paths through the existing containment (`fileController` approved
   folders, `isProtectedSystemPath`); `execFile` with fixed arguments; time limits.
2. Delete moves the item to `<dataRoot>/data/trash/<timestamp>/` and registers
   a rollback; "empty trash" is level 3.
3. Compare: unified diff capped at 200 lines.
4. Git: `-C <repo>` validated as a repository inside the configured roots;
   commit message from the request, redacted; push target read from
   `git rev-parse --abbrev-ref @{u}`.
5. Dev server: `spawn` the package script detached from the console, record PID
   and port; verify with the P6 port probe within 30 s; stop only recorded PIDs.
6. Catalogue metadata and risk classifiers for each action.

## Files to inspect
`tools/fileTool.ts`, `control/fileController.ts`, `tools/terminalTool.ts`,
`core/workspaceRoot.ts`, `security/workspacePathPolicy.ts`, P6 probes.

## Files that may be modified
New tool files, `control/fileController.ts`, `core/tools/index.ts`,
`core/toolCatalog.ts`, `security/riskEngine.ts`, tests, docs.

## Dependencies
P2, P3, P5, P6.

## Tests
`tests/filesAndDevToolsTest.ts`: real temp folders (list, recursive search,
compare, create, modify, rename, move, delete to trash and restore); paths
outside approved folders refused; a real temp git repository (status, diff,
branches, log, commit — approval per policy, push to a local bare remote —
approval required, push to `main` level 4); force push refused; a real package
script runs and its exit code is reported; a dev server started on a free port
is verified and stopped; stopping a PID JARVIS did not start is refused.

## Acceptance criteria (here)
All of the above with real files, git and processes.

## Security requirements
Containment unchanged; no shell; deletes recoverable; level 3–4 for pushes.

## Failure conditions
Any write outside approved folders; an unverified action; a force push possible.

## Completion requirements
Gate; checklist; PHASE_STATUS; commit `phase-10-files-and-dev`; CI green.

## As built (alignment note)
- Four tools rather than one file per area: `files` (actions), `git`
  (actions), `git_push` (its own tool, because its metadata marks a change
  outside the PC), `dev` (actions). Details: [FILES_AND_DEV.md](../FILES_AND_DEV.md).
- Modify keeps the previous version in the trash (restorable), besides delete.
- Commits refuse key files and credentials before anything is staged.
- Also fixed: `control_file` containment by real path; `data/screenshots/` and
  `data/trash/` git-ignored.

