# Remediation report

Branch `claude/jarvis-repair`, starting from `30605cf`. Basis: the Master Findings Register. Each finding was re-checked in the code first, reproduced where possible, then fixed with a regression test. Status per finding: `REMEDIATION_TRACKER.md`. Test numbers: `TEST_RESULTS.md`. What stays open: `REMAINING_RISKS.md`.

Nothing was pushed. `main` was not touched. No database, memory file or user file was deleted.

## Commits

| Commit | Phase | Findings |
|---|---|---|
| `d352a8f` | 1 | BUG-02, REL-01, SEC-01, SEC-11, HYP-01 |
| `c8ae2e3` | 2 (part 1) | SEC-02, SEC-03, SEC-04, SEC-05, SEC-06, SEC-07, SEC-17, SEC-18 (and TEST-03, OPS-03) |
| `00593e4` | 2 (part 2) | SEC-08, SEC-09, SEC-10, SEC-12, SEC-19 |
| `9ec6311` | 2 (part 3) | SEC-13, SEC-14, SEC-15, SEC-16, SEC-20 (and REL-08) |
| `9a851eb` | 3 | BUG-01, REL-02, REL-03, REL-04, REL-05, REL-06, REL-07, HYP-02, PERF-03 |
| the commit adding this file | 4 and 5 | TEST-01, TEST-02, TEST-04, ARCH-06, ARCH-07, ARCH-08; the rest documented |

## What changed, in short

### Stronger protections

- **Bridge (SEC-01, SEC-11):**
  - web pages are refused in every mode;
  - the token compare is constant-time;
  - message size is capped;
  - `/health` returns statuses only.
- **Vector memory service (SEC-18):**
  - needs a token on every route but `/liveness`;
  - refuses web origins and non-JSON POSTs;
  - its docs pages are off.

  Before: a web page could empty it.
- **Voice approval (SEC-02):** a spoken "yes" approves up to level 2. Above that you type.
- **Prompt injection (SEC-03):**
  - tool output, memory and replies built from tool output reach the model only as marked data;
  - the registry still refuses what the model asks for.
- **Navigation (SEC-04, SEC-17):** local and private addresses you did not name need approval, and redirects onto them are stopped.
- **Memory (SEC-05, OPS-03):**
  - every fact records where it came from;
  - `forget_memory` deletes a fact and its search entry.
- **Child processes (SEC-06):** they no longer receive JARVIS's API keys and tokens.
- **Scripts in other projects (SEC-07):** need approval when an agent runs them.
- **Nested approvals (SEC-08):** an approval covers the call you approved, not other tools it calls.
- **Fallbacks (SEC-09):** a fallback riskier than its tool is refused.
- **Disguised commands (SEC-10, SEC-20):**
  - `shut^down`, ``Stop-Comp`uter``, `iex`, encoded and joined commands are refused;
  - so are cmd.exe `%VAR%`, `^` and `!` in `run_command`.
- **Full control (SEC-12, SEC-19):**
  - limited to 30 minutes, extensions included;
  - an edited session file claiming longer is not restored.
- **Background goals (SEC-13):** recurring, permanent or desktop goals ask you once.
- **Secret files (SEC-14):** files named for keys, tokens or passwords are not read, compared, indexed or uploaded.
- **Self-repair installs (SEC-15):**
  - pinned to `requirements.txt`;
  - only into `.venv`;
  - only with your approval;
  - `difflib` removed.
- **Skills (SEC-16):** only folders listed in `skills/trusted-skills.json` load.

### Bugs reproduced and fixed

| ID | Before | After |
|---|---|---|
| BUG-02 | A repaired task ended with "unexpected error" (illegal transition SPEAKING → EXECUTING) | Progress messages no longer move the state machine |
| REL-01 | A stuck command held the action queue (a quick call waited 39.8 s) | The whole process tree is stopped; the quick call returns in 0.8 s |
| BUG-01 | A repaired plan A → B → C stopped after A | B and C run again with A |
| HYP-02 | The first request after start was planned without the skill tools | The first request waits for them |
| REL-04 | Overlapping requests lost track of the running goal | Goals are tracked per request |
| REL-06 | A low-risk action that threw was run 3 times | Run once; reads and searches still retry |
| PERF-03 | The 15 s planning watchdog cut off the model's own retries (3 × 10 s) | Watchdog derived from the retry budget (32 s) |
| REL-02 | Uncaught errors were logged and JARVIS ran on in an unknown state | It saves and exits with code 1; `pnpm dev:supervised` restarts it |

### Who decides what (ARCH-05)

A tool call passes these layers in order. A layer can refuse what an earlier one allowed; none can allow what an earlier one refused.

| Order | Layer | File | Decides |
|---|---|---|---|
| 1 | Registry dispatch floor | `core/toolRegistryV2.ts` | The tool's minimum permission level (`requiredLevel`) |
| 2 | Risk engine | `security/riskEngine.ts` | This call's level 0–4 from its arguments; refusals (critical, obfuscated, secret) |
| 3 | Policy decision | `riskEngine.decide()` | Run, ask, or deny, from the level, the session and `JARVIS_LEVEL2_POLICY` |
| 4 | Approval gate | `security/approvalGate.ts` | Your answer; voice limit (SEC-02); nested scope (SEC-08) |
| 5 | Controller | `control/*.ts` | Last checks next to the effect: protected processes, services and paths |
| 6 | Verifier | `core/verifiers.ts` | Whether the effect really happened |

Agents add a cap first (`maxRisk`, denied tools and categories in `core/agents/permissions.ts`).

## What to test on your PC

Use **CMD**, in the JARVIS folder. Run one step at a time.

1. Get the branch. Your `main` is not changed.
   ```
   git fetch origin
   git checkout claude/jarvis-repair
   git pull
   ```
   Nothing was pushed from here. If `git pull` reports no new commits, the branch has not been pushed yet; ask for it to be pushed first.

2. Install and check types:
   ```
   pnpm install
   pnpm run typecheck
   ```
   Expect no errors.

3. Run the whole suite on Windows:
   ```
   pnpm test
   ```
   The last line shows passed · failed · skipped. Please send the "Real failures" list if there is one. This is the first Windows run of these changes (REL-09).

4. Run the Windows check:
   ```
   pnpm verify:windows
   ```

5. Check your `.env` (a text editor is fine):
   - if it has `JARVIS_PLANNING_WATCHDOG_MS=20000`, empty the value; JARVIS warns at start otherwise;
   - optional: `JARVIS_VOICE_APPROVAL_MAX_RISK=1` to type every level-2 approval too;
   - move the token from `ai_workflows\_config\github my persnal tokens.txt` into `.env` as `GITHUB_TOKEN=...`, then delete that file yourself.

6. Start JARVIS with the restart supervisor:
   ```
   pnpm dev:supervised
   ```
   Then try:
   - "open notepad" → opens (level 1, no question);
   - "every morning at 9 summarise the news" → JARVIS asks once before recording it (SEC-13);
   - say "yes" to a level-3 request → JARVIS asks you to type approve (SEC-02);
   - "read the file github my persnal tokens" → refused (SEC-14);
   - turn on full control for 120 minutes → you get 30 (SEC-12).

7. Vector memory: on the first start JARVIS creates `data\security\vector_token`. If the vector service was already running from an older start, restart it once (close JARVIS, then start again) so both sides use the token.

8. If you add your own skill later, trust it after reading its code:
   ```
   npx tsx scripts/trustSkills.ts my_skill_folder
   ```
