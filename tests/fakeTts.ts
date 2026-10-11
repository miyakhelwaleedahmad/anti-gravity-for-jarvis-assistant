/**
 * tests/fakeTts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a test: a stand-in for tts.py that keeps the real speak() path.
 *
 * Tests used to replace orchestrator.speak with a function that only recorded
 * the text, which also skipped speak()'s move of the state machine to SPEAKING.
 * That hid BUG-02 (a progress message in the middle of a task left the state
 * machine in SPEAKING, and the next step's transition was refused).
 *
 * installFakeTts() keeps the real speak() and announce(), records what reached
 * the speaker, and plays it like tts.py: speaking_start, then speaking_end after
 * `playMs`, through the bridge's own lifecycle handler.
 */

export interface FakeTts {
  /** Everything spoken, final replies and progress messages, in order. */
  spoken: string[];
  /** Waits until queued playback has finished. */
  idle(): Promise<void>;
}

export function installFakeTts(orchestrator: any, nodeBridge: any, playMs = 5): FakeTts {
  const spoken: string[] = [];
  let playing = 0;
  orchestrator.config.voiceEnabled = true;
  nodeBridge.sendToRole = () => true;
  nodeBridge.speakToClients = (text: string) => {
    spoken.push(text);
    playing++;
    setTimeout(() => nodeBridge.handleSpeakingLifecycleSignal('speaking_start', {}), 0);
    setTimeout(() => { playing--; nodeBridge.handleSpeakingLifecycleSignal('speaking_end', {}); }, playMs);
  };
  return {
    spoken,
    async idle() {
      for (let i = 0; i < 200 && playing > 0; i++) await new Promise((r) => setTimeout(r, 5));
    },
  };
}
