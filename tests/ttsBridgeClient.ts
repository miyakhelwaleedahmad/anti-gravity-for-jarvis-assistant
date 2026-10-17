/**
 * tests/ttsBridgeClient.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a test: a stand-in for voice/tts.py on the real NodeBridge. It connects
 * and authenticates as tts.py does, records every `tts` message, and answers
 * each one with speaking_start and speaking_end, as playback would. Unlike
 * tests/fakeTts.ts it does not replace nodeBridge.speakToClients(), so the
 * bridge's own hand-off to the speech service is what is tested (VOICE-007).
 */

import WebSocket from 'ws';

export interface TtsStandIn {
  /** The texts the bridge sent to the speech service, in order. */
  received: string[];
  close(): void;
}

export async function connectTtsStandIn(port: number, token: string, playMs = 150): Promise<TtsStandIn> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'status' && msg.payload?.status === 'connected') {
        ws.send(JSON.stringify({ type: 'client_ready', payload: { role: 'tts', token } }));
        setTimeout(resolve, 100);
      }
      if (msg.type === 'tts') {
        received.push(String(msg.payload?.text ?? ''));
        ws.send(JSON.stringify({ type: 'speaking_start', payload: {} }));
        setTimeout(() => ws.send(JSON.stringify({ type: 'speaking_end', payload: { reason: 'queue_empty' } })), playMs);
      }
    });
  });
  return { received, close: () => ws.close() };
}
