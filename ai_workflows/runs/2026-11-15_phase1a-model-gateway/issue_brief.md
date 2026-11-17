# Issue Brief — Phase 1A: model gateway foundation

> Stage: 01_intake · Run `2026-11-15_phase1a-model-gateway` · Tracker tasks MM-1A-01 … MM-1A-07
> Source: owner request 2026-11-15 (Gate 0 approved with conditions); Gate 0 problems G0-01 … G0-08, G0-14
> (`docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md`).

## What the owner asked for

1. Model calls go where each role is configured to go.
2. Today's default model behaviour stays exactly as it is.
3. Each provider has its own circuit breaker and rate limit.
4. Providers declare their capabilities.
5. Usage records survive a restart.
6. coding_agent and qa_agent can use independently configured models.

## Constraints from the owner

- Protected files: plan only; each change is approved separately.
- No test weakened, deleted or bypassed; no broad rewrites; no unneeded dependencies or paid services; local-first.
- Approval gate and self-healing security unchanged.
- No commit, push or merge without approval; `main` untouched.
- No Phase 1B work (new providers, Gemini/OpenAI/Jev adapters) in this run.

## Runtime issue record

None: this is a design gap, not a runtime failure. There is nothing in `data/repairs/issues.json` to link.
