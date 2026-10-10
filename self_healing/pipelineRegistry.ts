/**
 * self_healing/pipelineRegistry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks the health of named pipeline segments directly.
 *
 * Pipeline names do not name a provider: the LLM path is `brain_to_llm`
 * whether Gemini or Groq is configured. The old names `brain_to_groq` and
 * `groq_to_memory` are still accepted everywhere and mapped to the new ones,
 * so an older caller or log reader keeps working.
 */

import { EventEmitter } from "events";
import { llmConfig } from "../config/llmconfig.js";

/** `loading`: starting up and expected to become healthy (e.g. a model loading); not a failure. */
export type PipelineStatus = "healthy" | "degraded" | "broken" | "loading" | "unknown";

/** The LLM call path, for the configured provider. */
export const LLM_PIPELINE = "brain_to_llm";
/** Writing the memory database (was `groq_to_memory`). */
export const MEMORY_PIPELINE = "brain_to_memory";
/** The vector memory service (reported by its supervisor and the health checker). */
export const VECTOR_PIPELINE = "vector_memory";

/** Old pipeline names → current ones. */
export const LEGACY_PIPELINE_ALIASES: Readonly<Record<string, string>> = {
  brain_to_groq: LLM_PIPELINE,
  groq_to_memory: MEMORY_PIPELINE,
};

export function canonicalPipeline(name: string): string {
  return LEGACY_PIPELINE_ALIASES[name] ?? name;
}

/**
 * A name a person can understand, for speech and alerts. The LLM path is
 * named after the provider actually configured.
 */
export function pipelineLabel(name: string, provider: string = llmConfig.provider === "gemini" ? "Gemini" : "Groq"): string {
  const p = canonicalPipeline(name);
  const labels: Record<string, string> = {
    wake_to_stt: "wake word",
    stt_to_brain: "speech recognition",
    brain_to_tts: "speech output",
    [LLM_PIPELINE]: provider ? `${provider} language model` : "language model",
    [MEMORY_PIPELINE]: "memory storage",
    memory_to_context: "memory recall",
    [VECTOR_PIPELINE]: "vector memory",
    tool_execution: "tool",
    vision_to_bridge: "vision",
  };
  return labels[p] ?? p.replace(/_/g, " ");
}

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
      LLM_PIPELINE,
      MEMORY_PIPELINE,
      VECTOR_PIPELINE,
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
    pipeline = canonicalPipeline(pipeline);
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
    pipeline = canonicalPipeline(pipeline);
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
    return this.getOrCreate(canonicalPipeline(pipeline));
  }

  setStatus(pipeline: string, status: PipelineStatus): void {
    const health = this.getOrCreate(canonicalPipeline(pipeline));
    health.status = status;
  }

  /**
   * Starting up (e.g. a model loading): not healthy yet, but not failing. The
   * watchdog leaves a loading pipeline alone; the first success makes it healthy.
   */
  recordLoading(pipeline: string): void {
    const health = this.getOrCreate(canonicalPipeline(pipeline));
    health.status = "loading";
  }

  incrementHealAttempts(pipeline: string): void {
    const health = this.getOrCreate(canonicalPipeline(pipeline));
    health.autoHealAttempts += 1;
  }

  resetHealAttempts(pipeline: string): void {
    const health = this.getOrCreate(canonicalPipeline(pipeline));
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
