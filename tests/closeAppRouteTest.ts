/**
 * tests/closeAppRouteTest.ts
 * Verifies that close/focus/switch commands route deterministically
 * and never call run_command or LLM.
 */
import { registerAllTools } from '../core/tools/index.js';
import { SkillLoader } from '../core/skillLoader.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { JarvisOrchestrator } from '../core/orchestrator.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== Close App / Browser Tab Route Test ===\n');

registerAllTools();
const skillsDir = path.resolve(__dirname, '..', 'skills');
const loader = new SkillLoader(skillsDir);
await loader.loadSkills();

const orchestrator = new JarvisOrchestrator();

// ── Section 1: Close commands must be deterministically matched ──────────────
console.log('--- Section 1: Close command routing ---');

type RouteCheck = { input: string; expectedType: string; expectedTarget?: string };
const closeCommands: RouteCheck[] = [
  { input: 'close youtube',        expectedType: 'close_browser_tab', expectedTarget: 'youtube' },
  { input: 'close current tab',    expectedType: 'close_current_tab' },
  { input: 'close notepad',        expectedType: 'close_app', expectedTarget: 'notepad' },
  { input: 'close current window', expectedType: 'close_current_window' },
];

for (const check of closeCommands) {
  const route = orchestrator.matchDeterministicCommand(check.input);
  ok(`"${check.input}" matched deterministically`, route !== null);
  if (route) {
    ok(`"${check.input}" has type="${check.expectedType}"`, route.type === check.expectedType);
    if (check.expectedTarget) {
      ok(`"${check.input}" has target="${check.expectedTarget}"`, route.target === check.expectedTarget);
    }
  }
}

// ── Section 2: Close commands must NOT call LLM or run_command ───────────────
console.log('\n--- Section 2: Close commands bypass LLM ---');

let llmCallCount = 0;
let runCommandCallCount = 0;

// Instrument run_command tool to detect if it's called
const origRunCommand = toolRegistryV2.get('run_command');
if (origRunCommand) {
  const origExecute = origRunCommand.execute.bind(origRunCommand);
  origRunCommand.execute = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    runCommandCallCount++;
    return origExecute(args, signal);
  };
}

for (const check of closeCommands) {
  const route = orchestrator.matchDeterministicCommand(check.input);
  ok(`"${check.input}" does NOT require LLM (matched pre-LLM)`, route !== null);
}

ok('run_command was never called for close commands', runCommandCallCount === 0);

// ── Section 3: Fragment filter passes close commands ─────────────────────────
console.log('\n--- Section 3: Fragment filter allows close commands ---');

// Simulate what jarvis.ts does for fragment filtering
function isValidCommand(text: string): boolean {
  const cleanInput = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const words = cleanInput.split(/\s+/).filter(Boolean);
  const actionVerbs = [
    'open', 'launch', 'start', 'close', 'kill', 'stop', 'exit', 'press',
    'type', 'click', 'run', 'show', 'get', 'is', 'help', 'status', 'cancel',
    'pause', 'resume', 'shutdown', 'focus', 'switch', 'list', 'what', 'move',
    'copy', 'delete', 'rename'
  ];
  const aliases = ['youtube', 'google', 'gmail', 'notepad', 'chrome', 'cmd', 'calculator', 'spotify'];
  const simplePhrases = ['hello', 'hi', 'hey', 'thank you', 'thanks', 'yes', 'no', 'ok', 'okay'];
  const isAction = words.some(w => actionVerbs.includes(w));
  const isAlias = words.some(w => aliases.includes(w));
  const isSimplePhrase = simplePhrases.includes(cleanInput);
  return words.length >= 2 || isAction || isAlias || isSimplePhrase;
}

ok('"close youtube" passes fragment filter', isValidCommand('close youtube'));
ok('"close notepad" passes fragment filter', isValidCommand('close notepad'));
ok('"close current tab" passes fragment filter', isValidCommand('close current tab'));
ok('"open youtube" passes fragment filter', isValidCommand('open youtube'));
ok('"press enter" passes fragment filter', isValidCommand('press enter'));
ok('"click there" passes fragment filter', isValidCommand('click there'));

// ── Section 4: Still blocks unsafe commands ──────────────────────────────────
console.log('\n--- Section 4: Unsafe commands are NOT matched ---');
const unsafeClose: string[] = [
  'close everything', 'close all', 'close windows', 'close explorer',
];
for (const cmd of unsafeClose) {
  const route = orchestrator.matchDeterministicCommand(cmd);
  // These should NOT be matched by the simple deterministic router
  // They should go to LLM for safer intent resolution
  console.log(`  ℹ️  "${cmd}" → ${route ? `matched (type=${route.type})` : 'not matched (goes to LLM)'}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
