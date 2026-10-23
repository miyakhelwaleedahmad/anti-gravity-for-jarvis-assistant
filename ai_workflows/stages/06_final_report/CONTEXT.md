# Stage 06 — Final Report

Produce a complete, honest summary of the run, then commit the reviewed
files by name.

## Inputs

| Source | Load | Why |
|---|---|---|
| `runs/<run>/diagnosis.md`, `reproduction.md` | Root cause, label, exception | What was wrong, how it was shown |
| `runs/<run>/change_log.md` | Changed files | What changed |
| `runs/<run>/verification.md` | Results, owed checks | Evidence |
| `runs/<run>/review.md` | Decision, independence, findings | Review outcome |

## Process

1. Summarize the root cause, files changed and why, and test results
   (copied from the verification record, not retyped from memory).
2. Copy the review decision and whether the reviewer was independent.
3. List unresolved risks, owed live checks and follow-up items.
4. Choose the verdict (in `output/final_report.md`):
   - Fixed and verified: tests pass, live check passed when required,
     review PASS by an independent reviewer.
   - Partially fixed / not verified: anything owed, BLOCKED, or a review
     that was not independent.
   - Not fixed.
   A review of CHANGES REQUIRED or BLOCKED never yields "approved"; say
   what remains unresolved.
5. Commit only the files the review covered. If anything changed after the
   review, return to `05b_review`. Stage by name:
   ```
   git status
   git add -- <file1> <file2>
   git diff --cached --name-only
   (stop if the list shows runtime data, credentials or untracked
   personal files; unstage them with git restore --staged -- <file>)
   git commit -m "Fix [bug]: [one-line description]"
   ```
   Never `git add .` or `git add -A`.
6. Tag (`git tag stable-[feature]-v[N]`) only after live verification and
   only when the owner asks. Pushing and merging need the owner's approval.

Forbidden: claiming a fix that verification or review does not support;
omitting risks; editing runtime files; starting the next bug.

## Outputs

`runs/<run>/final_report.md` from `output/final_report.md`.

## Audit / advancement

- PASS: report matches the verification and review records; commit made
  (or "no commit" with the reason). Advance to `07_closure`.
- FAIL: the report claims more than the evidence; correct it first.
