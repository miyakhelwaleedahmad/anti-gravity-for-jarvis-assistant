# Phase status

Updated after every phase. Checklist: [MASTER_PHASE_CHECKLIST.md](MASTER_PHASE_CHECKLIST.md).

## P0 — Discovery and architecture — COMPLETE

- **Implemented:** nothing in code (discovery phase). Documents in `docs/upgrade/`.
- **Tested:** baseline suite before any change: 92 files, 86 passed · 0 failed ·
  6 environment (Windows, Redis, Python venv, bridge token); CI mode 84 passed ·
  8 skipped. Commit `dc37503`.
- **Found:** see [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §1.
  Facts that shape the plan:
  - Session level 1 ("safe control") is defined but never granted: the level is
    0 or 2, so focus, open-URL and other level-1 actions are refused by default.
  - Voice approval accepts "yes", "proceed" and "do it" as well as "confirm".
  - The browser layer uses only the DevTools HTTP endpoints (list, open, close,
    activate); it cannot read a page.
  - Since Chrome 136, `--remote-debugging-port` is ignored for the default
    profile; a separate `--user-data-dir` is required
    ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)).
    JARVIS's existing instructions already use a separate profile.
  - `tools/browserTool.py` is a placeholder that returns fake text; it is not
    registered and nothing calls it.
  - The screen-capture service starts but nothing activates it.
  - Nothing redacts secrets from tool output.
- **Remaining:** P1–P15.
- **Next:** P1 — tool registry.

## P1 — Tool registry — COMPLETE

- **Implemented:**
  - Metadata on every tool (`core/toolRegistryV2.ts` types, `core/toolCatalog.ts`
    entries for all 34 tools): category, risk 0–4 with a risk per action for the
    nine multi-action tools, reversibility, external effect, expected effect,
    output. Skills may declare `meta` in `description.json`; a tool with neither
    gets derived defaults (never risk 0) and a warning.
  - Registry: `getMeta`, `riskOf` (unknown action → highest risk),
    `describeCapabilities` (grouped, filter by category or risk, approval need
    derived), `capabilitySummary`, `derivedMetaTools`.
  - `list_capabilities` tool (level 0).
  - "what can you do", "who are you", "list your tools" answered from the
    registry with no LLM request; capability questions are offered
    `list_capabilities`; each planning request carries a 196-character line
    naming the tool groups and their sizes.
- **Found and fixed:** "what can you do" never reached its fast route — "can
  you" is stripped as filler first, so it arrived as "what do" and went to the
  LLM, costing a request and answering with a fixed sentence.
- **Found, scheduled:** `explain_code` reads any absolute path (task T2.6, P2).
- **Tested:** `tests/toolRegistryMetadataTest.ts`, 36 checks, all pass; on the
  code before P1, 19 fail and 5 pass (the 5 are guards that held before).
  Full suite: 93 files, 87 passed · 0 failed · 6 environment.
- **Known limits:** metadata only describes; nothing is enforced from it until
  P2. Risk values are judgement calls recorded in the catalogue, reviewable in
  one file.
- **Next:** P2 — risk engine.

## P2 — Risk engine — COMPLETE

- **Implemented:**
  - `security/riskEngine.ts`: `assessRisk` gives one call a level 0–4, the
    reasons, and a refusal where a rule forbids it; `decide` turns that into
    run, ask or refuse from the session level, `JARVIS_LEVEL2_POLICY` and the
    tool's floor (table in [PERMISSION_MODEL.md](PERMISSION_MODEL.md)).
  - Registry: runs it after the floor and argument checks. A refusal returns
    `RISK_REFUSED` (a rule) or `PERMISSION_DENIED` (needs full control mode);
    a risk check that throws refuses the call.
  - `security/approvalScope.ts`: an approved call carries the approval to the
    controller it reaches, which no longer asks a second time. A call running
    at the same time, or queued behind it, does not see it.
  - Default session level 1; `JARVIS_DEFAULT_PERMISSION_LEVEL=0` restores the
    previous default. `JARVIS_LEVEL2_POLICY=ask` asks to approve each action
    instead of requiring full control mode. Both in `.env.example`.
  - Replies: a declined approval is "Cancelled, sir. You did not approve it,
    so nothing was done."; a refusal gives its reason.
  - Catalogue aligned with the controllers' own checks: window move and
    resize 2, Settings page 2, restarting JARVIS 3.
- **Found and fixed:**
  - `explain_code` read any file on the PC and sent it to the LLM (found in
    P1): now the JARVIS folder only, `.env` refused.
  - Command Prompt injection: with level 1 granted, `control_app open
    "notepad&calc"` would also have started calc, and so would a URL with `&`
    in control_browser's fallback. Such targets are refused.
  - The action queue retried an action the user had refused, so the question
    was asked twice. Refusals and cancellations are no longer retried.
  - The developer allow-list ("read-only git") accepted `git branch -D`,
    `git branch -m` and `git diff --output=<file>`.
  - The command classes rated `rd /s /q C:\`, `Clear-Disk`, `bcdedit` and
    deleting restore points HIGH_RISK, like `echo`. They are level 4 now, and
    deleting a drive, a user profile or a Windows system folder is refused.
  - An open_app dry run asked for approval although it opens nothing.
- **Behaviour changes (intended):**
  - Focus, minimise, maximise and control_app open/focus run without full
    control mode.
  - `write_file` needs full control mode (level 2, "modify project files");
    before, it ran at level 0 with no level check.
  - Restarting JARVIS through control_system needs full control mode and an
    approval; before, the approval alone.
- **Tested:**
  - `tests/riskEngineTest.ts`: 127 checks, all pass — levels of 35 calls, 35
    shell commands, decisions for 20 calls at session 0/1/2 under both
    policies, the real registry and orchestrator, real file writes, approval
    isolation. On the code before P2: 18 of 26 runnable checks fail (the
    engine sections need the new module).
  - `tests/actionQueueRecoveryTest.ts`: new section, 5 checks; 4 fail on the
    old queue.
  - Changed tests: `permissionSessionTest` and `dispatchAuthzTest` (default
    level 1); `registryRepairHonestyTest` and `taskFailureHonestyTest` — their
    helper that takes permissions out of a check now sets the tool's risk as
    well as its floor; two checks they skipped at the new default level run
    again.
  - Security tests unchanged and passing: runCommandSafety 11,
    securityGateUnit 36, dangerousCommandMatch 23, openAppSecurity 15,
    fileControlSafety 10, adminControl 30.
  - Full suite: 94 files, 88 passed · 0 failed · 6 environment; CI mode
    86 passed · 8 skipped.
- **Not verified here:** approval prompts on a real console and by voice
  (P3 replaces the presentation); the Windows controllers (P14).
- **Known limits:**
  - Level 4 is asked with the same YES as level 3 until P3 adds the typed code.
  - The critical-command patterns are a list, not a proof: a destructive
    command missing from it stays level 3 (full control mode and an approval
    every time).
  - control_browser refresh presses Ctrl+R, which needs level 2, so it fails
    at level 1 (P9 replaces it).
  - URLs with `&` or `%` open through Chrome's DevTools endpoint only; the
    `cmd /c start` fallback refuses them.
  - `git show HEAD:<file>` prints any tracked file; secrets in tool output are
    P4's subject.
- **Next:** P3 — approval gate.

## P3 — Approval gate — COMPLETE

- **Implemented:**
  - `security/approvalRequest.ts`: the request (ACTION, WHY, TARGET, EXPECTED
    EFFECT, RISK, REVERSIBILITY, id, level-4 code), its console block, its
    spoken version, and the answer rules.
  - `security/approvalGate.ts`: one request displayed at a time; typed answers
    through the CLI loop (`offerConsoleAnswer`), spoken ones through the speech
    handler (`offerVoiceAnswer`), both consumed so they do not run as commands;
    the voice window starts when JARVIS has finished speaking; level 4 only
    with the typed code. The older `requestApproval(action, command, …)` calls
    build a request the same way, and ask by voice when the request was spoken.
  - Decisions on the task step (`core/taskContext.ts` gives the gate the node
    it runs for), on the goal and in the audit log; the last 50 in memory.
  - Registry: builds the request from the tool's metadata and the user's words
    (the trace now carries them, and is ended when the request ends).
  - `security/redactor.ts` (P4's first task, needed here): every field is
    redacted before it is shown or logged.
- **Found and fixed:**
  - An answer was also run as a command: the approval prompt and the command
    prompt each read the typed line (found by reading the code; reproducing it
    needs a real terminal). A spoken answer also went down the command path,
    where the echo filter happened to drop it.
  - The voice window began when JARVIS started speaking: its own "say confirm"
    could approve, and the user had about half the 10 s left.
  - "proceed" and "do it" approved by voice.
  - The trace (request text and source) was never ended.
- **Found, scheduled:** `runAgentLoop` always gets `goal = null`, so goal
  status, plan summary and graph id are never stored (T7.3).
- **Tested:**
  - `tests/approvalGateStructuredTest.ts`: 60 checks, all pass — the six
    fields; 7 typed answers; an answer before display; spoken answers before,
    during and after the window, JARVIS's own words, another reply still
    playing, an unrelated sentence, "yes" with nothing pending; level 4 (code,
    wrong code, voice refused); one request at a time; recording through the
    orchestrator on the step, goal and audit log; redaction; older callers.
    On the code before P3: 11 of 12 runnable checks fail.
  - `tests/redactionTest.ts`: 29 checks, all pass (18 kinds, private-key block,
    plain text unchanged); before P3 the module did not exist.
  - Full suite: 96 files, 90 passed · 0 failed · 6 environment.
- **Not verified here:** a real microphone and speaker (timings simulated:
  speaking start/end as the TTS client reports them); a real Windows console.
  The wiring in `jarvis.ts` (CLI loop and speech handler) is not covered by an
  automated test — it needs the whole app running (P12 voice phase).
- **Known limits:** spoken answers depend on the TTS client reporting
  speaking start and end; without a speaker connected, listening starts 2 s
  after the request. From 0.3 s after JARVIS stops speaking, what the
  microphone hears is taken as the user's; a longer echo is not detected.
- **Next:** P4 — redaction at the sinks, memory policy, rate limits, action history.

## P4 — Redaction — COMPLETE

- **Implemented:**
  - Redaction at every sink (table in [SECURITY_MODEL.md](SECURITY_MODEL.md)):
    each tool result in the registry, each message to the LLM in the model
    router, the call history, conversation memory, long-term facts, episodes,
    the goal file, the four log writers and JARVIS's speech-to-text log.
  - `save_relation` refuses a credential; facts are stored with it replaced.
  - Rate limits per tool per minute by the call's risk (120/60/20/10/10,
    `JARVIS_TOOL_RATE_LIMITS`); over the limit: refused before any approval,
    not retried, "I've done that too many times in the last minute, sir."
  - Tools with `external: change` are at least risk 2.
  - `action_history` (level 0): the last calls and approval decisions,
    redacted; offered to the planner for "what did you just do?".
  - The redactor (from P3) also: JSON stays valid, "my password is …", a key
    cut short, whole objects (`redactDeep`), fail closed.
- **Found and fixed:**
  - The goal file stored each request's words as given, a token included.
  - Text cut short before it was logged could leave half a key that no longer
    matched (the tool audit's argument summary, episode summaries).
- **Found, scheduled:** when graph memory is off (the default),
  `save_relation` saves nothing and still says "Saved relation" — a silent
  no-op, the subject of P5.
- **Tested:**
  - `tests/secretSinksTest.ts`: 23 checks, all pass — five synthetic secrets
    planted in a tool's output and in the user's own words, through the real
    registry, orchestrator and model router (a fake provider records every
    request): none in any LLM request or in any of the 7 files written; memory,
    episodes, goals and logs keep their entries without them; save_relation;
    rate limit with an honest reply and no retry; the external-change floor;
    action_history. On the code before P4: 16 of 23 fail.
  - `tests/redactionTest.ts`: 38 checks (P3's 29 plus JSON, said-aloud,
    cut-short, objects, depth).
  - Full suite: 97 files, 91 passed · 0 failed · 6 environment — no ordinary
    tool output broken by redaction.
- **Known limits:** a password with no label cannot be recognised; the Python
  speech service's own transcript log is not redacted; documents ingested for
  search are stored as they are (only what reaches the LLM from them is
  redacted); the limits count per process (a restart starts them again).
- **Next:** P5 — observe → act → verify.

## P5 — Observe → act → verify — COMPLETE

- **Implemented:**
  - `core/verifiers.ts`: for every action tool, a check of its real effect or
    the reason there is none (Windows actions: P14; browser: P8; commands:
    their effect cannot be checked in general). Checks only read, and only
    what the action touched.
  - Registry: after a reported success the check runs, cut off at 5 s. A
    failed check makes the call a failure (`VERIFICATION_FAILED`, with what
    was found); a check that throws or runs out of time makes no claim.
  - Replies: "I checked: todo.txt holds the 8 characters written." when the
    check passed; "I tried, sir, but I could not confirm it worked:
    ghost.txt is not there." when it failed. A failed check is not retried.
  - Checks: write_file and control_file write (read back), copy, move/rename,
    create_folder, delete/delete_folder; save_relation (in long-term memory);
    ingest_documents (the index lists it); full control on/off.
- **Found and fixed:** with graph memory off (the default) save_relation saved
  nothing and said "Saved relation"; with it on, search_memory could not find
  it (it reads facts, not the graph). The relation is now also a fact.
- **Tested:** `tests/verifyAfterActTest.ts`, 23 checks, all pass — real files
  in a throwaway folder; a write that reports success without writing and one
  that writes something else; a delete that deletes nothing; a check that
  throws and one that hangs (cut off at 5 s); save_relation recalled by
  search_memory; ingest checked against the real index; every action tool has
  a check or a reason. On the code before P5: 18 of 21 fail. Full suite: 98
  files, 92 passed · 0 failed · 6 environment.
- **Not verified here:** checks of Windows actions (window closed, app open) —
  they need the PC (P14).
- **Known limits:** a check proves the effect was there when it ran, not that
  it lasts; a file written again by something else in the same moment could
  pass or fail the check by chance.
- **Next:** P6 — system and development observation.

## P6 — System and development observation — COMPLETE

- **Implemented:**
  - `perception/systemProbe.ts`, `devProbe.ts`, `gitProbe.ts` and the level-0
    tools `system_overview`, `dev_status`, `git_overview`
    ([SYSTEM_AWARENESS.md](SYSTEM_AWARENESS.md)). Node APIs and `git` only —
    the same code on Windows and Linux; no shell; no MAC address, no host name.
  - Routes, with no LLM request: "status", "system status", "how is my PC
    doing" → "CPU at 3 percent, 15 of 15.7 GB memory free, 29 GB free on the
    system disk, sir."; "is my backend running", "what servers are running" →
    "One local server is running, sir: port 3000 answers 200."
  - The planner is offered these tools for questions about CPU, memory, disks,
    ports, servers and git.
  - `JARVIS_DEV_PORTS`, `JARVIS_PROJECT_DIRS` in `.env.example`.
- **Found and fixed:** "status" answered "All systems are operational, sir."
  without looking at anything; "is my backend running" went to the LLM, which
  had no way to know and answered "Done, sir.".
- **Tested:** `tests/systemObservationTest.ts`, 28 checks, all pass — values
  against the OS's own readings; a real HTTP server on a real port (status,
  server, title kept as untrusted data), a closed port, a port that never
  answers, a redirect reported and not followed, one request per server; a
  database port only connected to; a real git repository (branch, changed and
  untracked files, last commit with a planted token redacted, diff summary); a
  folder named `$(touch pwned)` stays a name; a planted `core.fsmonitor`
  program that a plain `git status` ran did not run from the probe; `;` and
  outside paths refused; both routes with 0 LLM requests. On the code before
  P6: 23 of 27 fail. Full suite: 99 files, 93 passed · 0 failed · 6 environment.
- **Not verified here:** drive letters and `statfs` on Windows (the Windows
  branch of `driveRoots` runs only there — P14 check list).
- **Known limits:** a server on a port outside the list is not seen (add it to
  `JARVIS_DEV_PORTS`); which process owns a port is Windows work (P14).
- **Next:** P7 — world state.

## P7 — World state — COMPLETE

- **Implemented:**
  - `core/worldState.ts`: system, apps, browser, development and task parts,
    each with the time it was observed and its source. Stale parts are read
    again when a request needs them (5 min / 30 s / 30 s / 60 s); callers at
    the same time share one read; nothing new polls — the background observer
    hands in its window and Chrome readings.
  - Planning: the parts the request is about, at most 600 characters,
    redacted, angle brackets removed, as user-role data inside
    `<untrusted_context source="world-state">`; read again first for at most
    1.5 s.
  - Task part: goal and plan when execution starts, the current step, done
    and failed steps from the graph's events, the approval request on display.
  - Goals (T7.3): status, plan summary and graph id are now recorded; the
    loop returns its own failure reason; a failure is still counted once.
- **Found and fixed:** goals never got their planning/executing status, plan
  summary or graph id, and failed with a generic reason ("agent loop ended
  without success") — the loop always received an empty goal. Giving it the
  goal as it was would have counted each failure twice (the loop's own
  failGoal calls plus process()); the loop now reports, process() decides.
- **Tested:** `tests/worldStateTest.ts`, 20 checks, all pass — one read for a
  fresh part and one for three concurrent callers of a stale part; an older
  reading never replaces a newer one; the planning request for a backend
  question carries the development part and not the browser part; a summary
  of every part capped at 600 characters; a planted key redacted; a page
  title holding `</untrusted_context>` cannot close the wrapper; no world state
  for a request about none of it; current step, done step and the approval on
  display; memory file and facts unchanged by observations; the observer feeds
  the browser part; goal plan summary, graph id, one failure with the loop's
  reason. On the code before P7: the module does not exist, and 3 of the 4
  goal checks fail. Full suite: 100 files, 94 passed · 0 failed · 6 environment.
- **Not verified here:** the apps part on Windows (window titles come from the
  PowerShell session, P14).
- **Known limits:** sections are chosen by keywords; a request phrased without
  them gets no world state (the planner can still call the tools).
- **Next:** P8 — browser observation (real Chromium here).

