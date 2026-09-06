# SECURITY_RULES.md — Security Rules for JARVIS Development

> These rules protect against command injection, privilege escalation, and unsafe execution.

---

## Deterministic Router Security Rules

```
✅ The deterministic command router ONLY handles known safe aliases
✅ Aliases are a hardcoded whitelist — never dynamically generated
✅ Unknown app names must NOT match the router
✅ Unknown app names must fall through to the LLM planner / security check

❌ NEVER broaden open_app matching without:
   1. Adding exact test cases for new aliases
   2. Adding malicious input tests to Section 4 of deterministicCommandRouteTest.ts
   3. Verifying that "launch cmd /c del *" STILL does NOT match "cmd"
```

---

## Shell Command Security Rules

```
✅ open_app must ONLY execute its hardcoded resolved target
✅ Windows shell command format: cmd.exe /c start "" <resolved-target>
✅ The empty string "" after start prevents target from being parsed as a window title
✅ Resolved target comes from the hardcoded ALIASES map — never from raw user input

❌ NEVER pass raw user text directly into:
   - spawn() or exec() arguments
   - cmd.exe /c strings
   - PowerShell commands
   - start "" arguments

❌ NEVER allow strings like:
   - "cmd /c del *"    → must NOT match "cmd" alias
   - "open regedit"    → must NOT be in ALIASES
   - "open system32"   → must NOT be in ALIASES
   - "open virus.exe"  → must NOT be in ALIASES
   - "open unknownApp" → must NOT be in ALIASES
```

---

## Prefix Match Security Rule

The deterministic router uses a strict remainder check to prevent injection:

```typescript
// SAFE implementation:
if (stripped.startsWith(alias + ' ')) {
  const remainder = stripped.substring(alias.length).trim()
    // strip known filler words only
    .replace(/\bfor me\b/g, '')
    .replace(/\bplease\b/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/\ba\b/g, '')
    .trim();
  if (remainder === '') return target;  // ONLY match if nothing meaningful remains
  // Non-empty remainder = extra tokens = unsafe — do NOT match
}

// VULNERABLE (do not use):
if (stripped.startsWith(alias)) return target;
// ^ This lets "launch cmd /c del *" match "cmd" because "cmd c del" starts with "cmd"
```

**The vulnerable form was found and fixed. Never revert to it.**

---

## Approval Gate Rules

```
✅ Dangerous actions require confirmation via security/approvalGate.ts
✅ run_command tool is classified as HIGH RISK — requires explicit approval
✅ write_file tool is classified as MEDIUM RISK — requires path validation
✅ delete operations must never be auto-approved

❌ Do not bypass approvalGate.ts for any reason
❌ Do not downgrade risk levels (high → medium, medium → low) without diagnosis
```

---

## Security Test Requirements

Every security boundary test in deterministicCommandRouteTest.ts Section 4 must pass:

```
✅ "open system32"         → null (NOT matched)
✅ "open regedit"          → null (NOT matched)
✅ "launch cmd /c del *"   → null (NOT matched)  ← CRITICAL: was broken, now fixed
✅ "start taskmgr /cleanup" → null (NOT matched)
```

If any of these return a non-null result, there is a security regression.

---

## Environment Security Rules

```
❌ Never log API keys, tokens, or passwords
❌ Never commit .env file contents
❌ Never read .env and forward it to an LLM prompt
❌ Never trust user voice input as a safe shell command
❌ Never allow voice input to directly become a file path or command argument
```

---

## Python Process Security Rules

```
✅ Python voice services run as child processes with limited I/O
✅ Python scripts communicate via WebSocket messages only
✅ Python scripts must not receive raw shell commands from NodeBridge
❌ Do not add arbitrary Python script execution from NodeBridge
❌ Do not allow voice/wakeWords.py to execute anything other than voice detection
```
