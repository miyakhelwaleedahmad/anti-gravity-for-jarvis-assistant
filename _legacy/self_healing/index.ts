/**
 * autonomy/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single barrel export for the entire self-healing + pipeline layer.
 */

export { selfHealingManager, SelfHealingManager } from "./selfHealingManager.js";
export { failureDetector, FailureDetector } from "./failureDetector.js";
export { classifyFailure } from "./failureClassifier.js";
export type { ClassifiedFailure, FailureType, FailureSeverity } from "./failureClassifier.js";
export { planRecovery, computeBackoffMs, getRecoveryPolicy } from "./recoveryPlanner.js";
export type { RecoveryPlan, RecoveryAction, RecoveryActionKind, RecoveryPolicy } from "./recoveryPlanner.js";
export { repairExecutor, RepairExecutor } from "./repairExecutor.js";
export { fallbackRouter, FallbackRouter } from "./fallbackRouter.js";
export type { TTSEngine, STTEngine } from "./fallbackRouter.js";
// PART B-1: Export pipeline registry
export { pipelineRegistry, PipelineRegistry } from "./pipelineRegistry.js";
export type { PipelineHealth, PipelineHealthReport, PipelineStatus } from "./pipelineRegistry.js";

// PART B-2 & B-4: Watchdogs
export { pipelineWatchdog, PipelineWatchdog } from "./pipelineWatchdog.js";
export { fsWatcher, FSWatcher } from "./fsWatcher.js";

// Phase 8: Self-Healing & Monitoring
export { healthScorer, HealthScorer } from "./healthScorer.js";
export type { HealthScore, HealthBand } from "./healthScorer.js";
export { failureAnalytics, FailureAnalytics } from "./failureAnalytics.js";
export type { FailureDigest, PipelineAnalytics, EventKind } from "./failureAnalytics.js";
export { alertManager, AlertManager } from "./alertManager.js";
export type { Alert, AlertSeverity } from "./alertManager.js";
export { healthChecker, HealthChecker } from "./healthChecker.js";
export type { ProbeResult } from "./healthChecker.js";
