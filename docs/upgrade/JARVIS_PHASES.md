# JARVIS phases

Order, reasons and verification policy: [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md).
Tasks in detail: [MASTER_TASKS.md](MASTER_TASKS.md). Status: [MASTER_PHASE_CHECKLIST.md](MASTER_PHASE_CHECKLIST.md).

Every phase has the same completion gate:

> Implementation exists and is wired into JARVIS · tests exist and pass ·
> the functionality works when exercised for real · the existing suite still
> passes (no new failures) · security requirements hold · acceptance criteria
> met · documents updated · checklist complete. Any "no" → the phase stays open.

"Here" means verified in the Linux container with real components; "Windows"
means it needs the owner's PC (see the roadmap, §4).

---

## P0 — Discovery and architecture

- **Objective:** know what exists before changing anything.
- **Why:** the request is to extend JARVIS, not rewrite it.
- **Dependencies:** none.
- **Tasks:** T0.1 inspect the project; T0.2 write these documents.
- **Files affected:** `docs/upgrade/**` only.
- **Prompt:** none (this document set is its output).
- **Test plan:** none; the suite is run to record the baseline (86 · 0 · 6).
- **Acceptance:** what exists / is missing / is reused / must improve / is not
  touched is written down (roadmap §1); every later phase has a prompt.

## P1 — Tool registry: metadata and capability discovery

- **Objective:** every tool carries category, risk 0–4 per action, approval
  need, reversibility, external effect and an output description; JARVIS can
  list what it can do.
- **Why:** the risk engine (P2) and the planner need this; today JARVIS cannot
  answer "what can you do?" from facts.
- **Dependencies:** P0.
- **Tasks:** T1.1–T1.5.
- **Files affected:** `core/toolRegistryV2.ts`, `core/skillLoader.ts`,
  `core/toolCatalog.ts` (new), `core/tools/capabilityTool.ts` (new),
  `core/tools/index.ts`, `core/orchestrator.ts`, tests, docs.
- **Prompt:** [phase-01-tool-registry.md](phases/phase-01-tool-registry.md)
- **Test plan:** unit — metadata complete for every registered tool, per-action
  risk lookup, capability summary; integration — "what can you do" answered
  from the registry with no LLM request; "which tools do you have for files"
  offers `list_capabilities`; existing suite.
- **Acceptance (here):** 100 % of registered tools have explicit metadata;
  `list_capabilities` returns every tool grouped by category with its risk;
  tool behaviour and results unchanged.

## P2 — Permission and risk engine

- **Objective:** one decision — allow, ask, or deny — for each concrete call,
  from the tool's metadata, its arguments, the session and the settings.
- **Why:** risk depends on arguments ("focus" vs "close", `git status` vs
  `git push`), and three separate risk notions exist today.
- **Dependencies:** P1.
- **Tasks:** T2.1–T2.5.
- **Files affected:** `security/riskEngine.ts` (new), `core/toolRegistryV2.ts`,
  `control/permissionSession.ts` (default level setting), `.env.example`, tests, docs.
- **Prompt:** [phase-02-risk-engine.md](phases/phase-02-risk-engine.md)
- **Test plan:** table of calls → expected level and decision; dispatch through
  the real registry; every existing permission and injection test still passes.
- **Acceptance (here):** level 0–1 calls run without approval; level 2 follows
  the configured policy (default: needs full control mode, as today); level 3
  needs approval even in full control mode; level 4 never runs automatically;
  everything the blocklist and containment refuse today is still refused.

## P3 — Human approval gate

- **Objective:** a pending action is shown as ACTION / WHY / TARGET / EXPECTED
  EFFECT / RISK / REVERSIBILITY with "Do you approve this action?", and only an
  explicit answer to that request approves it.
- **Why:** today a bare "yes" heard by voice approves, and approvals are not
  tied to one action or recorded with the task.
- **Dependencies:** P2.
- **Tasks:** T3.1–T3.5.
- **Files affected:** `security/approvalGate.ts`, `security/approvalRequest.ts`
  (new), `core/toolRegistryV2.ts`, `core/taskGraphEngine.ts` (record on the node),
  `control/*` (no second prompt for an approved call), tests, docs.
- **Prompt:** [phase-03-approval-gate.md](phases/phase-03-approval-gate.md)
- **Test plan:** simulated console and voice answers; "yes" with no request
  shown is rejected; timeout denies; level 4 needs the typed code; decision is
  on the task node and in the audit log; an approved call is not asked twice.
- **Acceptance (here):** all of the above, through the real orchestrator.

## P4 — Secret redaction and data minimisation

- **Objective:** credentials never reach the LLM, memory or logs; observations
  are not stored long-term by default; per-tool rate limits; external sends
  controlled; action history queryable.
- **Why:** the next phases read pages, files and system data that can contain
  keys and passwords.
- **Dependencies:** P1 (metadata `external`), P2.
- **Tasks:** T4.1–T4.5.
- **Files affected:** `security/redactor.ts` (new), `core/toolRegistryV2.ts`,
  `core/orchestrator.ts`, `memory/agentMemory.ts`, `memory/memoryManager.ts`,
  `security/securityAuditLogger.ts`, `core/toolExecutionSandbox.ts`, tests, docs.
- **Prompt:** [phase-04-redaction.md](phases/phase-04-redaction.md)
- **Test plan:** planted secrets in tool output must not appear in any LLM
  request, memory file or log; rate limit trips; history tool output redacted.
- **Acceptance (here):** zero planted secrets leak across all three sinks.

## P5 — Observe → act → verify

- **Objective:** after an action reports success, JARVIS checks the result
  (file contents, tab present, process up, port open) before calling it done.
- **Why:** success today means only "the tool reported no error".
- **Dependencies:** P1.
- **Tasks:** T5.1–T5.4.
- **Files affected:** `core/toolRegistryV2.ts` (verifier hook),
  `core/orchestrator.ts`, `core/reflectionEngine.ts`, `tools/fileTool.ts`,
  `skills/control_file/*`, `core/tools/memoryTool.ts`, tests, docs.
- **Prompt:** [phase-05-verify.md](phases/phase-05-verify.md)
- **Test plan:** real file writes verified; a write that silently did not
  happen is caught and reported; replies say "checked".
- **Acceptance (here):** every non-Windows action tool has a verifier or a
  recorded reason why none is possible.

## P6 — System and development observation

- **Objective:** on-demand facts about the machine and the developer's work:
  OS, CPU, memory, disks, network, listening development ports, development
  servers, git repositories and their status.
- **Why:** "Is my backend running?" must be answered by looking, not guessing.
- **Dependencies:** P1, P4.
- **Tasks:** T6.1–T6.5.
- **Files affected:** `perception/systemProbe.ts`, `perception/devProbe.ts`,
  `perception/gitProbe.ts` (new), `core/tools/observationTools.ts` (new),
  `core/orchestrator.ts` (routes), tests, docs.
- **Prompt:** [phase-06-system-observation.md](phases/phase-06-system-observation.md)
- **Test plan:** values match Node's own readings; a server started by the test
  is found on its port; a real temporary git repository's changes are reported;
  path and argument injection refused.
- **Acceptance (here):** all observation tools level 0, on demand, redacted.
  (GPU, displays, audio devices, installed apps, services: P14.)

## P7 — World-state model

- **Objective:** one structured, timestamped picture — system, browser,
  development, task (goal, plan, current step, done, failed, pending approvals) —
  refreshed when stale, summarised for planning, never stored as memory.
- **Why:** observations are scattered today and some are minutes old.
- **Dependencies:** P3, P6.
- **Tasks:** T7.1–T7.5.
- **Files affected:** `core/worldState.ts` (new), `core/orchestrator.ts`
  (planning context), `perception/systemStateObserver.ts` (feeds it), tests, docs.
- **Prompt:** [phase-07-world-state.md](phases/phase-07-world-state.md)
- **Test plan:** stale sections refresh; summary size-capped and redacted;
  long-term memory unchanged after observation.
- **Acceptance (here):** planner receives the relevant world summary; no
  observation is written to long-term memory.

## P8 — Browser observation

- **Objective:** browser, tabs, active tab, title, URL, readable page text,
  structure (headings, links, buttons, forms, tables) through the DevTools
  protocol, read-only.
- **Why:** "What is open in my browser?" and every browser action need it.
- **Dependencies:** P4, P7.
- **Tasks:** T8.1–T8.5.
- **Files affected:** `perception/cdpClient.ts`, `perception/browserState.ts`
  (new), `perception/chromeState.ts`, observation tools, tests, docs.
- **Prompt:** [phase-08-browser-observation.md](phases/phase-08-browser-observation.md)
- **Test plan:** a real Chromium with a local test site: tabs, active tab, text,
  forms, links, tables read correctly; password field values never returned;
  page text arrives as untrusted data.
- **Acceptance (here):** all of the above against real Chromium. (The owner's
  Chrome needs the separate debugging profile — Chrome 136+ — checked in P14.)

## P9 — Browser control

- **Objective:** navigate, back, forward, reload, open/close/switch tab, click,
  type, select, scroll, screenshot, download, upload — by element, observed
  before and verified after.
- **Why:** browser tasks without blind clicking.
- **Dependencies:** P2, P3, P5, P8.
- **Tasks:** T9.1–T9.6.
- **Files affected:** `control/browserAgent.ts` (new), `control/browserController.ts`,
  `skills/browser_*` (new skills), tests, docs.
- **Prompt:** [phase-09-browser-control.md](phases/phase-09-browser-control.md)
- **Test plan:** real Chromium: each action changes the page as intended and the
  check confirms it; a click on a missing element is refused, not guessed;
  form submission and upload ask for approval per policy.
- **Acceptance (here):** every action verified against the real page.

## P10 — Files and development actions

- **Objective:** list, search, compare, create, modify, rename, move, delete;
  git status/diff/branches/log/commit/push; run tests, builds, dev servers —
  as structured tools with risk levels and checks.
- **Why:** today most of this needs free-text shell commands.
- **Dependencies:** P2, P3, P5, P6.
- **Tasks:** T10.1–T10.5.
- **Files affected:** `tools/fsTools.ts`, `tools/gitTools.ts`, `tools/devTools.ts`
  (new), `control/fileController.ts`, `core/tools/index.ts`, tests, docs.
- **Prompt:** [phase-10-files-and-dev.md](phases/phase-10-files-and-dev.md)
- **Test plan:** real temp folders, a real git repository, a real npm script and
  a real server: results correct, checks pass, risky operations stop for approval,
  paths outside approved folders refused.
- **Acceptance (here):** all of the above; no free-text command needed for them.

## P11 — Permission-aware error recovery

- **Objective:** on failure: observe, diagnose, plan a repair, check its risk,
  repair if safe, verify; stop and ask when the repair is risky.
- **Why:** repairs run today without a risk check of their own.
- **Dependencies:** P2, P3, P5, P7.
- **Tasks:** T11.1–T11.4.
- **Files affected:** `core/reflectionEngine.ts`, `core/orchestrator.ts`
  (repair phase), `core/recoveryPlanner.ts` (new), tests, docs.
- **Prompt:** [phase-11-error-recovery.md](phases/phase-11-error-recovery.md)
- **Test plan:** a stopped dev server is restarted and the port verified; a
  repair needing a process kill asks first and does nothing when refused.
- **Acceptance (here):** every repair step passes through the risk engine.

## P12 — Voice integration

- **Objective:** spoken approval requests and answers, short spoken summaries
  of observations, the new capabilities reachable by voice through the same
  pipeline as text.
- **Why:** the voice path must not bypass or weaken the new checks.
- **Dependencies:** P3, P6–P11.
- **Tasks:** T12.1–T12.4.
- **Files affected:** `security/approvalGate.ts`, `bridge/nodeBridge.ts`
  (confirmation words), `core/orchestrator.ts`, tests, docs.
- **Prompt:** [phase-12-voice.md](phases/phase-12-voice.md)
- **Test plan:** simulated speech through the real voice handlers; JARVIS's own
  spoken words cannot approve; same decisions as the text path.
- **Acceptance (here):** voice and text give identical decisions. (Microphone
  and speakers: P14 pack.)

## P13 — Integration and scenarios

- **Objective:** the end-to-end requests from the specification work.
- **Why:** each phase is tested alone; the user experiences them together.
- **Dependencies:** P1–P12.
- **Tasks:** T13.1–T13.4.
- **Files affected:** `tests/scenarios/*` (new), fixes where scenarios fail, docs.
- **Prompt:** [phase-13-integration.md](phases/phase-13-integration.md)
- **Test plan:** "what is open in my browser?", "is my backend running?", "why
  isn't my app working?", "continue what I was doing", "check why my website
  isn't working", and a dangerous request — with real Chromium, real servers, a
  real repository and a scripted model; LLM requests counted per scenario.
- **Acceptance (here):** every scenario passes; request counts recorded.

## P14 — Windows observation and control

- **Objective:** GPU, displays, audio devices, cameras and microphones,
  installed apps, services, process ↔ window ↔ port mapping, clipboard, UI
  Automation (structured clicks and values), screenshots, dialogs, checks for
  window and app actions; `pnpm verify:windows`.
- **Why:** these exist only on Windows.
- **Dependencies:** P1–P13.
- **Tasks:** T14.1–T14.6.
- **Files affected:** `perception/windowsProbe.ts`, `control/uiAutomation.ts`,
  `control/uia.ps1` (new), `control/windowController.ts`, `scripts/verifyWindows.ts`
  (new), tests, docs.
- **Prompt:** [phase-14-windows.md](phases/phase-14-windows.md)
- **Test plan:** unit tests with recorded PowerShell output here; real checks
  only on Windows through `pnpm verify:windows`.
- **Acceptance (Windows):** the verification report from the owner's PC shows
  every check passing. Until then: `[!] BLOCKED`.

## P15 — Final verification

- **Objective:** prove the whole system: unit, integration, end-to-end,
  browser, Windows, permission, security, failure/recovery, regression,
  performance; write `FINAL_JARVIS_IMPLEMENTATION_REPORT.md`.
- **Dependencies:** P1–P14.
- **Tasks:** T15.1–T15.3.
- **Prompt:** [phase-15-final-verification.md](phases/phase-15-final-verification.md)
- **Acceptance:** every result recorded as measured; failures and blocked
  items listed, none hidden.
