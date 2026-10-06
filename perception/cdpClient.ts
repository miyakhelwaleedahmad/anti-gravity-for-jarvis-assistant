/**
 * perception/cdpClient.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A small Chrome DevTools Protocol client on the existing `ws` package
 * (docs/upgrade/BROWSER_CONTROL.md).
 *
 * 127.0.0.1 only. Since Chrome 136 the debugging port works only with a
 * profile of its own (`--user-data-dir`); JARVIS's start instructions use one.
 * Callers send fixed commands: nothing here takes JavaScript from the model.
 */

import WebSocket from 'ws';

export const CDP_HOST = '127.0.0.1';

/** JARVIS_CDP_PORT or 9222. */
export function cdpPort(env: Record<string, string | undefined> = process.env): number {
  const port = Number(env['JARVIS_CDP_PORT']);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 9222;
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpVersion {
  Browser: string;
  'Protocol-Version': string;
}

export class CdpUnavailableError extends Error {
  constructor(port: number) {
    super(
      `Chrome is not reachable for JARVIS on ${CDP_HOST}:${port}. Start it with ` +
      `chrome.exe --remote-debugging-port=${port} --user-data-dir=<a separate profile folder> ` +
      '(Chrome 136 and later ignore the port for the everyday profile).',
    );
    this.name = 'CdpUnavailableError';
  }
}

async function getJson<T>(port: number, pathname: string, timeoutMs = 2_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://${CDP_HOST}:${port}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new CdpUnavailableError(port);
  }
  if (!res.ok) throw new Error(`DevTools ${pathname} answered ${res.status}`);
  return (await res.json()) as T;
}

export function cdpVersion(port = cdpPort()): Promise<CdpVersion> {
  return getJson<CdpVersion>(port, '/json/version');
}

/** Targets of every kind; `/json/list` puts the most recently active page first. */
export function listTargets(port = cdpPort()): Promise<CdpTarget[]> {
  return getJson<CdpTarget[]>(port, '/json/list');
}

export async function listPages(port = cdpPort()): Promise<CdpTarget[]> {
  return (await listTargets(port)).filter((t) => t.type === 'page');
}

/** A DevTools WebSocket URL on this machine, or nothing. */
function localSocketUrl(target: CdpTarget, port: number): string {
  const raw = target.webSocketDebuggerUrl ?? '';
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`Tab ${target.id} has no DevTools address.`); }
  const local = url.hostname === CDP_HOST || url.hostname === 'localhost';
  if (url.protocol !== 'ws:' || !local || Number(url.port) !== port || !url.pathname.startsWith('/devtools/')) {
    throw new Error(`Refused a DevTools address that is not this PC's (${url.host}).`);
  }
  return raw;
}

export class CdpSession {
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const entry = typeof msg.id === 'number' ? this.waiting.get(msg.id) : undefined;
      if (!entry) return; // events are not used
      this.waiting.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`DevTools: ${msg.error.message ?? 'error'}`));
      else entry.resolve(msg.result);
    });
    socket.on('close', () => this.failAll('the tab closed the connection'));
    socket.on('error', () => this.failAll('the connection failed'));
  }

  static connect(target: CdpTarget, port = cdpPort(), timeoutMs = 3_000): Promise<CdpSession> {
    const url = localSocketUrl(target, port);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: 16 * 1024 * 1024 });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error(`Tab ${target.id} did not answer in ${timeoutMs} ms.`)); }, timeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(new CdpSession(socket)); });
      socket.once('error', (err) => { clearTimeout(timer); reject(new Error(`Could not open tab ${target.id}: ${err.message}`)); });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('The tab connection is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} took longer than ${timeoutMs} ms.`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.failAll('closed');
    this.socket.close();
  }

  private failAll(reason: string): void {
    for (const [id, entry] of this.waiting) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`DevTools: ${reason}`));
      this.waiting.delete(id);
    }
  }
}

/** One connection per tab at a time: calls for the same tab wait their turn. */
const turns = new Map<string, Promise<unknown>>();

export function withPage<T>(target: CdpTarget, fn: (session: CdpSession) => Promise<T>, port = cdpPort()): Promise<T> {
  const previous = turns.get(target.id) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const session = await CdpSession.connect(target, port);
    try {
      return await fn(session);
    } finally {
      session.close();
    }
  });
  turns.set(target.id, run.catch(() => undefined));
  return run;
}

/**
 * Evaluate one of the fixed scripts in `perception/cdpScripts.ts` and return
 * its value. Callers pass only those scripts: the expression never comes from
 * the model.
 *
 * The script runs in an isolated world of the tab's main frame: it shares the
 * page's DOM but not its JavaScript, so a page that replaces built-ins
 * (String.prototype.slice, an innerText getter) cannot change what JARVIS
 * reads. `timeoutMs` bounds the whole call; a busy or frozen page fails with
 * a plain message.
 */
export async function evaluateFixed<T>(session: CdpSession, expression: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  let result: { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  try {
    const tree = await session.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, left());
    const world = await session.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: 'jarvis-read',
      grantUniveralAccess: false, // (the protocol's own spelling)
    }, left());
    result = await session.send('Runtime.evaluate', {
      expression,
      contextId: world.executionContextId,
      returnByValue: true,
      awaitPromise: false,
      timeout: left(),
    }, left() + 500);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/took longer than|Execution was terminated/i.test(message)) {
      throw new Error(`The page did not answer within ${timeoutMs} ms; it may be busy or frozen.`);
    }
    throw err;
  }
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description?.split('\n')[0] ?? result.exceptionDetails.text ?? 'error';
    throw new Error(`The page script failed: ${detail}`);
  }
  return result.result?.value as T;
}
