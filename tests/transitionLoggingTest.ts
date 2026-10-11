/**
 * tests/transitionLoggingTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-07: four call sites wrapped a state transition in an empty `catch {}`.
 * A refused transition left no trace of which code asked for it.
 *
 *   1. tryTransition() reports a refused transition with the caller's context
 *      and returns false; an allowed one returns true
 *   2. no empty catch around a transition is left in the orchestrator or jarvis.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { agentStateMachine, AgentState, tryTransition } = await import('../core/agentStateMachine.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Refused transitions are reported (ARCH-07) ===\n');
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
const refused = tryTransition(AgentState.REFLECTING, 'test caller'); // IDLE → REFLECTING is not allowed
console.warn = realWarn;
ok('a refused transition returns false', refused === false && agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
ok('…and is reported with the caller and both states', warnings.some((w) => /test caller: transition to REFLECTING refused from IDLE/.test(w)), warnings.join(' | ').slice(0, 160));
ok('an allowed one returns true', tryTransition(AgentState.PLANNING, 'test caller') === true && agentStateMachine.currentState === AgentState.PLANNING);

for (const file of ['core/orchestrator.ts', 'jarvis.ts']) {
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  ok(`${file}: no transition wrapped in an empty catch`, !/transition\([^)]*\);\s*\}\s*catch\s*(\(\w*\))?\s*\{\s*\}/.test(src));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
