/**
 * tests/chromeHelper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a test: finds a Chromium or Chrome on this machine and starts it headless
 * with a debugging port and a throwaway profile, for the browser tests.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const CANDIDATES = [
  process.env['JARVIS_TEST_CHROME'] ?? '',
  '/opt/pw-browsers/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findChromium(): string | undefined {
  return CANDIDATES.find((p) => p && fs.existsSync(p));
}

export async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export interface RunningChrome {
  port: number;
  process: ChildProcess;
  stop(): Promise<void>;
}

/** Headless, a free debugging port, a throwaway profile; resolves once DevTools answers. */
export async function startChromium(url = 'about:blank'): Promise<RunningChrome> {
  const binary = findChromium();
  if (!binary) throw new Error('No Chromium or Chrome found (set JARVIS_TEST_CHROME).');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chrome-'));
  const proc = spawn(binary, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu', url,
  ], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) break;
    } catch { /* not up yet */ }
  }
  return {
    port,
    process: proc,
    async stop() {
      proc.kill();
      await new Promise((r) => setTimeout(r, 500));
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still in use */ }
    },
  };
}
