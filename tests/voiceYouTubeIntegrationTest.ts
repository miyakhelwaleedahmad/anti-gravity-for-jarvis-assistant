/**
 * tests/voiceYouTubeIntegrationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 integration test: "Jarvis open YouTube for me"
 *
 * Validates the full dry-run path:
 *   raw STT text → normalizeVoiceInput → echo-filter decision
 *                → matchDeterministicCommand → open_app (dryRun=true)
 *
 * No browser is opened. No audio is played. Completely safe to run in CI.
 */

import { orchestrator, normalizeVoiceInput } from '../core/orchestrator.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { registerAllTools } from '../core/tools/index.js';
import { SkillLoader } from '../core/skillLoader.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// ── Simple echo filter logic mirrored from jarvis.ts ─────────────────────────
// (Without importing jarvis.ts — we're testing inputs, not runtime state)

function hasCommandKeyword(text: string): boolean {
  const COMMAND_KEYWORDS = new Set(['open', 'launch', 'start', 'close', 'run', 'stop', 'play', 'search',
    'youtube', 'google', 'chrome', 'notepad', 'calculator', 'spotify']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  return words.some(w => COMMAND_KEYWORDS.has(w));
}

function isCommandLike(text: string): boolean {
  const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const commandVerbs = ['open', 'launch', 'start', 'run', 'play', 'search', 'close', 'stop'];
  return words.some(w => commandVerbs.includes(w));
}

function wouldBeEchoFiltered(sttText: string, lastTtsText: string): boolean {
  const cleanStt = sttText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  // Command-like speech is always protected (jarvis.ts rule #1)
  if (isCommandLike(cleanStt)) return false;
  // Matches deterministic command → protected
  if (orchestrator.matchDeterministicCommand(sttText)) return false;

  const cleanTts = lastTtsText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (!cleanTts) return false;

  if (cleanStt === cleanTts || cleanTts.includes(cleanStt) || cleanStt.includes(cleanTts)) {
    if (hasCommandKeyword(cleanStt)) {
      const wordCount = cleanStt.split(/\s+/).filter(Boolean).length;
      if (wordCount > 3) return false;
    }
    return true;
  }

  const sttWords = cleanStt.split(/\s+/).filter(Boolean);
  const ttsWords = cleanTts.split(/\s+/).filter(Boolean);
  if (!sttWords.length || !ttsWords.length) return false;

  let overlapCount = 0;
  for (const w of sttWords) { if (ttsWords.includes(w)) overlapCount++; }
  const ratio = overlapCount / Math.max(sttWords.length, ttsWords.length);
  const threshold = hasCommandKeyword(cleanStt) ? 0.75 : 0.60;
  return ratio > threshold;
}

// ─────────────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== YouTube Voice Integration Test (Phase 2) ===\n');

  registerAllTools();
  const skillsDir = path.join(__dirname, '..', 'skills');
  const loader = new SkillLoader(skillsDir);
  await loader.loadSkills();

  // ── Section 1: normalizeVoiceInput ───────────────────────────────────────
  console.log('--- Section 1: normalizeVoiceInput ---');

  const NORMALIZATION_CASES: Array<[string, string]> = [
    ['Jarvis open YouTube for me',        'open youtube'],
    ['jarvis open you tube for me',       'open youtube'],
    ['hey jarvis open youtube please',    'open youtube'],
    ['JARVIS OPEN YOUTUBE',               'open youtube'],
    ['open you-tube',                     'open youtube'],
    ['open you tube',                     'open youtube'],
    ['open YouTube',                      'open youtube'],
    ['launch YouTube',                    'launch youtube'],
    ['start youtube',                     'start youtube'],
    ['open git hub',                      'open github'],
    ['Jarvis please open notepad',        'open notepad'],
    ['hey jarvis can you open chrome',    'open chrome'],
  ];

  for (const [raw, expected] of NORMALIZATION_CASES) {
    const result = normalizeVoiceInput(raw);
    assert(result === expected, `normalize("${raw}") → "${expected}" (got: "${result}")`);
  }

  // ── Section 2: Echo filter — command speech must NOT be suppressed ───────
  console.log('\n--- Section 2: Echo filter protection ---');

  // Simulate: JARVIS just spoke "Opening YouTube, sir."
  const LAST_TTS = 'Opening YouTube, sir.';

  const ECHO_SHOULD_PASS: string[] = [
    'open youtube',
    'open YouTube for me',
    'launch youtube',
    'open YouTube please',
    'open you tube',
    'start youtube',
  ];

  for (const sttText of ECHO_SHOULD_PASS) {
    const echoed = wouldBeEchoFiltered(sttText, LAST_TTS);
    assert(!echoed, `"${sttText}" NOT echo-filtered after TTS "${LAST_TTS}"`);
  }

  // Things that ARE echoes should still be filtered
  const ECHO_SHOULD_FILTER: string[] = [
    'opening youtube sir',
    'one moment sir i will get to that right after this',
    'jarvis version 2 is online sir autonomous systems are fully operational',
  ];

  for (const sttText of ECHO_SHOULD_FILTER) {
    const echoed = wouldBeEchoFiltered(sttText, sttText); // same as TTS
    assert(echoed, `"${sttText}" IS correctly echo-filtered`);
  }

  // ── Section 3: Deterministic routing with normalized variants ────────────
  console.log('\n--- Section 3: Deterministic routing of normalized inputs ---');

  const RAW_VOICE_VARIANTS: Array<[string, string]> = [
    ['Jarvis open YouTube for me',         'youtube'],
    ['hey jarvis please open youtube',     'youtube'],
    ['jarvis open you tube',               'youtube'],
    ['open YouTube',                       'youtube'],
    ['launch YouTube',                     'youtube'],
    ['start youtube please',               'youtube'],
    ['open notepad for me',                'notepad'],
    ['open google please',                 'google'],
  ];

  for (const [rawInput, expectedTarget] of RAW_VOICE_VARIANTS) {
    const normalizedInput = normalizeVoiceInput(rawInput);
    const route = orchestrator.matchDeterministicCommand(normalizedInput);
    assert(
      route?.target === expectedTarget,
      `route("${rawInput}" → normalized: "${normalizedInput}") → target="${expectedTarget}" (got: ${route?.target})`
    );
  }

  // ── Section 4: open_app dry-run execution ────────────────────────────────
  console.log('\n--- Section 4: open_app dry-run for youtube ---');

  try {
    const result = await toolRegistryV2.execute('open_app', { target: 'youtube', dryRun: true });
    assert(result.success === true, 'open_app("youtube", dryRun) succeeds');

    const parsed = JSON.parse(result.output);
    assert(parsed.dryRun === true, 'response.dryRun === true');
    assert(parsed.resolvedTarget === 'https://www.youtube.com', `resolvedTarget = "https://www.youtube.com" (got: "${parsed.resolvedTarget}")`);
    console.log(`    [open_app] target=youtube resolved="${parsed.resolvedTarget}" dryRun=true`);
  } catch (err) {
    assert(false, `open_app dry-run threw: ${err}`);
  }

  // ── Section 5: Full pipeline simulation ──────────────────────────────────
  console.log('\n--- Section 5: Full pipeline simulation (raw → normalized → route → tool) ---');

  const rawSpeech = 'Jarvis open YouTube for me';
  const normalized = normalizeVoiceInput(rawSpeech);
  const route = orchestrator.matchDeterministicCommand(normalized);

  assert(!!route, `Pipeline: route matched for "${rawSpeech}"`);
  assert(route?.target === 'youtube', `Pipeline: target=youtube`);
  assert(route?.type === 'open_app', `Pipeline: type=open_app`);

  if (route?.target) {
    const toolResult = await toolRegistryV2.execute('open_app', { target: route.target, dryRun: true });
    assert(toolResult.success === true, `Pipeline: open_app succeeded`);
    const parsed = JSON.parse(toolResult.output);
    assert(parsed.resolvedTarget === 'https://www.youtube.com', `Pipeline: resolvedTarget=https://www.youtube.com`);
    console.log(`    [Pipeline] "${rawSpeech}" → "${normalized}" → target="${route.target}" → "${parsed.resolvedTarget}"`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('❌ Some YouTube integration tests FAILED.');
    process.exit(1);
  } else {
    console.log('✅ All YouTube integration tests PASSED.');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[YouTubeIntegrationTest] Unexpected error:', err);
  process.exit(1);
});
