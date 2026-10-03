/**
 * tests/providerFailoverTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS-016 — the router had exactly one provider registered, so a Groq outage
 * was a total reasoning outage.
 * JARVIS-010 — the Groq response-cache key hashed only the first 200 characters
 * of each message, so two different requests sharing a prefix collided.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModelRouter } from '../bridge/modelRouter.js';
import { OpenAICompatibleProvider } from '../bridge/openaiProvider.js';
import { getWorkspaceRoot } from '../core/workspaceRoot.js';
import type { ILLMProvider, ILLMRequest, ILLMResponse } from '../bridge/llmTypes.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`);
    failed++;
  }
}

function provider(name: string, behaviour: 'ok' | 'throw'): ILLMProvider & { calls: number; isConfigured(): boolean } {
  return {
    calls: 0,
    isConfigured: () => true,
    async chat(_req: ILLMRequest): Promise<ILLMResponse> {
      (this as { calls: number }).calls++;
      if (behaviour === 'throw') throw new Error(`${name} is down`);
      return { content: `answer from ${name}` };
    },
  };
}

const req: ILLMRequest = { messages: [{ role: 'user', content: 'hello' }] };

console.log('\n=== Provider Failover Test ===\n');

console.log('--- A failing primary falls through to the fallback ---');
{
  const router = new ModelRouter('groq');
  const down = provider('groq', 'throw');
  const up = provider('openai', 'ok');
  router.registerProvider('groq', down);
  router.registerProvider('openai', up);

  const res = await router.chat(req);
  ok('a response was still produced', res.content === 'answer from openai', res.content);
  ok('the primary was attempted', down.calls === 1, `${down.calls} call(s)`);
  ok('the fallback was attempted', up.calls === 1, `${up.calls} call(s)`);
}

console.log('\n--- A healthy primary is not bypassed ---');
{
  const router = new ModelRouter('groq');
  const up = provider('groq', 'ok');
  const spare = provider('openai', 'ok');
  router.registerProvider('groq', up);
  router.registerProvider('openai', spare);

  const res = await router.chat(req);
  ok('answered by the primary', res.content === 'answer from groq', res.content);
  ok('the fallback was never called', spare.calls === 0, `${spare.calls} call(s)`);
}

console.log('\n--- All providers down surfaces the error ---');
{
  const router = new ModelRouter('groq');
  router.registerProvider('groq', provider('groq', 'throw'));
  router.registerProvider('openai', provider('openai', 'throw'));
  let threw = false;
  try { await router.chat(req); } catch { threw = true; }
  ok('the failure is surfaced, not swallowed', threw);
}

console.log('\n--- An explicitly requested provider is honoured exactly ---');
{
  const router = new ModelRouter('groq');
  const down = provider('groq', 'throw');
  const spare = provider('openai', 'ok');
  router.registerProvider('groq', down);
  router.registerProvider('openai', spare);

  let threw = false;
  try { await router.chat(req, 'groq'); } catch { threw = true; }
  ok('a named provider does not silently fail over', threw);
  ok('the other provider was not substituted', spare.calls === 0, `${spare.calls} call(s)`);
}

console.log('\n--- An unconfigured fallback is skipped ---');
{
  const unconfigured = new OpenAICompatibleProvider('https://api.openai.com/v1', '', 'gpt-4o-mini');
  ok('a keyless default endpoint reports unconfigured', unconfigured.isConfigured() === false);
  const local = new OpenAICompatibleProvider('http://127.0.0.1:11434/v1', '', 'llama3');
  ok('a local endpoint needs no key', local.isConfigured() === true);
  const keyed = new OpenAICompatibleProvider('https://api.openai.com/v1', 'sk-test', 'gpt-4o-mini');
  ok('an API key alone is enough', keyed.isConfigured() === true);
}

console.log('\n--- JARVIS-010: the cache key covers the whole message ---');
{
  const src = fs.readFileSync(path.join(getWorkspaceRoot(), 'bridge', 'groqProvider.ts'), 'utf8');
  const hashFn = src.slice(src.indexOf('hashRequest'), src.indexOf('hashRequest') + 900);
  // Strip comments first: the fix is documented by a comment that quotes the old
  // truncation, which would otherwise match the very pattern being ruled out.
  const code = hashFn
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  ok('no 200-char truncation remains in the cache key', !/slice\(0,\s*200\)/.test(code));
  ok('full message content is hashed', /c:\s*m\.content\s*\?\?\s*''/.test(code));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
