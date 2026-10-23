# Stage 05 — Verification

Confirm the change works: tests through the runner, and live checks on the
owner's PC when the behaviour needs them.

## Inputs

| Source | Load | Why |
|---|---|---|
| `runs/<run>/patch_plan.md` | Tests listed, live verification yes/no | What must be run |
| `runs/<run>/reproduction.md` | Regression test and its earlier failure | Before/after evidence |
| `runs/<run>/change_log.md` | Changed files | What is being verified |
| `_config/TEST_MATRIX.md` | Commands, Windows note, Live Runtime Verification | How to run each check |

## Process

1. Run, in order (CMD or PowerShell; each test gets its own empty data folder):
   ```
   pnpm run typecheck
   pnpm test -- --only=<regression test>,<required group from TEST_MATRIX.md>
   pnpm test -- --ci
   ```
   Voice changes: the group is `nodeBridgeSingletonTest, voiceRouteMockTest,
   interruptGatingTest, openAppSmokeTest, latencySmokeTest,
   deterministicCommandRouteTest`.
2. The regression test from Stage 02b must now pass, for the right reason.
3. Paste the real runner lines. Record every PASS, FAIL, TIMEOUT, BLOCKED
   and SKIPPED with the machine it ran on.
4. Live checks (voice, microphone, speaker, Windows control, real browser)
   only with the owner present, as in `TEST_MATRIX.md`; for the YouTube
   route: `pnpm run dev`, wait for READY wakeword/stt/tts, say "Jarvis open
   YouTube for me", confirm the browser and the spoken reply, capture the log.
5. A check that cannot run here is BLOCKED and listed as owed, never PASS.
   No isolated test covers open_app "notepad"/"cmd" or "open YouTube for me".

Forbidden: changing assertions or expected results; skipping a listed
test; reporting PASS without running the command; running test files
directly (`npx tsx tests/<name>.ts` writes JARVIS's real data); calling a
voice bug fixed from mock tests; live checks without the owner.

## Outputs

`runs/<run>/verification.md` from `output/verification.md`: each command,
machine, raw result, live-check log (or why it is owed), remaining issues.

## Audit / advancement

- PASS: type check 0 errors, regression test and required tests pass,
  no new FAIL in `--ci`, live check passed when required. Advance to
  `05b_review`.
- INCOMPLETE: tests pass but a required live check is owed or BLOCKED.
  Advance to `05b_review`; Stage 06 cannot report the bug fixed.
- FAIL: a required test fails. Return to `04_implementation` (or
  `02_diagnosis` if the cause was wrong).
- A failure that also fails on the base commit is recorded as pre-existing,
  with the base-commit result.
