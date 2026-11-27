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
  /** The full payload of each tts message (text, and the bridge's request id). */
  payloads: { text?: string; id?: string }[];
  /** The outcome put on the next speaking_end, as tts.py reports it (VOICE-005). */
  outcome: string;
  /** false: receive tts messages but never answer, as a hung or dead tts.py. */
  respond: boolean;
  /** Send a raw message, as tts.py would (e.g. hardware_error). */
  send(msg: unknown): void;
  close(): void;
}

export async function connectTtsStandIn(port: number, token: string, playMs = 150): Promise<TtsStandIn> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: string[] = [];
  const payloads: { text?: string; id?: string }[] = [];
  const standIn = { received, payloads, outcome: 'played', respond: true } as TtsStandIn;
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
        payloads.push(msg.payload ?? {});
        if (!standIn.respond) return;
        const ids = msg.payload?.id ? [msg.payload.id] : undefined;
        ws.send(JSON.stringify({ type: 'speaking_start', payload: {} }));
        setTimeout(() => ws.send(JSON.stringify({ type: 'speaking_end', payload: { reason: 'queue_empty', outcome: standIn.outcome, ...(ids ? { ids } : {}) } })), playMs);
      }
    });
  });
  standIn.send = (msg) => ws.send(JSON.stringify(msg));
  standIn.close = () => ws.close();
  return standIn;
}

/**
 * For tests that drive speaking_start/speaking_end themselves: registers a
 * connected tts.py with the bridge, without a network connection, that takes
 * every message and answers nothing. Without one, the bridge (rightly) ends a
 * speaking turn at once, since no tts.py would ever end it (VOICE-001).
 * Returns the messages it was sent.
 */
export function attachSilentTtsClient(bridge: unknown): unknown[] {
  const sent: unknown[] = [];
  const client = {
    readyState: WebSocket.OPEN,
    send(data: string, cb?: (err?: Error) => void) { sent.push(JSON.parse(data)); cb?.(); },
  };
  (bridge as { readyClients: Map<string, unknown> }).readyClients.set('tts', client);
  return sent;
}
