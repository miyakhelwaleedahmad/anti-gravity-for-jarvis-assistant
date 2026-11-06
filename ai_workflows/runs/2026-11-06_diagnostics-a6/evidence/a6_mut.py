"""Mutation check for phase A6 (TRA-13, TRA-15): each fault alone; the named test must fail.
Every file is restored afterwards and checked by md5. Run from the repository root."""
import subprocess, pathlib, os, hashlib
K = "control/pcControlKernel.ts"; L = "control/actionAuditLog.ts"; R = "core/toolRegistryV2.ts"
W = "monitoring/traceWiring.ts"; C = "tests/chromeHelper.ts"; T = "diagnosticsA6Test"
MUTANTS = [
  ("M1 no trace id in the action log line", T, [(K, "    ...(traceId ? { traceId } : {}),\n    ...(agentPath ? { agentPath } : {}),", "    ...(agentPath ? { agentPath } : {}),")]),
  ("M2 the action name as the command again", T, [(K, "    userCommand: request ? (request.length > 160 ? `${request.slice(0, 157)}...` : request) : actionName,", "    userCommand: actionName,")]),
  ("M3 no 'verified: pending'", T, [(K, "        ...(isReadOnly ? {} : { verified: 'pending' as const }),\n", "")]),
  ("M4 the fixed risk level again", T, [(K, "        riskLevel,\n        allowed: true,", "        riskLevel: 'medium',\n        allowed: true,")]),
  ("M5 the fixed rollbackAvailable again (Q2)", T, [(K, "        ...(isReadOnly ? {} : { verified: 'pending' as const }),\n        durationMs,", "        ...(isReadOnly ? {} : { verified: 'pending' as const }),\n        durationMs,\n        rollbackAvailable: true,")]),
  ("M6 a long request not cut short", T, [(K, "request.length > 160 ? `${request.slice(0, 157)}...` : request", "request")]),
  ("M7 a passed check not handed on (Q1)", T, [(R, "        this._emitVerification({ tool: ran.name, status: 'verified', evidence: redact(verification.evidence) });\n", "")]),
  ("M8 a failed check not handed on", T, [(R, "    this._emitVerification({ tool: ran.name, status: 'failed', evidence });\n", "")]),
  ("M9 the trace does not record the check", T, [(W, "    toolLog.withCorrelation(trace())[v.status === 'verified' ? 'info' : 'warn']('verification', {", "    if (Date.now() < 0) toolLog.withCorrelation(trace())[v.status === 'verified' ? 'info' : 'warn']('verification', {")]),
  ("M10 the action log does not record the check", T, [(W, "    void actionAuditLog.logVerification(", "    if (Date.now() < 0) void actionAuditLog.logVerification(")]),
  ("M11 the check line without the trace id", T, [(W, "      ...(traceId ? { traceId } : {}), ...(agentPath ? { agentPath } : {}), tool: v.tool,", "      ...(agentPath ? { agentPath } : {}), tool: v.tool,")]),
  ("M12 an unverifiable check written as if it ran", T, [(R, "      if (verification.status === 'verified') {\n        console.log(`[ToolRegistry] ✓ ${ran.name}: checked — ${verification.evidence}.`);\n        this._emitVerification({ tool: ran.name, status: 'verified',", "      {\n        console.log(`[ToolRegistry] ✓ ${ran.name}: checked — ${verification.evidence}.`);\n        this._emitVerification({ tool: ran.name, status: 'verified',")]),
  ("M13 Windows: only the parent ended (TRA-15)", T, [(C, "return platform === 'win32' ? ['taskkill', '/PID', String(pid), '/T', '/F'] : undefined;", "return undefined;")]),
  ("M14 Windows: taskkill without the tree", T, [(C, "['taskkill', '/PID', String(pid), '/T', '/F']", "['taskkill', '/PID', String(pid), '/F']")]),
  # Review round 1 (F1, F2, F3, F6)
  ("M15 inside an agent: the foreground's trace id again (F1)", T, [(K, "  const traceId = agentPath ? undefined : getTraceId();", "  const traceId = getTraceId();")]),
  ("M16 a read says a check is pending (F2)", T, [(K, "        ...(isReadOnly ? {} : { verified: 'pending' as const }),", "        verified: 'pending' as const,")]),
  ("M17 every failure 'not allowed' again (F6)", T, [(K, "        allowed: !blocked,", "        allowed: false,")]),
  ("M18 the case-sensitive 'Denied' check again (F6)", T, [(K, "const blocked = isPermissionDenial(errMsg)\n        || /cancelled by user|not approved|was denied|safety policy|^Execution Blocked:|^Access Denied: Path/i.test(errMsg);", "const blocked = errMsg.includes('cancelled') || errMsg.includes('Denied');")]),
  ("M19 the helper ignores a failed taskkill (F3)", T, [(C, "  if (cmd && run(cmd[0]!, cmd.slice(1)).status === 0) return;", "  if (cmd) { run(cmd[0]!, cmd.slice(1)); return; }")]),
  ("M20 the failure line without the request (F3)", T, [(K, "      await actionAuditLog.log({\n        ...requestFields(actionName),\n        normalizedIntent: actionName,\n        action: actionName,\n        target: targetName,\n        permissionLevel: permLevel,\n        riskLevel,\n        allowed: !blocked,", "      await actionAuditLog.log({\n        userCommand: actionName,\n        normalizedIntent: actionName,\n        action: actionName,\n        target: targetName,\n        permissionLevel: permLevel,\n        riskLevel,\n        allowed: !blocked,")]),
  # Review round 2 (F10, F11, F12)
  ("M21 an agent's check line: the foreground's trace id again (F10)", T, [(W, "    const traceId = agentPath ? undefined : getTraceId();", "    const traceId = getTraceId();")]),
  ("M22 an agent's check line without the agent's name (F10)", T, [(W, "      ...(traceId ? { traceId } : {}), ...(agentPath ? { agentPath } : {}), tool: v.tool,", "      ...(traceId ? { traceId } : {}), tool: v.tool,")]),
  ("M23 the round-1 rule again: any 'denied' blocked (F11)", T, [(K, "const blocked = isPermissionDenial(errMsg)\n        || /cancelled by user|not approved|was denied|safety policy|^Execution Blocked:|^Access Denied: Path/i.test(errMsg);", "const blocked = /cancelled|denied/i.test(errMsg);")]),
  ("M24 a permission-level refusal not blocked (F11)", T, [(K, "const blocked = isPermissionDenial(errMsg)\n        || /", "const blocked = /")]),
  ("M25 a cancel not blocked (F11)", T, [(K, "/cancelled by user|", "/")]),
  ("M26 'not approved' not blocked (F11)", T, [(K, "|not approved|", "|")]),
  ("M27 outside the approved folders not blocked (F11)", T, [(K, "|^Access Denied: Path/i", "/i")]),
  ("M28 taskkill on an exited Chrome's id (F12)", T, [(C, "  const running = proc.exitCode === null && proc.signalCode === null;", "  const running = true;")]),
  ("M29 a Chrome ended by a signal counted as running (F12)", T, [(C, "proc.exitCode === null && proc.signalCode === null", "proc.exitCode === null")]),
  # Review round 3 (F15, F17)
  ("M30 a denied dangerous shortcut not blocked (F15)", T, [(K, "|was denied|", "|")]),
  ("M31 a safety-policy refusal not blocked (F15)", T, [(K, "|safety policy|", "|")]),
  ("M32 a critical-process refusal not blocked (F15)", T, [(K, "|^Execution Blocked:|", "|")]),
  ("M33 any 'cancelled' blocked again (F17)", T, [(K, "/cancelled by user|", "/cancelled|")]),
]
only = os.environ.get("MUT_ONLY")
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
files = sorted({e[0] for _, _, es in MUTANTS for e in es})
md5 = lambda f: hashlib.md5(pathlib.Path(f).read_bytes()).hexdigest()
before = {f: md5(f) for f in files}
caught = 0
for name, test, edits in MUTANTS:
    originals = {f: pathlib.Path(f).read_text() for f, _, _ in edits}
    bad = [(f, pathlib.Path(f).read_text().count(o)) for f, o, _ in edits if pathlib.Path(f).read_text().count(o) != 1]
    if bad:
        print(f"{name}: NOT APPLIED {bad}", flush=True); continue
    try:
        for f, o, n in edits:
            p = pathlib.Path(f); p.write_text(p.read_text().replace(o, n))
        r = subprocess.run(["pnpm", "test", "--", f"--only={test}"], capture_output=True, text=True, timeout=600,
                           env={**os.environ, "JARVIS_CHROME_AUTOSTART": "off"})
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        first = next((l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")), "")
    finally:
        for f, text in originals.items(): pathlib.Path(f).write_text(text)
    caught += not passed
    print(f"{name} [{test}]: {'CAUGHT' if not passed else 'MISSED'} | {first[:170]}", flush=True)
after = {f: md5(f) for f in files}
print(f"\n{caught}/{len(MUTANTS)} caught")
print("tree restored (md5):", "YES" if before == after else f"NO {[(f, before[f], after[f]) for f in files if before[f] != after[f]]}")
