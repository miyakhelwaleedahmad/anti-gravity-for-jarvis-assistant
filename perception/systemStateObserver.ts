import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { getWindowsState } from './windowsState.js';
import { getChromeState } from './chromeState.js';
import { getJarvisServiceState } from './jarvisServiceState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SystemStateObserverConfig {
  activeWindowIntervalMs: number;
  openAppsIntervalMs: number;
  chromeTabsIntervalMs: number;
  jarvisServicesIntervalMs: number;
  systemStatsIntervalMs: number;
  writeIntervalMs: number;
}

function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const DEFAULT_CONFIG: SystemStateObserverConfig = {
  // OPT-BG-1: Raised intervals — persistent PS session (OPT-PS-1) makes
  // each poll cheap (5–30ms vs old 200–800ms), so we can poll less often
  // without losing responsiveness while saving ~50% background CPU.
  activeWindowIntervalMs:   envMs('JARVIS_ACTIVE_WINDOW_POLL_MS', 8000),   // was 4000
  openAppsIntervalMs:       envMs('JARVIS_OPEN_APPS_POLL_MS',     10000),  // was 5000
  chromeTabsIntervalMs:     envMs('JARVIS_CHROME_TABS_POLL_MS',   12000),  // was 7000
  jarvisServicesIntervalMs: envMs('JARVIS_SERVICES_POLL_MS',      20000),  // was 15000
  systemStatsIntervalMs:    envMs('JARVIS_SYSTEM_STATS_POLL_MS',  15000),  // was 10000
  writeIntervalMs:          envMs('JARVIS_SYSTEM_STATE_WRITE_MS', 5000),   // was 3000
};


export class SystemStateObserver {
  private config: SystemStateObserverConfig;
  private stateFilePath: string;
  private state: any;
  private isRunning = false;
  private timers: any[] = [];
  private stateChanged = false;

  // Locks to prevent concurrent execution of slow probes
  private windowsProbeLock = false;
  private chromeProbeLock = false;
  private servicesProbeLock = false;

  constructor(config: Partial<SystemStateObserverConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stateFilePath = path.resolve(__dirname, '..', 'data', 'runtime', 'system_state.json');
    this.state = {
      timestamp: new Date().toISOString(),
      activeWindow: { title: '', processName: '', pid: 0 },
      openApps: [],
      chrome: { running: false, debugPort: 9222, tabs: [] },
      jarvisServices: {
        redis: 'unknown',
        vectorMemory: 'unknown',
        nodeBridge: 'unknown',
        stt: 'unknown',
        tts: 'unknown',
        wakeword: 'unknown',
        vision: 'unknown'
      },
      system: {
        platform: process.platform,
        freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024)
      },
      safety: {
        protectedApps: ['Antigravity', 'Code', 'WindowsTerminal', 'powershell', 'cmd'],
        destructiveActionsRequireConfirmation: true
      }
    };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[SystemStateObserver] Starting background PC state observer...');

    // Ensure the runtime directory exists synchronously at start
    const dir = path.dirname(this.stateFilePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err: any) {
      if (err.code !== 'EEXIST') {
        console.error('[SystemStateObserver] Failed to create runtime dir:', err.message);
      }
    }

    // Schedule background loops
    this.schedule(async () => this.pollWindowsState(), this.config.activeWindowIntervalMs);
    this.schedule(async () => this.pollChromeState(), this.config.chromeTabsIntervalMs);
    this.schedule(async () => this.pollJarvisServices(), this.config.jarvisServicesIntervalMs);
    this.schedule(async () => this.pollSystemStats(), this.config.systemStatsIntervalMs);
    this.schedule(async () => this.writeStateToFile(), this.config.writeIntervalMs);
    console.log(
      `[SystemStateObserver] Poll intervals activeWindow=${this.config.activeWindowIntervalMs}ms chromeTabs=${this.config.chromeTabsIntervalMs}ms services=${this.config.jarvisServicesIntervalMs}ms write=${this.config.writeIntervalMs}ms`,
    );
    
    // Initial runs (asynchronous to avoid blocking startup)
    setImmediate(() => {
      this.pollWindowsState();
      this.pollChromeState();
      this.pollJarvisServices();
      this.pollSystemStats();
    });
  }

  stop(): void {
    this.isRunning = false;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    console.log('[SystemStateObserver] Stopped background PC state observer.');
  }

  getState(): any {
    return { ...this.state };
  }

  private schedule(task: () => Promise<void>, intervalMs: number): void {
    const timer = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        await task();
      } catch (err: any) {
        console.error('[SystemStateObserver] Task error:', err.message);
      }
    }, intervalMs);
    timer.unref(); // don't block process exit
    this.timers.push(timer);
  }

  private async pollWindowsState(): Promise<void> {
    if (this.windowsProbeLock) return;
    this.windowsProbeLock = true;
    try {
      const windowsData = await getWindowsState();
      
      const activeWindowChanged = JSON.stringify(this.state.activeWindow) !== JSON.stringify(windowsData.activeWindow);
      const openAppsChanged = JSON.stringify(this.state.openApps) !== JSON.stringify(windowsData.openApps);
      
      if (activeWindowChanged || openAppsChanged) {
        this.state.activeWindow = windowsData.activeWindow;
        this.state.openApps = windowsData.openApps;
        this.stateChanged = true;
      }
    } finally {
      this.windowsProbeLock = false;
    }
  }

  private async pollChromeState(): Promise<void> {
    if (this.chromeProbeLock) return;
    this.chromeProbeLock = true;
    try {
      const chromeData = await getChromeState();
      const chromeChanged = JSON.stringify(this.state.chrome) !== JSON.stringify(chromeData);
      
      if (chromeChanged) {
        this.state.chrome = chromeData;
        this.stateChanged = true;
      }
    } finally {
      this.chromeProbeLock = false;
    }
  }

  private async pollJarvisServices(): Promise<void> {
    if (this.servicesProbeLock) return;
    this.servicesProbeLock = true;
    try {
      const servicesData = await getJarvisServiceState();
      const servicesChanged = JSON.stringify(this.state.jarvisServices) !== JSON.stringify(servicesData);
      
      if (servicesChanged) {
        this.state.jarvisServices = servicesData;
        this.stateChanged = true;
      }
    } finally {
      this.servicesProbeLock = false;
    }
  }

  private async pollSystemStats(): Promise<void> {
    const freeMemoryMb = Math.round(os.freemem() / 1024 / 1024);
    const totalMemoryMb = Math.round(os.totalmem() / 1024 / 1024);
    
    if (this.state.system.freeMemoryMb !== freeMemoryMb || this.state.system.totalMemoryMb !== totalMemoryMb) {
      this.state.system.freeMemoryMb = freeMemoryMb;
      this.state.system.totalMemoryMb = totalMemoryMb;
      this.stateChanged = true;
    }
  }

  private async writeStateToFile(): Promise<void> {
    if (!this.stateChanged) return;

    // Capture snapshot before async I/O — another poll may mutate this.state
    // while we await the write, so we serialize a copy to prevent partial data.
    const snapshot = { ...this.state, timestamp: new Date().toISOString() };
    const content = JSON.stringify(snapshot, null, 2);

    try {
      const dir = path.dirname(this.stateFilePath);
      await fs.promises.mkdir(dir, { recursive: true });
      const tempPath = this.stateFilePath + '.tmp';
      await fs.promises.writeFile(tempPath, content, 'utf-8');
      
      try {
        await fs.promises.rename(tempPath, this.stateFilePath);
      } catch (renameErr: any) {
        // Fallback for Windows file lock (EPERM / EBUSY) when reading concurrently
        if (['EPERM', 'EBUSY', 'EACCES'].includes(renameErr.code)) {
          await fs.promises.writeFile(this.stateFilePath, content, 'utf-8');
          try { await fs.promises.unlink(tempPath); } catch {}
        } else {
          throw renameErr;
        }
      }
      // Reset AFTER successful write so data is never silently dropped.
      this.stateChanged = false;
    } catch (err: any) {
      // Do not reset stateChanged on failure — retry on next interval.
      console.error(
        `[SystemStateObserver] Failed to write system_state.json (${this.stateFilePath}):`,
        err.message,
      );
    }
  }
}

export const systemStateObserver = new SystemStateObserver();
