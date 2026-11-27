# Stage 07 — Closure

Leave a complete, accurate record of the run in the repository, so the work
does not exist only in a conversation. Closure records; it never changes
runtime state.

## Inputs

| Source | Load | Why |
|---|---|---|
| `runs/<run>/` | Every artifact in the run folder | What happened |
| `runs/<run>/final_report.md`, `review.md` | Whole files | Verdict and review decision |
| `_config/SOURCES_OF_TRUTH.md` | Table and rules | Which tracker owns the ID |
| The owning tracker | Only the row for this finding ID | Current recorded status |
| `git log --oneline -5`, `git status` | Output | Final commit, clean tree |

## Process

1. Check the final report against `verification.md` and `review.md`: same
   results, same review decision, BLOCKED and SKIPPED items still listed.
2. Record files changed, final commit (or "no commit"), tests, known
   limitations and outstanding findings.
3. Make sure the run folder holds `issue_brief`, `diagnosis`,
   `reproduction`, `patch_plan`, `change_log`, `verification`, `review` and
   `final_report`. A stage that did not run is recorded as such, with the
   reason; never fill it in afterwards. Keep failed attempts and their
   evidence; never delete them to make the run look clean.
4. Tracker: find the owner of the ID in `SOURCES_OF_TRUTH.md`. Update that
   one existing row (status, run folder, commit) only when the task concerns
   that finding. Never copy it into a second tracker. BUG-n IDs have no
   tracker file: record them here only. No ID (documentation or maintenance
   work): write "Issue ID: none", never invent one.
5. Runtime issue (`iss-…`): never edit `data/repairs/issues.json` or
   `occurrences.jsonl`. JARVIS resolves an issue itself (the same effect
   working again, or a repair run whose check passed). Record the status
   last read and the owner action still needed, e.g. run JARVIS and ask
   "show the repair report". If the runtime is unavailable, say so.
6. Lessons and Obsidian: lessons come only from JARVIS's own resolution
   (`issueStore.onResolved` → `secondBrain.noteResolvedIssue`). Do not write
   a lesson, an error note or anything under the vault's `JARVIS/` folder by
   hand, and do not copy run documents into Obsidian.
7. List follow-up actions separately from completed work.
8. Commit the run folder and the runs index by name (see Stage 06 for the
   staging commands). Pushing needs the owner's approval.

## Outputs

`runs/<run>/closure.md` from `output/closure.md`, and one new row in
`runs/README.md`.

## Audit / advancement

- COMPLETE: verified fix, review PASS by an independent reviewer, no open
  runtime issue left unexplained.
- COMPLETE WITH LIMITATIONS: work done, with unverified parts (live check
  owed, review not independent, issue awaiting JARVIS) listed.
- BLOCKED: a required step could not run. Never reported as resolved.
- ABANDONED: stopped by the owner; the evidence is kept.
- Human approval: pushing, merging, tagging, or accepting a limitation as
  final.
