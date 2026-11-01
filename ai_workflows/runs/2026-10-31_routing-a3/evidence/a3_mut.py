"""Mutation check for phase A3: each fault alone; routingA3Test must fail.
Every file is restored afterwards. Run from the repository root."""
import subprocess, pathlib, os
MUTANTS = [
  ("M1 no named-tab route", "core/deterministicRoutes.ts",
   "if (namedTab && !NOT_A_TAB_NAME.test(namedTab[1]!)) {", "if (false) {"),
  ("M2 'this' / 'current' accepted as a tab name", "core/deterministicRoutes.ts",
   "if (namedTab && !NOT_A_TAB_NAME.test(namedTab[1]!)) {", "if (namedTab) {"),
  ("M3 one-letter words and 4 words accepted", "core/deterministicRoutes.ts",
   "const CLOSE_NAMED_TAB = new RegExp(`^close (?:the )?((?=[a-z0-9.]{2,64} )${TAB_NAME_WORD}(?: (?=[a-z0-9.]{2,64} )${TAB_NAME_WORD}){0,2}) tab$`);",
   "const CLOSE_NAMED_TAB = new RegExp(`^close (?:the )?(${TAB_NAME_WORD}(?: ${TAB_NAME_WORD}){0,3}) tab$`);"),
  ("M4 exact full-control words only", "core/deterministicRoutes.ts",
   "if (isEnableFullControlPhrase(clean)) {", "if (clean === 'enable full control mode') {"),
  ("M5 'disable' counted as enabling", "core/fullControlPhrase.ts",
   "const VERB = /^(?:enable|enabled|unable|inable|anable|turn on|switch on|activate)$/;",
   "const VERB = /^(?:enable|enabled|unable|inable|anable|turn on|switch on|activate|disable|turn off|stop)$/;"),
  ("M6 any word accepted for 'control'", "core/fullControlPhrase.ts",
   "if (control.length < 5 || control.length > 9 || !/^[ck]/.test(control) || distance(control, 'control') > 2) return false;", ""),
  ("M7 planner not offered full control for near-misses", "core/planningToolSelection.ts",
   " || isEnableFullControlPhrase(clean.replace(/[^a-z0-9\\s]/g, ''))", ""),
  ("M8 the skill asks again inside the approved call", "skills/enable_full_control_session/skill.ts",
   "const approved = alreadyApproved || await approvalGate.requestApproval(", "const approved = await approvalGate.requestApproval("),
  ("M9 'Failed to enable' without the reason", "core/orchestrator.ts",
   "failureReply(result, 'I did not turn on full control mode, sir.')", "'Failed to enable full control, sir.'"),
  ("M10 mixed request not offered the app tool", "core/planningToolSelection.ts",
   "    if (isBrowserClose && /\\band\\b/.test(clean)) addIfRegistered('control_app', 'control_window');\n", ""),
  ("M11 dots removed again", "core/voiceInput.ts",
   "result = result.replace(/[^a-z0-9\\s.]/g, '')", "result = result.replace(/[^a-z0-9\\s]/g, '')"),
  # Review fixes (round 1)
  ("M12 filler words accepted as a tab name (R1)", "core/deterministicRoutes.ts",
   "|the|a|an|my|your|his|her|our|their|it|its|one|first|second|third|next|previous|prev|left|right|old|tab|tabs'", "'"),
  ("M13 tab name read without its dot (R2)", "core/deterministicRoutes.ts",
   "CLOSE_NAMED_TAB.exec(normalized.toLowerCase().replace(/[^a-z0-9\\s.]/g, '').trim())", "CLOSE_NAMED_TAB.exec(clean)"),
  ("M14 any approval of this tool skips the question (R5)", "skills/enable_full_control_session/skill.ts",
   "approvedCall !== undefined && isSameCall(approvedCall, 'enable_full_control_session', args)", "approvedCall?.tool === 'enable_full_control_session'"),
  # Review fixes (round 2)
  ("M15 URL pieces accepted as a tab name (N1)", "core/deterministicRoutes.ts",
   "|www|http|https|com|org|net)", ")"),
  ("M16 no length cap on a tab-name word (N2)", "core/deterministicRoutes.ts",
   "(?:the )?((?=[a-z0-9.]{2,64} )", "(?:the )?((?=[a-z0-9.]{2,} )"),
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
        r = subprocess.run(["pnpm", "test", "--", "--only=routingA3Test"], capture_output=True, text=True, timeout=600)
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        first = next((l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")), "")
    finally:
        p.write_text(original)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {first[:170]}", flush=True)
print(f"\n{caught}/{len(MUTANTS)} caught")
