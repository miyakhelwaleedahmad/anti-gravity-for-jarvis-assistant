/**
 * tests/dashboardLabelTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-7: the dashboard said "STT (Whisper)" and "TTS (Kokoro)" while Google
 * STT (the wake-word process) heard the owner and edge-tts or the offline
 * voice spoke. The labels now name the engine actually used last.
 * BUG-22: the cache line names both caches (Redis and in-process).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const { voiceLabel, runtimeDashboard } = await import('../monitoring/runtimeDashboard.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

ok('nothing heard yet: just "STT", no engine claimed', voiceLabel('stt', {}) === 'STT');
ok('heard by the wake-word process: STT (Google STT)', voiceLabel('stt', { lastTranscriptEngine: 'Google STT' }) === 'STT (Google STT)');
ok('heard by stt.py: STT (Whisper)', voiceLabel('stt', { lastTranscriptEngine: 'Whisper' }) === 'STT (Whisper)');
ok('nothing spoken yet: just "TTS"', voiceLabel('tts', { lastSpeechOutcome: null }) === 'TTS');
for (const e of ['edge-tts', 'pyttsx3', 'windows-sapi']) ok(`spoken by ${e}: TTS (${e})`, voiceLabel('tts', { lastSpeechOutcome: { engine: e } }) === `TTS (${e})`.slice(0, 18));

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'nodeBridge.ts'), 'utf8');
ok('the bridge records which process sent the transcript', /role === "wakeword"\) this\.lastTranscriptEngine = "Google STT"/.test(src) && /role === "stt"\) this\.lastTranscriptEngine = msg\.payload\?\.engine === "Google STT" \? "Google STT" : "Whisper"/.test(src));

// The rendered dashboard: no fixed engine names.
(nodeBridge as any).lastSpeechOutcome = { outcome: 'played', detail: '', at: Date.now(), engine: 'pyttsx3' };
(nodeBridge as any).lastTranscriptEngine = 'Google STT';
const out: string[] = [];
const realLog = console.log;
const { healthManager } = await import('../monitoring/healthManager.js');
const snap = await healthManager.probe();
snap.services.stt = { name: 'stt', status: 'online', checkedAt: Date.now() } as any;
snap.services.tts = { name: 'tts', status: 'online', checkedAt: Date.now() } as any;
console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
runtimeDashboard.render(snap);
console.log = realLog;
const text = out.join('\n');
ok('the dashboard shows the engines in use', text.includes('STT (Google STT)') && text.includes('TTS (pyttsx3)'), text.split('\n').filter((l) => /STT|TTS/.test(l)).join(' | '));
ok('…and no longer claims Kokoro', !text.includes('Kokoro'));

// BUG-22: "Hit Ratio: 0.0%" was the in-process LRU's, which memory lookups do
// not use; the Redis cache hits in the log never showed.
const { cacheHitsLabel } = await import('../monitoring/runtimeDashboard.js');
ok('both caches are shown, each named', cacheHitsLabel({ totalHits: 0, totalMisses: 3 }, { embedding: { hits: 9, misses: 3 }, vectorResult: { hits: 3, misses: 12 } }) === 'Cache hits: Redis 44.4% (12/27)  in-process 0.0% (0/3)');
ok('a cache not asked yet shows "-", not 0%', cacheHitsLabel({ totalHits: 0, totalMisses: 0 }, {}) === 'Cache hits: Redis -  in-process -');
ok('the dashboard shows the labelled line, not "Hit Ratio"', /Cache hits: Redis/.test(text) && !text.includes('Hit Ratio'), text.split('\n').filter((l) => /Cache|Hit/.test(l)).join(' | '));
const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, '');
const memLines = text.split('\n').map(plain).filter((l) => /RSS:|Cache hits:/.test(l));
const ruler = plain(text.split('\n').find((l) => plain(l).startsWith('├')) ?? '');
ok('…and those lines fit the box', memLines.length === 2 && memLines.every((l) => [...l].length === [...ruler].length), memLines.map((l) => [...l].length).join(',') + ' vs ' + [...ruler].length);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
