# Phase 6 — System and development observation

## Goal
On-demand, level-0 facts about the machine and development work — OS, CPU,
memory, disks, network, listening development ports, development servers, git
repositories — with code that runs the same on Windows and Linux.

## Current system context
- `get_system_info` (`tools/terminalTool.ts`): OS, CPU count, memory, uptime.
- `control_system network_status` (`os.networkInterfaces`, includes MAC
  addresses), `disk_status` (PowerShell `Get-Volume`, Windows only).
- Nothing about ports, servers or git (git only through run_command).
- Router: "status" / "system status" reply "All systems are operational, sir."
  without checking anything.

## Required changes
1. `perception/systemProbe.ts`, `perception/devProbe.ts`, `perception/gitProbe.ts`.
2. Tools `system_overview`, `dev_status`, `git_overview` (level 0, metadata).
3. Router: "status"/"system status" and "is my backend running" answered from
   the probes, without an LLM request.

## Implementation steps
1. `systemProbe.snapshot()`: platform, release, version (`os.version()`),
   arch, hostname (not sent to the model unless asked), CPU model, cores,
   usage (two `os.cpus()` samples 200 ms apart), memory total/free, uptime,
   disks via `fs.promises.statfs` on each drive root (Windows: letters found
   with `fs.existsSync('X:\\')`, Linux: `/`), network: interface name, IPv4,
   internal flag (no MAC).
2. `devProbe.scan(ports = JARVIS_DEV_PORTS)`: TCP connect to 127.0.0.1 with a
   300 ms limit, all ports in parallel; for each open port an HTTP GET `/` with a
   1 s limit: status code, `Server` header, `<title>` (≤ 80 chars, redacted,
   untrusted). Never follows redirects off localhost.
3. `gitProbe.overview(roots = JARVIS_PROJECT_DIRS)`: repositories at the root
   and one level below; `execFile('git', ['-C', repo, 'status',
   '--porcelain=v2', '--branch'])`, `['log', '-5', '--format=%h %s']`,
   `['diff', '--stat']`; paths validated (absolute, inside configured roots, no
   control characters); 3 s limit per call; no shell.
4. Tools with catalogue metadata (OBSERVATION / DEVELOPMENT, risk 0); outputs JSON.
5. Orchestrator routes: `status`, `system status` → short spoken summary of
   `system_overview` (CPU %, memory free, disk free of the system drive);
   `is my backend running`, `is my server running`, `what servers are running`
   → `dev_status` summary. Existing route tests updated only where the reply
   text changes (the old reply was not an observation).

## Files to inspect
`tools/terminalTool.ts`, `control/systemController.ts`, `core/environmentContext.ts`,
`core/orchestrator.ts` (router), `perception/*`.

## Files that may be modified
New probe files, `core/tools/observationTools.ts` (new), `core/tools/index.ts`,
`core/toolCatalog.ts`, `core/orchestrator.ts`, `.env.example`, tests, docs.

## Dependencies
P1, P4.

## Tests
`tests/systemObservationTest.ts`: snapshot values match `os` readings; disk
total > 0; no MAC addresses; a server started by the test on a free port is
reported open with its status and title; a closed port is reported closed; a
temporary git repository with a commit and an edit reports branch, changed
file and last commit; a root path with `;` or a path outside roots is refused;
"system status" and "is my backend running" answered with 0 LLM requests.

## Acceptance criteria (here)
All tests with real sockets, a real HTTP server and real git.

## Security requirements
Level 0; no shell; fixed git arguments; localhost only; output redacted;
page titles marked untrusted.

## Failure conditions
Any probe that blocks longer than its limit; any shell use; any MAC address in output.

## Completion requirements
Gate; checklist; PHASE_STATUS; SYSTEM_AWARENESS; commit `phase-06-system-observation`; CI green.
