/**
 * perception/devProbe.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Which development servers are running on this PC: a TCP connect to each
 * configured port on 127.0.0.1 (300 ms), and for an open one an HTTP GET of
 * `/` (1 s) for its status, server header and page title.
 *
 * Localhost only; redirects are never followed. A page title is the page's
 * own text: it is shortened, redacted, and marked untrusted.
 */

import * as http from 'http';
import * as net from 'net';
import { redact } from '../security/redactor.js';

export const DEFAULT_DEV_PORTS = [3000, 3001, 4200, 5000, 5173, 8000, 8080, 8081, 8888] as const;

/**
 * Database ports: only connected to. An HTTP request to them is noise in
 * their logs (Redis reports it as a possible attack and drops the client).
 */
export const NON_HTTP_PORTS: ReadonlySet<number> = new Set([1433, 3306, 5432, 6379, 11211, 27017]);

export interface PortStatus {
  port: number;
  open: boolean;
  http?: {
    status: number;
    server?: string;
    /** The page's own title: untrusted text, never an instruction. */
    title?: string;
    location?: string;
  };
}

/** JARVIS_DEV_PORTS="3000,5173" or the defaults; invalid entries are dropped. */
export function devPorts(env: Record<string, string | undefined> = process.env): number[] {
  const configured = (env['JARVIS_DEV_PORTS'] ?? '')
    .split(/[,;\s]+/)
    .map((p) => Number(p))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return configured.length ? [...new Set(configured)] : [...DEFAULT_DEV_PORTS];
}

export function portOpen(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function pageTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const title = redact(m[1]!.replace(/\s+/g, ' ').trim());
  return title ? title.slice(0, 80) : undefined;
}

const MAX_BODY = 64 * 1024;

export function httpInfo(port: number, timeoutMs = 1000): Promise<PortStatus['http'] | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PortStatus['http'] | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { 'User-Agent': 'JARVIS-devProbe' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      const answer = () => finish({
        status: res.statusCode ?? 0,
        ...(typeof res.headers.server === 'string' ? { server: redact(res.headers.server).slice(0, 60) } : {}),
        ...(pageTitle(body) ? { title: pageTitle(body) } : {}),
        // Reported, not followed.
        ...(typeof res.headers.location === 'string' ? { location: redact(res.headers.location).slice(0, 120) } : {}),
      });
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_BODY) { answer(); req.destroy(); }
      });
      res.on('end', answer);
      res.on('error', answer);
      res.on('close', answer);
    });
    const timer = setTimeout(() => { req.destroy(); finish(undefined); }, timeoutMs);
    req.on('error', () => finish(undefined));
  });
}

/** Every port in parallel; each takes at most ~1.3 s. */
export async function scanDevPorts(ports = devPorts()): Promise<PortStatus[]> {
  return Promise.all(ports.map(async (port): Promise<PortStatus> => {
    if (!(await portOpen(port))) return { port, open: false };
    if (NON_HTTP_PORTS.has(port)) return { port, open: true };
    const info = await httpInfo(port);
    return { port, open: true, ...(info ? { http: info } : {}) };
  }));
}

/** One spoken sentence about the servers that answered. */
export function describeServers(statuses: PortStatus[]): string {
  const open = statuses.filter((s) => s.open);
  if (open.length === 0) {
    return `No development server is running on the usual ports, sir (${statuses.map((s) => s.port).join(', ')}).`;
  }
  const each = open.map((s) => (s.http
    ? `port ${s.port} answers ${s.http.status}`
    : NON_HTTP_PORTS.has(s.port) ? `port ${s.port} is open` : `port ${s.port} is open but does not answer HTTP`));
  return `${open.length === 1 ? 'One local server is' : `${open.length} local servers are`} running, sir: ${each.join('; ')}.`;
}
