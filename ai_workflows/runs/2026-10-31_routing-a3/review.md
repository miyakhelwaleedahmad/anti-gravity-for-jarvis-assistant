# Review — routing (phase A3)

Reviewer: a separate agent session (general-purpose), read-only, tests through the runner only. Not a human.

## Round 1 — CHANGES REQUIRED

The reviewer ran 17 tests through the runner (17 passed, the DO_NOT_BREAK set included), `tsc --noEmit` (0 errors) and two probes (routes, phrase matcher and normaliser edge cases; the risk decision for `control_browser close` at levels 0 and 2).

Approval skip (N-PC3): sound. The approval scope is created only by `toolRegistryV2.execute`, after the owner approved, and holds the args the skill receives. Another tool's approval is removed before a nested call (`withoutApproval`). Parallel calls each have their own `AsyncLocalStorage` context. Repairs run after the scope ends. Agents cannot call the tool. The tool is risk 3 with no per-action override, so the registry always asks first, by route, planner or control centre (typed only by default). Full control is enabled only after exactly one owner approval.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R1 | med | "close the tab", "close my tab", "close the first tab" (and it / your / one / second / next / previous / left / old) routed to `close_browser_tab` with the filler word as the name; `findTab` closes the first tab whose title or URL contains it, and with full control on there is no question: "close the tab" could close a "The Guardian" tab | **Fixed**: those words (and a, an, his, her, our, their, its, third, prev, right, tab, tabs) are not a tab name; 11 tests; mutant M12 caught |
| R2 | low | "close the github.com tab" routed with the name `githubcom`, which matches no URL | **Fixed**: the name is read with its dots; tests; mutant M13 caught |
| R3 | low (records) | change_log cited D6 for the double approval; D6 is the security probe, and the cause was not in diagnosis.md | **Fixed**: D7 added; change_log cites it |
| R4 | info | verification.md pointed to a review.md that did not exist yet | **Fixed**: this file |
| R5 | info | No test that another approval in scope still makes the skill ask; the action check was case-sensitive | **Fixed**: `isSameCall` (same tool, same arguments); three direct-call tests. On the old guard, an approval of this tool with other arguments turned full control on without a question (not reachable today, per the reviewer, but now tested); mutant M14 caught |
| R6 | info | The phrase matcher also accepts "enable full central mode", "unable full control", "enable fall control"; rejects disable, off, extra words, questions, look-alike letters | No change: the approval is always asked, so a false match only adds a question |
| R7 | info | Normaliser: "please.open notepad" now routes to open notepad (before: no route); path text loses its dots ("notes/../x" → "notesx") | No change: the route does what was said; no path text gets through |

Other checks without a defect: route order ("close current tab", "close all tabs", "close the browser tab", "close chrome"); shell text in a tab name reaches only a substring match and the spoken reply; P4 maps a refusal to "not approved"; P5 only adds the app tools when the browser and something else are named; the honestActionReplyTest wording change is legitimate; the evidence matches the records; no PC claims.

Mutation check after the round-1 fixes: **14/14 caught** (`evidence/a3_mut_run_review.txt`); tree restored.

## Round 2 — PASS

The reviewer ran 21 tests through the runner (21 passed, DO_NOT_BREAK included), `tsc --noEmit` (0 errors) and two probes: 49 route phrasings with timing on 50–60k-character inputs, and the number of questions through `toolRegistryV2.execute` for 7 argument shapes plus a refusal.

R1, R2, R5 fixed:
- Filler words no longer route.
- Dotted names keep their dot.
- The registry hands the skill the same `args` object it approved; nothing adds or removes keys on the way. So `isSameCall` holds for the registry's own call. Each shape (`{}`, `{durationMinutes:15}`, `{source:'voice',…}`, `{action:'enable'}`, `{action:'Enable'}`, `{durationMinutes:999}`) asked exactly once. "No" asked once and left full control off.

The regex is linear in practice (3–16 ms on 60k characters). Only the named-tab line reads the dotted text. Names with a stop word ("new york times", "google one") go to the planner: slower, still works.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| N1 | low | URL pieces were accepted as a tab name: "close the www tab", "close the http tab", "close the .com tab" match nearly every tab URL, and with full control on the first one closes without a question | **Fixed**: www, http, https, com, org, net are not a tab name. The list now matches whole words only (a dot is part of a word), so "github.com", "www.google.com" and "my.site" still route. 9 tests; mutant M15 caught |
| N2 | info | No length limit on a tab-name word (a 60k-character target) | **Fixed**: at most 64 characters per word; tests for 64 (routes) and 65 (does not); mutant M16 caught |
| N3 | info | `review_r1_new_code_run.txt` shows only the runner's PASS, not the check count | **Fixed**: the direct runs are kept with their counts (`evidence/review_n1_old_code_checks.txt`, `evidence/review_n1_new_code_checks.txt`) |

Tests first for N1/N2: on the code before those fixes, **78 passed, 7 failed** (the 7 URL-piece phrases; `evidence/review_n1_old_code_checks.txt`). The 64/65-character and "www.google.com" / "my.site" tests were added with the fix, not run on the code before it; mutant M16 shows the 65-character test fails without the cap. After: **89 passed, 0 failed** (`evidence/review_n1_new_code_checks.txt`). Mutation check: **16/16 caught** (`evidence/a3_mut_run_review2.txt`); tree restored.

The N1/N2 fixes were made after this PASS, so a round-3 check of them follows.

## Round 3 — PASS

The reviewer ran 16 tests through the runner (16 passed, DO_NOT_BREAK included), `tsc --noEmit` (0 errors) and a probe of 56 route phrasings and 7 timing shapes.

- N1 fixed: the URL pieces no longer route; "github.com", "www.google.com", "google.org", "netflix", "x.com", "stack overflow" still do.
- N2 fixed: 64 characters per word routes, 65 does not.
- R1 not reopened: "close the tab", "close my tab", "close my.tab", "close the the.tab", "close the my. tab" do not route. Dotted names that contain a filler word ("my.site", "this.tab", "www.com") now route; each searches only for its whole dotted text, never a bare filler word, and `close_browser_tab` has no Ctrl+W fallback.
- Still linear: 2–16 ms on 58–60k characters (7 shapes).
- Records match the evidence.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| N4 | info | verification.md row read as if the N2 checks had run on the old code | **Fixed**: the row says "N1 checks" and that the N2 checks came with the fix |
| N5 | info | Dotted names containing a filler or URL word now route | No change: safe, as above |
| N6 | info | 89/89 is from the direct run; the runner shows only PASS | No change: the runner run passes too |
