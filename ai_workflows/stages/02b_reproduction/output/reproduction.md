# Reproduction — [Replace with Bug Name]

> Stage: 02b_reproduction · Template. Copy to `ai_workflows/runs/<run>/reproduction.md`
> and fill in the copy; leave this file blank.
> Date: [fill in] · Machine: [owner's Windows PC / CI / other host — name it]

---

## Failure Being Reproduced

| Field | Value |
|---|---|
| Issue ID | [`iss-…` from the issue brief, or "none (no runtime issue)"] |
| Symptom | [exact, from the issue brief] |
| Expected behaviour | |
| Observed behaviour | |
| Affected file / subsystem | [from the diagnosis] |
| Trigger steps | 1. … |

## Method

- [ ] Existing test: `tests/<name>.ts`
- [ ] New regression test (draft, not committed): `tests/<name>.ts`
- [ ] Manual check on the owner's PC (owner present)
- [ ] None possible (fill in the Exception section)

## Commands and Output

```
[exact command, e.g. pnpm test -- --only=<name>]
[paste the runner lines and the failing assertion message; never invent output]
```

Runs: [n] · Failed: [n] (for a flaky result)

## Result Label (choose one)

| Label | Meaning |
|---|---|
| REPRODUCED | An automated test fails now, for the diagnosed reason |
| REPRODUCED-MANUAL | Seen by the owner on the real PC, with captured logs |
| MOCK-ONLY | Reproduced only with stand-ins for speech, browser or OS |
| FLAKY | Fails in some runs only (counts above) |
| INFERRED | Cause deduced from code or logs; nothing was run |
| NOT REPRODUCED | Tried; the failure did not appear |
| BLOCKED | Needs hardware, OS or a service this machine lacks |

Label: [ ]

Why the failure matches the diagnosed cause: [ ]

## Exception (any label other than REPRODUCED / REPRODUCED-MANUAL)

- Why reproduction is unavailable: [ ]
- Evidence that exists (logs, issue record, owner report): [ ]
- Evidence that would verify a fix: [ ]
- Owner-PC steps (shell, command, what to say/click, expected log lines): [ ]

## Ready for Patch Plan?

- [ ] Label recorded honestly; no runtime code or existing test changed
- [ ] REPRODUCED / REPRODUCED-MANUAL, or the exception is written out for the owner
