import { nodeBridge } from '../bridge/nodeBridge.js';
import { orchestrator, normalizeVoiceInput } from '../core/orchestrator.js';
import {
  mergePendingVoiceContinuation,
  shouldUseContinuationContext,
} from '../core/voiceContinuation.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`PASS: ${label}`);
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    failed++;
  }
}

function waitForSttUnavailable(timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stt_unavailable event not emitted')), timeoutMs);
    nodeBridge.onBridgeEvent('stt_unavailable', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function run(): Promise<void> {
  console.log('\n=== Voice Continuation Fallback Test ===\n');

  const bridge = nodeBridge as any;
  bridge.readyClients = new Map();
  bridge.pendingListenStart = false;
  bridge.pendingListenStartedAt = null;

  const partialCommand = normalizeVoiceInput('open');
  assert(shouldUseContinuationContext(partialCommand), 'wake_word has_command=false partial "open" enables continuation context');

  const unavailablePromise = waitForSttUnavailable(500);
  const listenStarted = nodeBridge.sendListenStart(25);
  assert(listenStarted === false, 'listen_start returns false when STT is not ready');

  const unavailable = await unavailablePromise;
  assert(unavailable?.reason === 'listen_start_timeout', 'STT missing emits clear stt_unavailable event');

  const fragment = normalizeVoiceInput('YouTube');
  const merged = mergePendingVoiceContinuation(partialCommand, fragment);
  assert(merged === 'open youtube', 'follow-up fragment "YouTube" merges to "open youtube"');

  const route = orchestrator.matchDeterministicCommand(merged);
  assert(route?.type === 'open_app', 'merged command routes deterministically');
  assert(route?.target === 'youtube', 'merged command target is youtube');

  const directFragment = normalizeVoiceInput('open YouTube for');
  assert(directFragment === 'open youtube', 'dangling filler "for" is stripped from context fragment');
  const directRoute = orchestrator.matchDeterministicCommand(directFragment);
  assert(directRoute?.target === 'youtube', 'context fragment "open YouTube for" routes to youtube');

  nodeBridge.stop();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

run().catch((err) => {
  console.error('[VoiceContinuationFallbackTest] Unexpected error:', err);
  process.exit(1);
});
