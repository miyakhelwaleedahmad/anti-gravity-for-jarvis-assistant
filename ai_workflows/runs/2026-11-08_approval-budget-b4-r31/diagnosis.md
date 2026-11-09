# Diagnosis — approval wait inside a tool's budget (B4 R3-1)

Read-only, on `7ea2d3a` (Gate 0, reported to the owner on 2026-11-08). Probes ran from temporary copies.

## Root cause

A question a controller asks while its tool runs is timed by the tool's budget.

| Where | What |
|---|---|
| `core/toolExecutionSandbox.ts:56-60` | Budget per risk tier: high 15 s, medium 20 s, low 30 s |
| `core/toolExecutionSandbox.ts:109-112, 125-126` | The timer starts with the call; `tool.execute(args, ac.signal)` (its questions included) runs under it; at the deadline the signal is aborted |
| `core/toolExecutionSandbox.ts:147-161` | 5 s after the abort the call ends as "TIMEOUT … JARVIS stopped waiting for it" |
| `control/browserController.ts:192, 197` | `closeBrowser` asks inside the tool (`withoutApproval`), then refuses when the signal was aborted |
| `security/approvalGate.ts:43-53, 261-263, 419-452` | The owner's window: typed 30 s; spoken 20 s counted from when JARVIS has finished saying the question (that wait up to 90 s) |
| `core/toolRegistryV2.ts:791-832, 960-962` | The registry's own approval is asked before the sandbox starts: not affected |

On the PC the spoken question itself took about 15 s, so the budget ran out (20:55:36) before the answer window opened (20:55:39).

## Scope

Every tool that asks inside its run is medium or high risk, so all go through the sandbox (`evidence/r31_tool_tiers.txt`). Asking inside: `browserController.closeBrowser`, `appController` (protected app, several windows), `windowController` (browser, unknown or protected window), `processController`, `fileController`, `adminController`, `systemController`, `keyboardController`, `tabClose.checkTabClose`, `skills/automation`, `enable_full_control_session`. Only `browserController` checks the signal after the answer.

`evidence/r31_probe_sandbox.txt` (the real sandbox, a fake tool, a shortened budget):
- A, browser style: an answer just after the budget is refused (the PC bug);
- B, other controllers: an answer just after the budget is acted on;
- C, other controllers: an answer after the sandbox stopped waiting: JARVIS reports "TIMEOUT … JARVIS stopped waiting", and the action still happens about 0.5 s later (at real values, a typed "yes" between 20 s and 30 s).

Other clocks checked: the action queue's 10 s timer (`control/actionQueue.ts:47-49`) aborts the queue's signal. `closeBrowser` does not get that signal (it gets the tool's signal, `pcControlKernel.ts:304-306`), so the browser path is not affected. *Corrected after the independent review (F4):* the admin commands do get it. `runShellCommand`, `runPowerShell` and the service actions pass `either(signal, qs)` (`pcControlKernel.ts:444-468`), and `adminController.runShellCommand` asks the owner and then runs the command with that signal (`adminController.ts:98-103`). When the registry's approval does not already cover the question, a "yes" given more than 10 s after the queue started is taken, but the command is stopped at once (`TIMEOUT: The command was cancelled and stopped`). Through the registry the question is normally covered and not asked. This is a separate issue, not fixed in R3-1. The task graph has no per-node timeout; the EXECUTING state has no watchdog; the registry's 25 s limit applies to low-risk tools, and none of them asks.
