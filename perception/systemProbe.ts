/**
 * perception/systemProbe.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A snapshot of the machine, read when asked (docs/upgrade/SYSTEM_AWARENESS.md):
 * OS, CPU and its load, memory, uptime, disks, network addresses.
 *
 * Node APIs only, so the same code runs on Windows and Linux. No MAC addresses.
 */

import * as fs from 'fs';
import * as os from 'os';

export interface DiskInfo {
  mount: string;
  totalGB: number;
  freeGB: number;
  usedPercent: number;
}

export interface NetworkAddress {
  name: string;
  ipv4: string;
  internal: boolean;
}

export interface SystemSnapshot {
  platform: NodeJS.Platform;
  release: string;
  version: string;
  arch: string;
  cpu: { model: string; cores: number; usagePercent: number };
  memory: { totalGB: number; freeGB: number; usedPercent: number };
  uptimeHours: number;
  disks: DiskInfo[];
  network: NetworkAddress[];
  takenAt: string;
}

const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** CPU load over `sampleMs`, from two readings of the counters. */
export async function cpuUsagePercent(sampleMs = 200): Promise<number> {
  const before = os.cpus();
  await sleep(sampleMs);
  const after = os.cpus();
  let idle = 0;
  let total = 0;
  after.forEach((cpu, i) => {
    const prev = before[i]?.times;
    if (!prev) return;
    const t = cpu.times;
    const busy = (t.user - prev.user) + (t.nice - prev.nice) + (t.sys - prev.sys) + (t.irq - prev.irq);
    const rest = t.idle - prev.idle;
    total += busy + rest;
    idle += rest;
  });
  return total > 0 ? round1(100 * (1 - idle / total)) : 0;
}

/** Drive roots: C:\ to Z:\ that exist on Windows (A: and B: can stall), `/` elsewhere. */
export function driveRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['/'];
  const roots: string[] = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try { if (fs.existsSync(root)) roots.push(root); } catch { /* not a drive */ }
  }
  return roots;
}

export async function diskInfo(roots = driveRoots()): Promise<DiskInfo[]> {
  const disks = await Promise.all(roots.map(async (mount): Promise<DiskInfo | null> => {
    try {
      const s = await fs.promises.statfs(mount);
      const total = s.blocks * s.bsize;
      if (total <= 0) return null;
      const free = s.bavail * s.bsize;
      return { mount, totalGB: round1(total / GB), freeGB: round1(free / GB), usedPercent: round1(100 * (1 - free / total)) };
    } catch {
      return null; // an empty card reader or a drive that went away
    }
  }));
  return disks.filter((d): d is DiskInfo => d !== null);
}

export function networkAddresses(): NetworkAddress[] {
  const out: NetworkAddress[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4') out.push({ name, ipv4: a.address, internal: a.internal });
    }
  }
  return out;
}

export async function systemSnapshot(): Promise<SystemSnapshot> {
  const cpus = os.cpus();
  const total = os.totalmem();
  const free = os.freemem();
  const [usagePercent, disks] = await Promise.all([cpuUsagePercent(), diskInfo()]);
  return {
    platform: process.platform,
    release: os.release(),
    version: typeof os.version === 'function' ? os.version() : '',
    arch: os.arch(),
    cpu: { model: cpus[0]?.model?.trim() ?? 'unknown', cores: cpus.length, usagePercent },
    memory: { totalGB: round1(total / GB), freeGB: round1(free / GB), usedPercent: round1(100 * (1 - free / total)) },
    uptimeHours: round1(os.uptime() / 3600),
    disks,
    network: networkAddresses(),
    takenAt: new Date().toISOString(),
  };
}

/** One spoken sentence: load, free memory, free space on the system drive. */
export function describeSnapshot(s: SystemSnapshot): string {
  const system = s.disks.find((d) => /^c:\\$/i.test(d.mount) || d.mount === '/') ?? s.disks[0];
  const parts = [
    `CPU at ${Math.round(s.cpu.usagePercent)} percent`,
    `${s.memory.freeGB} of ${s.memory.totalGB} GB memory free`,
  ];
  if (system) parts.push(`${Math.round(system.freeGB)} GB free on ${system.mount === '/' ? 'the system disk' : `drive ${system.mount[0]}`}`);
  return `${parts.join(', ')}, sir.`;
}
