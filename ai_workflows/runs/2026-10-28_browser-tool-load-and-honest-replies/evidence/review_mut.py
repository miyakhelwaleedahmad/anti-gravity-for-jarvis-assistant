"""Each review finding put back on its own; the named test must then fail.
Every file is restored afterwards. Run from the repository root."""
import subprocess, pathlib
MUTANTS = [
  ("R3 closing tag not held back", "core/spokenText.ts", "honestActionReplyTest",
   "const tail = /<\\/?[a-z_ ]*$/i.exec(out);", "const tail = /<[a-z_ ]*$/i.exec(out);"),
  ("R1 every reply replaced when nothing acted", "core/orchestrator.ts", "honestActionReplyTest",
   "if (noAction && verb && claimsAction(reply, verb)) {", "if (noAction && verb) {"),
  ("R2 web lookups count as actions", "core/actionHonesty.ts", "honestActionReplyTest",
   "return meta?.category === 'NETWORK' && meta.external === 'query' && !meta.actions;", "return false;"),
  ("R4 direct answer not checked", "core/orchestrator.ts", "honestActionReplyTest",
   # Line as it stands after the N3 fix (the round-1 pattern no longer exists).
   "if (asked && !isClarifyingQuestion(reply) && claimsAction(reply, asked)) {", "if (false) {"),
  ("R5 still loading not recognised", "core/reflectionEngine.ts", "browserRefusalSpokenTest",
   "if (loading) return `I couldn't do that yet, sir. ${loading}`;", ""),
  ("Fix A: import not shared (each call imports anew, slow skill degraded)", "core/skillLoader.ts", "skillImportTimeoutTest",
   "const pending = this.pendingImports.get(targetPathToImport) ?? startImport();", "const pending = startImport().then((m) => { if (!m) return m; return m; });"),
  # Review round 2:
  ("N1 -ing / will forms not claims", "core/actionHonesty.ts", "honestActionReplyTest",
   "const forms = [pastForm(verb), ingForm(verb), `(?:will|'ll|going to|about to) ${verb}`, 'done', 'completed', 'successfully', 'all set'];",
   "const forms = [pastForm(verb), 'done', 'completed', 'successfully', 'all set'];"),
  ("N1 'no worries' counted as a negation", "core/actionHonesty.ts", "honestActionReplyTest",
   "!NEGATION.test(part.replace(POLITE_NEGATION, ''))", "!NEGATION.test(part)"),
  ("N2 failed reply model claims the task was completed", "core/orchestrator.ts", "honestActionReplyTest",
   "      if (noAction && verb) {\n        this.speak(noActionReply(verb));\n        return;\n      }\n", ""),
  ("N3 clarifying question replaced", "core/orchestrator.ts", "honestActionReplyTest",
   "if (asked && !isClarifyingQuestion(reply) && claimsAction(reply, asked)) {", "if (asked && claimsAction(reply, asked)) {"),
]
import os
if os.environ.get("MUT_ONLY"): MUTANTS = [m for m in MUTANTS if m[0].split()[0] in os.environ["MUT_ONLY"].split(",")]
if os.environ.get("ROUND2"): MUTANTS = [m for m in MUTANTS if m[0][:2] in ("N1", "N2", "N3")]
caught = 0
for name, file, test, old, new in MUTANTS:
    p = pathlib.Path(file); original = p.read_text()
    if original.count(old) != 1:
        print(f"{name}: NOT APPLIED ({original.count(old)})"); continue
    try:
        p.write_text(original.replace(old, new))
        r = subprocess.run(["pnpm", "test", "--", f"--only={test}"], capture_output=True, text=True, timeout=600)
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        first = next((l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")), "")
    finally:
        p.write_text(original)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {first[:180]}")
print(f"\n{caught}/{len(MUTANTS)} caught")
