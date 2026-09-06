/**
 * self_healing/pipelineWatchdog.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A watchdog that runs every 60 seconds and checks for stale pipelines.
 */

import { pipelineRegistry } from "./pipelineRegistry.js";
import { selfHealingManager } from "./selfHealingManager.js";
import { EventEmitter } from "events";
import { conversationBus } from "../core/conversationBus.js";

interface HealAction {
  action: string;
  target: string;
}

const PIPELINE_HEAL_MAP: Record<string, HealAction> = {
  "wake_to_stt":       { action: "restart_process", target: "wakeword" },
  "stt_to_brain":      { action: "restart_process", target: "stt" },
  "brain_to_tts":      { action: "restart_process", target: "tts" },
  "brain_to_groq":     { action: "retry_connection", target: "groq" },
  "groq_to_memory":    { action: "reinit_memory",    target: "memoryManager" },
  "memory_to_context": { action: "reinit_memory",    target: "memoryManager" },
  "tool_execution":    { action: "reload_tools",     target: "toolExecutor" },
  "reflection_loop":   { action: "restart_script",   target: "reflectionEngine.py" },
};

export class PipelineWatchdog extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly CHECK_INTERVAL_MS = 60_000;
  private activeHeals = new Set<string>();

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.checkHealth(), this.CHECK_INTERVAL_MS);
    console.log(`[Watchdog] 🐕 Pipeline watchdog started (checks every ${this.CHECK_INTERVAL_MS / 1000}s).`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async checkHealth(): Promise<void> {
    // CONV-GUARD: Never trigger pipeline restarts during active conversation or TTS
    if (!conversationBus.isIdle) {
      console.log("[Watchdog] 🐕 Health check skipped — JARVIS is active (conversation or speaking).");
      return;
    }
    console.log("[Watchdog] Running pipeline health check...");
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;
    const TEN_MINUTES = 10 * 60 * 1000;

    const report = pipelineRegistry.getHealth();

    for (const [pipeline, health] of Object.entries(report)) {
      if (health.status === "unknown" || this.activeHeals.has(pipeline)) continue;

      let newStatus = health.status;

      // Rule: If failureCount >= 3 within the last 10 minutes -> mark as "broken"
      if (health.failureCount >= 3 && (now - health.lastFailure) < TEN_MINUTES) {
        newStatus = "broken";
      } 
      // Rule: If lastSuccess is > 5 mins ago AND failureCount > 0 -> mark as "degraded"
      else if (health.failureCount > 0 && (now - health.lastSuccess) > FIVE_MINUTES) {
        newStatus = "degraded";
      }

      if (newStatus !== health.status) {
        pipelineRegistry.setStatus(pipeline, newStatus);
        
        if (newStatus === "broken" || newStatus === "degraded") {
          console.warn(`[Watchdog] ⚠️ Pipeline '${pipeline}' marked as ${newStatus.toUpperCase()}`);
          this.initiateHeal(pipeline, newStatus);
        }
      }
    }
  }

  private initiateHeal(pipeline: string, severity: string): void {
    const health = pipelineRegistry.getPipeline(pipeline);
    
    if (health.autoHealAttempts >= 3) {
      console.error(`[Watchdog] 🔴 Pipeline '${pipeline}' is unrecoverable (3 heal attempts failed). Disabling auto-heal.`);
      this.emit("pipeline_unrecoverable", pipeline);
      return;
    }

    this.activeHeals.add(pipeline);
    pipelineRegistry.incrementHealAttempts(pipeline);
    
    const actionPlan = PIPELINE_HEAL_MAP[pipeline];
    if (!actionPlan) {
      console.error(`[Watchdog] No heal plan mapped for pipeline '${pipeline}'`);
      this.activeHeals.delete(pipeline);
      return;
    }

    console.log(`[Watchdog] Executing heal for '${pipeline}': ${actionPlan.action} targeting '${actionPlan.target}' (Attempt ${health.autoHealAttempts}/3)`);

    // Delegate to SelfHealingManager logic based on action plan
    try {
      void selfHealingManager.executeHealAction(pipeline, actionPlan);
    } catch (err) {
      console.error(`[Watchdog] Error executing heal action:`, err);
    }

    // Schedule re-check in 30 seconds
    setTimeout(() => {
      console.log(`[Watchdog] Re-checking heal status for '${pipeline}'...`);
      this.activeHeals.delete(pipeline);
      const postHeal = pipelineRegistry.getPipeline(pipeline);
      
      // If it hasn't succeeded since the heal started, trigger failure logic
      if (postHeal.status !== "healthy" && (Date.now() - postHeal.lastSuccess) > 30000) {
         console.warn(`[Watchdog] Heal for '${pipeline}' did not result in a success signal within 30s.`);
      } else {
         console.log(`[Watchdog] Heal for '${pipeline}' successful!`);
      }
    }, 30_000);
  }
}

export const pipelineWatchdog = new PipelineWatchdog();
