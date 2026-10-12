/**
 * system/controlCenter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A small local Control Center (OPS-01): a page on this PC that shows what
 * JARVIS is doing and offers a few actions. Off unless JARVIS_CONTROL_CENTER=1.
 *
 * What it does not do, on purpose:
 *   - listen anywhere but loopback (127.0.0.1 / ::1); any other host throws
 *   - show secrets: every answer passes the redactor, and the page never
 *     receives a key or token (the login token is typed by the owner)
 *   - run commands: there is no terminal and no free tool call; the actions
 *     are a fixed list
 *   - decide anything itself: each action runs through toolRegistryV2.execute,
 *     so the permission level, the risk engine and the approval gate apply as
 *     for a spoken request. A dangerous action (turning on full control) still
 *     asks for approval in the JARVIS console; a click does not approve it.
 *
 * Access:
 *   - the token in data/security/control_center_token (owner-only file, made
 *     at first start), or JARVIS_CONTROL_CENTER_TOKEN; typed on the login page
 *   - login gives an HttpOnly, SameSite=Strict session cookie (30 min idle)
 *     and a CSRF token; every POST needs both, a JSON body, and no foreign
 *     Origin. The Host header must name this loopback port (DNS rebinding).
 *   - five wrong tokens a minute, then logins are refused for that minute
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dataRoot } from '../core/workspaceRoot.js';
import { redact, redactDeep } from '../security/redactor.js';
import { assertLoopbackBind } from '../security/remoteAccess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONTROL_CENTER_DEFAULT_PORT = 7790;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_BODY_BYTES = 16 * 1024;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;

/** The actions the page may ask for, and how each maps to a registry tool. */
export const CONTROL_CENTER_ACTIONS: Record<string, { tool: string; args: (body: Record<string, unknown>) => Record<string, unknown> }> = {
  pause_goal: { tool: 'goal_control', args: (b) => ({ action: 'pause', goal: String(b['goal'] ?? 'latest').slice(0, 120) }) },
  resume_goal: { tool: 'goal_control', args: (b) => ({ action: 'resume', goal: String(b['goal'] ?? 'latest').slice(0, 120) }) },
  cancel_goal: { tool: 'goal_control', args: (b) => ({ action: 'cancel', goal: String(b['goal'] ?? 'latest').slice(0, 120) }) },
  stop_agents: { tool: 'cancel_agent_task', args: () => ({ which: 'all' }) },
  disable_full_control: { tool: 'disable_full_control_session', args: () => ({}) },
  enable_full_control: { tool: 'enable_full_control_session', args: (b) => ({ action: 'enable', durationMinutes: Number(b['minutes'] ?? 10) }) },
};

export interface ToolRunner {
  execute(tool: string, args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }>;
}

export interface ControlCenterOptions {
  host?: string;
  port?: number;
  token?: string;
  tools?: ToolRunner;
  /** Extra read-only status (LLM provider state). Redacted before it is sent. */
  extraStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  log?: (message: string) => void;
}

export function controlCenterTokenFile(): string {
  return path.join(dataRoot(path.resolve(__dirname, '..')), 'data', 'security', 'control_center_token');
}

/** The login token: JARVIS_CONTROL_CENTER_TOKEN, else a kept random one. Never logged. */
export function getControlCenterToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['JARVIS_CONTROL_CENTER_TOKEN']?.trim();
  if (fromEnv) return fromEnv;
  const file = controlCenterTokenFile();
  let token = '';
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch { /* not made yet */ }
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      token = fs.readFileSync(file, 'utf8').trim();
    }
  }
  return token;
}

function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

interface Session { id: string; csrf: string; lastSeen: number }

export interface ControlCenter {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

export async function startControlCenter(opts: ControlCenterOptions = {}): Promise<ControlCenter> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`The Control Center listens only on 127.0.0.1 or ::1, not "${host}".`);
  }
  assertLoopbackBind(host, 'The Control Center');
  const token = opts.token ?? getControlCenterToken();
  const log = opts.log ?? ((m: string) => console.log(m));
  const tools: ToolRunner = opts.tools ?? (await import('../core/toolRegistryV2.js')).toolRegistryV2 as unknown as ToolRunner;
  const sessions = new Map<string, Session>();
  let loginFailures: number[] = [];
  let port = opts.port ?? CONTROL_CENTER_DEFAULT_PORT;

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, {
      'Content-Type': isText ? headers['Content-Type'] ?? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      ...headers,
    });
    res.end(isText ? body : JSON.stringify(redactDeep(body)));
  };

  const sessionOf = (req: http.IncomingMessage): Session | undefined => {
    const cookie = String(req.headers.cookie ?? '');
    const id = /(?:^|;\s*)jcc_session=([A-Za-z0-9_-]{20,})/.exec(cookie)?.[1];
    if (!id) return undefined;
    const s = sessions.get(id);
    if (!s) return undefined;
    if (Date.now() - s.lastSeen > SESSION_IDLE_MS) { sessions.delete(id); return undefined; }
    s.lastSeen = Date.now();
    return s;
  };

  const hostAllowed = (req: http.IncomingMessage) => {
    const h = String(req.headers.host ?? '');
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
  };
  const originAllowed = (req: http.IncomingMessage) => {
    const o = req.headers.origin;
    if (o === undefined) return true;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}` || o === `http://[::1]:${port}`;
  };

  const readJson = (req: http.IncomingMessage): Promise<Record<string, unknown> | null> => new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null);
      } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });

  const status = async () => {
    const run = async (tool: string, args: Record<string, unknown>) => {
      try {
        const r = await tools.execute(tool, args);
        return r.success ? String(r.output ?? '') : `unavailable: ${String(r.error ?? 'failed').slice(0, 120)}`;
      } catch (err) {
        return `unavailable: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
      }
    };
    return {
      permissions: await run('get_permission_status', {}),
      goals: await run('goal_status', {}),
      agents: await run('agent_status', { question: 'summary' }),
      ...(opts.extraStatus ? { model: await opts.extraStatus() } : {}),
      actions: Object.keys(CONTROL_CENTER_ACTIONS),
    };
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) return send(res, 421, { error: 'Wrong host.' });
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/') {
        return send(res, 200, fs.readFileSync(path.join(__dirname, 'controlCenter', 'index.html'), 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (method === 'GET' && (url.pathname === '/app.js' || url.pathname === '/app.css')) {
        const file = url.pathname.slice(1);
        const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
        return send(res, 200, fs.readFileSync(path.join(__dirname, 'controlCenter', file), 'utf8'), { 'Content-Type': type });
      }

      if (method === 'POST') {
        if (!originAllowed(req)) return send(res, 403, { error: 'Requests from other sites are refused.' });
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return send(res, 415, { error: 'Send JSON.' });
        }
      }

      if (method === 'POST' && url.pathname === '/api/login') {
        const now = Date.now();
        loginFailures = loginFailures.filter((t) => now - t < LOGIN_WINDOW_MS);
        if (loginFailures.length >= LOGIN_LIMIT) return send(res, 429, { error: 'Too many wrong tokens. Wait a minute.' });
        const body = await readJson(req);
        const given = typeof body?.['token'] === 'string' ? body['token'] : '';
        if (!given || !sameSecret(given, token)) {
          loginFailures.push(now);
          log('[ControlCenter] Refused a login with a wrong token.');
          return send(res, 401, { error: 'Wrong token.' });
        }
        const s: Session = { id: crypto.randomBytes(24).toString('base64url'), csrf: crypto.randomBytes(24).toString('base64url'), lastSeen: now };
        sessions.set(s.id, s);
        log('[ControlCenter] Owner logged in.');
        return send(res, 200, { csrf: s.csrf }, { 'Set-Cookie': `jcc_session=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}` });
      }

      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
      const session = sessionOf(req);
      if (!session) return send(res, 401, { error: 'Log in first.' });

      if (method === 'GET' && url.pathname === '/api/status') return send(res, 200, await status());

      if (method !== 'POST') return send(res, 405, { error: 'Not allowed.' });
      const csrf = String(req.headers['x-csrf-token'] ?? '');
      if (!csrf || !sameSecret(csrf, session.csrf)) return send(res, 403, { error: 'Missing or wrong CSRF token.' });

      if (url.pathname === '/api/logout') {
        sessions.delete(session.id);
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'jcc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (url.pathname === '/api/action') {
        const body = await readJson(req);
        const name = typeof body?.['action'] === 'string' ? body['action'] : '';
        const action = Object.prototype.hasOwnProperty.call(CONTROL_CENTER_ACTIONS, name) ? CONTROL_CENTER_ACTIONS[name] : undefined;
        if (!body || !action) return send(res, 403, { error: 'That action is not offered here.' });
        log(`[ControlCenter] Action "${name}" → ${action.tool} (through the registry).`);
        const result = await tools.execute(action.tool, action.args(body));
        return send(res, result.success ? 200 : 409, { success: result.success, output: String(result.output ?? '').slice(0, 2000), error: result.error });
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (err) {
      log(`[ControlCenter] Request failed: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      if (!res.headersSent) send(res, 500, { error: 'The Control Center could not answer.' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (address && typeof address === 'object') port = address.port;
  log(`[ControlCenter] Listening on http://${host === '::1' ? '[::1]' : host}:${port} (this PC only).`);
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => { sessions.clear(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
