/**
 * tests/llmProviderConfigTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider selection (Groq or Gemini) and the startup validator.
 *
 * Before this, the LLM address was hard-coded to Groq: GEMINI_API_KEY,
 * GEMINI_API_URL and even GROQ_API_URL were read by nothing, and the validator
 * accepted the unused XAI_API_KEY placeholder as an LLM key, so JARVIS started
 * with no way to reason.
 *
 * Every case passes its own environment; nothing here reads the developer's
 * .env or touches the network.
 */

// Blank every variable the validator reads before llmconfig's dotenv import
// runs: dotenv never overrides a variable that is already defined.
for (const name of [
  'GEMINI_API_KEY', 'GEMINI_API_URL', 'GROQ_API_KEY', 'GROQ_API_URL', 'XAI_API_KEY',
  'JARVIS_LLM_PROVIDER', 'JARVIS_BRAIN_MODEL', 'JARVIS_FAST_MODEL', 'JARVIS_LLM_REASONING_EFFORT',
]) process.env[name] = '';

const { resolveProviderSettings, isPlaceholderKey, geminiOpenAIBaseURL } = await import('../config/llmconfig.js');
const { configValidator } = await import('../config/configValidator.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const GEMINI_OPENAI = 'https://generativelanguage.googleapis.com/v1beta/openai';
const FAKE_GEMINI_KEY = 'AQ.test-gemini-key-0123456789abcdefghij';
const FAKE_GROQ_KEY = 'gsk_test0123456789abcdefghijklmnopqrstuvwxyz0123';

console.log('\n=== LLM Provider Config Test ===\n');

console.log('--- The .env shape that failed: Gemini key, xAI placeholder, bare API root ---');
{
  const s = resolveProviderSettings({
    XAI_API_KEY: 'your_xai_api_key_here',
    GEMINI_API_KEY: FAKE_GEMINI_KEY,
    GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1beta',
    JARVIS_BRAIN_MODEL: 'gemini-3.5-flash',
    JARVIS_FAST_MODEL: 'gemini-3.5-flash',
  });
  ok('Gemini is selected from its key', s.provider === 'gemini', s.provider);
  ok('the Gemini key is the one sent', s.apiKey === FAKE_GEMINI_KEY);
  ok('the bare /v1beta root is extended to the OpenAI-compatible path', s.baseURL === GEMINI_OPENAI, s.baseURL);
  ok('the extension is reported', s.notes.some((n) => n.includes('extended')));
  ok('models come from .env', s.model === 'gemini-3.5-flash' && s.fastModel === 'gemini-3.5-flash');
  ok('thinking defaults to minimal for Gemini', s.reasoningEffort === 'minimal', String(s.reasoningEffort));
}

console.log('\n--- Gemini defaults and URL forms ---');
{
  const s = resolveProviderSettings({ GEMINI_API_KEY: FAKE_GEMINI_KEY });
  ok('default address is the OpenAI-compatible endpoint', s.baseURL === GEMINI_OPENAI, s.baseURL);
  ok('default brain model is gemini-3.5-flash', s.model === 'gemini-3.5-flash');
  ok('default fast model is gemini-3.5-flash-lite (separate quota)', s.fastModel === 'gemini-3.5-flash-lite');
  ok('trailing slash from Google docs is accepted', geminiOpenAIBaseURL(`${GEMINI_OPENAI}/`) === GEMINI_OPENAI);
  ok('an /openai URL is left alone', geminiOpenAIBaseURL(GEMINI_OPENAI) === GEMINI_OPENAI);
  ok('a /v1 root is extended too', geminiOpenAIBaseURL('https://example.test/v1') === 'https://example.test/v1/openai');
}

console.log('\n--- Groq keeps working, and GROQ_API_URL is finally read ---');
{
  const s = resolveProviderSettings({ GROQ_API_KEY: FAKE_GROQ_KEY, GROQ_API_URL: 'https://proxy.example.test/openai/v1/' });
  ok('Groq is selected from its key', s.provider === 'groq');
  ok('GROQ_API_URL is used (trailing slash removed)', s.baseURL === 'https://proxy.example.test/openai/v1', s.baseURL);
  ok('no reasoning_effort is sent to Groq unless asked', s.reasoningEffort === undefined);
  ok('Groq defaults are unchanged', s.model === 'qwen-2.5-32b' && s.fastModel === 'llama-3.1-8b-instant');
  const d = resolveProviderSettings({ GROQ_API_KEY: FAKE_GROQ_KEY });
  ok('default Groq address unchanged', d.baseURL === 'https://api.groq.com/openai/v1', d.baseURL);
}

console.log('\n--- Choosing between two keys ---');
{
  const both = resolveProviderSettings({ GROQ_API_KEY: FAKE_GROQ_KEY, GEMINI_API_KEY: FAKE_GEMINI_KEY });
  ok('both keys: Groq, as before', both.provider === 'groq');
  ok('both keys: the choice is explained', both.notes.some((n) => n.includes('JARVIS_LLM_PROVIDER=gemini')));
  const forced = resolveProviderSettings({ GROQ_API_KEY: FAKE_GROQ_KEY, GEMINI_API_KEY: FAKE_GEMINI_KEY, JARVIS_LLM_PROVIDER: 'Gemini' });
  ok('JARVIS_LLM_PROVIDER=gemini wins (case-insensitive)', forced.provider === 'gemini' && forced.apiKey === FAKE_GEMINI_KEY);
  const bogus = resolveProviderSettings({ GEMINI_API_KEY: FAKE_GEMINI_KEY, JARVIS_LLM_PROVIDER: 'openai' });
  ok('an unknown provider name falls back to the keys, with a note', bogus.provider === 'gemini' && bogus.notes.length > 0);
}

console.log('\n--- Placeholders are not keys ---');
{
  ok('"your_xai_api_key_here" is a placeholder', isPlaceholderKey('your_xai_api_key_here'));
  ok('"gsk_..." is a placeholder', isPlaceholderKey('gsk_...'));
  ok('an empty value is a placeholder', isPlaceholderKey('  '));
  ok('a real-looking key is not', !isPlaceholderKey(FAKE_GEMINI_KEY));
  const s = resolveProviderSettings({ GROQ_API_KEY: 'your_groq_key_here', GEMINI_API_KEY: FAKE_GEMINI_KEY });
  ok('a placeholder Groq key does not shadow a real Gemini key', s.provider === 'gemini');
}

console.log('\n--- Thinking control ---');
{
  ok('off sends nothing', resolveProviderSettings({ GEMINI_API_KEY: FAKE_GEMINI_KEY, JARVIS_LLM_REASONING_EFFORT: 'off' }).reasoningEffort === undefined);
  ok('an explicit level is kept', resolveProviderSettings({ GEMINI_API_KEY: FAKE_GEMINI_KEY, JARVIS_LLM_REASONING_EFFORT: 'LOW' }).reasoningEffort === 'low');
  const bad = resolveProviderSettings({ GEMINI_API_KEY: FAKE_GEMINI_KEY, JARVIS_LLM_REASONING_EFFORT: 'max' });
  ok('an invalid level keeps the default and says so', bad.reasoningEffort === 'minimal' && bad.notes.some((n) => n.includes('max')));
  ok('Groq gets it only when asked', resolveProviderSettings({ GROQ_API_KEY: FAKE_GROQ_KEY, JARVIS_LLM_REASONING_EFFORT: 'none' }).reasoningEffort === 'none');
}

console.log('\n--- Startup validator ---');
function validateWith(env: Record<string, string>) {
  for (const name of ['GEMINI_API_KEY', 'GEMINI_API_URL', 'GROQ_API_KEY', 'GROQ_API_URL', 'XAI_API_KEY',
    'JARVIS_LLM_PROVIDER', 'JARVIS_BRAIN_MODEL', 'JARVIS_FAST_MODEL', 'JARVIS_LLM_REASONING_EFFORT']) {
    process.env[name] = env[name] ?? '';
  }
  return configValidator.validate();
}
{
  const xaiOnly = validateWith({ XAI_API_KEY: 'your_xai_api_key_here' });
  ok('only the xAI placeholder: JARVIS refuses to start', xaiOnly.canStart === false);
  const realXai = validateWith({ XAI_API_KEY: 'xai-0123456789abcdefghijklmnop' });
  const crit = realXai.issues.find((i) => i.level === 'CRITICAL');
  ok('a real xAI key alone is not enough, and the message says xAI is unused',
    realXai.canStart === false && !!crit?.message.includes('does not use xAI'), crit?.message);

  const gemini = validateWith({ GEMINI_API_KEY: FAKE_GEMINI_KEY, JARVIS_BRAIN_MODEL: 'gemini-3.5-flash', JARVIS_FAST_MODEL: 'gemini-3.5-flash-lite' });
  ok('a Gemini key is accepted', gemini.canStart === true, gemini.summary);
  ok('no model warning for matching Gemini models', !gemini.issues.some((i) => i.level === 'WARNING' && i.field.startsWith('JARVIS_')));

  const leftover = validateWith({ GEMINI_API_KEY: FAKE_GEMINI_KEY, JARVIS_BRAIN_MODEL: 'qwen/qwen3-32b', JARVIS_FAST_MODEL: 'gemini-3.5-flash' });
  ok('a Groq model left in .env with a Gemini key is warned about',
    leftover.issues.some((i) => i.level === 'WARNING' && i.field === 'JARVIS_BRAIN_MODEL'));

  const short = validateWith({ GEMINI_API_KEY: 'AQ.short' });
  ok('a truncated key is critical', short.canStart === false);

  const groq = validateWith({ GROQ_API_KEY: FAKE_GROQ_KEY, JARVIS_BRAIN_MODEL: 'qwen/qwen3-32b', JARVIS_FAST_MODEL: 'llama-3.1-8b-instant' });
  ok('a Groq-only setup still validates', groq.canStart === true, groq.summary);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
