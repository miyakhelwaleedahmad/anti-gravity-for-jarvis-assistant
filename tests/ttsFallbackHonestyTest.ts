/**
 * tests/ttsFallbackHonestyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE-003: self-healing does not claim a TTS switch that never happens.
 *
 * When tts.py crashed, the recovery plan restarted it and then ran
 * "fallback_tts: pyttsx3", which moved a label in fallbackRouter and reported
 * success ("TTS switched to fallback: pyttsx3"). Nothing in tts.py reads that
 * label: it kept using edge-tts. The real fallback is now in tts.py itself,
 * per phrase, and named on speaking_end (engine).
 *
 * Checked: a tts.py crash is recovered by restarting it, with no voice switch
 * in the plan; the fallback_tts action, if run, does not report a switch and
 * leaves the label alone. (The STT fallback is not part of this repair.)
 */
import { planRecovery } from '../self_healing/recoveryPlanner.js';
import { repairExecutor } from '../self_healing/repairExecutor.js';
import { fallbackRouter } from '../self_healing/fallbackRouter.js';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  const line = `  ${condition ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`;
  if (condition) { console.log(line); passed++; } else { console.error(line); failed++; }
}

console.log('\n=== Self-healing does not fake a TTS switch (VOICE-003) ===\n');
const crash = { type: 'PythonProcessCrash', severity: 'high', module: 'tts', message: 'Process exited with code 1', raw: null, timestamp: new Date() } as never;
const plan = planRecovery(crash, 1, 3);
const kinds = plan.actions.map((a: { kind: string }) => a.kind);
ok('a tts.py crash is recovered by restarting it', kinds.includes('restart_process'), kinds.join(', '));
ok('…with no "fallback_tts" voice switch in the plan', !kinds.includes('fallback_tts'), kinds.join(', '));

const before = fallbackRouter.getTTSEngine();
const r = await repairExecutor.execute({ kind: 'fallback_tts', target: 'pyttsx3' } as never);
const text = `${r.output} ${r.error ?? ''}`;
ok('the fallback_tts action does not report a switch', !/switched/i.test(text), text.trim());
ok('…and leaves the label alone', fallbackRouter.getTTSEngine() === before, `${before} → ${fallbackRouter.getTTSEngine()}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
