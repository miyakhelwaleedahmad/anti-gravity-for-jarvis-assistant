# Review — diagnostics (phase A6)

Reviewer: a separate agent session (general-purpose), read-only. Not a human.

## Round 1 — CHANGES REQUIRED (small)

The reviewer ran:
- the new test: 19/19;
- the typecheck: `TC=0`;
- probes of redaction at the 160-character cut, of an action inside a background agent, and of Linux Chrome after `stop()`.

Confirmed:
- **Redaction.** A key or password split by the cut is still redacted; at most a bare prefix such as `ghp_...` is left.
- **Kernel log calls.** Only the two kernel log calls exist, and both are changed.
- **The registry.** It emits after the check, with the fallback tool's name, the evidence redacted, and errors in a listener caught; nothing else changed.
- **Trace wiring.** It is idempotent, and its unawaited action-log write cannot reject; the action line comes before its check line.
- **Chrome.** `taskkill /PID n /T /F` is the right Windows command.
- **Tests.** The stand-ins have no platform branches, and each test runs in its own process.
- **Records.** The counts match the evidence.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| F1 | med | Inside a background agent, a line had the agent's words with the foreground request's trace id; a check ending after the next request began takes that request's id | **Fixed** for the agent: its words and `agentPath`, no foreground trace id. The late check is recorded. Tests first; M15 |
| F2 | low–med | `verified: "pending"` on every success, also on reads that are never checked; the records claimed more | **Fixed**: only on a change; the records say no `verification` line means not checked. M16 |
| F3 | low | Test gaps: `stop()` not tested; the failure line's fields; no kernel action plus check end to end | **Fixed** in part: `endChrome` (exported, platform and runner stood in for), the failure line, and an end-to-end case through `control_app`. `stop()` itself is recorded. M19, M20 |
| F4 | low | The TRA-15 cause stated as fact; `jarvisChromeTest`'s real Chrome ended with `kill()`; the runner's SIGKILL | **Fixed**: "likely" in the diagnosis, and `jarvisChromeTest` uses `endChrome`. The runner is recorded |
| F5 | low | Chrome already exited: taskkill cannot reach its children | Recorded |
| F6 | low | `allowed: false` on every failure; `normalizedIntent` still the action name | **Fixed** for `allowed` (and "Permission denied." is now `blocked`; the case-sensitive check is gone). `normalizedIntent` is recorded. M17, M18 |
| F7 | info | The Linux probe had no evidence file | **Fixed**: `evidence/a6_linux_chrome_probe.txt` and `.mts` |
| F8 | info | The trace wiring's header did not mention `verification` entries or their evidence | **Fixed** |
| F9 | info | `secretSinksTest` still passes `confirmationRequired: false` | Recorded |

## Round 2 — CHANGES REQUIRED (small)

The reviewer ran the test (29/29), the typecheck (`TC=0`) and a probe of an agent calling a registry tool, of failure wordings, and of `endChrome` after Chrome exited. All nine round-1 outcomes were confirmed as recorded, and the evidence counts matched.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| F10 | med | An agent's `verification` line still had the foreground request's trace id, so it could not be joined to the agent's action line | **Fixed** in the action log: `agentPath`, no foreground `traceId`. The trace entry's data names the agent (see F16). Tests first (through the registry inside `runAsAgent`); M21, M22 |
| F11 | med | `/cancelled\|denied/i` made OS refusals ("EACCES: permission denied", "Access is denied.") `blocked`, and JARVIS's "Permission Level 2 required" an allowed `failure`; the change log described the rule wrongly | **Fixed**: `isPermissionDenial()` or a cancel, "not approved", or "Access Denied: Path". Change log corrected. M23–M27 |
| F12 | med | `endChrome` ran `taskkill /T /F` after Chrome had exited, when Windows may have given the id to another program | **Fixed**: taskkill only while `exitCode` and `signalCode` are both unset. M28, M29 |
| F13 | low | The `treeKillCommand` comment stated the Windows cause as fact | **Fixed**: "likely" |
| F14 | info | No foreground work found running as an agent; a callback fired from agent code would carry agent scope | Recorded under known limits |

## Round 3 — CHANGES REQUIRED (small)

The reviewer ran the test (37/37), the typecheck (`TC=0`) and a probe of the blocked rule on every refusal wording thrown in `control/*.ts`. F10, F12, F13 and F14 were confirmed; F11 was confirmed for its target wordings; the evidence counts matched.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| F15 | low–med | Four JARVIS refusals that go through the kernel were logged as allowed failures: a denied dangerous shortcut, "Execution Blocked:" (critical process), "Blocked by safety policy", "Refused by safety policy" | **Fixed**: `was denied`, `safety policy`, `^Execution Blocked:` added to the rule. Tests first; M30–M32 |
| F16 | low | The records said an agent's check has no foreground trace id "in the trace" too; the trace entry keeps the foreground correlation id, as agent `tool_call` entries do | **Fixed** in the records; the code is unchanged |
| F17 | info | `\bcancelled\b` also matched "Chrome cancelled the download" | **Fixed**: `cancelled by user` (every "cancelled" refusal in `control/` says it, or also says "not approved"). M25, M33 |
| F18 | info | "Execution queue is PAUSED …" is logged as an allowed `failure` | Recorded under known limits |

## Round 4 — APPROVED

The reviewer ran the test (43/43), the typecheck (`TC=0`), and a probe that sorted every refusal-like error text thrown in `control/*.ts` with the new rule. F15–F18 were confirmed. Every "cancelled" wording either says "cancelled by user" or is caught by "not approved". The evidence counts and the change log's description of the rule matched the code.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| F19 | low | `Service name "…" rejected by policy` is logged as an allowed `failure`; closer to bad input than a refusal (debatable, optional) | Recorded under known limits |
