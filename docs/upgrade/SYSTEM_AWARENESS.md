# System awareness

System and development observation: P6 ([prompt](phases/phase-06-system-observation.md)).
World state: P7 ([prompt](phases/phase-07-world-state.md)).
Windows-only observation: P14 ([prompt](phases/phase-14-windows.md)).

## Today

| Fact | How | Tool |
|---|---|---|
| Active window, open apps with window titles | persistent PowerShell session | get_active_window, get_open_apps, is_app_open |
| Chrome tabs (debugging profile only) | DevTools HTTP API on 127.0.0.1:9222 | get_browser_tabs, is_tab_open |
| JARVIS's own services | bridge client list | get_jarvis_service_status |
| OS, CPU count, memory, uptime | Node `os` | get_system_info |
| Network interfaces, disk volumes | `os.networkInterfaces`, PowerShell `Get-Volume` | control_system network_status / disk_status |
| Process list | PowerShell `Get-Process` | control_process list |
| Combined snapshot | background observer every 8–20 s → `data/runtime/system_state.json` | get_system_state, get_pc_state |

Gaps: GPU, displays, audio devices, cameras/microphones, installed apps,
services, listening ports, development servers, git repositories, clipboard.
"system status" is answered with a fixed sentence ("All systems are
operational") without looking at anything.

## Target

### On-demand probes (P6 — same code on Windows and Linux)

| Probe | Facts | Source |
|---|---|---|
| `systemProbe` | OS name/version, CPU model, cores, usage over 200 ms, memory, uptime, disks (free/total), network interfaces (name, IPv4, up), Node version | Node `os`, `fs.statfs` |
| `devProbe` | Which local ports from a list accept connections; for HTTP ones the status, `Server` header and page title | TCP connect, HTTP GET with 1 s limit |
| `gitProbe` | Repositories under configured roots; branch, ahead/behind, changed files, last commits, diff summary | `git` with fixed arguments, no shell |

Configuration: `JARVIS_DEV_PORTS` (default: 3000, 3001, 4200, 5000, 5173, 5432,
6379, 8000, 8080, 8888, 9000), `JARVIS_PROJECT_DIRS` (default: the JARVIS folder).

### Windows probes (P14)

GPU (`Win32_VideoController`), displays, audio devices, cameras and
microphones (PnP device classes), installed apps (uninstall registry keys),
services (`Get-Service`), listening ports with the owning process
(`Get-NetTCPConnection`), process ↔ window mapping, clipboard (level 1, redacted).

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

## Questions it should answer by looking

| Question | Observation |
|---|---|
| What is running? | apps + development servers |
| Is my backend running? | dev ports + HTTP probe; on Windows also the owning process |
| Why isn't my application working? | process, port, HTTP status, recent log lines, browser tab state |
| What is open in my browser? | browser section |
| Continue what I was doing | active window, browser tab, recent goals → asks when unsure |
