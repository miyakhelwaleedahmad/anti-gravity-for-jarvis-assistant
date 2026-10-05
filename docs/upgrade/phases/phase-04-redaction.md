# Phase 4 — Secret redaction and data minimisation

## Goal
Credentials never reach the LLM, memory or logs; observations do not become
long-term memories by default; tools are rate-limited; outside-changing tools
are at least level 2; recent actions can be listed.

## Current system context
- Tool output goes unfiltered into: the task node result → synthesis prompt
  (`handleSuccess`), `agentMemory.addObservation`, `pushEpisode`,
  conversation memory; planning context (unifiedContextBuilder).
- Logs: `securityAuditLogger`, tool audit (`toolExecutionSandbox`), action
  audit (`actionAuditLog`), structured logger.
- No redaction exists anywhere.

## Required changes
1. `security/redactor.ts`.
2. Apply at sinks.
3. Memory policy.
4. Rate limits; external-change floor.
5. `action_history` tool.

## Implementation steps
1. `redactSecrets(text): { text, count, kinds }` with patterns for:
   Google keys (`AIza…`, `AQ.…`), OpenAI-style `sk-…`, Groq `gsk_…`, GitHub
   `ghp_/gho_/ghs_/github_pat_…`, AWS `AKIA…`, Slack `xox…`, JWT
   (`eyJ….….…`), `Authorization: Bearer …`, `Cookie:` / `Set-Cookie:` values,
   `-----BEGIN … PRIVATE KEY-----` blocks, `password|passwd|pwd|secret|token|api[_-]?key = …`
   pairs, URLs with `user:pass@`, `.env` lines whose name contains KEY, TOKEN,
   SECRET or PASSWORD. Replacement keeps the kind: `[REDACTED:github-token]`.
2. Sinks: executor result returned to the graph (orchestrator
   `makeMidMonitoredExecutor`), `agentMemory` (observations, episodes,
   conversation), `memoryManager` writes, `securityAuditLogger` lines,
   `toolExecutionSandbox` arg summaries, `actionAuditLog`.
3. `save_relation` / `rememberFact`: if the redactor finds a secret, refuse with
   "I don't store credentials".
4. Registry rate limit per tool per minute: risk 0 → 120, 1 → 60, 2 → 20,
   3–4 → 10 (env overrides); over the limit → `RATE_LIMITED` (fatal, honest).
   Tools with `external: change` → risk at least 2 (enforced in `riskOf`).
5. `action_history` (level 0): last N registry history records and approval
   decisions, redacted.

## Files to inspect
`core/orchestrator.ts`, `memory/agentMemory.ts`, `memory/memoryManager.ts`,
`memory/unifiedContextBuilder.ts`, `security/securityAuditLogger.ts`,
`core/toolExecutionSandbox.ts`, `control/actionAuditLog.ts`, `core/toolRegistryV2.ts`.

## Files that may be modified
The above plus `security/redactor.ts` (new), `core/tools/historyTool.ts` (new),
`core/tools/memoryTool.ts`, tests, docs.

## Dependencies
P1, P2 (P3 for the approval-history part).

## Tests
`tests/redactionTest.ts`: each pattern with synthetic secrets (never real
keys); plain text unchanged; end-to-end: a stubbed tool returns text with
planted secrets → no LLM request (spy on `modelRouter`), memory file, episode
log or audit log contains them; `save_relation` with a token refused; rate
limit trips at the limit; `action_history` output redacted.

## Acceptance criteria (here)
Zero planted secrets in any sink; suite unchanged.

## Security requirements
Redaction errors fail closed (drop the text, keep "[REDACTED]"); synthetic
test secrets only.

## Failure conditions
Any planted secret found in a sink; false positives that break ordinary tool
output in the existing suite.

## Completion requirements
Gate; checklist; PHASE_STATUS; SECURITY_MODEL; commit `phase-04-redaction`; CI green.
