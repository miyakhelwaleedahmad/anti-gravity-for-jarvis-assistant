/**
 * self_healing/pipelineRegistry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks the health of named pipeline segments directly.
 */

import { EventEmitter } from "events";

export type PipelineStatus = "healthy" | "degraded" | "broken" | "unknown";

export interface PipelineHealth {
  pipeline: string;
  lastSuccess: number;
  lastFailure: number;
  failureCount: number;
  status: PipelineStatus;
  autoHealAttempts: number;
}

export type PipelineHealthReport = Record<string, PipelineHealth>;

export class PipelineRegistry extends EventEmitter {
  private static instance: PipelineRegistry;
  private pipelines: Map<string, PipelineHealth> = new Map();

  private constructor() {
    super();
    const defaultPipelines = [
      "wake_to_stt",
      "stt_to_brain",
      "brain_to_tts",
      "brain_to_groq",
      "groq_to_memory",
      "memory_to_context",
      "tool_execution",
      // "reflection_loop" removed with JARVIS-018: voice/reflectionEngine.py
      // does not exist, so the pipeline could never report healthy and the
      // watchdog could only ever log "no heal plan mapped" for it.
    ];
    for (const p of defaultPipelines) {
      this.pipelines.set(p, {
        pipeline: p,
        lastSuccess: 0,
        lastFailure: 0,
        failureCount: 0,
        status: "unknown",
        autoHealAttempts: 0
      });
    }
  }

  static getInstance(): PipelineRegistry {
    if (!PipelineRegistry.instance) {
      PipelineRegistry.instance = new PipelineRegistry();
    }
    return PipelineRegistry.instance;
  }

  recordSuccess(pipeline: string): void {
    const health = this.getOrCreate(pipeline);
    health.lastSuccess = Date.now();
    health.failureCount = 0;
    if (health.status !== "healthy") {
      health.status = "healthy";
      health.autoHealAttempts = 0;
      console.log(`[PipelineRegistry] 🟢 Pipeline '${pipeline}' is now healthy.`);
    }
    // Only update map, don't necessarily emit just for success
  }

  recordFailure(pipeline: string, error: string): void {
    const health = this.getOrCreate(pipeline);
    health.lastFailure = Date.now();
    health.failureCount += 1;
    console.error(`[PipelineRegistry] 🔴 Pipeline '${pipeline}' failure recorded: ${error} (count: ${health.failureCount})`);
  }

  getHealth(): PipelineHealthReport {
    const report: PipelineHealthReport = {};
    for (const [key, val] of this.pipelines.entries()) {
      report[key] = { ...val };
    }
    return report;
  }

  getBrokenPipelines(): string[] {
    const broken: string[] = [];
    for (const [key, val] of this.pipelines.entries()) {
      if (val.status === "broken" || val.status === "degraded") {
        broken.push(key);
      }
    }
    return broken;
  }

  getPipeline(pipeline: string): PipelineHealth {
    return this.getOrCreate(pipeline);
  }

  setStatus(pipeline: string, status: PipelineStatus): void {
    const health = this.getOrCreate(pipeline);
    health.status = status;
  }

  incrementHealAttempts(pipeline: string): void {
    const health = this.getOrCreate(pipeline);
    health.autoHealAttempts += 1;
  }

  resetHealAttempts(pipeline: string): void {
    const health = this.getOrCreate(pipeline);
    health.autoHealAttempts = 0;
  }

  private getOrCreate(pipeline: string): PipelineHealth {
    if (!this.pipelines.has(pipeline)) {
      this.pipelines.set(pipeline, {
        pipeline,
        lastSuccess: 0,
        lastFailure: 0,
        failureCount: 0,
        status: "unknown",
        autoHealAttempts: 0
      });
    }
    return this.pipelines.get(pipeline)!;
  }
}

export const pipelineRegistry = PipelineRegistry.getInstance();
