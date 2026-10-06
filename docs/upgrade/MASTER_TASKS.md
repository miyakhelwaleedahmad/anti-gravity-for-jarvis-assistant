# Master task list

Every task: ID, priority, status, dependencies, description, files, steps, tests,
acceptance. Status uses the checklist marks: `[ ]` `[~]` `[x]` `[!]` `[-]`.
Each task follows: inspect → implement → test → verify → document → mark done.

Priorities: **Critical** (safety or a dependency of everything after it),
**High** (core capability), **Normal**.

---

## P0 — Discovery

### T0.1 — Inspect the project
- Critical · [x] · depends on: —
- Read every area listed in the roadmap §1 without changing code.
- Acceptance: has / missing / reuse / improve / do-not-touch recorded.

### T0.2 — Write the plan
- Critical · [x] · depends on: T0.1
- Files: `docs/upgrade/**`.
- Acceptance: every phase has a prompt, tasks, tests and acceptance criteria.

---

## P1 — Tool registry

### T1.1 — Metadata model
- Critical · [x] · depends on: T0.2
- Add to `AgentTool` an optional `meta`: category; default risk 0–4; risk per
  action for multi-action tools; approval (`none` / `policy` / `always`);
  reversible (`yes` / `partial` / `no`); external effect (`none` / `reads` /
  `writes`); output format and description. Registry helpers `getMeta(name)`
  and `riskOf(name, args)`.
- Files: `core/toolRegistryV2.ts`.
- Steps: 1) types; 2) helpers; 3) `riskOf` reads `actionRisk[args.action]`,
  falls back to the default risk.
- Tests: helpers return declared values; an unknown action returns the tool's
  highest action risk (never lower).
- Acceptance: `execute()` behaviour unchanged.

### T1.2 — Metadata for every existing tool
- Critical · [x] · depends on: T1.1
- One catalogue for the 33 built-in tools; skills may also declare `meta` in
  `description.json`, which wins. A tool with neither gets derived defaults and
  one startup warning.
- Files: `core/toolCatalog.ts` (new), `core/skillLoader.ts`, `core/toolRegistryV2.ts`.
- Steps: 1) catalogue entries (category, risks per action, approval,
  reversibility, external, output); 2) attach at registration; 3) skill loader
  reads `meta`.
- Tests: every registered tool has explicit metadata; every enum action of a
  multi-action tool has a risk.
- Acceptance: 100 % coverage, checked by a test that fails when a new tool
  forgets its metadata.

### T1.3 — Discovery API
- High · [x] · depends on: T1.2
- `describeCapabilities({ category?, maxRisk? })` grouped by category;
  `capabilitySummary()` — a few lines for the planner.
- Files: `core/toolRegistryV2.ts`.
- Tests: grouping, filters, summary lists each category present.
- Acceptance: the planner gets a group line under 400 characters (the full
  per-tool summary, 650 characters, is printed, not sent).

### T1.4 — `list_capabilities` and routes
- High · [x] · depends on: T1.3
- A level-0 tool returning the grouped list; the "what can you do" route answers
  from the registry with no LLM request; capability questions ("which tools do
  you have for files?") are offered `list_capabilities`.
- Files: `core/tools/capabilityTool.ts` (new), `core/tools/index.ts`,
  `core/orchestrator.ts`.
- Tests: route reply names real categories and makes zero LLM requests; the
  planner is offered the tool for capability questions only.
- Acceptance: existing router tests unchanged.

### T1.5 — Tests, suite, documents
- High · [x] · depends on: T1.1–T1.4
- Files: `tests/toolRegistryMetadataTest.ts`, `docs/upgrade/TOOL_REGISTRY.md`,
  status and checklist.
- Acceptance: new test fails on the old code; full suite no new failures; CI green.

---

## P2 — Risk engine

### T2.1 — Risk assessment
- Critical · [x] · depends on: T1.5
- `assessRisk({ tool, args, source })` → level 0–4, reasons, action, target.
- Files: `security/riskEngine.ts` (new).
- Tests: table of tool calls → expected level.

### T2.2 — Argument classifiers
- Critical · [x] · depends on: T2.1
- Commands through `permissionManager` (SAFE_READ_ONLY→0 … CRITICAL→4); file
  deletes → 3; writes outside temp → 2; service stop/restart → 3; process kill →
  3; open_app targets that need approval (cmd) → 3; anything the blocklist
  refuses → 4. A classifier may raise the level, never lower it — except three
  that set it from the arguments the way the controllers already do
  (run_command, temp `.txt` writes, YouTube/blank tab close); see
  PERMISSION_MODEL.md.
- Tests: each classifier, including injection strings.

### T2.3 — Policies
- Critical · [x] · depends on: T2.1
- 0–1 allow; 2 per `JARVIS_LEVEL2_POLICY` (`session`, default: needs full
  control mode as today · `ask`: approval each time); 3 approval, also in full
  control mode; 4 never automatic — approval (the typed code is T3.3), and
  denied outright where the blocklist denies today.
- Tests: every level × session × setting combination.

### T2.4 — Dispatch integration
- Critical · [x] · depends on: T2.2, T2.3
- `toolRegistryV2.execute` asks the engine after its existing checks; deny →
  refused with the reason; approve → existing approval gate, and the approved
  call runs inside an "approved" scope so a controller does not ask again.
- Files: `core/toolRegistryV2.ts`, `security/approvalGate.ts`.
- Tests: through the real registry and orchestrator; one prompt per call.

### T2.5 — Default session level, documents
- High · [x] · depends on: T2.4
- Default session level 1 (`JARVIS_DEFAULT_PERMISSION_LEVEL`, `0` restores the
  previous default), so level-1 actions (open, focus, navigate) run without
  full control mode, as the specification requires.
- Files: `control/permissionSession.ts`, `.env.example`, `docs/upgrade/PERMISSION_MODEL.md`.
- Tests: level-1 actions allowed by default; level-2 still refused without full control.


### T2.6 — explain_code reads any file
- Critical · [x] · depends on: T2.1
- Found in P1: `skills/coding/skill.ts` accepts any absolute path, so
  "explain C:\Users\…\.ssh\id_rsa" or the project's `.env` sends the file
  to the LLM. Apply read_file's containment (workspace root, system paths
  refused) in the skill itself, where every caller passes through it.
- Files: `skills/coding/skill.ts`.
- Tests: absolute path outside the project, `..` escape, `.env` → refused.

### T2.7 — Found in P2: fixed in the same phase
- Critical · [x] · depends on: T2.4
- Command Prompt injection: at the new default level, `control_app open`
  passed its target to `cmd /c start`, so "notepad&calc" started a second
  program. Targets with `& | ^ < > % "` are refused (`control/appController.ts`).
- The action queue retried an action the user had just refused, asking the
  same question twice. Refusals, cancellations and permission errors are no
  longer retried (`control/actionQueue.ts`).
- The developer allow-list called itself read-only git but accepted
  `git branch -D`, `git branch -m` and `git diff --output=<file>`
  (`tools/terminalTool.ts`).
- The command classes rated `rd /s /q C:\`, `Clear-Disk`, `bcdedit` and
  deleting restore points as HIGH_RISK, the same as `echo`; the risk engine
  makes them level 4 and refuses deleting a drive, a user profile or a Windows
  system folder.
- Tests: `riskEngineTest`, `actionQueueRecoveryTest`.

---

## P3 — Approval gate

### T3.1 — Approval request model
- Critical · [x] · depends on: T2.5
- id, action, why, target, expected effect, risk, reversibility, source,
  displayed-at, expires-at; built from the risk assessment and tool metadata.
- Files: `security/approvalRequest.ts` (new).

### T3.2 — Presentation
- Critical · [x] · depends on: T3.1
- Console block with the six fields and "Do you approve this action?"; a short
  spoken version.
- Files: `security/approvalGate.ts`.

### T3.3 — Answer rules
- Critical · [x] · depends on: T3.2
- Accept APPROVE / YES / CONFIRM only while that request is the displayed
  pending one and within its window; level 4 needs `APPROVE <code>` typed;
  anything else denies.
- Files: `security/approvalGate.ts`, `bridge/nodeBridge.ts`.
- Tests: answer before display, after expiry, for another request — all denied.

### T3.4 — Recording
- High · [x] · depends on: T3.3
- Decision on the task node, the goal and the security audit log, with the request id.
- Files: `core/taskGraphEngine.ts`, `core/orchestrator.ts`, `security/securityAuditLogger.ts`.

### T3.5 — Tests and documents
- High · [x] · depends on: T3.1–T3.4
- Files: `tests/approvalGateStructuredTest.ts`, `PERMISSION_MODEL.md`.

### T3.6 — Found in P3: fixed in the same phase
- Critical · [x] · depends on: T3.3
- An answer was also run as a command: the approval prompt and the command
  prompt both read the typed line; a spoken answer reached the command path
  too (where the echo filter happened to drop it). Answers are now consumed.
- Spoken answers were taken from the moment JARVIS began speaking, so its own
  "say confirm" could approve, and part of the 10 s went by while it spoke.
  The window now starts when it has finished.
- "proceed" and "do it" approved by voice; now approve, confirm or yes.
- The request's words and source stayed set after a request ended (endTrace
  was never called), so a later approval could show an old request as WHY.
- Files: `security/approvalGate.ts`, `jarvis.ts`, `core/orchestrator.ts`.

---

## P4 — Redaction and data minimisation

### T4.1 — Redactor
- Critical · [x] (built in P3, which needed it for approval requests) · depends on: T3.5
- Patterns for API keys (Google, OpenAI-style, Groq, GitHub, AWS, Slack), JWTs,
  bearer headers, cookies, private-key blocks, `password=` / `token=` pairs,
  connection strings with passwords, sensitive `.env` names.
- Files: `security/redactor.ts` (new).
- Tests: synthetic secrets of each shape are masked; ordinary text untouched.

### T4.2 — Apply at the sinks
- Critical · [x] · depends on: T4.1
- Tool results before the planner, synthesis and memory; conversation and
  episode memory; audit and tool logs.
- Files: `core/orchestrator.ts`, `memory/agentMemory.ts`, `memory/memoryManager.ts`,
  `security/securityAuditLogger.ts`, `core/toolExecutionSandbox.ts`.
- Tests: planted secrets absent from every LLM request, memory file and log.

### T4.3 — Memory policy
- High · [x] · depends on: T4.2
- Observations are not saved as long-term facts; `save_relation` refuses
  content that the redactor flags.

### T4.4 — Rate limits and external sends
- High · [x] · depends on: T4.2
- Calls per minute per tool by risk; tools with `external: writes` are at
  least level 2.

### T4.5 — Action history
- Normal · [x] · depends on: T4.2
- `action_history` (level 0): recent calls and approvals, redacted.

### T4.6 — Found in P4: fixed in the same phase
- High · [x] · depends on: T4.2
- The goal file (`data/runtime/goals.json`) stored each request's words as
  they were, so a token said or typed in a request stayed on disk.
- Text cut short before it was logged could leave half a key that no longer
  matched its pattern (tool audit argument summary, episode summaries): the
  audit redacts before cutting, and the redactor hides a cut-off key prefix.

---

## P5 — Observe → act → verify

### T5.1 — Verifier hook
- Critical · [x] · depends on: T1.5
- `verify(args, output)` on a tool; the registry runs it after success with a
  time limit; result `verified` / `failed` / `unverifiable` with evidence.
- Files: `core/toolRegistryV2.ts`.

### T5.2 — Failed check is a failure
- Critical · [x] · depends on: T5.1
- The executor fails the node with `VERIFICATION_FAILED: <evidence>`;
  reflection reports it honestly.
- Files: `core/orchestrator.ts`, `core/reflectionEngine.ts`.

### T5.3 — Verifiers for existing actions
- High · [x] · depends on: T5.1
- write_file (read back), control_file (exists / absent / contents),
  save_relation (memory finds it), ingest_documents (manifest).
- Files (as built): `core/verifiers.ts` — one table, a check or a reason per
  action tool; `core/tools/memoryTool.ts`.

### T5.4 — Replies and documents
- High · [x] · depends on: T5.2, T5.3
- Replies say when a result was checked.

### T5.5 — Found in P5: fixed in the same phase
- High · [x] · depends on: T5.3
- save_relation saved nothing with graph memory off (the default) and still
  said "Saved relation"; with it on, search_memory (which reads facts, not
  the graph) could not find it. The relation is now also a long-term fact.

---

## P6 — System and development observation

### T6.1 — System snapshot
- High · [x] · depends on: T4.5
- OS, CPU model/cores/usage, memory, uptime, disks, network interfaces (no MAC
  addresses) — Node APIs only, so the same code runs on Windows.
- Files: `perception/systemProbe.ts` (new).

### T6.2 — Ports and development servers
- High · [x] · depends on: T6.1
- Probe a configurable list of local ports; for open ones, an HTTP request for
  status, server header and page title.
- Files: `perception/devProbe.ts` (new).

### T6.3 — Git
- High · [x] · depends on: T6.1
- Repositories under configured roots; branch, ahead/behind, changes, last
  commits, diff summary — `git` with fixed arguments, no shell.
- Files: `perception/gitProbe.ts` (new).

### T6.4 — Tools and routes
- High · [x] · depends on: T6.1–T6.3
- `system_overview`, `dev_status`, `git_overview` (level 0); "is my backend
  running?" and "system status" answered from real observation (the current
  "status" reply says "All systems are operational" without checking anything).
- Files: `core/tools/observationTools.ts` (new), `core/orchestrator.ts`.

### T6.5 — Tests and documents
- High · [x] · depends on: T6.4
- Real server on a real port; real temporary git repository; injection refused.

---

## P7 — World state

### T7.1 — Model · Critical · [x] · depends on: T6.5
Sections system / browser / development / task, each with `observedAt` and source.
Files: `core/worldState.ts` (new).

### T7.2 — Refresh on demand · High · [x] · depends on: T7.1
`refresh(sections, maxAgeMs)` uses the probes; nothing polls.

### T7.3 — Task state · High · [x] · depends on: T7.1, T3.4
Goal, plan, current step, done, failed, pending approvals.
Found in P3: `runAgentLoop` always receives `goal = null` (the goal is created
in the background and not resolved yet), so a goal's planning/executing
status, plan summary and task-graph id are never recorded. Fix here.
(Done: the loop records status once the goal exists, and returns its failure
reason; process() alone completes or fails the goal, so a failure is still
counted once — passing the goal in naively would have counted it twice.)

### T7.4 — Planning summary · High · [x] · depends on: T7.2
Only sections relevant to the request; capped; redacted; marked as data.
Files: `core/orchestrator.ts`.

### T7.5 — Tests and documents · High · [x] · depends on: T7.1–T7.4
Stale refresh; size cap; long-term memory unchanged.

---

## P8 — Browser observation

### T8.1 — DevTools client · Critical · [x] · depends on: T7.5
WebSocket client on the existing `ws` package; command ids; time limits; fixed
in-page scripts only (no model-written JavaScript).
Files: `perception/cdpClient.ts` (new).
(Done, with two additions: the scripts run in an isolated world, so a page
that replaces built-ins cannot change them; only this PC's DevTools addresses
are accepted.)

### T8.2 — Browser state · High · [x] · depends on: T8.1
Version, windows, tabs, active (visible) tab, title, URL.
Files: `perception/browserState.ts` (new), `perception/chromeState.ts`.
(`chromeState.ts` now reads `JARVIS_CDP_PORT`; `get_browser_tabs` is unchanged.)

### T8.3 — Page reader · High · [x] · depends on: T8.1
Text (capped), headings, links, buttons, forms (labels, types; password values
never), tables (first rows), stable element references.
Found in P8: elements named like DOM properties (`<img name="title">`, an
input named `action`) shadow those properties; the scripts read through the
prototypes' getters.

### T8.4 — Tools · High · [x] · depends on: T8.2, T8.3
`browser_state`, `browser_read_page`, `browser_page_structure` (level 0); page
content wrapped as untrusted data.
Found in P8: the three P6 planner patterns in `core/orchestrator.ts` held a
backspace character where `\b` was meant, so the planner was never offered
`system_overview`, `dev_status` or `git_overview` from a request's words (the
direct "system status" and "is my backend running" routes use other patterns
and worked). Fixed, with planner checks in `tests/systemObservationTest.ts`.

### T8.5 — Tests and documents · High · [x] · depends on: T8.4
Real Chromium and a local test site.

---

## P9 — Browser control

### T9.1 — Navigation and tabs · High · [x] · depends on: T8.5, T5.4
navigate (http/https only), back, forward, reload, new, switch (level 1), close (level 2).
(Tabs through the DevTools HTTP endpoints — `/json/new` with PUT — rather than
`Target.*`: the same effect, no browser-level connection needed.)

### T9.2 — Element actions · High · [x] · depends on: T9.1
click, type, select, scroll by element reference; password fields refused.
(References are short ids kept by JARVIS — `perception/browserRefs.ts` — not
CSS paths the model could alter; the tools live in
`core/tools/browserActionTools.ts`, one file instead of nine skill folders.)

### T9.3 — Observe and verify · Critical · [x] · depends on: T9.2
Element present, visible and enabled before; URL, value or page change after.
(Also: same element and same page as when JARVIS looked, not covered; a page
dialog is reported, never answered.)

### T9.4 — Screenshot, download, upload · Normal · [x] · depends on: T9.3
Screenshot saved locally, not sent to the model by default; download verified
on disk; upload only from approved folders, level 3.

### T9.5 — Risk metadata · Critical · [x] · depends on: T9.1–T9.4
Per-action risk; form submission level 2.
(Plus label words: send/save/sign in 2, delete/remove 3, pay/buy/checkout 4.)
Found in P9: the per-minute limit counted every call of a tool against the
limit of the current call's level, so ten ordinary clicks made a payment
click "rate limited"; calls are now counted per level.

### T9.6 — Tests and documents · High · [x] · depends on: T9.5
Found in P9: `control_browser` open_url (GET answered 405, so the system
browser opened instead), close_current and refresh (a tab id looked up among
titles and URLs) did not work; refresh and close_current pressed keys into
whatever window had the keyboard. Repaired and checked in the browser.

---

## P10 — Files and development actions

### T10.1 — File tools · High · [x] · depends on: T9.6
list, search, compare, create, modify, rename, move, delete (to a JARVIS trash
for undo), inside approved folders.
Files: `tools/fsTools.ts` (new), `control/fileController.ts`.
(One tool, `files`, with an action argument; also restore, trash, empty_trash.)
Found in P10: `control_file` compared paths as text, so a link inside an
approved folder led outside it (it read `/etc/hostname` through a link in
temp). Containment now compares real paths in both.

### T10.2 — Git tools · High · [x] · depends on: T10.1
status/diff/branches/log (0), add/commit (2), switch branch (2), push (3; to
`main`/`master` 4); force push refused.
Files: `tools/gitTools.ts` (new).
(`git` and a separate `git_push`, whose metadata says it changes something
outside the PC. Commits refuse key files and credentials before staging.)

### T10.3 — Test, build, dev server · High · [x] · depends on: T10.1
Package scripts on an allowlist; start a dev server and verify its port; stop
only servers JARVIS started.
Files: `tools/devTools.ts` (new).

### T10.4 — Verifiers · Critical · [x] · depends on: T10.1–T10.3
(Each tool checks its own effect; the registry's verify step takes it.)

### T10.5 — Tests and documents · High · [x] · depends on: T10.4
Found in P10: `data/` was not git-ignored, so P9's browser screenshots
(`data/screenshots/`) could have been committed; it and the new trash are
ignored now.

---

## P11 — Error recovery

### T11.1 — Observe on failure · High · [x] · depends on: T10.5
Refresh the world-state sections the failed step touched.

### T11.2 — Repair candidates · High · [x] · depends on: T11.1
Known failures → repairs (server down → start, tab missing → open); otherwise replan.
Files: `core/recoveryPlanner.ts` (new), `core/orchestrator.ts`.
(Also: a port held by JARVIS's own old server → stop it; a server JARVIS
never ran, or a missing file → ask the user. Killing other processes is not
a repair: JARVIS asks instead.)

### T11.3 — Risk check for repairs · Critical · [x] · depends on: T11.2
Each repair step through the risk engine; risky → approval or report.

### T11.4 — Verify and report · High · [x] · depends on: T11.3
Bounded attempts; honest final message.

---

## P12 — Voice

### T12.1 — Spoken approval · Critical · [x] · depends on: T11.4
Short request (action, target, risk, reversibility); answer window; level 4 not by voice.
(Mostly built in P3; P12 ends the request on "cancel".)

### T12.2 — JARVIS cannot approve itself · Critical · [x] · depends on: T12.1
A heard answer matching JARVIS's own last speech is rejected.
Found in P12: only the request itself was guarded; an "approve" heard while
JARVIS said anything else during the window approved, and the echo of "Voice
cannot approve this one" denied a level-4 request. Anything heard while JARVIS
speaks, or 0.3 s after, is now ignored.

### T12.3 — Spoken summaries · Normal · [x] · depends on: T11.4
At most three sentences; details printed.
Found in P12: "what is open" and "what is open in chrome" read raw JSON aloud.

### T12.4 — Voice routes · Normal · [x] · depends on: T12.3
New observation questions by voice, same pipeline.

---

## P13 — Integration and scenarios

### T13.1 — Scenario harness · High · [x] · depends on: T12.4
Real Chromium, local servers, temporary git repository, scripted model, LLM-request counter.

### T13.2 — Scenarios · High · [x] · depends on: T13.1
Browser contents; backend running; application not working; continue previous
work; website not working; dangerous request.

### T13.3 — Fixes found by scenarios · High · [x] · depends on: T13.2

### T13.4 — Documents and quota table · Normal · [x] · depends on: T13.3

---

## P14 — Windows observation and control

### T14.1 — Windows observation · High · [ ] · depends on: T13.4
GPU, displays, audio devices, cameras/microphones, installed apps, services,
listening ports with owning process, process ↔ window, clipboard read (level 1, redacted).

### T14.2 — UI Automation · High · [ ] · depends on: T14.1
Elements of the active window; invoke; set value; focus.

### T14.3 — Screenshots and screen observation · Normal · [ ] · depends on: T14.1

### T14.4 — Clipboard write and dialogs · Normal · [ ] · depends on: T14.2

### T14.5 — Checks for window and app actions · Critical · [ ] · depends on: T14.2

### T14.6 — `pnpm verify:windows` · Critical · [ ] · depends on: T14.1–T14.5
Runs the real checks on the owner's PC and writes a report to send back.

---

## P15 — Final verification

### T15.1 — All test groups · Critical · [ ] · depends on: T14.6
### T15.2 — Security and performance review · Critical · [ ] · depends on: T15.1
### T15.3 — FINAL_JARVIS_IMPLEMENTATION_REPORT.md · High · [ ] · depends on: T15.2
