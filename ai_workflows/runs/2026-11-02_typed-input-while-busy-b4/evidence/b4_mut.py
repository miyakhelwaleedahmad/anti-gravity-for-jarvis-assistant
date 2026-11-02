"""Mutation check for phase B4 (N-PC2): each fault alone; typedWhileBusyB4Test must fail.
Every file is restored afterwards. Run from the repository root."""
import subprocess, pathlib, os
MUTANTS = [
  ("M1 typed input in LISTENING not handled", "core/orchestrator.ts",
   "    } else if (agentStateMachine.is(AgentState.LISTENING)) {", "    } else if (false) {"),
  ("M2 a left-over state not reset", "core/orchestrator.ts",
   "    } else if (source === 'cli' && !agentStateMachine.is(AgentState.IDLE) && !agentStateMachine.is(AgentState.PROCESSING_STT)) {", "    } else if (false) {"),
  ("M3 the wrong fix: allow LISTENING -> PLANNING in the state rules", "core/agentStateMachine.ts",
   "[AgentState.LISTENING]:      [AgentState.PROCESSING_STT, AgentState.INTERRUPTED, AgentState.IDLE],", "[AgentState.LISTENING]:      [AgentState.PROCESSING_STT, AgentState.INTERRUPTED, AgentState.IDLE, AgentState.PLANNING],"),
  ("M4 barge-in while SPEAKING removed", "core/orchestrator.ts",
   "    if (curState === AgentState.SPEAKING || curState === AgentState.INTERRUPTED) {\n      this.handleBargeInBeforeProcessing(input, source);", "    if (false) {\n      this.handleBargeInBeforeProcessing(input, source);"),
  # Review round 1 (R5): the "replaced request is aborted" check can fail
  ("M5 a running request is not aborted by the new one", "core/orchestrator.ts",
   "    this.currentAbortController?.abort();\n    const controller = new AbortController();", "    const controller = new AbortController();"),
  # Review round 1 (R1, owner's choice): typed text replaces a waiting spoken request
  ("M6 the waiting spoken request is not dropped (R1)", "core/orchestrator.ts",
   "      this.runBargeInCallbacks();\n      agentStateMachine.reset();\n    }", "      agentStateMachine.reset();\n    }"),
  # Review round 2 (N1): only typed text takes the left-over branch
  ("M7 the left-over branch also takes spoken input (N1)", "core/orchestrator.ts",
   "    } else if (source === 'cli' && !agentStateMachine.is(AgentState.IDLE)", "    } else if (!agentStateMachine.is(AgentState.IDLE)"),
]
only = os.environ.get("MUT_ONLY")
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
caught = 0
for name, file, old, new in MUTANTS:
    p = pathlib.Path(file); original = p.read_text()
    if original.count(old) != 1:
        print(f"{name}: NOT APPLIED ({original.count(old)})"); continue
    try:
        p.write_text(original.replace(old, new))
        r = subprocess.run(["pnpm", "test", "--", "--only=typedWhileBusyB4Test"], capture_output=True, text=True, timeout=600)
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        first = next((l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")), "")
    finally:
        p.write_text(original)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {first[:170]}", flush=True)
print(f"\n{caught}/{len(MUTANTS)} caught")
