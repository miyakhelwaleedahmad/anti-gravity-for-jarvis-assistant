# System awareness

System and development observation: P6 ([prompt](phases/phase-06-system-observation.md)).
World state: P7 ([prompt](phases/phase-07-world-state.md)).
Windows-only observation: P14 ([prompt](phases/phase-14-windows.md)).

## Today

| Fact | How | Tool |
|---|---|---|
| Active window, open apps with window titles | persistent PowerShell session | get_active_window, get_open_apps, is_app_open |
| Chrome tabs (debugging profile only) | DevTools HTTP API on 127.0.0.1 (`JARVIS_CDP_PORT`, default 9222) | get_browser_tabs, is_tab_open |
| JARVIS's own services | bridge client list | get_jarvis_service_status |
| OS, CPU count, memory, uptime | Node `os` | get_system_info |
| Network interfaces, disk volumes | `os.networkInterfaces`, PowerShell `Get-Volume` | control_system network_status / disk_status |
| Process list | PowerShell `Get-Process` | control_process list |
| Combined snapshot | background observer every 8–20 s → `data/runtime/system_state.json` | get_system_state, get_pc_state |
| OS, CPU load, memory, disks, network (no MAC) — P6 | `perception/systemProbe.ts`: Node `os`, `fs.statfs` | system_overview |
| Development servers on local ports — P6 | `perception/devProbe.ts`: TCP connect, HTTP GET of `/` | dev_status |
| Git repositories in the project folders — P6 | `perception/gitProbe.ts`: `git` with fixed arguments, no shell | git_overview |
| Browser, windows, tabs, the tab on screen; a page's text and structure — P8 | `perception/browserState.ts`: DevTools protocol on 127.0.0.1 (`JARVIS_CDP_PORT`, default 9222), fixed read-only scripts | browser_state, browser_read_page, browser_page_structure |

Since P6, "status" / "system status" ("how is my PC doing") read the machine
and answer in one sentence ("CPU at 3 percent, 15 of 15.7 GB memory free, 29
GB free on the system disk, sir."); "is my backend running" / "what servers
are running" check the ports. Neither sends a request to the LLM. Before P6,
"status" answered "All systems are operational" without looking at anything.

Gaps (P14, Windows): GPU, displays, audio devices, cameras/microphones,
installed apps, services, the process that owns a port, clipboard.

## Target

### On-demand probes (P6 — same code on Windows and Linux)

| Probe | Facts | Source |
|---|---|---|
| `systemProbe` | OS name/version, CPU model, cores, usage over 200 ms, memory, uptime, disks (free/total), network interfaces (name, IPv4, up), Node version | Node `os`, `fs.statfs` |
| `devProbe` | Which local ports from a list accept connections; for HTTP ones the status, `Server` header and page title | TCP connect, HTTP GET with 1 s limit |
| `gitProbe` | Repositories under configured roots; branch, ahead/behind, changed files, last commits, diff summary | `git` with fixed arguments, no shell |

Configuration (as built): `JARVIS_DEV_PORTS` (default: 3000, 3001, 4200,
5000, 5173, 8000, 8080, 8081, 8888 — 9000 is JARVIS's own bridge and is left
out; database ports such as 5432 or 6379 can be added and are then only
connected to, never sent an HTTP request), `JARVIS_PROJECT_DIRS` (`;`-separated;
default: the JARVIS folder; repositories at each folder and one level below).

Limits: system 200 ms CPU sample; each port 300 ms to connect and 1 s for
HTTP, all in parallel; each git call 3 s. Git runs with `core.fsmonitor`
switched off and no external diff driver, so a repository's own settings
cannot run a program (tested: a plain `git status` ran a planted fsmonitor
program; the probe did not).

### Windows probes (P14)

GPU (`Win32_VideoController`), displays, audio devices, cameras and
microphones (PnP device classes), installed apps (uninstall registry keys),
services (`Get-Service`), listening ports with the owning process
(`Get-NetTCPConnection`), process ↔ window mapping, clipboard (level 1, redacted).

Built as the `windows_overview` tool (sections gpu, displays, audio, cameras,
apps, services, ports, windows; optional `filter`), through
`perception/windows_probe.ps1` — one short PowerShell process per reading,
the section name in an environment variable, the script text fixed
([PC_CONTROL.md](PC_CONTROL.md)). Windows are every visible top-level window
(EnumWindows, not one per program), joined with the ports their process
listens on. Speakers and microphones are told apart by the names Windows
gives them. The clipboard is the `clipboard` tool. Checked here with
`ConvertTo-Json` output and PowerShell's own parser; on the PC by
`pnpm verify:windows`.

### World state (P7)

```
system      os, cpu, memory, disks, network          observedAt
apps        active window, open apps                 observedAt
browser     browser, tabs, active tab, title, URL    observedAt
development servers/ports, repositories, branches    observedAt
task        goal, plan, current step, done, failed,
            pending approvals
```

- Each section has a timestamp; a request that needs a section older than its
  limit (30 s for apps and browser, 60 s for development, 5 min for system)
  refreshes it first.
- The planner gets only the sections the request is about, capped and redacted.
- World state is never written to long-term memory.

As built (P7, `core/worldState.ts`): parts are chosen from the request's words
(browser/tab/page → browser; server/port/backend/git/repo → development;
app/window → apps; cpu/memory/disk/slow → system). Stale parts are read again
before planning, at most 1.5 s; callers asking at the same time share one
read. The background observer hands in its window and Chrome readings, so
they rarely need a read of their own. The summary — at most 600 characters,
redacted, angle brackets removed — goes to the planner as user-role data inside
`<untrusted_context source="world-state">`, like the OCR text. The task part
follows the graph's steps and shows the approval request on display.

## Questions it should answer by looking

| Question | Observation |
|---|---|
| What is running? | apps + development servers |
| Is my backend running? | dev ports + HTTP probe; on Windows also the owning process |
| Why isn't my application working? | process, port, HTTP status, recent log lines, browser tab state |
| What is open in my browser? | browser section |
| Continue what I was doing | active window, browser tab, recent goals → asks when unsure |
