# Diagnosis — time questions refused (N-PC10)

Read-only: the owner's PC log, the code at `3ed4baf`, and `evidence/probe_before.mts` (output in `evidence/probe_before.txt`).

| ID | Finding | Evidence |
|---|---|---|
| D1 | The fast time answer matches three exact strings only: "what time is it", "time" and "what is the time". It runs after `normalizeVoiceInput`, which strips "can you", so "can you tell me time" arrives as "tell me time". Every other wording goes to the planner: "what time is this", "what's the time", "tell me the time", "time now", "current time" and "what time is it now". (The double space in the owner's "what  time is this" is not a cause: `normalizeVoiceInput` already collapses spaces. Found by mutant M2, which removed a redundant second collapse.) | `core/deterministicRoutes.ts:207`, `:314`; probe: of 26 wordings, only the three exact ones (plus "jarvis what time is it") reach the time route |
| D2 | There is no fast answer for the date: "what's the date" and "what day is it" go to the planner. | probe |
| D3 | The planner is told only `[SYS t=HH:MM:SS …]`, which is UTC (`toISOString().slice(11, 19)`): no date, no time zone, and nothing saying it is the clock. The owner's PC is UTC+5: the log shows 06:21 UTC against 11:21 on the PC. Unable to answer from that, the model calls `run_command` with `powershell` every time. That it was after the clock (`Get-Date`) is an inference: the log shows only the tool, the command name and the refusal. | `memory/unifiedContextBuilder.ts:253-256`; PC log: `[LLM:gemini] 🔧 Model called 1 tool(s): run_command`, five times |
| D4 | That line is also cached with the context: 5 s hot and 60 s LRU, by query. A cache hit, such as the owner's second "what time is this" ("⚡ Cache hit"), would reuse an old time. | `memory/unifiedContextBuilder.ts:80-97` |
| D5 | The refusal itself is correct: `powershell` is not on the developer allowlist, and the reply says so. It stays as it is. | `core/commandSafety.ts`; PC log `RISK_REFUSED` |
| D6 | A route with a reply and no handler of its own is spoken by the generic branch, so a new `date` route needs no orchestrator change. | `core/orchestrator.ts:851` (`this.speak(route.reply)`) |

Both files to change are protected (`ai_workflows/_config/RUNTIME_PROTECTED_FILES.md`): `core/deterministicRoutes.ts` and `memory/unifiedContextBuilder.ts`.
