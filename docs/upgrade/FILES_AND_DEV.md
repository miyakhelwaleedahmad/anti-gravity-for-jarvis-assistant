# Files and development actions

Built in P10 ([prompt](phases/phase-10-files-and-dev.md)). Four tools, no shell,
fixed arguments, each change checked afterwards (the P5 verify step). Levels:
[PERMISSION_MODEL.md](PERMISSION_MODEL.md) ("Files, git and development").

## files (`tools/fsTools.ts`)

| Action | Does | Checks after |
|---|---|---|
| list | a folder, 1–3 levels, at most 300 entries | — |
| search | by part of a name and/or a text, recursively (8 levels, 20 000 entries, 100 results; skips `node_modules`, `.git`, `dist`, `build`, `.venv`…; key files by name only; links not followed) | — |
| compare | a unified diff of two text files (2 000 lines each, 200 lines out) | — |
| create | a file (never over an existing one) or a folder | the file holds the text / the folder is there |
| modify | find and replace (one occurrence, or `all`), or the whole text; the previous version goes to the trash | the file holds the new text |
| rename, move | within the approved folders, never over an existing item | the new path exists, the old one is gone |
| delete | moves the item into `<data>/data/trash/<id>/` with a note of where it was | gone from its folder, kept in the trash |
| restore | puts a trash item back (a previous version replaces the file, which is kept in turn) | it is back |
| trash, empty_trash | lists / deletes the trash for good | the trash is empty |

Containment: the approved folders (the JARVIS folder, Desktop, Documents,
Downloads, temp), compared by **real path** — a link inside an approved folder
that leads elsewhere is refused. Files that run when opened (`.exe`, `.bat`,
`.cmd`, `.ps1`, `.vbs`, `.msi`, `.lnk`, `.reg`…) are never created or changed.
A whole approved folder is never deleted, moved or renamed. The trash and the
browser screenshots are in `.gitignore`.

## git and git_push (`tools/gitTools.ts`)

Repositories inside the project folders (`JARVIS_PROJECT_DIRS`, real path).
`git` with `--no-pager`, `core.fsmonitor=false`, no password prompt.

| Action | Does | Checks after |
|---|---|---|
| status, diff, branches, log | reads (diff capped at 200 lines) | — |
| commit | `git add` (the named paths, or every change) and `git commit -m` | the last commit has the message; nothing left staged |
| switch | an existing branch, or a new one (`create`); names checked with `git check-ref-format` | the repository is on the branch |
| git_push | the current branch to its upstream, or to `origin` with `--set-upstream` | the remote branch has the local commit |

A commit is refused before anything is staged when a file it would take is a
key file (`.env`, `*.pem`, `id_rsa`, `credentials.json`…) or when the
redactor finds a credential in a change or in the message. There is no way to
force a push: the tool has no such option, and any `force` argument is refused.

## dev (`tools/devTools.ts`)

Projects with a `package.json` inside the project folders. The package manager
comes from the lock file (pnpm, yarn, else npm); the script name must be in
`package.json` and on the allowlist, so no typed text reaches a shell.

| Action | Does | Checks after |
|---|---|---|
| scripts | lists the scripts and what JARVIS does with each | — |
| run | `test`, `build`, `lint`, `typecheck`, `check` (and `test:…` etc.); up to 10 min (`JARVIS_DEV_RUN_TIMEOUT_MS`) | the exit code (a failing test run is reported, not hidden) |
| start_server | `dev`, `start`, `serve`, `preview`; optional `port` (passed as `PORT`) | a port answers within 30 s (`JARVIS_DEV_SERVER_START_MS`), from the output's address or a newly open dev port; otherwise JARVIS stops it |
| stop_server | by pid or project — only servers JARVIS started | the process is gone and its port closed |
| servers | lists them, and (P13) under `stopped` the ones that have stopped since: how (by itself with its exit code, from outside with a signal, or by JARVIS) and their last output lines, redacted | — |

The list of servers JARVIS started is kept in memory: after JARVIS restarts it
cannot stop one it started before. The diagnosis ([SCENARIOS.md](SCENARIOS.md))
uses the same list to say why a server stopped and to start it again.
