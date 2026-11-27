# CONTEXT_LOADING_RULES.md — What to Read for Each Bug Type

> These rules prevent AI agents from loading irrelevant files,
> which wastes context budget and increases the risk of accidental changes.

---

## General Rule

> Load ONLY the files necessary to understand and fix the specific bug.
> Do not load all files "just in case."
> Do not load node_modules, .venv, logs, generated reports, or temp files unless explicitly needed.

---

## `_config/` Safety (applies to every task)

- Never load `_config/` as a folder (no `_config/*`, no "read every config
  file"). Open a `_config/` file only when this file, `ai_workflows/CONTEXT.md`
  or the current stage's `CONTEXT.md` names it.
- Never open, print, copy, stage or commit a file whose name suggests a
  secret: token, secret, password, credential, private key, `.env`. The
  Git-ignored `_config/github my persnal tokens.txt` on the owner's PC is one:
  do not open it; moving it out of the repository is the owner's decision.
- Never write a credential value anywhere (reports, logs, commits). Say only
  whether a key is set (SET / EMPTY).
- `_config/add this to your fyp projct.txt` belongs to the owner's separate
  university attendance (FYP) project, not JARVIS. Do not load it for JARVIS
  work. Moving it is pending the owner's approval; do not move or copy it.

---

## What to Load for Each Bug Type

The load lists (and what not to load) for voice, memory, tool/skill,
state-machine, self-healing, TypeScript-compile and performance bugs are in
`CONTEXT_LOADING_BY_BUG_TYPE.md`. Open only the section for the bug at hand.
Agent, Windows/browser and Obsidian work: the `ARCH_*.md` file named in
`ARCHITECTURE_MAP.md`, then only the files it lists for the problem.

---

## Documentation / Workflow Tasks

**Task examples:**
- Creating workflow documents
- Writing audit reports
- Updating JARVIS_CURRENT_STATUS.md

**Load only:**
```
ai_workflows/CONTEXT.md
The specific _config/ files the task names (never the whole folder; see _config/ Safety)
```

**Do NOT load or modify:**
```
Any runtime file
Any test file
.env
memory/*
voice/*
bridge/*
```

---
## Files Never to Load Unnecessarily

```
node_modules/          ← Never
.venv/                 ← Never
logs/*.jsonl           ← Only if analyzing specific log events
memory/jarvis_memory.json  ← Only if debugging stored facts
jarvis_structure.txt   ← Never (11MB, useless for code bugs)
jarvis_structure_utf8.txt  ← Never
project_tree.txt       ← Never
analysis.json          ← Only if doing a module audit
temp_stt_*.wav         ← Never
```
