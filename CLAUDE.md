# CLAUDE.md — Start Here

This file only points the way. The rules live in `ai_workflows/`.

1. Read `ai_workflows/CLAUDE.md` and follow its development-workflow contract.
2. For a bug fix or maintenance task, go to `ai_workflows/CONTEXT.md` and work
   through the stages: intake, diagnosis (with reproduction evidence), patch
   plan. Implementation starts only after the owner approves the plan.
3. Where each fact lives: `ai_workflows/_config/SOURCES_OF_TRUTH.md`.
   What to load: `ai_workflows/_config/CONTEXT_LOADING_RULES.md` (never the
   whole `_config/` folder, never a file named for a token, password or key).

Always:
- No destructive cleanup (`git clean`, `git reset --hard`, `git checkout -- .`),
  no broad rewrites, no deleting or moving files without the owner's approval.
- Stage files by name (`git add -- <file>`), never `git add .` or `-A`.
- Run tests through the runner (`pnpm test -- --only=<names>`, `pnpm test -- --ci`),
  never `npx tsx tests/<name>.ts`; add a regression test for each fix.
- Report results truthfully: command, machine, output. A Linux or CI pass is
  not a live check. Voice, microphone, speaker and Windows behaviour count as
  fixed only after a live run on the owner's PC.
- Protect: runtime data (`data/`, `memory/`), credentials, browser automation,
  Windows control, voice, the agent roles (JARVIS and its seven specialists)
  with their permissions and spawn limits, the tool registry and risk levels,
  and the approval gates (code repair needs the owner's typed approval).
  See `ai_workflows/_config/RUNTIME_PROTECTED_FILES.md`.
