/**
 * tests/livePreflight.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * For live-provider tests (pnpm test:live): before any command, check that the
 * configured provider has a key and answers. If not, print "BLOCKED: <reason>"
 * and exit 3, which tests/runAll.ts reports as blocked (not verified), within
 * seconds instead of a 120 s timeout or a pass with no provider. The key is
 * never printed.
 */

import { llmStatus, classifyLLMError } from '../bridge/llmStatus.js';
import { groqProvider } from '../bridge/groqProvider.js';

export function blocked(reason: string): never {
  console.log(`BLOCKED: ${reason}`);
  process.exit(3);
}

export async function requireLiveProvider(): Promise<void> {
  const status = llmStatus.snapshot();
  if (!status.hasKey) blocked(`no API key for the configured provider (${status.provider}); set it in .env (GROQ_API_KEY or GEMINI_API_KEY)`);
  try {
    await groqProvider.ping(AbortSignal.timeout(10_000));
  } catch (err) {
    const c = classifyLLMError(err);
    // A rate limit means the provider answered: the run can go ahead.
    if (c.kind !== 'rate_limit') blocked(`${status.provider} at ${status.host} is not usable: ${c.kind}: ${c.message.slice(0, 160)}`);
  }
  console.log(`Provider ${status.provider} (${status.model}) at ${status.host} answered.`);
}
