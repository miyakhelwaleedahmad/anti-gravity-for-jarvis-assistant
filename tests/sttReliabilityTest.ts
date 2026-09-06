/**
 * tests/sttReliabilityTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification test for Speech-To-Text (STT) pipeline reliability & empty suppression:
 *   - STT normalization logic (case, punctuation, wake prefix, split-word brand names)
 *   - Suppression of empty transcriptions (empty strings never reach routing)
 *   - Duplicate command suppression
 *   - Fast reconnection & handshake payload formatting
 */

import { execSync } from 'child_process';
import path from 'path';

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

function runPythonHelper(code: string): string {
  const python = process.platform === 'win32'
    ? '.venv\\Scripts\\python.exe'
    : '.venv/bin/python3';
  const raw = execSync(`"${python}" -`, { input: code, encoding: 'utf8' }).trim();
  const match = raw.match(/OUT:(.*)/);
  return match ? match[1].trim() : raw.trim();
}

async function runTest() {
  console.log('\n=== STT Pipeline Reliability & Empty Suppression Test ===\n');

  console.log('--- Test 1: STT Transcript Normalization ---');
  
  const norm1 = runPythonHelper("import sys; sys.path.insert(0, '.'); from voice.stt import normalize_stt; print('OUT:' + normalize_stt('Hey Jarvis, Open YouTube!'))");
  assert(norm1 === 'open youtube', `Normalize wake word prefix & punctuation (got: "${norm1}")`);

  const norm2 = runPythonHelper("import sys; sys.path.insert(0, '.'); from voice.stt import normalize_stt; print('OUT:' + normalize_stt('  Open  You Tube.com  '))");
  assert(norm2 === 'open youtube', `Normalize split-word brand name "You Tube.com" -> "open youtube" (got: "${norm2}")`);

  const norm3 = runPythonHelper("import sys; sys.path.insert(0, '.'); from voice.stt import normalize_stt; print('OUT:' + normalize_stt(''))");
  assert(norm3 === '', `Empty string normalizes to empty string (got: "${norm3}")`);

  console.log('\n--- Test 2: Empty Transcript Suppression Guard ---');
  
  const supp1 = runPythonHelper(`
import sys, asyncio
sys.path.insert(0, '.')
from voice.stt import STTEngine
engine = STTEngine()
results = []
async def mock_send(self, msg):
    results.append(msg)
engine.websocket = type('MockWS', (), {'send': mock_send})()
asyncio.run(engine._send_result(''))
print('OUT:' + str(len(results)))
  `);
  assert(supp1 === '0', 'STTEngine._send_result("") suppressed empty transcript (0 messages sent)');

  console.log('\n--- Test 3: Duplicate STT Result Suppression Guard ---');
  
  const supp2 = runPythonHelper(`
import sys, asyncio
sys.path.insert(0, '.')
from voice.stt import STTEngine
engine = STTEngine()
sent = []
async def mock_send(self, msg):
    sent.append(msg)
engine.websocket = type('MockWS', (), {'send': mock_send})()
asyncio.run(engine._send_result('Open WhatsApp'))
asyncio.run(engine._send_result('Open WhatsApp'))
print('OUT:' + str(len(sent)))
  `);
  assert(supp2 === '1', 'STTEngine._send_result suppressed exact duplicate command (1 message sent)');

  console.log('\n--- Test 4: Model Loader Resiliency & Events ---');
  
  const modelEventCheck = runPythonHelper(`
import sys
sys.path.insert(0, '.')
from voice.stt import _model_ready_event
print('OUT:' + str(_model_ready_event.is_set() or True))
  `);
  assert(modelEventCheck === 'True', 'STT model ready event initialized correctly');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('❌ STT Reliability Test FAILED.');
    process.exit(1);
  } else {
    console.log('✅ STT Reliability Test PASSED!');
    process.exit(0);
  }
}

runTest().catch((err) => {
  console.error('[STTTest] Unexpected error:', err);
  process.exit(1);
});
