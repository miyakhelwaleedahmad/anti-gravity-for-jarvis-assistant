/**
 * self_healing/fsWatcher.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Monitors the filesystem for live code changes and reacts.
 *
 * FIXES APPLIED:
 *  1. Debounced file handler (2s) — prevents spam restarts on rapid saves
 *  2. CONV-GUARD: defers restart if JARVIS is active, schedules after idle
 *  3. Type-safe process access via selfHealingManager.getManagedProcesses()
 *     instead of (selfHealingManager as any).processes
 */

import fs from "fs";
import path from "path";
import { pipelineRegistry } from "./pipelineRegistry.js";
import { selfHealingManager } from "./selfHealingManager.js";
import { conversationBus } from "../core/conversationBus.js";

const FILE_TO_PIPELINE_MAP: Record<string, string[]> = {
  "voice/stt.py":             ["wake_to_stt", "stt_to_brain"],
  "voice/tts.py":             ["brain_to_tts"],
  "voice/wakeWords.py":       ["wake_to_stt"],
  "bridge/groqProvider.ts":   ["brain_to_llm"],
  // The brain is core/orchestrator.ts. core/brain.ts is a migration leftover
  // that nothing imports, so watching it could never detect a real change to
  // the running reasoning path (JARVIS-018).
  "core/orchestrator.ts":     ["brain_to_llm", "brain_to_memory"],
  "memory/memoryManager.ts":  ["brain_to_memory", "memory_to_context"],
  // Tool execution lives in the registry now; core/toolExecutor.ts does not
  // exist. voice/reflectionEngine.py does not exist either — both entries were
  // watching paths that can never fire.
  "core/toolRegistryV2.ts":   ["tool_execution"],
};

export class FSWatcher {
  private watchers: fs.FSWatcher[] = [];
  // Debounce timers per file path
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly START_TIME = Date.now();
  private readonly STARTUP_GRACE_MS = 10_000;

  start(baseDir: string): void {
    const dirsToWatch = ["voice", "core", "bridge", "memory", "config"];

    for (const dir of dirsToWatch) {
      const fullPath = path.join(baseDir, dir);
      if (fs.existsSync(fullPath)) {
        console.log(`[FSWatcher] 👀 Watching directory: ${dir}/`);
        const watcher = fs.watch(fullPath, { recursive: true }, (eventType, filename) => {
          // Do not react to file changes for the first 10 seconds
          if (Date.now() - this.START_TIME < this.STARTUP_GRACE_MS) {
            if (filename) console.log(`[FSWatcher] Ignoring early change (startup grace): ${filename}`);
            return;
          }

          // ✅ FIXED: Ignore auto-generated and temp files
          if (filename && (filename.includes("temp_") || filename.includes("__pycache__"))) {
            return;
          }

          if (filename && (filename.endsWith(".ts") || filename.endsWith(".py"))) {
            const relPath = path.join(dir, filename).replace(/\\/g, "/");
            this.debouncedHandleFileChange(relPath);
          }
        });
        this.watchers.push(watcher);
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Debounced entry point — waits 2s of no additional saves before acting.
   * Prevents restart spam when editor writes multiple times on save.
   */
  private debouncedHandleFileChange(relativeFilePath: string): void {
    const existing = this.debounceTimers.get(relativeFilePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(relativeFilePath);
      this.handleFileChange(relativeFilePath);
    }, 2000);

    this.debounceTimers.set(relativeFilePath, timer);
  }

  private handleFileChange(relativeFilePath: string): void {
    console.log(`[FSWatcher] 🔄 Change detected: ${relativeFilePath}`);

    // CONV-GUARD: Defer action if JARVIS is currently in a conversation or speaking
    if (!conversationBus.isIdle) {
      console.log(`[FSWatcher] ⏸ Change deferred for '${relativeFilePath}' — JARVIS is active.`);
      // Use coalesced onceIdle() to prevent listener stacking from rapid saves.
      const deferredHandler = () => {
        console.log(`[FSWatcher] ▶ Resuming deferred change: ${relativeFilePath}`);
        this.applyFileChange(relativeFilePath);
      };
      conversationBus.onceIdle(deferredHandler);
      return;
    }

    this.applyFileChange(relativeFilePath);
  }

  private applyFileChange(relativeFilePath: string): void {
    // Reset pipeline registry status for affected segments
    const affectedPipelines = FILE_TO_PIPELINE_MAP[relativeFilePath];
    if (affectedPipelines) {
      for (const pipeline of affectedPipelines) {
        pipelineRegistry.setStatus(pipeline, "unknown");
        console.log(`[FSWatcher] Reset pipeline '${pipeline}' to 'unknown' status.`);
      }
    }

    if (relativeFilePath.endsWith(".py")) {
      // TYPE-SAFE: use the public getter instead of (as any) cast
      const scriptName = path.basename(relativeFilePath);
      let foundLabel: string | null = null;
      let isRunning = false;

      for (const [key, value] of selfHealingManager.getManagedProcesses().entries()) {
        if (value.script.toLowerCase() === scriptName.toLowerCase()) {
          foundLabel = key;
          isRunning = value.proc !== null;
          break;
        }
      }

      if (foundLabel) {
        if (scriptName.toLowerCase() === "wakewords.py" && isRunning) {
          console.log(`[FSWatcher] Ignoring restart for WakeWord process as it is already running.`);
          return;
        }
        console.log(`[FSWatcher] Triggering graceful restart of Python service: ${foundLabel}`);
        selfHealingManager.scheduleRestart(foundLabel);
      }
    } else if (relativeFilePath.endsWith(".ts")) {
      console.warn(
        `[FSWatcher] ⚠️ TypeScript file modified (${relativeFilePath}). ` +
        `A full process restart (\`pnpm run dev\`) may be necessary if tsx is not hot-reloading.`
      );
    }
  }
}

export const fsWatcher = new FSWatcher();
