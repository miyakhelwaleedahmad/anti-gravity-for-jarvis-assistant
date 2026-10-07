/**
 * perception/windowsProbe.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Windows readings on request (P14, docs/upgrade/SYSTEM_AWARENESS.md): GPU,
 * displays, audio devices (speakers and microphones), cameras, installed
 * apps, services, listening ports with their process, and windows with their
 * process.
 *
 * Each reading runs perception/windows_probe.ps1 in its own short PowerShell
 * process. The section name goes in through an environment variable and is
 * checked against a fixed list on both sides; the script text never changes.
 * The persistent session (perception/windowsState.ts) is not used: these
 * readings can take seconds (WMI, the registry), and that session also serves
 * the window poll every 4 s and the window actions, which would wait behind a
 * slow reading or see the session restarted by a stuck one.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The only PowerShell files JARVIS runs this way. */
export const PS_FILES = {
  probe: path.join(here, 'windows_probe.ps1'),
  desktop: path.join(here, '..', 'control', 'desktop.ps1'),
  uia: path.join(here, '..', 'control', 'uia.ps1'),
} as const;

export const PROBE_SECTIONS = ['gpu', 'displays', 'audio', 'cameras', 'apps', 'services', 'ports', 'windows'] as const;
export type ProbeSection = typeof PROBE_SECTIONS[number];

export class WindowsOnlyError extends Error {
  constructor() { super('This needs Windows: JARVIS reads it through Windows PowerShell.'); }
}

export interface PsResult { ok: boolean; error?: string; [key: string]: unknown }

/** Values for the scripts: short, one line, no control characters. */
const SAFE_ENV_VALUE = /^[^\u0000-\u001f]{0,4096}$/;

/**
 * Runs one of JARVIS's own .ps1 files with values in environment variables
 * and returns the JSON object it printed last.
 */
export function runPsFile(file: keyof typeof PS_FILES, env: Record<string, string>, timeoutMs: number): Promise<PsResult> {
  if (!Object.prototype.hasOwnProperty.call(PS_FILES, file)) return Promise.reject(new Error('Refused: JARVIS runs only its own PowerShell files.'));
  for (const [name, value] of Object.entries(env)) {
    if (!/^JARVIS_[A-Z_]{1,40}$/.test(name) || typeof value !== 'string' || !SAFE_ENV_VALUE.test(value)) {
      return Promise.reject(new Error(`Refused: ${name} is not a value JARVIS passes to PowerShell.`));
    }
  }
  if (process.platform !== 'win32') return Promise.reject(new WindowsOnlyError());
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_FILES[file]], {
      env: { ...process.env, ...env }, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell: false,
    }, (err, stdout) => {
      const line = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
      if (line) {
        try { resolve(JSON.parse(line) as PsResult); return; } catch { /* not JSON */ }
      }
      if (err && (err as { killed?: boolean }).killed) reject(new Error(`PowerShell did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      else reject(new Error(`PowerShell gave no result${err ? ` (${err.message.split('\n')[0]})` : ''}.`));
    });
  });
}

// ── Parsers: PowerShell's JSON → plain readings ────────────────────────────────

/** ConvertTo-Json gives an object for one item and nothing for none. */
export function asArray<T = Record<string, unknown>>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return value && typeof value === 'object' ? [value as T] : [];
}

const str = (v: unknown, max = 200): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

export interface GpuInfo { name: string; driver: string; memoryGB?: number; memoryNote?: string; width?: number; height?: number; refreshHz?: number; status: string }
export function parseGpu(r: PsResult): GpuInfo[] {
  return asArray(r['items']).map((g) => {
    const bytes = num(g['memoryBytes']);
    return {
      name: str(g['name']), driver: str(g['driver'], 40), status: str(g['status'], 20),
      ...(bytes ? { memoryGB: Math.round((bytes / 1024 ** 3) * 10) / 10 } : {}),
      // Win32_VideoController.AdapterRAM is 32 bits: a larger card shows about 4 GB.
      ...(bytes && bytes >= 4 * 1024 ** 3 - 1024 ** 2 ? { memoryNote: 'Windows reports at most 4 GB here; the card may have more' } : {}),
      ...(num(g['width']) ? { width: num(g['width']) } : {}),
      ...(num(g['height']) ? { height: num(g['height']) } : {}),
      ...(num(g['refreshHz']) ? { refreshHz: num(g['refreshHz']) } : {}),
    };
  }).filter((g) => g.name);
}

export interface DisplayInfo { name: string; primary: boolean; width: number; height: number; x: number; y: number }
export function parseDisplays(r: PsResult): DisplayInfo[] {
  return asArray(r['items']).map((d) => ({
    name: str(d['name'], 60), primary: d['primary'] === true,
    width: Number(d['width']) || 0, height: Number(d['height']) || 0, x: Number(d['x']) || 0, y: Number(d['y']) || 0,
  })).filter((d) => d.width > 0 && d.height > 0);
}

export type AudioRole = 'microphone' | 'speaker' | 'other';
/** What an audio endpoint is, from the name Windows gives it. */
export function audioRole(name: string): AudioRole {
  if (/microphone|\bmic\b|line in|input|array|headset mic/i.test(name)) return 'microphone';
  if (/speaker|headphone|headset|output|hdmi|display audio|digital audio|s\/pdif|earphone/i.test(name)) return 'speaker';
  return 'other';
}
export interface AudioInfo { devices: Array<{ name: string; maker: string; status: string }>; endpoints: Array<{ name: string; role: AudioRole; status: string }> }
export function parseAudio(r: PsResult): AudioInfo {
  return {
    devices: asArray(r['devices']).map((d) => ({ name: str(d['name']), maker: str(d['maker'], 60), status: str(d['status'], 20) })).filter((d) => d.name),
    endpoints: asArray(r['endpoints']).map((e) => ({ name: str(e['name']), role: audioRole(str(e['name'])), status: str(e['status'], 20) })).filter((e) => e.name),
  };
}

export interface CameraInfo { name: string; kind: string; status: string }
export function parseCameras(r: PsResult): CameraInfo[] {
  return asArray(r['items']).map((c) => ({ name: str(c['name']), kind: str(c['kind'], 20), status: str(c['status'], 20) })).filter((c) => c.name);
}

export interface InstalledApp { name: string; version: string; publisher: string }
export function parseApps(r: PsResult): { items: InstalledApp[]; total: number } {
  const items = asArray(r['items']).map((a) => ({ name: str(a['name'], 120), version: str(a['version'], 40), publisher: str(a['publisher'], 80) })).filter((a) => a.name);
  return { items, total: Number(r['total']) || items.length };
}

export interface ServiceInfo { name: string; display: string; status: string; start: string }
export function parseServices(r: PsResult): ServiceInfo[] {
  return asArray(r['items']).map((s) => ({ name: str(s['name'], 80), display: str(s['display'], 120), status: str(s['status'], 20), start: str(s['start'], 20) })).filter((s) => s.name);
}

export interface PortInfo { port: number; addresses: string[]; pid: number; process: string }
/** Listening ports, one entry per port and process (IPv4 and IPv6 listeners joined). */
export function parsePorts(r: PsResult): PortInfo[] {
  const byKey = new Map<string, PortInfo>();
  for (const p of asArray(r['items'])) {
    const port = Number(p['port']);
    const pid = Number(p['pid']);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const key = `${port}/${pid}`;
    const entry = byKey.get(key) ?? { port, addresses: [], pid: Number.isInteger(pid) ? pid : 0, process: str(p['process'], 60) };
    const address = str(p['address'], 60);
    if (address && !entry.addresses.includes(address)) entry.addresses.push(address);
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

export interface WindowInfo { pid: number; process: string; title: string; hwnd: string }
/** Visible top-level windows, each with its process; the handle as "0x…" (what the window tools take). */
export function parseWindows(r: PsResult): WindowInfo[] {
  return asArray(r['items']).map((w) => ({
    pid: Number(w['pid']) || 0, process: str(w['process'], 60), title: str(w['title'], 160),
    hwnd: /^\d{1,19}$/.test(String(w['hwnd'] ?? '')) ? `0x${BigInt(String(w['hwnd'])).toString(16).toUpperCase()}` : '',
  })).filter((w) => w.pid > 0 && w.hwnd);
}

/** Windows with the ports their process listens on: process ↔ window ↔ port. */
export function joinWindowsAndPorts(windows: WindowInfo[], ports: PortInfo[]): Array<WindowInfo & { ports: number[] }> {
  return windows.map((w) => ({ ...w, ports: ports.filter((p) => p.pid === w.pid).map((p) => p.port) }));
}

const PARSERS: Record<ProbeSection, (r: PsResult) => unknown> = {
  gpu: parseGpu, displays: parseDisplays, audio: parseAudio, cameras: parseCameras,
  apps: parseApps, services: parseServices, ports: parsePorts, windows: parseWindows,
};

/**
 * How long one reading may take. Each starts a fresh Windows PowerShell,
 * which on a slow PC needs many seconds before it runs a line: on the
 * owner's 2010 iMac with a hard disk, gpu, displays, audio, cameras and
 * services went past the first limits of 10–15 s (verify:windows,
 * 2026-10-07). A limit only matters when a reading is slow.
 */
const SECTION_TIMEOUT_MS: Record<ProbeSection, number> = {
  gpu: 60_000, displays: 45_000, audio: 60_000, cameras: 60_000, apps: 60_000, services: 60_000, ports: 45_000, windows: 45_000,
};

/** One window's state: a fresh PowerShell too, asked in the checks after window actions. */
const WINDOW_STATE_TIMEOUT_MS = 30_000;

export interface WindowState { exists: boolean; visible: boolean; foreground: boolean; minimized: boolean; maximized: boolean }

/**
 * One window, asked of Windows by its handle ("0x1A2B" or decimal digits):
 * the exact check after closing, focusing, minimising or maximising it —
 * not a list, which can leave a window out.
 */
export async function windowState(hwnd: string): Promise<WindowState> {
  const text = String(hwnd ?? '').trim();
  const decimal = /^0x[0-9a-f]{1,16}$/i.test(text) ? BigInt(text).toString() : /^\d{1,19}$/.test(text) ? text : '';
  if (!decimal) throw new Error('That is not a window handle.');
  const r = await runPsFile('probe', { JARVIS_PROBE_SECTION: 'window_state', JARVIS_PROBE_HWND: decimal }, WINDOW_STATE_TIMEOUT_MS);
  if (!r.ok) throw new Error(`Windows did not say how the window is: ${str(r.error, 160) || 'no reason given'}.`);
  return { exists: r['exists'] === true, visible: r['visible'] === true, foreground: r['foreground'] === true, minimized: r['minimized'] === true, maximized: r['maximized'] === true };
}

/** One reading, parsed. Throws WindowsOnlyError off Windows. */
export async function probeWindows(section: ProbeSection): Promise<unknown> {
  if (!(PROBE_SECTIONS as readonly string[]).includes(section)) throw new Error(`Unknown section "${String(section).slice(0, 20)}".`);
  const result = await runPsFile('probe', { JARVIS_PROBE_SECTION: section }, SECTION_TIMEOUT_MS[section]);
  if (!result.ok) throw new Error(`Windows did not give the ${section} reading: ${str(result.error, 160) || 'no reason given'}.`);
  return PARSERS[section](result);
}
