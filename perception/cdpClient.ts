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

async function tabEndpoint(port: number, pathname: string, method: 'GET' | 'PUT'): Promise<Response> {
  try {
    return await fetch(`http://${CDP_HOST}:${port}${pathname}`, { method, signal: AbortSignal.timeout(3_000) });
  } catch {
    throw new CdpUnavailableError(port);
  }
}

/** Opens a tab. `/json/new` takes PUT (current Chrome answers 405 to GET) and an encoded address. */
export async function openTab(url: string, port = cdpPort()): Promise<CdpTarget> {
  const res = await tabEndpoint(port, `/json/new?${encodeURIComponent(url)}`, 'PUT');
  if (!res.ok) throw new Error(`Chrome did not open a tab (${res.status}).`);
  return (await res.json()) as CdpTarget;
}

export async function activateTab(id: string, port = cdpPort()): Promise<void> {
  const res = await tabEndpoint(port, `/json/activate/${encodeURIComponent(id)}`, 'GET');
  if (!res.ok) throw new Error(`Chrome did not bring the tab forward (${res.status}).`);
}

export async function closeTabById(id: string, port = cdpPort()): Promise<void> {
  const res = await tabEndpoint(port, `/json/close/${encodeURIComponent(id)}`, 'GET');
  if (!res.ok) throw new Error(`Chrome did not close the tab (${res.status}).`);
}

/** A DevTools WebSocket URL on this machine, or nothing. */
function localSocketUrl(raw: string | undefined, label: string, port: number, prefix = '/devtools/'): string {
  let url: URL;
  try { url = new URL(raw ?? ''); } catch { throw new Error(`${label} has no DevTools address.`); }
  const local = url.hostname === CDP_HOST || url.hostname === 'localhost';
  if (url.protocol !== 'ws:' || !local || Number(url.port) !== port || !url.pathname.startsWith(prefix)) {
    throw new Error(`Refused a DevTools address that is not this PC's (${url.host}).`);
  }
  return url.href;
}

function openSocket(url: string, label: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: 32 * 1024 * 1024 });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`${label} did not answer in ${timeoutMs} ms.`)); }, timeoutMs);
    socket.once('open', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (err) => { clearTimeout(timer); reject(new Error(`Could not open ${label}: ${err.message}`)); });
  });
}

export class CdpSession {
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Map<string, Set<(params: any) => void>>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (typeof msg.id !== 'number') {
        if (typeof msg.method === 'string') for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
        return;
      }
      const entry = this.waiting.get(msg.id);
      if (!entry) return;
      this.waiting.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`DevTools: ${msg.error.message ?? 'error'}`));
      else entry.resolve(msg.result);
    });
    socket.on('close', () => this.failAll('the tab closed the connection'));
    socket.on('error', () => this.failAll('the connection failed'));
  }

  static async connect(target: CdpTarget, port = cdpPort(), timeoutMs = 3_000): Promise<CdpSession> {
    const url = localSocketUrl(target.webSocketDebuggerUrl, `Tab ${target.id}`, port);
    return new CdpSession(await openSocket(url, `tab ${target.id}`, timeoutMs));
  }

  /** The browser itself (downloads), not a tab. */
  static async connectBrowser(port = cdpPort(), timeoutMs = 3_000): Promise<CdpSession> {
    const version = await getJson<CdpVersion & { webSocketDebuggerUrl?: string }>(port, '/json/version');
    const url = localSocketUrl(version.webSocketDebuggerUrl, 'The browser', port, '/devtools/browser/');
    return new CdpSession(await openSocket(url, 'the browser', timeoutMs));
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

  /** Calls `fn` for each `method` event until the returned function is called. */
  on(method: string, fn: (params: any) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(fn);
    this.listeners.set(method, set);
    return () => { set.delete(fn); };
  }

  close(): void {
    this.failAll('closed');
    this.listeners.clear();
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

/** One JARVIS operation per tab at a time: calls for the same tab wait their turn. */
const turns = new Map<string, Promise<unknown>>();

export function inTurn<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
  const previous = turns.get(tabId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const settled = run.catch(() => undefined);
  turns.set(tabId, settled);
  void settled.then(() => { if (turns.get(tabId) === settled) turns.delete(tabId); });
  return run;
}

/** One connection to the tab, in its turn (never call it for the same tab from inside `inTurn`). */
export function withPage<T>(target: CdpTarget, fn: (session: CdpSession) => Promise<T>, port = cdpPort()): Promise<T> {
  return inTurn(target.id, async () => {
    const session = await CdpSession.connect(target, port);
    try {
      return await fn(session);
    } finally {
      session.close();
    }
  });
}

/** A plain message for a page that did not answer in time; other errors unchanged. */
function pageTimeout(err: unknown, timeoutMs: number): Error {
  const message = err instanceof Error ? err.message : String(err);
  return /took longer than|Execution was terminated/i.test(message)
    ? new Error(`The page did not answer within ${timeoutMs} ms; it may be busy or frozen.`)
    : err instanceof Error ? err : new Error(message);
}

/**
 * A new isolated world in the tab's main frame: it shares the page's DOM but
 * not its JavaScript, so a page that replaces built-ins (String.prototype.slice,
 * an innerText getter) cannot change what JARVIS's scripts see or do.
 */
export async function isolatedWorld(session: CdpSession, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  try {
    const tree = await session.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, left());
    const world = await session.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: 'jarvis',
      grantUniveralAccess: false, // (the protocol's own spelling)
    }, left());
    return world.executionContextId;
  } catch (err) {
    throw pageTimeout(err, timeoutMs);
  }
}

type EvaluateResult<T> = { result?: { value?: T; objectId?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

function scriptFailure(details: NonNullable<EvaluateResult<unknown>['exceptionDetails']>): Error {
  const detail = details.exception?.description?.split('\n')[0] ?? details.text ?? 'error';
  return new Error(`The page script failed: ${detail}`);
}

/**
 * Evaluate one of the fixed scripts in `perception/cdpScripts.ts` and return
 * its value, in a new isolated world. Callers pass only those scripts: the
 * expression never comes from the model. `timeoutMs` bounds the whole call;
 * a busy or frozen page fails with a plain message.
 */
export async function evaluateFixed<T>(
  session: CdpSession,
  expression: string,
  timeoutMs = 5_000,
  /** userGesture: run as if the user had clicked (media play()); awaitPromise: wait for a promise the script returns. */
  opts: { userGesture?: boolean; awaitPromise?: boolean } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const contextId = await isolatedWorld(session, timeoutMs);
  let result: EvaluateResult<T>;
  try {
    result = await session.send('Runtime.evaluate', {
      expression, contextId, returnByValue: true, awaitPromise: !!opts.awaitPromise, userGesture: !!opts.userGesture, timeout: left(),
    }, left() + 500);
  } catch (err) {
    throw pageTimeout(err, timeoutMs);
  }
  if (result.exceptionDetails) throw scriptFailure(result.exceptionDetails);
  return result.result?.value as T;
}

/**
 * Call one of the fixed functions in `perception/cdpScripts.ts` (the `_FN`
 * constants) in an isolated world, with plain values as arguments. Values
 * are passed as data, never pasted into the source. With `{ handle: true }`
 * the result is a reference to the returned object (for DOM.setFileInputFiles)
 * instead of its value.
 */
export async function callFixed<T>(
  session: CdpSession,
  contextId: number,
  functionDeclaration: string,
  args: unknown[],
  timeoutMs = 5_000,
  options: { handle?: boolean } = {},
): Promise<T> {
  let result: EvaluateResult<T>;
  try {
    result = await session.send('Runtime.callFunctionOn', {
      functionDeclaration,
      executionContextId: contextId,
      arguments: args.map((value) => ({ value })),
      returnByValue: !options.handle,
      awaitPromise: false,
    }, timeoutMs);
  } catch (err) {
    throw pageTimeout(err, timeoutMs);
  }
  if (result.exceptionDetails) throw scriptFailure(result.exceptionDetails);
  return (options.handle ? result.result?.objectId : result.result?.value) as T;
}

/** Lets the page forget a handle from `callFixed(…, { handle: true })`. */
export async function releaseHandle(session: CdpSession, objectId: string): Promise<void> {
  await session.send('Runtime.releaseObject', { objectId }, 2_000).catch(() => undefined);
}
