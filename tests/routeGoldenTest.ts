/**
 * tests/routeGoldenTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-01: parts of the orchestrator are moved into their own modules in
 * small steps. Each step must not change behaviour. This test records what
 * the deterministic router and the voice-input normaliser answer for a fixed
 * set of phrases (tests/fixtures/route-golden.json, taken from the code before
 * the first move) and fails on any difference.
 *
 *   npx tsx tests/routeGoldenTest.ts --record   rewrite the fixture (only
 *                                               for an intended change)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-route-golden-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'route-golden.json');
const { orchestrator, normalizeVoiceInput } = await import('../core/orchestrator.js');

const PHRASES = [
  'stop', 'cancel', 'jarvis stop', 'pause', 'resume', 'hello', 'hey jarvis', 'thanks', 'what time is it',
  'open notepad', 'open youtube', 'launch chrome', 'start calculator', 'open you tube please', 'Jarvis, open Git Hub for me',
  'close notepad', 'minimize chrome', 'play lofi music on youtube', 'search youtube for cats', 'search google for weather',
  'what can you do', 'who are you', 'list your capabilities', 'what are your tools',
  'whats running', 'what is running on my pc', 'what is open in chrome', 'which tabs are open', 'what is currently open in my browser',
  'why isnt my app working', 'my server is down', 'fix the website', 'is the backend working',
  'continue what i was doing', 'what was i doing', 'yes', 'no thanks',
  'is youtube open', 'enable full control mode', 'system status', 'how is my pc doing', 'git status', 'what changed in my project',
  'how many agents are running', 'show me the task tree', 'what have the workers found', 'which agents failed', 'how much work remains',
  'what sub agents did the research agent create', 'what are your agents doing', 'stop this research', 'cancel all agents',
  'what are my goals', 'goal status', 'pause the goal', 'resume goal called news', 'approve goal',
  'ask the data agent to clean the sales csv', 'delegate: summarise the logs', 'in the background, find the best laptops under 1000',
  'research the best python web frameworks', 'find me information about rust async runtimes',
  'every morning at 9 summarise the news', 'remind me every hour to drink water',
  'write a poem about the sea', 'tell me a joke', 'delete all my files', 'shutdown the computer', '', '   ', '!!!',
];
const STABLE = (r: unknown) => JSON.stringify(r, (k, v) => (k === 'reply' && typeof v === 'string' && /\d{1,2}:\d{2}/.test(v) ? '<time>' : v));
const now: Record<string, { route: string; normalized: string }> = {};
for (const p of PHRASES) now[p] = { route: STABLE(orchestrator.matchDeterministicCommand(p)), normalized: normalizeVoiceInput(p) };

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Route golden test (ARCH-01) ===\n');
if (process.argv.includes('--record')) {
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, JSON.stringify(now, null, 2) + '\n');
  console.log(`recorded ${PHRASES.length} phrases to ${path.relative(process.cwd(), fixture)}`);
} else {
  const golden = JSON.parse(fs.readFileSync(fixture, 'utf8')) as typeof now;
  ok('the fixture covers every phrase', PHRASES.every((p) => p in golden));
  for (const p of PHRASES) {
    ok(`route for "${p}"`, golden[p]?.route === now[p]!.route, `was ${golden[p]?.route}, now ${now[p]!.route}`);
    ok(`normalised "${p}"`, golden[p]?.normalized === now[p]!.normalized, `was ${golden[p]?.normalized}, now ${now[p]!.normalized}`);
  }
  console.log(`  ${passed} checks passed`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
