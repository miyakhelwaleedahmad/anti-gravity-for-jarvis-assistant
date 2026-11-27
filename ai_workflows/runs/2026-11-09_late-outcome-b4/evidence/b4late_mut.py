"""Mutation check for B4 (an action that ends after JARVIS stopped waiting): each fault alone;
tests/lateOutcomeB4Test.ts must fail. Every file is restored afterwards and checked by md5.
Run from the repository root."""
import subprocess, pathlib, os, hashlib
SB = "core/toolExecutionSandbox.ts"; OU = "core/outcomeUnknown.ts"; AL = "control/actionAuditLog.ts"
KE = "control/pcControlKernel.ts"; RG = "core/toolRegistryV2.ts"; TG = "core/taskGraphEngine.ts"
RE = "core/reflectionEngine.ts"; AD = "control/adminController.ts"; PR = "system/processRunner.ts"; GR = "core/goalRecovery.ts"
MUTANTS = [
  # Identity capture (A1, B1)
  ("K1 late_result takes the identity when the tool ends, not at the start", [(SB, "        void Promise.all([stoppedWaiting, outcomeWritten]).then(() => actionAuditLog.logLateResult({\n          ...origin,", "        void Promise.all([stoppedWaiting, outcomeWritten]).then(() => actionAuditLog.logLateResult({\n          ...captureCallOrigin(tool.name),")]),
  ("K2 outcome_unknown takes the identity when JARVIS gives up, not at the start", [(SB, "            ...origin, tool: tool.name, waitedMs,", "            ...captureCallOrigin(tool.name), tool: tool.name, waitedMs,")]),
  ("K3 the identity is not frozen", [(OU, "  return Object.freeze({", "  return ({")]),
  ("K4 the kernel takes the request when the action ends", [(KE, "    const origin = requestFields(actionName);", "    const origin = { get userCommand() { return requestFields(actionName).userCommand; }, get traceId() { return requestFields(actionName).traceId; }, get agentPath() { return requestFields(actionName).agentPath; } } as any;")]),
  # Audit lines and ordering (A3, A4)
  ("K5 no outcome_unknown line", [(AL, "    return this.append({ timestamp: new Date().toISOString(), type: 'outcome_unknown', ...entry });", "    return true;")]),
  ("K6 no late_result line", [(SB, "      if (stoppedWaiting) {\n        // It ended after", "      if (false) {\n        // It ended after")]),
  ("K7 the result is returned before the outcome_unknown line is written", [(SB, "          void stoppedWaiting.then(() => resolve({ output: gaveUpOutput!, stuck: true }));", "          resolve({ output: gaveUpOutput!, stuck: true });"), (SB, "      if (stoppedWaiting) await stoppedWaiting;\n", "")]),
  ("K8 late_result not ordered after outcome_unknown", [(SB, "        void Promise.all([stoppedWaiting, outcomeWritten]).then(() => actionAuditLog.logLateResult({", "        void Promise.resolve().then(() => actionAuditLog.logLateResult({")]),
  # Audit failure handling
  ("K9 a failed or overdue audit write is not reported", [(SB, "            if (ok !== true) {", "            if (false) {")]),
  ("K10 no limit on the audit wait", [(SB, "          stoppedWaiting = Promise.race([written, late]).then((ok) => {", "          stoppedWaiting = written.then((ok) => {")]),
  ("K11 a tool ending during the audit wait turns the result into its real result", [(SB, "    if ('stuck' in settled || gaveUpOutput !== undefined) {", "    if ('stuck' in settled) {")]),
  # Result text (A2) and wording
  ("K12 the gave-up text has no outcome-unknown marker", [(SB, "          gaveUpOutput = `Error: ${OUTCOME_UNKNOWN_MARK}: Tool", "          gaveUpOutput = `Error: TIMEOUT: Tool")]),
  ("K13 the gave-up text has no time waited", [(SB, "JARVIS stopped waiting for it after ${secondsText(waitedMs)}. It may still finish.`;", "JARVIS stopped waiting for it. It may still finish.`;")]),
  ("K14 always plural seconds", [(OU, "  return `${n} second${n === 1 ? '' : 's'}`;", "  return `${n} seconds`;")]),
  # Registry (C) and task graph (D)
  ("K15 the registry tries a fallback after an unknown outcome", [(RG, "          if (!isError || i === chain.length - 1 || isOutcomeUnknown(output)) {", "          if (!isError || i === chain.length - 1) {")]),
  ("K16 the registry retries a thrown unknown outcome", [(RG, "          if (isOutcomeUnknown(errMsg)) {\n            this._recordMetric", "          if (false) {\n            this._recordMetric")]),
  ("K17 the task graph re-runs an unknown outcome", [(TG, "        : isOutcomeUnknown(errMsg)                                         ? 'fatal'\n", "")]),
  # Reflection classification and wording
  ("K18 no outcome_unknown pattern (override kept)", [(RE, "  { pattern: OUTCOME_UNKNOWN_MARK,   class: 'outcome_unknown', strategy: 'abort' },\n", "")]),
  ("K19 no outcome_unknown override (pattern kept)", [(RE, "    if (unknownOutcome) {\n      dominantClass = 'outcome_unknown';", "    if (false) {\n      dominantClass = 'outcome_unknown';")]),
  ("K20 neither the pattern nor the override", [(RE, "  { pattern: OUTCOME_UNKNOWN_MARK,   class: 'outcome_unknown', strategy: 'abort' },\n", ""), (RE, "    if (unknownOutcome) {\n      dominantClass = 'outcome_unknown';", "    if (false) {\n      dominantClass = 'outcome_unknown';")]),
  ("K21 the owner's sentence is not used", [(RE, "        ? (unknownOutcome ? this.outcomeUnknownVoiceMessage(graph, unknownOutcome) : undefined)", "        ? (undefined as string | undefined)")]),
  ("K22 several steps named like one", [(RE, "    const action = graph.nodes.size <= 1", "    const action = true")]),
  ("K23 a stopped command said like a tool JARVIS stopped waiting for", [(RE, "    if (stopped) return `${stopped[1]} was stopped after", "    if (false) return `${stopped[1]} was stopped after")]),
  # Admin and process runner
  ("K24 a command that never started said to have maybe run", [(AD, "  if (r.started === false) return `${what} was not started: the request was stopped before it began.`;\n", "")]),
  ("K25 the admin seconds not measured (always 10)", [(AD, "  const stopped = stoppedCommandError(r, performance.now() - t0, what);", "  const stopped = stoppedCommandError(r, 10_000, what);")]),
  ("K26 runProcess says a never-started process started", [(PR, "    return { stdout: '', stderr: '', exitCode: undefined, cancelled: true, timedOut: false, started: false };", "    return { stdout: '', stderr: '', exitCode: undefined, cancelled: true, timedOut: false, started: true };")]),
  ("K27 the kernel logs a stopped command as failure", [(KE, "isOutcomeUnknown(errMsg) ? 'unknown' : 'failure',", "'failure',")]),
  # Goal recovery
  ("K28 goal classification misses the marker (budget/transient win)", [(GR, "  if (isOutcomeUnknown(text)) return 'outcome_unknown';\n", "")]),
  # Second-review corrections (V1, V2, V3, V5): each reverted alone
  ("V1m the never-started wording is not final for the action queue (retried, asked twice)", [(AD, "was not started: the request was stopped before it began.`;", "was not started: the request had already been stopped.`;")]),
  ("V2m late_result waits only for the 2 s limit, not for the timeout line's write", [(SB, "        void Promise.all([stoppedWaiting, outcomeWritten]).then(", "        void Promise.all([stoppedWaiting]).then(")]),
  ("V3m the planner's [SYSTEM NOTE] is said", [(RE, "    const request = graph.goal.replace(/\\n\\n\\[SYSTEM NOTE:[\\s\\S]*$/, '').trim();", "    const request = graph.goal;")]),
  ("V5m the failure message's comment misplaced again", [(RE, "  private buildFailureVoiceMessage(goal: string", "  /** misplaced */\n  private buildFailureVoiceMessage(goal: string")]),
  ("V1q the action queue does not treat \"was stopped\" as final (it retries)", [("control/actionQueue.ts", "|was stopped|", "|")]),
  ("K29 goal recovery schedules an unknown outcome again", [(GR, "  if (cls === 'outcome_unknown' || isOutcomeUnknown(`${failure.code ?? ''} ${failure.message}`)) {", "  if (false) {")]),
]
only = os.environ.get("MUT_ONLY")
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
files = sorted({e[0] for _, es in MUTANTS for e in es})
md5 = lambda f: hashlib.md5(pathlib.Path(f).read_bytes()).hexdigest()
if os.environ.get("CHECK_ONLY"):
    for name, edits in MUTANTS:
        print(name.split()[0], [pathlib.Path(f).read_text().count(o) for f, o, _ in edits])
    raise SystemExit(0)
before = {f: md5(f) for f in files}
caught = 0
for name, edits in MUTANTS:
    originals = {f: pathlib.Path(f).read_text() for f, _, _ in edits}
    bad = [(f, pathlib.Path(f).read_text().count(o)) for f, o, _ in edits if pathlib.Path(f).read_text().count(o) != 1]
    if bad:
        print(f"{name}: NOT APPLIED {bad}", flush=True); continue
    try:
        for f, o, n in edits:
            p = pathlib.Path(f); p.write_text(p.read_text().replace(o, n, 1))
        r = subprocess.run(["node", "node_modules/tsx/dist/cli.mjs", "tests/lateOutcomeB4Test.ts"], capture_output=True, text=True, timeout=400)
        out = r.stdout + r.stderr
        passed = r.returncode == 0 and ", 0 failed" in out
        fails = [l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")]
    except subprocess.TimeoutExpired:
        passed, fails = False, ["FAIL: (the test run timed out)"]
    finally:
        for f, text in originals.items(): pathlib.Path(f).write_text(text)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {len(fails)} failing; first: {(fails[0] if fails else '')[:170]}", flush=True)
after = {f: md5(f) for f in files}
print(f"\n{caught}/{len(MUTANTS)} caught")
print("tree restored (md5):", "YES" if before == after else f"NO {[(f, before[f], after[f]) for f in files if before[f] != after[f]]}")
