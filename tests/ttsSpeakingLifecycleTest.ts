import { nodeBridge } from '../bridge/nodeBridge.js';
import { conversationBus } from '../core/conversationBus.js';

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

async function run(): Promise<void> {
  console.log('\n=== TTS Speaking Lifecycle Test ===\n');

  conversationBus.speakingEnded();

  const bridge = nodeBridge as any;
  const originalReadyClients = bridge.readyClients;
  const sentToWakeWord: any[] = [];

  bridge.readyClients = new Map([
    ['wakeword', {
      readyState: 1,
      send(data: string) {
        sentToWakeWord.push(JSON.parse(data));
      },
    }],
  ]);

  let bridgeStartSeen = false;
  let bridgeEndSeen = false;
  let busStartSeen = false;
  let busEndSeen = false;

  nodeBridge.onBridgeEvent('speaking_start', () => {
    bridgeStartSeen = true;
  });
  nodeBridge.onBridgeEvent('speaking_end', () => {
    bridgeEndSeen = true;
  });

  const pauseMic = () => {
    busStartSeen = true;
    nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });
  };
  const resumeMic = () => {
    busEndSeen = true;
    nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });
  };

  conversationBus.on('speaking:start', pauseMic);
  conversationBus.on('speaking:end', resumeMic);

  nodeBridge.handleSpeakingLifecycleSignal('speaking_start', { reason: 'test_playback_start' });
  assert(bridgeStartSeen, 'NodeBridge emitted speaking_start bridge event');
  assert(busStartSeen, 'conversationBus emitted speaking:start');
  assert(conversationBus.isSpeaking, 'conversationBus isSpeaking=true after speaking_start');
  assert(
    sentToWakeWord.some(msg => msg?.payload?.action === 'pause'),
    'WakeWord/mic pause command sent after speaking_start'
  );

  nodeBridge.handleSpeakingLifecycleSignal('speaking_end', { reason: 'test_playback_end' });
  assert(bridgeEndSeen, 'NodeBridge emitted speaking_end bridge event');
  assert(busEndSeen, 'conversationBus emitted speaking:end');
  assert(!conversationBus.isSpeaking, 'conversationBus isSpeaking=false after speaking_end');
  assert(
    sentToWakeWord.some(msg => msg?.payload?.action === 'resume'),
    'WakeWord/mic resume command sent after speaking_end'
  );

  conversationBus.off('speaking:start', pauseMic);
  conversationBus.off('speaking:end', resumeMic);
  bridge.readyClients = originalReadyClients;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('[ttsSpeakingLifecycleTest] Unexpected error:', err);
  process.exit(1);
});
