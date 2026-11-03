"""Mutation check for N-PC10: each fault alone; timeQuestionsNpc10Test must fail.
Every file is restored afterwards. Run from the repository root."""
import subprocess, pathlib, os
R = "core/deterministicRoutes.ts"; U = "memory/unifiedContextBuilder.ts"
MUTANTS = [
  ("M1 time back to the three exact wordings", R,
   "  if (TIME_QUESTION.some((pattern) => pattern.test(clockAsk))) {", "  if (clean === 'what time is it' || clean === 'time' || clean === 'what is the time') {"),
  # M2 (spaces not collapsed) was equivalent: normalizeVoiceInput already collapses them.
  # The redundant collapse was removed from the code, and M2 with it (npc10_mut_run.txt, first run).
  ("M3 no date answer", R,
   "  if (DATE_QUESTION.some((pattern) => pattern.test(clockAsk))) {", "  if (false) {"),
  ("M4 time pattern not anchored at the end (over-match)", R,
   "  /^what time is (it|this)( now| right now)?$/,", "  /^what time is (it|this)( now| right now)?/,"),
  ("M5 date pattern not anchored at the end (over-match)", R,
   "  /^(whats|what is) the (current )?date( today)?$/,", "  /^(whats|what is) the (current )?date( today)?/,"),
  ("M6 clock line back to UTC time", U,
   "  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;", "  const time = now.toISOString().slice(11, 16);"),
  ("M7 cache hit keeps the old clock line", U,
   "      return { ...hit, systemState, mergedContext: hit.mergedContext.replace(hit.systemState, () => systemState) };", "      return hit;"),
  ("M8 time zone offset sign flipped", U,
   "offset >= 0 ? '+' : '-'", "offset >= 0 ? '-' : '+'"),
  ("M9 cache hit refreshes systemState but not the context sent", U,
   "mergedContext: hit.mergedContext.replace(hit.systemState, () => systemState) }", "mergedContext: hit.mergedContext }"),
  # Review round 1 (T2, T3, T5)
  ("M10 time reply in the PC's regional format (T2)", R,
   "toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })", "toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })"),
  ("M11 date reply in the PC's regional format (T2)", R,
   "toLocaleDateString('en-US', { weekday: 'long'", "toLocaleDateString([], { weekday: 'long'"),
  ("M12 a trailing jarvis is not dropped (T3)", R,
   "  const clockAsk = clean.replace(/ jarvis$/, '');", "  const clockAsk = clean;"),
  ("M13 'what is time' and the like match again (T5)", R,
   "  /^(whats|what is) the (current )?time( now| right now)?$/,", "  /^(whats|what is) (the )?(current )?time( now| right now)?$/,"),
  # Follow-up P3, P4 (owner's PC, 2026-11-02 at c568b49)
  ("M14 'which day' / 'what day is this' not matched (P3)", R,
   "  /^(what|which) day is (it|today|this)( today)?$/,", "  /^what day is (it|today)( today)?$/,"),
  ("M15 'what date is it' / 'which date is today' not matched (P3)", R,
   "  /^(what|which) date is (it|today)( today)?$/,\n", ""),
  ("M16 the clock line no longer says it is this PC's clock (P4, T14)", U,
   ", read from this PC's clock for this request.", ""),
  ("M17 the 'which day' pattern not anchored at the end (T17)", R,
   "  /^(what|which) day is (it|today|this)( today)?$/,", "  /^(what|which) day is (it|today|this)( today)?/,"),
  ("M18 'what date is this' answered with today's date (T15)", R,
   "  /^(what|which) date is (it|today)( today)?$/,", "  /^(what|which) date is (it|today|this)( today)?$/,"),
]
only = os.environ.get("MUT_ONLY")
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
caught = 0
for name, file, old, new in MUTANTS:
    p = pathlib.Path(file); original = p.read_text()
    if original.count(old) != 1:
        print(f"{name}: NOT APPLIED ({original.count(old)})", flush=True); continue
    try:
        p.write_text(original.replace(old, new))
        r = subprocess.run(["pnpm", "test", "--", "--only=timeQuestionsNpc10Test"], capture_output=True, text=True, timeout=600)
        out = r.stdout + r.stderr
        passed = "1 passed · 0 failed" in out
        first = next((l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")), "")
    finally:
        p.write_text(original)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {first[:170]}", flush=True)
print(f"\n{caught}/{len(MUTANTS)} caught")
