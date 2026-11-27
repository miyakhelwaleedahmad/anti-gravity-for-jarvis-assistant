# Windows PC verification checklist: Phase 1A

> Nothing on this list has been run. Every Phase 1A result so far comes from Linux in a cloud container, with stand-in providers.
> Run these on the owner's Windows PC with real API keys, in **PowerShell**, from the JARVIS folder. Record each result (pass/fail and what you saw) at the bottom of this file or in `verification.md`.
> Settings go in `.env`. Restart JARVIS (`pnpm start`) after changing it.

## 0. Before you start

1. **Check the code builds and the Windows-only tests run.**

   ```powershell
   pnpm run typecheck
   pnpm test -- --ci
   ```

   Expected: typecheck exits 0, and the suite reports 0 failed. On the PC, the tests skipped on Linux should now run:
   - Windows, PowerShell 7, Redis, `.venv` and bridge-token tests;
   - `realTtsHandoffTest`.

   Note every test that still skips, with the reason it gives.
2. **Keep a copy of `.env`** before changing any setting below, so you can restore it.

## 1. Actual Claude model identity

1. **Set a strict Claude route.** In `.env`:

   ```
   JARVIS_MODEL_REVIEW=anthropic:<your Claude model alias>
   ```

   Then run one code-repair review, or a goal whose criterion is checked by review.
   - **Expected:** it succeeds.
   - **If it fails with "model identity not confirmed":** record the model name in the message. It is the id Claude reported, and it doesn't match the alias or the id its model list returned.
2. **Check what the usage log recorded.**

   ```powershell
   Get-Content data\usage\model_usage.jsonl -Tail 3
   ```

   **Expected:** `model` is the alias; `servedModel` is the id Claude reported. Record both.
3. **Repeat with a dated model id** instead of the alias. **Expected:** it succeeds.

## 2. Gemini / Groq model identity

1. **Set a strict route on the Gemini or Groq primary.** In `.env`:

   ```
   JARVIS_MODEL_AGENT_CODING_AGENT=<gemini or groq>:<brain model>
   ```

   Ask JARVIS to explain a file (a coding task). **Expected:** it is answered.
   - **If it fails with "model identity not confirmed":** record the reported model string (for example a `models/` prefix or a version suffix). This decides whether strict Gemini/Groq routes can be used as configured.
2. **Look at the usage record:**

   ```powershell
   Get-Content data\usage\model_usage.jsonl -Tail 3
   ```

   Record the `servedModel`.
3. **Under a real rate limit**, if one happens or the free tier is used up: the strict call fails. It is never answered by the fast model (check `servedModel`).

## 3. Strict coding-agent routing

With `JARVIS_MODEL_AGENT_CODING_AGENT` set:

1. **"What changed in git recently?"** Expected: answered, with the usage record on the configured model.
2. **"Explain the router code; then explain the agent manager code."** Expected: every `code_analysis_worker` usage record uses the configured model, never the default.
3. **Temporarily set a wrong model name** and ask again. Expected:
   - the task ends **FAILED** with the provider's reason;
   - no other model answers;
   - nothing is "answered by keyword rules".

## 4. Research-worker inheritance

With `JARVIS_MODEL_AGENT_CODING_AGENT` set, ask: **"Find TypeScript libraries for Chrome DevTools Protocol."**

1. **Expected:** in the usage records, the coding agent's own call and the deep-analysis worker's call both use the configured model.
2. **With a wrong model name:** the task ends FAILED. No rule-based answer is given.

## 5. Independent QA with genuinely different models

1. **Different models (should pass).** Set coding and QA on different providers:

   ```
   JARVIS_MODEL_AGENT_CODING_AGENT=anthropic:<model>
   JARVIS_MODEL_AGENT_QA_AGENT=<gemini or groq>:<model>
   JARVIS_QA_REQUIRE_INDEPENDENT=true
   ```

   Ask QA to review a change summary. **Expected:**
   - COMPLETED;
   - the result's `data.independence.status` is `independent`;
   - `qaModels` names the model really used.
2. **Same model (should fail closed).** Set QA to the same model as coding. **Expected:**
   - FAILED, "independent QA unavailable … human review required";
   - no QA model call in the usage records.
3. **An alias of coding's model** (a dated id, or a gateway id for the same model). **Expected:** FAILED, the same as the same-model case.
4. **Not required.** Set `JARVIS_QA_REQUIRE_INDEPENDENT=false`. **Expected:** QA runs, is labelled not independent, and no identity look-up happens.
5. **Look-up time limit.** Note how long QA takes to start when independence is required: this is the identity look-up. `JARVIS_QA_IDENTITY_LOOKUP_MS` limits it (default 10000 ms).

## 6. Provider fallback behaviour

1. **Non-strict conversation fallback.** Make the conversation provider fail, for example by setting `JARVIS_MODEL_CONVERSATION` to a provider with a wrong key. Expected:
   - the fallback provider answers;
   - the same provider is tried again only after a "model not found" kind of error;
   - after a sign-in, network, rate-limit or server error it is not tried again.
2. **Strict route: no fallback.** Make a strict route fail (`JARVIS_MODEL_REVIEW` with a wrong key). Expected: it fails with the reason, and no other provider answers.
3. **Claude without server-side fallbacks on a strict route.** If a policy refusal happens, record what JARVIS says.

## 7. Verification failures

1. **Research with an unreachable source.** Run a research request whose answer cites a GitHub repository while GitHub can't be reached (disconnect the network for the check, or use a repository that doesn't exist). Expected:
   - the console shows `Verification: inconclusive` with `?` lines;
   - JARVIS says the result needs your review;
   - nothing is added to long-term memory for it.
2. **The same inside a goal.** Expected:
   - the goal task becomes **needs review**, with code `VERIFICATION_INCONCLUSIVE`;
   - the goal waits for you.

## 8. Voice interaction after a provider failure

1. Start JARVIS (`pnpm start`) with a strict agent route that will fail. Ask a coding question by voice.
   - **Expected:** JARVIS reports the failure in speech, and the conversation keeps working.
   - **Then:** ask an ordinary question. It is answered by the conversation model.
2. **While talking, start a background agent task.** Expected:
   - your replies aren't delayed;
   - the background call waits;
   - if `JARVIS_MODEL_QUEUE_WAIT_MS` is set, a background call that waits longer than that ends with a clear error.
3. **Barge-in** during a spoken failure message still stops the speech.

## Results

| Section | Result | Notes (model strings, messages, timings) |
|---|---|---|
| 0 |  |  |
| 1 |  |  |
| 2 |  |  |
| 3 |  |  |
| 4 |  |  |
| 5 |  |  |
| 6 |  |  |
| 7 |  |  |
| 8 |  |  |
