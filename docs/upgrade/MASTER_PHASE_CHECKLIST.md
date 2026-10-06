# Master phase checklist

`[ ]` not started · `[~]` in progress · `[x]` complete · `[!]` blocked · `[-]` skipped

A phase is marked complete only when its gate in [JARVIS_PHASES.md](JARVIS_PHASES.md)
passes. Results and dates: [PHASE_STATUS.md](PHASE_STATUS.md).

| Phase | Status |
|---|---|
| P0 Discovery and architecture | [x] |
| P1 Tool registry | [x] |
| P2 Risk engine | [x] |
| P3 Approval gate | [x] |
| P4 Redaction | [x] |
| P5 Observe → act → verify | [x] |
| P6 System and development observation | [x] |
| P7 World state | [x] |
| P8 Browser observation | [x] |
| P9 Browser control | [x] |
| P10 Files and development actions | [x] |
| P11 Error recovery | [ ] |
| P12 Voice | [ ] |
| P13 Integration and scenarios | [ ] |
| P14 Windows observation and control | [ ] |
| P15 Final verification | [ ] |

## P0 — Discovery and architecture
- [x] Repository, orchestrator, state machine, loop, tools, memory, voice, bridge inspected
- [x] Browser, control, Windows, files, terminal, security, permissions inspected
- [x] Tests, CI, configuration, dependencies inspected
- [x] Has / missing / reuse / improve / do-not-touch written (roadmap §1)
- [x] Phase plan, task list, design documents, phase prompts written
- [x] PHASE COMPLETE

## P1 — Tool registry
- [x] Architecture inspected
- [x] Metadata model designed (category, risk per action, approval, reversible, external, output)
- [x] Metadata filled for every registered tool
- [x] Registry discovery API (by category, by risk, capability summary)
- [x] `list_capabilities` tool
- [x] Planner and "what can you do" use the registry
- [x] Unit tests created
- [x] Tests passing (and failing on the old code where they test new behaviour)
- [x] Integration test passing (real orchestrator)
- [x] Full suite: no new failures
- [x] Documentation updated
- [x] Acceptance criteria verified
- [x] PHASE COMPLETE

## P2 — Risk engine
- [x] Risk assessment for a concrete call (tool, action, arguments, session)
- [x] Argument classifiers (commands, paths, deletes, services, URLs)
- [x] Policies for levels 0–4, level 2 configurable
- [x] Wired into registry dispatch, after every existing check
- [x] Default session level per the specification (level 1 actions automatic)
- [x] Unit tests, integration tests, full suite
- [x] Existing permission, injection and blocklist tests still pass
- [x] Documentation updated
- [x] PHASE COMPLETE

## P3 — Approval gate
- [x] Approval request model (action, why, target, effect, risk, reversibility)
- [x] Console and spoken presentation, "Do you approve this action?"
- [x] Answer accepted only for the displayed pending request; level 4 typed code
- [x] Decision recorded on the task node, goal and audit log
- [x] No second prompt inside the controller for an approved call
- [x] Tests (console, voice simulated, timeout, vague yes, level 4), full suite
- [x] Documentation updated
- [x] PHASE COMPLETE

## P4 — Redaction
- [x] Redactor for keys, tokens, passwords, private keys, cookies (built in P3)
- [x] Applied before the LLM, memory and logs
- [x] Observations kept out of long-term memory by default
- [x] Per-tool rate limits; external-send policy
- [x] Action history tool
- [x] Leak tests over all sinks, full suite
- [x] Documentation updated
- [x] PHASE COMPLETE

## P5 — Observe → act → verify
- [x] Verifier hook in the registry; unverified counts as failure
- [x] Verifiers for file, memory and document actions
- [x] Replies distinguish checked from unchecked
- [x] Tests (real files, a silent failure caught), full suite
- [x] Documentation updated
- [x] PHASE COMPLETE

## P6 — System and development observation
- [x] System snapshot (OS, CPU, memory, disks, network)
- [x] Listening development ports and servers
- [x] Git repositories, status, branches, diff summary
- [x] Routes for common questions without an LLM request
- [x] Tests with real servers and a real repository, full suite
- [x] Documentation updated
- [x] PHASE COMPLETE

## P7 — World state
- [x] Model with timestamps and freshness
- [x] Refresh on demand
- [x] Task state including pending approvals
- [x] Planning summary (relevant, capped, redacted)
- [x] Not stored in long-term memory
- [x] Tests, full suite, documentation
- [x] PHASE COMPLETE

## P8 — Browser observation
- [x] DevTools protocol client (WebSocket, timeouts)
- [x] Browser, tabs, active tab, title, URL
- [x] Page text and structure; password values never read
- [x] Page content passed as untrusted data
- [x] Tests against real Chromium, full suite, documentation
- [x] PHASE COMPLETE

## P9 — Browser control
- [x] Navigation and tab actions
- [x] Click, type, select, scroll by element
- [x] Observe before, verify after
- [x] Screenshot, download, upload
- [x] Risk levels per action, approvals
- [x] Tests against real Chromium, full suite, documentation
- [x] PHASE COMPLETE

## P10 — Files and development actions
- [x] File tools (list, search, compare, create, modify, rename, move, delete)
- [x] Git tools (status, diff, branches, log, commit, push)
- [x] Test, build and dev-server tools
- [x] Verifiers for each action
- [x] Tests with real files, repository, scripts, servers; full suite; documentation
- [x] PHASE COMPLETE

## P11 — Error recovery
- [ ] Diagnosis uses fresh observation
- [ ] Repair steps pass the risk engine
- [ ] Risky repair stops and asks
- [ ] Verification after repair
- [ ] Tests, full suite, documentation
- [ ] PHASE COMPLETE

## P12 — Voice
- [ ] Spoken approval request and answer rules
- [ ] Spoken summaries for observations
- [ ] New capabilities reachable by voice through the same pipeline
- [ ] JARVIS's own speech cannot approve
- [ ] Tests (simulated speech), full suite, documentation
- [ ] PHASE COMPLETE

## P13 — Integration and scenarios
- [ ] Browser, backend, application, "continue", website, dangerous-request scenarios
- [ ] LLM request count per scenario recorded
- [ ] Tests, full suite, documentation
- [ ] PHASE COMPLETE

## P14 — Windows observation and control
- [ ] Windows observation (GPU, displays, audio, cameras, installed apps, services, ports, clipboard)
- [ ] UI Automation, screenshots, dialogs
- [ ] Checks for window and app actions
- [ ] `pnpm verify:windows`
- [ ] Unit tests here
- [ ] Verification report from the owner's Windows PC
- [ ] PHASE COMPLETE

## P15 — Final verification
- [ ] Unit, integration, end-to-end, browser, Windows, permission, security, recovery, regression, performance
- [ ] FINAL_JARVIS_IMPLEMENTATION_REPORT.md
- [ ] PHASE COMPLETE
