/**
 * core/orchestrator.ts  (Phase 1 — Controlled Autonomy Layer)
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS Central Orchestration Kernel
 *
 * PLAN → EXECUTE → OBSERVE → REFLECT → REPAIR → REPEAT
 *
 * Phase 1 additions (non-breaking extensions):
 *   - GoalManager       : wraps every request in a persistent Goal lifecycle
 *   - EnvironmentContext: injects OS/CWD/process awareness into LLM planning
 *   - Memory-driven plan: retrieves relevant facts before every planning call
 *   - Pre-execution     : reflectionEngine.preExecutionCheck() before DAG runs
 *   - Mid-execution     : reflectionEngine.midExecutionCheck() after each batch
 */

import { agentStateMachine, AgentState, tryTransition } from './agentStateMachine.js';
import { UNTRUSTED_RULE, untrusted } from '../security/untrustedText.js';
import { asRepair, beginTrace, endTrace } from './traceContext.js';
import { diagnose, MAX_RECOVERY_ROUNDS, observeFailure } from './stepRecovery.js';
import {
  continueOffer, continueQuestion, diagnosisSummary, repairSummary, runningSummary, systemStateSummary, tabsSummary, unfinishedReason,
} from './voiceSummaries.js';
import { taskGraphEngine, TaskGraphBuilder, type TaskGraph } from './taskGraphEngine.js';
import type { ApprovalDecision } from '../security/approvalRequest.js';
import { verificationFailedReply, withCheck } from './verifiers.js';
import { worldState } from './worldState.js';
import { approvalGate } from '../security/approvalGate.js';
import { currentTaskNode } from './taskContext.js';
import { toolRegistryV2, type ToolResult } from './toolRegistryV2.js';
import { APPROVAL_DENIED_REPLY, FULL_CONTROL_HINT, RATE_LIMITED_REPLY, isPermissionDenial } from '../control/permissionDenial.js';
import { reflectionEngine, type RepairStrategy } from './reflectionEngine.js';
import { agentMemory } from '../memory/agentMemory.js';
import { modelRouter } from '../bridge/modelRouter.js';
import { nodeBridge } from '../bridge/nodeBridge.js';
import { llmConfig } from '../config/llmconfig.js';
import { conversationBus } from './conversationBus.js';
import { registerAllTools } from './tools/index.js';
import { SkillLoader } from './skillLoader.js';
import { normalizeVoiceInput } from './voiceInput.js';
import { recordFailure } from './issueStore.js';
import { captureInFlight, noteInFlight } from './selfCheck.js';
import { selectPlanningToolNames, shouldUseHeavyContext } from './planningToolSelection.js';
import {
  describeCommandResult, desktopReply, devStatusReply, parseJson, repairFailure, systemStatusReply, trendingReply,
} from './replyText.js';
import { matchDeterministicCommand, type DeterministicRoute } from './deterministicRoutes.js';
export { capabilitiesReply, describeCommandResult, desktopReply, devStatusReply, systemStatusReply, trendingReply } from './replyText.js';
export { normalizeVoiceInput } from './voiceInput.js';
import type { ILLMMessage, ILLMToolCall } from '../bridge/llmTypes.js';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AsyncLocalStorage } from 'node:async_hooks';

// ── Phase 1: New module imports ───────────────────────────────────────────────
import { goalManager, type Goal } from './goalManager.js';
import { getSystemContext } from './environmentContext.js';
import { memoryManager } from '../memory/memoryManager.js';
import { unifiedContextBuilder } from '../memory/unifiedContextBuilder.js';
// ── Phase 6: Adaptive planning intelligence ────────────────────────────────
import { plannerIntelligence } from './plannerIntelligence.js';
import { taskGraphEngine as _tge } from './taskGraphEngine.js';
import { LOW_RISK_TOOLS, SIMPLE_REPLY_TOOLS } from './toolNameLists.js';
import { redact } from '../security/redactor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrchestratorConfig {
  maxRepairCycles: number;      // Max REFLECT→REPAIR→EXECUTE loops before abort
  streamingEnabled: boolean;    // Whether to stream LLM output to TTS
  voiceEnabled: boolean;        // Whether to route output to nodeBridge
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxRepairCycles: 3,
  streamingEnabled: true,
  voiceEnabled: true,
};

/**
 * The request a piece of the agent loop belongs to: its process() call and
 * that call's own abort signal (aborted by a newer request or an interrupt).
 * Checks used to read this.currentAbortController, which by then was the
 * newer request's: on the owner's PC a replaced request went on speaking and
 * moving the shared state, and the newer request failed with "unexpected
 * error" (SPEAKING -> OBSERVING).
 */
/** Longest the first request waits for the skill tools (HYP-02). */
const SKILLS_WAIT_MS = 10_000;

/**
 * How a request's planning went: the outcome of its last planPhase() and the
 * stage timings for its timing table. Kept per request (ARCH-03): on the
 * shared orchestrator, overlapping requests wrote the same fields.
 */
interface PlanState {
  outcome: 'graph' | 'answered' | 'failed' | 'interrupted';
  timings: Record<string, number>;
}
const requestContext = new AsyncLocalStorage<{ callId: string; signal: AbortSignal; plan?: PlanState }>();

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/** History tag for a reply built from tool output: it keeps that origin (SEC-03). */
const FROM_TOOLS = ['from_tool_output'];

/**
 * A history turn for the model. A reply that was built from tool output is
 * replayed inside the untrusted wrapper: it may repeat what a web page or a
 * document said, and it is evidence, not JARVIS's own instruction (SEC-03).
 */
function historyMessage(h: { role: string; content: string; tags?: string[] }): ILLMMessage {
  const role = (h.role === 'user' || h.role === 'assistant' ? h.role : 'user') as ILLMMessage['role'];
  if (h.tags?.includes(FROM_TOOLS[0]!)) {
    return { role, content: untrusted('earlier reply built from tool results', h.content) };
  }
  return { role, content: h.content };
}

export class JarvisOrchestrator {
  private config: OrchestratorConfig;
  private isLoopRunning = false;

  // ── Concurrent execution protection ─────────────────────────────────────────
  // Only one runAgentLoop() may be active at a time. A second process() call
  // while a loop is active will abort the previous one before starting a new one.
  private _loopExecuting = false;

  // Phase 1: tracks the active Goal object during a request
  /**
   * The goal of each request still running, by its process() call (REL-04).
   * One shared field was overwritten by an overlapping request and cleared by
   * whichever finished first, so an interrupt could miss a running goal.
   */
  private activeGoals = new Map<string, Goal>();
  private currentProcessCallId: string | null = null;
  private currentAbortController: AbortController | null = null;
  private isConversationEndDeferred = false;
  // Guard to prevent speaking:end listener and finally block from both
  // calling conversationEnded() / reset() simultaneously.
  private _conversationEndHandled = false;
  // Tracks whether conversationBus.conversationStarted() was called for the
  // current request — ensures the finally block can always pair it with
  // conversationEnded() even on very early exceptions.
  private _conversationStarted = false;
  /**
   * Plan state outside a request (planPhase called directly); inside one, see
   * planState(). Its outcome says how the last planPhase() call ended when it
   * returned no graph: it spoke a direct answer, spoke an apology for an LLM
   * failure, or was interrupted. The callers used to guess, and a replan that
   * answered directly was followed by "I was unable to recover from the
   * error, sir."
   */
  private planOutside: PlanState = { outcome: 'graph', timings: {} };
  /**
   * "Continue what I was doing" (P13): the unfinished request JARVIS offered
   * to run again. Only a "yes" as the very next request, within a minute,
   * runs it — as a new request, through every check; anything else drops it.
   */
  private continueOffer: { description: string; expires: number } | null = null;
  public onBargeIn: (() => void)[] = [];
  /**
   * Settles when the skills are registered (HYP-02). Loading was not awaited:
   * a request in the first moments was planned without the skill tools
   * (open_app, control_*, weather…), and the model picked something else.
   */
  private skillsReady: Promise<void> = Promise.resolve();

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Register all built-in tools on creation
    registerAllTools();

    // Load skills from skills/ directory and register as AgentTools
    const skillsDir = path.join(__dirname, '..', 'skills');
    const skillLoader = new SkillLoader(skillsDir);
    // HYP-02: kept, so the first requests wait for the skills (process()).
    this.skillsReady = skillLoader.loadSkills().then(count => {
      if (count > 0) {
        console.log(`[Orchestrator] 🎯 ${count} skill(s) loaded into ToolRegistry: ${toolRegistryV2.names().length} tools in total.`);
      }

      // Phase 7: Pre-warm context + tool caches immediately after skill load
      // so the first user request never suffers a cold-start penalty.
      Promise.resolve().then(async () => {
        try {
          // 1. LLM definition cache warm (was already here — moved inside skill callback)
          toolRegistryV2.getLLMDefinitions();

          // 2. Pre-warm unifiedContextBuilder with a placeholder 'default' session
          //    so the first light context build is a cache hit
          await unifiedContextBuilder.buildContext('startup warmup', 'default', {
            includeHeavy: false,
            depthHint: 'fast',
          });
          console.log('[Orchestrator] ☁️  Phase 7: context cache pre-warmed.');
        } catch { /* non-fatal */ }
      }).catch(() => {});
    }).catch(err => {
      console.warn('[Orchestrator] Skill loading failed (non-fatal):', err);
    }).then(() => undefined);

    // OPT-8: Pre-warm the LLM definition cache immediately (before skill load completes)
    Promise.resolve().then(() => toolRegistryV2.getLLMDefinitions()).catch(() => {});


    // OPT-8: Run GoalManager and MemoryManager init concurrently at startup.
    // Both are independent — no ordering requirement between them.
    Promise.all([
      goalManager.init().then(() => {
        console.log('[Orchestrator] 🎯 GoalManager initialized.');
      }),
      memoryManager.init().then(async () => {
        const { decayed, removed } = await memoryManager.decayMemory();
        if (decayed > 0) {
          console.log(`[Orchestrator] 🌙 Memory decay: ${decayed} facts aged, ${removed} pruned.`);
        }
      }),
    ]).catch(err => {
      console.warn('[Orchestrator] Startup init warning (non-fatal):', err);
    });

    // World state (P7): the task part follows the graph's steps and the
    // approval request on display.
    taskGraphEngine.on('node_started', (e: { tool: string; args?: Record<string, unknown> }) => worldState.stepStarted(stepLabel(e)));
    taskGraphEngine.on('node_completed', (e: { tool: string; args?: Record<string, unknown> }) => worldState.stepFinished(stepLabel(e), true));
    taskGraphEngine.on('node_failed', (e: { tool: string; args?: Record<string, unknown> }) => worldState.stepFinished(stepLabel(e), false));
    worldState.watchApprovals(() => approvalGate.pendingSummary());

    // Wire interrupt signal: abort active graph on interrupt
    agentStateMachine.on('interrupted', () => {
      this.currentAbortController?.abort();
      this.isConversationEndDeferred = false;
      const graph = taskGraphEngine.getCurrentGraph();
      if (graph) {
        console.log('[Orchestrator] 🛑 Interrupt received — aborting active task graph.');
        taskGraphEngine.interrupt(graph);
      }
      agentMemory.clearWorkingContext();
      // Phase 1: fail the active goal on interrupt
      for (const g of this.activeGoals.values()) goalManager.failGoal(g.id, 'Interrupted by user').catch(() => {});
      this.activeGoals.clear();
    });

    // Handle deferred conversation end and reset.
    // Guard with _conversationEndHandled to prevent the speaking:end listener
    // and the finally block from racing each other.
    conversationBus.on('speaking:end', () => {
      if (this.isConversationEndDeferred && !this._conversationEndHandled) {
        this._conversationEndHandled = true;
        console.log('[Orchestrator] Deferred TTS finished. Ending conversation and resetting state to IDLE.');
        this.isConversationEndDeferred = false;
        conversationBus.conversationEnded();
        if (agentStateMachine.currentState === AgentState.SPEAKING) {
          agentStateMachine.reset();
        }
      }
    });

    agentStateMachine.on('watchdog_reset', (data) => {
      this.handleWatchdogReset(data as { fromState: AgentState; reason: string });
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Main entry point. Accepts user input and drives the full agent loop.
   * Called by jarvis.ts for both voice (source='voice') and CLI (source='cli').
   */
  async process(input: string, source: 'cli' | 'voice' = 'cli'): Promise<void> {
    // The first request waits for the skills, at most SKILLS_WAIT_MS (HYP-02).
    await this.waitForSkills();
    const callId = Math.random().toString(36).substring(7);
    this.currentProcessCallId = callId;
    // "Why are you stuck?" describes the request in flight, so that is read
    // before this request's trace replaces it and the abort below stops it.
    if (this.matchDeterministicCommand(input)?.type === 'investigate_stuck') {
      try {
        noteInFlight(captureInFlight({
          state: String(agentStateMachine.currentState),
          stateHistory: agentStateMachine.stateHistory,
          graph: taskGraphEngine.getCurrentGraph(),
          ...(approvalGate.pendingSummary() ? { approval: approvalGate.pendingSummary()! } : {}),
        }));
      } catch (err) {
        console.warn('[Orchestrator] could not read the request in flight:', (err as Error).message);
      }
    }
    // One correlation id per request, so the plan, every tool call and the
    // outcome can be joined back together in the trace log (JARVIS-015).
    beginTrace(source, input);
    this.isConversationEndDeferred = false;
    this._conversationEndHandled = false;

    const curState = agentStateMachine.currentState;
    if (curState === AgentState.SPEAKING || curState === AgentState.INTERRUPTED) {
      this.handleBargeInBeforeProcessing(input, source);
    }

    // Abort any in-flight request from a previous process() call. Done after
    // the barge-in handling, which aborts the current controller: created
    // before it, this request's own LLM call was cancelled before it started,
    // and a command typed while JARVIS was speaking was silently dropped.
    this.currentAbortController?.abort();
    const controller = new AbortController();
    this.currentAbortController = controller;

    if (agentStateMachine.is(AgentState.INTERRUPTED)) {
      console.log('[Orchestrator] ⚠️  System interrupted — ignoring new input until reset.');
      return;
    }

    // Concurrent execution protection: if a loop is already executing (e.g. a
    // slow LLM call is in-flight) abort it and wait for it to drain before
    // starting the new one.  The previous AbortController abort above signals
    // the old loop to exit; we do NOT await it — the finally block in the old
    // process() call will clean up its own state.
    if (this._loopExecuting) {
      console.warn('[Orchestrator] ⚠️  Concurrent process() call detected — previous loop aborted, proceeding.');
      agentStateMachine.reset();
    }

    console.log(`[Orchestrator] Processing input [${source}]: "${input}"`);
    const t0 = performance.now();
    // This request's plan outcome and per-stage timings (filled by planPhase()).
    const planState: PlanState = { outcome: 'graph', timings: {} };

    this._conversationStarted = true;
    conversationBus.conversationStarted();

    // ── Phase 1: Create Goal ─────────────────────────────────────────────────
    // PIPELINE-OPT: Goal creation is now non-blocking. The disk I/O (20-50ms)
    // runs concurrently with the agent loop start. We only resolve the promise
    // when we need the goal object (after the loop completes).
    let goal: Goal | null = null;
    let goalPromise: Promise<Goal | null> | null = null;
    const shouldCreateGoal =
      !this.matchDeterministicCommand(input) &&
      !this.isSimpleConversationalInput(input);

    if (shouldCreateGoal) {
      goalPromise = goalManager.createGoal(input, source).then(g => {
        goalManager.transition(g, 'in_progress', 'request started', { quiet: true });
        this.activeGoals.set(callId, g);
        goal = g;
        return g;
      }).catch(err => {
        console.warn('[Orchestrator] GoalManager unavailable (non-fatal):', err);
        return null;
      });
    } else {
      console.log('[Orchestrator] Skipping GoalManager for simple/deterministic request.');
    }

    let loopOutcome: 'success' | 'failed' | 'blocked' = 'success';
    // What the loop learned for this request's goal: its approval decisions
    // and, when it fails, why. The goal itself is completed or failed here only.
    const record: LoopRecord = { approvals: [] };
    const approvals = record.approvals;
    try {
      // Agent loop starts IMMEDIATELY — goal creation runs in background
      loopOutcome = await requestContext.run({ callId, signal: controller.signal, plan: planState }, () => this.runAgentLoop(input, source, goalPromise, record));

      // ── Phase 1: Resolve Goal based on actual outcome ──────────────────────
      // PIPELINE-OPT: Resolve the background goal promise now (it ran concurrently
      // with the agent loop, so this is effectively free — it's already settled).
      if (goalPromise) {
        goal = await goalPromise;
      }
      if (goal) {
        if (approvals.length) goal.metadata = { ...goal.metadata, approvals };
        if (loopOutcome === 'success') {
          await goalManager.completeGoal(goal.id);
        } else {
          // 'failed' or 'blocked' — do NOT mark as completed
          await goalManager.failGoal(
            goal.id,
            record.failReason ?? (loopOutcome === 'blocked' ? 'blocked by safety policy' : 'agent loop ended without success'),
          ).catch(() => {});
        }
        this.activeGoals.delete(callId);
      }
    } catch (err) {
      console.error('[Orchestrator] ❌ Unhandled error in agent loop:', err);

      // ── Structured exception classification ────────────────────────────────
      // Distinguish transient infrastructure errors from hard code bugs so the
      // user gets a precise message and we log the right severity.
      const errStr = String(err);
      const isRateLimit    = errStr.includes('rate-limited') || errStr.includes('429');
      const isTimeout      = errStr.includes('timeout') || errStr.includes('ETIMEDOUT') || errStr.includes('AbortError');
      const isNetworkError = errStr.includes('ECONNREFUSED') || errStr.includes('ENOTFOUND') || errStr.includes('fetch failed');
      const isAborted      = controller.signal.aborted;

      let fallback: string;
      if (isAborted) {
        // Aborted by a newer request — stay silent; the new request handles the response.
        fallback = '';
      } else if (isRateLimit) {
        fallback = 'The cloud model is rate-limited, sir. Local commands are still available.';
      } else if (isTimeout) {
        fallback = 'My reasoning systems timed out, sir. Please try again in a moment.';
      } else if (isNetworkError) {
        fallback = 'I cannot reach my reasoning backend, sir. Please check your connection.';
      } else {
        fallback = 'I encountered an unexpected error, sir. Please try again.';
        // Rate limits, time-outs and network errors are recorded by the provider
        // (the language model's ledger outcome); this is everything else.
        recordFailure({ component: 'orchestrator', message: err instanceof Error ? `${err.name}: ${err.message}` : errStr, error: err });
      }

      // Spoken as this request (it was not aborted), whatever context called process().
      if (fallback) requestContext.run({ callId, signal: controller.signal, plan: planState }, () => this.speak(fallback));

      // ── Phase 1: Fail Goal on unhandled error ──────────────────────────────
      if (goalPromise) { goal = await goalPromise; }
      if (goal) {
        if (approvals.length) goal.metadata = { ...goal.metadata, approvals };
        await goalManager.failGoal(goal.id, errStr).catch(() => {});
        this.activeGoals.delete(callId);
      }
    } finally {
      this._loopExecuting = false;
      if (this.currentProcessCallId === callId) {
        this.currentAbortController = null;
        // The request is over: an approval asked later must not show its
        // words as WHY, nor be asked by voice because it was spoken.
        endTrace();
        worldState.endTask();
        agentMemory.clearWorkingContext();
        if (agentStateMachine.currentState !== AgentState.SPEAKING) {
          // ── Conversation recovery guarantee ─────────────────────────────────
          // Always pair conversationStarted() with conversationEnded() to prevent
          // the bus from getting stuck in isActive=true after an early exception.
          if (!this._conversationEndHandled) {
            this._conversationEndHandled = true;
            if (this._conversationStarted) {
              conversationBus.conversationEnded();
            }
          }
          this._conversationStarted = false;
          agentStateMachine.reset();
        } else if (!nodeBridge.speechInFlight && !conversationBus.isSpeaking) {
          // SPEAKING, but no reply is on its way to tts.py (not connected, its
          // connection dropped, voice off): no speaking_end will come to end
          // the request. Before, it waited for the speaking watchdog (VOICE-001).
          console.log('[Orchestrator] State is SPEAKING but no reply is in flight — ending the request now.');
          if (!this._conversationEndHandled) {
            this._conversationEndHandled = true;
            if (this._conversationStarted) conversationBus.conversationEnded();
          }
          this._conversationStarted = false;
          agentStateMachine.reset();
        } else {
          console.log('[Orchestrator] State is SPEAKING — deferring reset and conversationEnded to IDLE until TTS completes.');
          this.isConversationEndDeferred = true;
        }
      } else {
        // This callId is superseded — still reset _conversationStarted so the
        // flag doesn't bleed into the next request.
        this._conversationStarted = false;
        console.log(`[Orchestrator] callId ${callId} is no longer the current active call. Skipping state reset.`);
      }
      const totalMs = Math.round(performance.now() - t0);
      // ── Print per-stage timing table ────────────────────────────────────────────────
      const planStages: Record<string, number> = planState.timings;
      if (Object.keys(planStages).length > 0) {
        console.log('\n┌────────────────────────────────────────────┐');
        console.log('│  ⏱  JARVIS Timing Breakdown                 │');
        console.log('├────────────────────────────────────────────┤');
        for (const [stage, ms] of Object.entries(planStages)) {
          if (stage === 'TokensEstimated') {
            const dots = '.'.repeat(Math.max(1, 22 - stage.length));
            console.log(`│  ${stage}${dots}${String(ms).padStart(8)} tok  │`);
          } else {
            const dots = '.'.repeat(Math.max(1, 26 - stage.length));
            console.log(`│  ${stage}${dots}${String(ms).padStart(6)}ms  │`);
          }
        }
        console.log('├────────────────────────────────────────────┤');
        console.log(`│  TOTAL........................${String(totalMs).padStart(6)}ms  │`);
        console.log('└────────────────────────────────────────────┘\n');
      } else {
        console.log(`[Timing] Total request processing time: ${totalMs}ms`);
      }

    }
    // "Yes" to "continue what I was doing": the earlier request, as a new
    // request of its own — planned again, every step checked and asked again.
    if (record.followUp && this.currentProcessCallId === callId) {
      await this.process(record.followUp, source);
    }
  }

  /**
   * Marks the orchestrator ready for requests. It is event-driven: it runs
   * when a request arrives. Work that continues without a request — stored
   * goals, schedules, retries — is the Goal Runtime's (core/goalRuntime.ts).
   */
  startLoop(): void {
    if (this.isLoopRunning) return;
    this.isLoopRunning = true;
    console.log('[Orchestrator] Ready for requests (event-driven; background goals run in the Goal Runtime).');
  }

  stopLoop(): void {
    this.isLoopRunning = false;
    console.log('[Orchestrator] ⏹️  Stopped taking requests.');
  }

  getState(): AgentState {
    return agentStateMachine.currentState;
  }

  // ── Safe Runtime Reset ────────────────────────────────────────────────────

  /**
   * Encapsulated runtime reset — the single authoritative path for emergency
   * teardown.  Combines all the ad-hoc reset fragments that were previously
   * scattered across the class into one atomic operation.
   *
   * Safe to call from:
   *   - watchdog handlers
   *   - external shutdown signals
   *   - test teardown
   *   - barge-in recovery
   *
   * After this call the orchestrator is in a clean IDLE state, ready for the
   * next request.  Any in-flight LLM / tool call is aborted via the
   * AbortController.
   */
  public safeReset(reason = 'manual_reset'): void {
    console.log(`[Orchestrator] 🔄 safeReset() called. Reason: ${reason}`);

    // 1. Abort any in-flight async operation
    if (this.currentAbortController) {
      this.currentAbortController.abort(new Error(reason));
      this.currentAbortController = null;
    }

    // 2. Fail the active goal so it isn't left as 'in_progress'
    for (const g of this.activeGoals.values()) goalManager.failGoal(g.id, reason).catch(() => {});
    this.activeGoals.clear();

    // 3. Interrupt and abort any active task graph
    const graph = taskGraphEngine.getCurrentGraph();
    if (graph) {
      taskGraphEngine.interrupt(graph);
    }

    // 4. Clear ephemeral agent memory
    agentMemory.clearWorkingContext();

    // 5. Ensure conversation bus is closed (prevent isActive=true leak)
    if (!this._conversationEndHandled && this._conversationStarted) {
      this._conversationEndHandled = true;
      conversationBus.conversationEnded();
    }
    this._conversationStarted = false;
    this.isConversationEndDeferred = false;

    // 6. Reset deferred flags
    this._conversationEndHandled = false;
    this._loopExecuting = false;
    this.currentProcessCallId = null;

    // 7. Reset the state machine to IDLE (clears watchdogs and queued transitions)
    agentStateMachine.reset();

    console.log('[Orchestrator] ✅ safeReset() complete — system is IDLE.');
  }

  // ── Agent Loop ────────────────────────────────────────────────────────────

  /**
   * The core PLAN → EXECUTE → OBSERVE → REFLECT → REPAIR cycle.
   */
  private async runAgentLoop(
    input: string,
    source: 'cli' | 'voice',
    goalReady: Promise<Goal | null> | null = null,
    record: LoopRecord = { approvals: [] },
  ): Promise<'success' | 'failed' | 'blocked'> {
    const approvals = record.approvals;
    // The goal is created in the background while planning starts; its status
    // is recorded once it exists. (The loop used to receive `null` every time,
    // so planning/executing, the plan summary and the graph id were never
    // stored.) Completing or failing it is process()'s job: the loop records
    // why it failed in `record.failReason`.
    const noteGoal = (status: 'planning' | 'executing', extras: Parameters<typeof goalManager.updateGoalStatus>[2] = {}) => {
      void goalReady?.then((g) => (g ? goalManager.updateGoalStatus(g.id, status, extras) : undefined)).catch(() => {});
    };
    this._loopExecuting = true;

    // ── ⚡ Deterministic Pre-Router: known open/launch commands ───────────────
    // Checked FIRST — before memory writes — so memory unavailability never
    // blocks a fast-path command. Bypasses LLM to prevent Groq 429 failures.
    const route = this.matchDeterministicCommand(input);
    // An offer to continue holds for the very next request only.
    if (route?.type !== 'continue_confirmed' && route?.type !== 'continue_declined') this.continueOffer = null;
    if (route) {
      console.log(`[Orchestrator] ⚡ Deterministic command route: type="${route.type}"${route.target ? ` target="${route.target}"` : ''}`);
      // Transition through IDLE → PLANNING → EXECUTING only if not already there.
      // This prevents illegal PLANNING→PLANNING or EXECUTING→EXECUTING throws when
      // a new deterministic command arrives mid-execution of a previous one.
      const curSt = agentStateMachine.currentState;
      if (curSt !== AgentState.PLANNING && curSt !== AgentState.EXECUTING) {
        tryTransition(AgentState.PLANNING, 'route to planning');
      }
      if (agentStateMachine.currentState !== AgentState.EXECUTING) {
        tryTransition(AgentState.EXECUTING, 'route to execution');
      }
      // JARVIS-019: the outcome of these tool calls used to be discarded — the
      // route always reported 'success', so a failed open_app was recorded as a
      // completed goal. Track it without changing any spoken reply.
      let routeSucceeded = true;
      const runRoutedTool = async (tool: string, args: Record<string, unknown>) => {
        const result = await toolRegistryV2.execute(tool, args);
        if (!result?.success) routeSucceeded = false;
        return result;
      };
      // A failed route says why. A permission refusal used to come out as
      // "encountered an issue", with no hint that full control mode was needed.
      const failureReply = (result: { error?: string; output?: string } | undefined, fallback: string): string => {
        const reason = result?.error ?? '';
        if (reason === 'APPROVAL_DENIED') return APPROVAL_DENIED_REPLY;
        if (reason === 'RATE_LIMITED') return RATE_LIMITED_REPLY;
        if (reason === 'VERIFICATION_FAILED') return verificationFailedReply(result?.output ?? '');
        if (reason === 'RISK_REFUSED') return `I couldn't do that, sir. ${(result?.output ?? '').replace(/^Refused by safety policy:\s*/, '')}`;
        if (isPermissionDenial(reason) || isPermissionDenial(result?.output ?? '')) return FULL_CONTROL_HINT;
        return reason && reason.length <= 120 ? `${fallback} ${reason}` : fallback;
      };
      try {
        if (route.type === 'open_app' && route.target) {
          const result = await runRoutedTool('open_app', { target: route.target, source });
          const reply = result?.success
            ? route.reply
            : failureReply(result, `I tried to open ${route.target} but encountered an issue, sir.`);
          this.speak(reply);
        } else if (route.type === 'close_browser_tab' && route.target) {
          const result = await runRoutedTool('control_browser', { action: 'close', target: route.target });
          const reply = result?.success
            ? route.reply
            : failureReply(result, `I tried to close the tab "${route.target}" but encountered an issue, sir.`);
          this.speak(reply);
        } else if (route.type === 'close_current_tab') {
          const result = await runRoutedTool('control_browser', { action: 'close_current' });
          const reply = result?.success
            ? route.reply
            : failureReply(result, `I tried to close the current tab but encountered an issue, sir.`);
          this.speak(reply);
        } else if (route.type === 'close_app' && route.target) {
          const result = await runRoutedTool('control_app', { action: 'close', target: route.target });
          const reply = result?.success
            ? route.reply
            : failureReply(result, `I tried to close the application "${route.target}" but encountered an issue, sir.`);
          this.speak(reply);
        } else if (route.type === 'close_current_window') {
          const result = await runRoutedTool('control_window', { action: 'close_current' });
          const reply = result?.success
            ? route.reply
            : failureReply(result, `I tried to close the active window but encountered an issue, sir.`);
          this.speak(reply);
        } else if (route.type === 'get_system_state') {
          // A few spoken sentences; the full state goes to the console (it used to be read out as JSON).
          const result = await runRoutedTool('get_system_state', {});
          if (result?.success) console.log(`[Orchestrator] System state:\n${result.output}`);
          this.speak(result?.success ? systemStateSummary(parseJson(result.output)) : 'Failed to retrieve system state, sir.');
        } else if (route.type === 'get_browser_tabs') {
          // The tabs with the one on screen (P8), said in at most three sentences.
          const live = await runRoutedTool('browser_state', {});
          const state = live?.success ? parseJson(live.output.replace(/^<untrusted_context[^>]*>\n?|\n?<\/untrusted_context>$/g, '')) : null;
          if (state?.tabs) {
            console.log(`[Orchestrator] Browser:\n${live!.output}`);
            this.speak(tabsSummary(state.tabs));
          } else {
            if (live && !live.success) console.log(`[Orchestrator] ${live.output}`);
            const seen = await runRoutedTool('get_browser_tabs', {});
            const tabs = seen?.success ? parseJson(seen.output) : null;
            this.speak(Array.isArray(tabs) && tabs.length
              ? tabsSummary(tabs)
              : 'Chrome is not reachable for me, sir. The console shows how to start it with the debugging port.');
          }
        } else if (route.type === 'whats_running') {
          const [apps, servers] = await Promise.all([runRoutedTool('get_open_apps', {}), runRoutedTool('dev_status', {})]);
          const appList = apps?.success ? parseJson(apps.output) : null;
          this.speak(runningSummary(Array.isArray(appList) ? appList : [], servers?.success ? devStatusReply(servers.output) : 'I could not check the local servers, sir.'));
        } else if (route.type === 'is_tab_open' && route.target) {
          const result = await runRoutedTool('is_tab_open', { tabNameOrUrl: route.target });
          this.speak(result?.success && result.output === 'true' ? `Yes, the ${route.target} tab is open, sir.` : `No, the ${route.target} tab is not open, sir.`);
        } else if (route.type === 'enable_full_control_session') {
          const result = await runRoutedTool('enable_full_control_session', { source });
          this.speak(result?.success ? `Full control mode enabled, sir.` : 'Failed to enable full control, sir.');
        } else if (route.type === 'status') {
          // One sentence from a real reading; no LLM request.
          const result = await runRoutedTool('system_overview', {});
          this.speak(result?.success ? systemStatusReply(result.output) : 'I could not read the system state, sir.');
        } else if (route.type === 'dev_status') {
          const result = await runRoutedTool('dev_status', {});
          this.speak(result?.success ? devStatusReply(result.output) : 'I could not check the local servers, sir.');
        } else if (route.type === 'diagnose_app') {
          this.speak(await this.diagnoseAndRepair(runRoutedTool));
        } else if (route.type === 'continue_work') {
          this.speak(await this.continueWork(runRoutedTool));
        } else if (route.type === 'continue_confirmed') {
          const offer = this.continueOffer;
          this.continueOffer = null;
          if (offer) {
            console.log(`[Orchestrator] ▶️  Continuing "${offer.description}" as a new request.`);
            record.followUp = offer.description;
          }
        } else if (route.type === 'continue_declined') {
          this.continueOffer = null;
          this.speak(route.reply);
        } else if (route.type === 'agent_status') {
          // First line is said; the tree and details go to the console.
          const [question, agent] = (route.target ?? 'summary').split('|');
          const result = await runRoutedTool('agent_status', { question, ...(agent ? { agent } : {}) });
          const [first, ...rest] = (result?.output ?? '').split('\n');
          if (rest.length) console.log(`[Orchestrator] Agents:\n${rest.join('\n')}`);
          this.speak(result?.success && first ? first : 'I could not read what the agents are doing, sir.');
        } else if (route.type === 'agent_stop') {
          const result = await runRoutedTool('cancel_agent_task', { which: route.target ?? 'latest' });
          const message = result?.success ? parseJson(result.output)?.message : undefined;
          this.speak(typeof message === 'string' ? message : failureReply(result, 'I could not stop the agents, sir.'));
        } else if (route.type === 'delegate' && route.target) {
          const result = await runRoutedTool('delegate_task', { task: route.target, ...(route.specialist ? { specialist: route.specialist } : {}) });
          const message = result?.success ? parseJson(result.output)?.message : undefined;
          this.speak(typeof message === 'string' ? `On it, sir. ${message}` : failureReply(result, 'I could not start the agents, sir.'));
        } else if (route.type === 'goal_status') {
          const result = await runRoutedTool('goal_status', {});
          const [first, ...rest] = (result?.output ?? '').split('\n');
          if (rest.length) console.log(`[Orchestrator] Goals:\n${rest.join('\n')}`);
          this.speak(result?.success && first ? first : 'I could not read the goals, sir.');
        } else if (route.type === 'goal_control' && route.target) {
          const [action, goalRef] = route.target.split('|');
          const result = await runRoutedTool('goal_control', { action, goal: goalRef });
          const body = result?.success ? parseJson(result.output) : undefined;
          this.speak(typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? `${body.error} Sir.` : failureReply(result, 'I could not change that goal, sir.'));
        } else if (route.type === 'goal_create' && route.target) {
          const g = JSON.parse(route.target) as { kind: string; objective: string; scheduleText?: string };
          const result = await runRoutedTool('goal_create', { objective: g.objective, kind: g.kind, ...(g.scheduleText ? { schedule: g.scheduleText } : {}) });
          const body = result?.success ? parseJson(result.output) : undefined;
          this.speak(typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? `I could not record that goal: ${body.error}` : failureReply(result, 'I could not record that goal, sir.'));
        } else if ((route.type === 'youtube_search' || route.type === 'youtube_play' || route.type === 'site_search') && route.target) {
          const d = JSON.parse(route.target) as Record<string, string>;
          const args = route.type === 'youtube_search' ? { query: d['query'], open: d['open'] }
            : route.type === 'youtube_play' ? { action: d['action'] } : { site: d['site'], query: d['query'] };
          const result = await runRoutedTool(route.type, args);
          this.speak(desktopReply(route.type, d, result));
        } else if (route.type === 'youtube_trending' && route.target) {
          const d = JSON.parse(route.target) as { region?: string; category?: string };
          const result = await runRoutedTool('youtube_trending', { ...(d.region ? { region: d.region } : {}), ...(d.category ? { category: d.category } : {}) });
          if (result?.success && !/^\s*Error/.test(result.output)) console.log(`[Orchestrator] YouTube:\n${result.output}`);
          this.speak(trendingReply(result));
        } else if (route.type === 'health_check' || route.type === 'self_check_full' || route.type === 'repair_report' || route.type === 'investigate_stuck') {
          // Read-only questions about JARVIS itself (core/selfCheck.ts): nothing is repaired here.
          const mode = { health_check: 'quick', self_check_full: 'full', repair_report: 'report', investigate_stuck: 'stuck' }[route.type];
          const result = await runRoutedTool('self_check', { mode });
          const report = result?.success ? parseJson(result.output) : undefined;
          if (Array.isArray(report?.details)) console.log(`[Orchestrator] ${(report.details as string[]).join('\n')}`);
          this.speak(typeof report?.spoken === 'string' ? report.spoken : failureReply(result, 'I could not check myself, sir.'));
        } else if (route.type === 'list_capabilities') {
          // Through the registry like any tool call; the full list goes to the console.
          const result = await runRoutedTool('list_capabilities', {});
          if (result?.success) console.log(`[Orchestrator] Capabilities:\n${result.output}`);
          this.speak(result?.success ? route.reply : 'I could not read my tool list, sir.');
        } else {
          if (route.type === 'what_can_you_do') {
            console.log(`[Orchestrator] Capabilities:\n${toolRegistryV2.capabilitySummary()}`);
          }
          if (route.type === 'stop') {
            nodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });
            (nodeBridge as any).pendingTTS = [];
            this.runBargeInCallbacks();
          }
          this.speak(route.reply);
        }
      } catch (err) {
        console.error('[Orchestrator] Deterministic command execution error:', err);
        this.speak(`Sorry, I could not process the command, sir.`);
        routeSucceeded = false;
      }
      return routeSucceeded ? 'success' : 'failed';
    }

    // Record user input to memory — fire-and-forget (non-blocking).
    // PIPELINE-OPT: This was awaited before, blocking 5-30ms before planning.
    // Memory write doesn't affect planning — no reason to wait.
    try {
      agentMemory.addConversationMessage('user', input).catch((memErr) => {
        console.warn('[Orchestrator] Memory write failed (non-fatal):', (memErr as Error).message);
      });
      agentMemory.pushEpisode('user_input', `User [${source}]: ${input.substring(0, 200)}`, {}, 3);
    } catch (memErr) {
      console.warn('[Orchestrator] Memory write failed (non-fatal):', (memErr as Error).message);
    }

    // ── Phase 1: PLANNING ────────────────────────────────────────────────────

    if (this.isSimpleConversationalInput(input)) {
      await this.streamDirectChat(input);
      return 'success';
    }

    agentStateMachine.transition(AgentState.PLANNING);
    noteGoal('planning');

    if (this.isInterrupted()) return 'failed';

    const planResult = await this.planPhase(input);

    if (!planResult) {
      const isActionRequest = /\b(open|launch|start|run|close|delete|search|find|read|write|set|get|create|exec|build)\b/i.test(input);
      const isAborted = this.isInterrupted() || this.requestSignal()?.aborted;
      const noAnswer = this.planState().outcome !== 'answered';

      if (isAborted || isActionRequest || noAnswer) {
        console.warn(`[Orchestrator] ⚠️ Planning failed or returned no actionable graph for "${input}". Goal marked FAILED.`);
        record.failReason = isAborted ? 'Planning interrupted by watchdog/abort' : 'Planning produced no tool execution graph';
        // A replaced request leaves the state to the newer one.
        if (!this.isSuperseded()) agentStateMachine.transition(AgentState.IDLE);
        return 'failed';
      }

      // Pure conversational answer (non-action query)
      agentStateMachine.transition(AgentState.IDLE);
      return 'success';
    }

    // ── Phase 1: PRE-EXECUTION CHECK ─────────────────────────────────────────
    const preCheck = await reflectionEngine.preExecutionCheck(planResult);
    console.log(`[Orchestrator] 🔍 Pre-check: ${preCheck.verdict} — ${preCheck.summary}`);

    if (preCheck.verdict === 'rejected') {
      const msg = `My plan was invalid before it started, sir. ${preCheck.issues[0] ?? 'Unknown issue.'}`;
      this.speak(msg);
      record.failReason = preCheck.summary;
      return 'failed';
    }

    // ── Phase 6: PLANNER INTELLIGENCE ANALYSIS ─────────────────────────────
    // Runs after structural preCheck — adds confidence scoring, failure
    // prediction, and plan validation on top of the structural check.
    let replanRequest: { reason: string } | null = null;
    let activePlan = planResult;
    try {
      const intelligence = plannerIntelligence.analyzeGraph(planResult);

      if (intelligence.recommendation === 'replan') {
        const highRisk = intelligence.predictions.filter(p => p.riskLevel === 'high');
        const topIssue = highRisk[0];
        // The prediction is about failing, not danger: "high-risk steps" read
        // like the safety levels, for a step that had merely failed before (P13).
        const why = topIssue?.reasons.find((r) => /failure rate|not registered|missing required/i.test(r)) ?? topIssue?.reasons[0];
        const msg = topIssue
          ? `Part of my plan is likely to fail, sir: the ${topIssue.tool} step${why ? ` (${why})` : ''}. I'll plan it again.`
          : `I am not confident in this plan, sir. I'll plan it again.`;

        // The message promised a replan, but the code called failGoal() and
        // returned 'failed' without ever replanning (JARVIS-007). Record the
        // intent here and act on it after this analysis block, so a genuine
        // replan attempt happens and the guard still bounds it.
        console.warn(`[Orchestrator] ⚠️ PlannerIntelligence: recommendation=replan.`);
        this.announce(msg);
        replanRequest = {
          reason: topIssue?.reasons.join('; ') ?? 'plan confidence below threshold',
        };
      }

      if (intelligence.recommendation === 'proceed_with_caution') {
        console.warn(`[Orchestrator] ⚠️ PlannerIntelligence: proceeding with caution (medium risk).`);
        // Log the top predicted failure so the repair phase has context
        const topRisk = intelligence.predictions[0];
        if (topRisk) {
          console.warn(`[Orchestrator]   Top risk: node="${topRisk.nodeId}" tool="${topRisk.tool}" reasons=${topRisk.reasons.join('; ')}`);
        }
      }
    } catch (err) {
      // Non-fatal — intelligence analysis should never block execution
      console.warn('[Orchestrator] PlannerIntelligence analysis failed (non-fatal):', err);
    }

    // ── Act on a low-confidence plan by actually replanning (JARVIS-007) ────
    if (replanRequest) {
      if (!taskGraphEngine.canReplan(input)) {
        console.warn('[Orchestrator] ⛔ Replan guard: budget exhausted for this goal.');
        record.failReason = 'PlannerIntelligence: low confidence plan rejected';
        return 'failed';
      }

      const replanned = await this.repairPhase('replan', { context: replanRequest.reason }, activePlan, input);
      if (!replanned) {
        // A direct answer finishes the request; an LLM failure or interrupt does not.
        if (this.planState().outcome !== 'answered') return 'failed';
        return 'success';
      }
      activePlan = replanned;
    }

    noteGoal('executing', { planSummary: preCheck.summary, taskGraphId: planResult.id });
    worldState.startTask(input, [...activePlan.nodes.values()].map(stepLabel));

    let graph = activePlan;
    let repairCycles = 0;
    let recoveryRounds = 0;

    // ── Repair Loop ──────────────────────────────────────────────────────────
    while (repairCycles <= this.config.maxRepairCycles) {
      if (this.isInterrupted()) return 'failed';

      // ── Phase 2: EXECUTING with mid-execution monitoring ───────────────────
      agentStateMachine.transition(AgentState.EXECUTING);

      graph = await taskGraphEngine.execute(graph, this.makeMidMonitoredExecutor(graph));
      collectApprovals(graph, approvals);

      if (this.isInterrupted()) return 'failed';

      // ── Phase 3: OBSERVING ─────────────────────────────────────────────────
      agentStateMachine.transition(AgentState.OBSERVING);

      this.collectObservations(graph);

      // ── Phase 4: REFLECTING ────────────────────────────────────────────────
      agentStateMachine.transition(AgentState.REFLECTING);

      // OPT-3: Fast-path — skip full LLM-capable reflection for low-risk tools.
      // reflectionEngine.reflect() can invoke the LLM for unknown failure diagnosis,
      // costing 200-800ms even on success. For read/open/info operations that all
      // succeeded, we know the outcome and skip directly to handleSuccess.
      const allNodes = [...graph.nodes.values()];
      const lowRisk = new Set(LOW_RISK_TOOLS);
      const allSucceeded = allNodes.every(n => n.status === 'done');
      // Any step whose metadata says it only reads (risk 0) counts too (P8).
      const allLowRisk   = allNodes.every(n => lowRisk.has(n.tool) || toolRegistryV2.riskOf(n.tool, n.args) === 0);

      if (allSucceeded && allLowRisk) {
        console.log(`[Orchestrator] ⚡ OPT-3: Skipping full reflection for low-risk successful graph.`);
        await this.handleSuccess(graph, input);
        return 'success';
      }

      const reflection = await reflectionEngine.reflect(graph, agentMemory);

      console.log(`[Orchestrator] 💡 Reflection: ${reflection.outcome} | strategy: ${reflection.repairStrategy}`);

      // ── Success path ───────────────────────────────────────────────────────
      if (reflection.outcome === 'success') {
        await this.handleSuccess(graph, input);
        return 'success';
      }

      // ── P11: a failure JARVIS knows gets a concrete repair first ──────────
      // Each repair step goes through the registry (risk engine, approval with
      // the failure as WHY, after-action check); then the failed step runs again.
      const recovery = await this.recoverPhase(graph, recoveryRounds);
      if (recovery.kind === 'repaired') {
        recoveryRounds++;
        continue;
      }
      if (recovery.kind === 'stop') {
        this.speak(recovery.message);
        record.failReason = recovery.reason;
        return recovery.blocked ? 'blocked' : 'failed';
      }

      // ── Abort path ─────────────────────────────────────────────────────────
      if (reflection.repairStrategy === 'abort' || repairCycles >= this.config.maxRepairCycles) {
        if (reflection.shouldSpeak && reflection.voiceMessage) {
          this.speak(reflection.voiceMessage);
        }
        console.log(`[Orchestrator] ⛔ Aborting after ${repairCycles} repair cycle(s).`);

        // Store failure as long-term memory
        await agentMemory.rememberFact(
          `Failed task: "${input.substring(0, 100)}" — ${reflection.failureClass ?? 'unknown error'}`,
          7, 'agent_failure'
        );

        // Detect safety-blocked scenarios to report accurate goal outcome
        const isBlocked = reflection.failureClass === 'tool_error' &&
          reflection.summary?.toLowerCase().includes('safety policy');

        // Phase 1: the goal fails with this reason (process() records it)
        record.failReason = reflection.summary;
        return isBlocked ? 'blocked' : 'failed';
      }

      // ── Phase 5: REPAIRING ────────────────────────────────────────────────
      agentStateMachine.transition(AgentState.REPAIRING);
      repairCycles++;

      console.log(`[Orchestrator] 🔧 Repair cycle ${repairCycles}/${this.config.maxRepairCycles}: ${reflection.repairStrategy}`);
      agentMemory.pushEpisode('repair', `Repair cycle ${repairCycles}: ${reflection.repairStrategy}`, {
        failureClass: reflection.failureClass,
        strategy: reflection.repairStrategy,
        failedNodes: reflection.failedNodes.map(n => n.id),
      }, 7);

      // ── Phase 6: Dynamic Replanning Guard ─────────────────────────────────
      // Before entering the repair phase, check: if strategy is 'replan',
      // gate it through the canReplan() guard so we never loop infinitely.
      if (reflection.repairStrategy === 'replan') {
        const allowed = taskGraphEngine.canReplan(input);
        if (!allowed) {
          console.warn(`[Orchestrator] ⛔ Phase 6 replan guard: max replans reached for this goal.`);
          this.speak('I have attempted multiple strategies and was unable to complete the task, sir.');
          record.failReason = 'max replans exceeded';
          return 'failed';
        }
        // Generate and log alternative strategies for failed nodes
        try {
          for (const failedNode of reflection.failedNodes.slice(0, 3)) {
            const alts = plannerIntelligence.generateAlternatives(failedNode);
            if (alts.length > 0) {
              console.log(`[Orchestrator] 🔀 Alternatives for node "${failedNode.id}" (${failedNode.tool}):`);
              alts.slice(0, 2).forEach(a => console.log(`  [${a.priority}] ${a.description}`));
            }
          }
        } catch { /* non-fatal */ }
      }

      const repaired = await this.repairPhase(
        reflection.repairStrategy,
        reflection.repairArgs ?? {},
        graph,
        input
      );

      if (!repaired) {
        // Repair produced no actionable plan
        console.log('[Orchestrator] ⛔ Repair failed — no recovery possible.');
        // A replan that ended without a graph has already spoken (its answer, or
        // the LLM-failure apology) or was interrupted; a second message here
        // contradicted it ("<answer>. I was unable to recover from the error").
        const replanSpoke = reflection.repairStrategy === 'replan' && this.planState().outcome !== 'graph';
        if (!replanSpoke) {
          this.speak(reflection.voiceMessage ?? 'I was unable to recover from the error, sir.');
        }
        return 'failed';
      }

      // repairPhase may have produced a new graph (replan) or mutated the existing one
      if (repaired instanceof Map || typeof repaired === 'object' && 'nodes' in repaired) {
        graph = repaired as TaskGraph;
      }
    }
    return 'success';
  }

  // ── Phase Implementations ─────────────────────────────────────────────────

  /**
   * "Why isn't my application working?" (P13, core/diagnosis.ts): the
   * diagnosis from real readings; the repairs it proposes, each through the
   * registry (risk engine, approval gate with the fault as WHY); then a second
   * diagnosis, which is what the reply says about the result.
   */
  private async diagnoseAndRepair(run: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>): Promise<string> {
    const first = await run('diagnose_app', {});
    const report = first?.success ? parseJson(first.output) : null;
    if (!report) return 'I could not check the application, sir.';
    console.log(`[Orchestrator] Diagnosis:\n${first.output}`);
    type Step = { tool: string; args: Record<string, unknown>; says: string; did: string };
    const faults: Array<{ text: string; repairs?: Step[] }> = Array.isArray(report.faults) ? report.faults : [];
    const repairs = faults.flatMap((f) => f.repairs ?? []);
    if (!repairs.length) return diagnosisSummary(report);

    const why = `To get your application working, JARVIS needs to repair this: ${faults.filter((f) => f.repairs?.length).map((f) => f.text).join('; ')}.`;
    const done: string[] = [];
    let reloadedTab: string | undefined;
    for (const step of repairs) {
      console.log(`[Orchestrator] 🩹 Repair: ${step.says} via ${step.tool}`);
      agentMemory.pushEpisode('repair', `Repair: ${step.says}`, { tool: step.tool }, 7);
      const result = await asRepair(why, () => run(step.tool, step.args));
      if (!result?.success) return repairSummary(report, done, { says: step.says, reason: repairFailure(result) }, null);
      if (step.tool === 'browser_navigate') reloadedTab = String(step.args['tab'] ?? '');
      done.push(step.did);
    }
    const second = await run('diagnose_app', {});
    const after = second?.success ? parseJson(second.output) : null;
    if (after) console.log(`[Orchestrator] Diagnosis after the repair:\n${second.output}`);
    return repairSummary(report, done, null, after, reloadedTab);
  }

  /**
   * "Continue what I was doing" (P13): the newest request, when it is recent
   * and did not finish, is named with why it stopped and offered again (a
   * "yes" runs it as a new request). Otherwise JARVIS asks, saying what is on
   * screen.
   */
  private async continueWork(run: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>): Promise<string> {
    const last = goalManager.getRecentGoals(1).find((g) => Date.now() - g.createdAt < CONTINUE_WINDOW_MS);
    if (last && last.status !== 'completed' && last.status !== 'cancelled') {
      this.continueOffer = { description: last.description, expires: Date.now() + CONTINUE_OFFER_MS };
      return continueOffer(last.description, unfinishedReason(last.status, last.lastError));
    }
    const [browser, active] = await Promise.all([run('browser_state', {}), run('get_active_window', {})]);
    const state = browser?.success ? parseJson(browser.output.replace(/^<untrusted_context[^>]*>\n?|\n?<\/untrusted_context>$/g, '')) : null;
    const activeWindow = active?.success ? parseJson(active.output) : null;
    const onScreen = state?.visibleTab?.title || activeWindow?.title || undefined;
    return continueQuestion(last ? { description: last.description, done: last.status === 'completed' } : undefined, onScreen);
  }

  /**
   * RECOVERY (P11, core/stepRecovery.ts): for each failed step, read again
   * the part of the PC it touched and diagnose it. A known failure is repaired
   * through the tool registry — so the risk engine, the approval gate and the
   * after-action check apply — and the step is reset to run again; at most
   * MAX_RECOVERY_ROUNDS rounds. A failure that needs the user, or a repair
   * that is refused or not approved, stops with an honest message.
   */
  private async recoverPhase(graph: TaskGraph, rounds: number): Promise<
    | { kind: 'none' }
    | { kind: 'repaired' }
    | { kind: 'stop'; message: string; reason: string; blocked: boolean }
  > {
    const failed = [...graph.nodes.values()].filter((n) => n.status === 'failed');
    for (const node of failed) {
      await observeFailure(node).catch(() => undefined);
      const diagnosis = diagnose(node);
      if (diagnosis.kind === 'none') continue;
      if (diagnosis.kind === 'ask') return { kind: 'stop', message: diagnosis.message, reason: diagnosis.failure, blocked: false };
      if (rounds >= MAX_RECOVERY_ROUNDS) {
        return {
          kind: 'stop',
          message: `I repaired it ${rounds} times, sir, but the step still fails: ${diagnosis.failure}.`,
          reason: `still failing after ${rounds} repairs: ${diagnosis.failure}`,
          blocked: false,
        };
      }
      const why = `To finish your request, JARVIS needs to repair this: ${diagnosis.failure}.`;
      agentStateMachine.transition(AgentState.REPAIRING);
      for (const step of diagnosis.steps) {
        console.log(`[Orchestrator] 🩹 Repair (${rounds + 1}/${MAX_RECOVERY_ROUNDS}): ${step.says} via ${step.tool}`);
        agentMemory.pushEpisode('repair', `Repair: ${step.says}`, { tool: step.tool, failure: diagnosis.failure }, 7);
        const result = await asRepair(why, () => toolRegistryV2.execute(step.tool, step.args));
        if (!result.success) {
          const refused = result.error === 'RISK_REFUSED' || result.error === 'PERMISSION_DENIED';
          const reason = result.error === 'APPROVAL_DENIED' ? 'it was not approved'
            : refused ? `the safety policy refused it (${result.output.replace(/^Refused by safety policy: /, '').slice(0, 160)})`
            : `that failed as well (${(result.verification?.evidence ?? result.output).slice(0, 160)})`;
          return {
            kind: 'stop',
            message: `I could not finish, sir: ${diagnosis.failure}. I wanted to ${step.says}, but ${reason}.`,
            reason: `${diagnosis.failure}; repair not done: ${reason}`,
            blocked: refused,
          };
        }
      }
      this.announce(`I ${diagnosis.steps.map((s) => s.did).join(' and ')} first, because ${diagnosis.failure}, sir.`);
      reflectionEngine.resetFailedNodes(graph, [node.id]);
      return { kind: 'repaired' };
    }
    return { kind: 'none' };
  }

  /**
   * PLANNING PHASE
   * Calls the LLM to infer intent and generate tool_calls.
   * Builds a TaskGraph from the response.
   */
  private cachedSystemPrompt: string = '';
  private cachedSysTokens: number = 0;

  public getPrewarmedSystemPrompt(): { prompt: string; tokens: number } {
    if (!this.cachedSystemPrompt) {
      const sys = llmConfig.systemPrompt;
      const maxChars = 1200 * 4;
      this.cachedSystemPrompt = sys.length > maxChars ? sys.substring(0, maxChars) + '...' : sys;
      this.cachedSysTokens = Math.ceil(this.cachedSystemPrompt.length / 4);
    }
    return { prompt: this.cachedSystemPrompt, tokens: this.cachedSysTokens };
  }

  private async planPhase(input: string): Promise<TaskGraph | null> {
    console.log('[Orchestrator] 🧠 PLANNING — calling LLM...');
    this.planState().outcome = 'interrupted';
    const planPrepStart = performance.now();

    // ── 1. Fast Pre-Warmed System Prompt ──────────────────────────────────────
    const { prompt: systemPrompt, tokens: sysTokens } = this.getPrewarmedSystemPrompt();
    const messages: ILLMMessage[] = [{ role: 'system', content: systemPrompt }];
    // What exists beyond the few tools offered with this request (≈40 tokens).
    const toolOverview = capabilityOverview();
    if (toolOverview) messages.push({ role: 'system', content: toolOverview });

    // ── 2. Optimized Tool Selection & Fast Token Estimate (Zero Serialization) 
    const selectedToolNames = this.selectPlanningToolNames(input);
    const tools = selectedToolNames.length > 0
      ? toolRegistryV2.getLLMDefinitions(selectedToolNames)
      : [];
    const toolTokens = selectedToolNames.length > 0
      ? toolRegistryV2.getToolTokensEstimate(selectedToolNames)
      : 0;

    // ── 3. Memory Injection — Unified Memory Fast Path (No Duplication) ───────
    let unifiedCtxText = '';
    let uniTokens = 0;
    try {
      const ctxStart = performance.now();
      const sessionId = memoryManager.getStats().sessionId || 'default';
      const includeHeavyContext = this.shouldUseHeavyContext(input);
      const unifiedCtx = await unifiedContextBuilder.buildContext(input, sessionId, {
        includeHeavy: includeHeavyContext,
      });
      const ctxMs = Math.round(performance.now() - ctxStart);
      console.log(`[Timing] buildContext: ${ctxMs}ms (heavy=${includeHeavyContext})`);
      
      this.planState().timings['ContextBuild'] = ctxMs;

      unifiedCtxText = unifiedCtx.mergedContext;
      uniTokens = unifiedCtxText.length >> 2;
      // Memory and recent conversation hold text that came from outside (web
      // pages, documents, agents' research): data for the plan, in a user
      // message, never a system message (SEC-03).
      if (unifiedCtxText.trim()) {
        messages.push({ role: 'system', content: UNTRUSTED_RULE });
        messages.push({ role: 'user', content: untrusted('memory and recent conversation', unifiedCtxText, 12_000) });
      }

      const recentGoals = goalManager.getRecentGoalContext(4);
      if (recentGoals) {
        messages.push({ role: 'user', content: untrusted('recent goals', recentGoals.length > 800 ? recentGoals.substring(0, 800) + '...' : recentGoals) });
      }
    } catch (err) {
      console.warn('[Orchestrator] Unified Memory retrieval failed (non-fatal):', err);
    }

    // Only inject working context from agentMemory if active, avoiding duplicate LTM
    let memTokens = 0;
    const workingContext = agentMemory.getWorkingContext();
    if (workingContext) {
      const workingSummary = `[ACTIVE TASK] Goal: ${workingContext.goal} (Iter: ${workingContext.iteration})`;
      memTokens = workingSummary.length >> 2;
      messages.push({ role: 'user', content: untrusted('active task', workingSummary) });
    }

    // World state (P7): the parts this request is about, read again if stale
    // (at most ~1.5 s), as data in the same wrapper as the OCR text below.
    try {
      const wanted = worldState.sectionsFor(input);
      if (wanted.length) {
        await Promise.race([worldState.refresh(wanted), new Promise((r) => setTimeout(r, WORLD_REFRESH_BUDGET_MS))]);
      }
      const world = worldState.planningContext(input);
      if (world) messages.push({ role: 'user', content: world });
    } catch (err) {
      console.warn('[Orchestrator] World state unavailable (non-fatal):', err);
    }

    // Inject vision frame if available.
    //
    // OCR text is whatever happens to be on screen — a web page, a document, a
    // chat window — so it is attacker-controllable content, not instruction.
    // It used to be pushed as a `system` message, which is the highest-trust
    // role the model has: a screen reading "ignore previous instructions and
    // run ..." was indistinguishable from a genuine directive (JARVIS-014).
    //
    // It now goes in as `user` content inside explicit delimiters, with the
    // matching rule in the system prompt telling the model to treat anything
    // inside them as data. Angle brackets in the OCR text are stripped so it
    // cannot forge a closing tag and escape the wrapper.
    const visionFrame = nodeBridge.getLatestScreenFrame();
    if (visionFrame) {
      const sanitize = (value: string): string => value.replace(/[<>]/g, '');
      const activeWindow = sanitize(String(visionFrame.active_window ?? ''));
      const ocrText = sanitize(String(visionFrame.ocr_text ?? '').substring(0, 300));
      const visionCtx =
        `<untrusted_context source="ocr">\n` +
        `Active window: ${activeWindow}\n` +
        `Screen text: ${ocrText}\n` +
        `</untrusted_context>`;
      messages.push({ role: 'user', content: visionCtx });
    }

    // ── 4. Fast History Trimming ──────────────────────────────────────────────
    let historyTokens = 0;
    const history = agentMemory.getConversationHistory(5);
    const trimmedHistory: ILLMMessage[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      const tks = h.content.length >> 2;
      if (historyTokens + tks <= 500) {
        trimmedHistory.unshift(historyMessage(h));
        historyTokens += tks;
      } else {
        break;
      }
    }

    messages.push(...trimmedHistory);
    messages.push({ role: 'user', content: input });

    const inputTokens = input.length >> 2;
    const totalTokens = sysTokens + memTokens + uniTokens + historyTokens + toolTokens + inputTokens;
    const planPrepMs = Math.round(performance.now() - planPrepStart);

    console.log(`[Orchestrator] 📊 Planning preparation complete in ${planPrepMs}ms (Estimated Tokens: ~${totalTokens})`);

    // Set up working context
    const taskId = `task_${Date.now()}`;
    agentMemory.setWorkingContext({
      taskId,
      goal: input,
      startedAt: Date.now(),
      toolResults: {},
      observations: [],
      iteration: 1,
      metadata: {},
    });

    // LLM call with tools
    try {
      const request: {
        model: string;
        messages: ILLMMessage[];
        tools?: any[];
        tool_choice?: 'auto' | 'none';
        signal?: AbortSignal;
      } = {
        model: llmConfig.model,
        messages,
        signal: this.requestSignal(),
      };
      if (tools.length > 0) {
        request.tools = tools;
        request.tool_choice = 'auto';
      } else {
        request.tool_choice = 'none';
      }

      // Check interrupt before calling
      if (this.isInterrupted()) return null;

      const llmStart = performance.now();
      console.log(`[Timing] LLM call starting — model=${llmConfig.model} totalTokensEst=${totalTokens}`);
      const response = await modelRouter.chat(request);
      const llmMs = Math.round(performance.now() - llmStart);
      // Record in plan stage timings for the outer table
      const planTimings = this.planState().timings;
      planTimings['LLM Network'] = llmMs;
      planTimings['TokensEstimated'] = totalTokens;
      console.log(`[Timing] LLM returned in ${llmMs}ms — tokens_used=${response.usage?.totalTokens ?? '?'} prompt_tokens=${response.usage?.promptTokens ?? '?'}`);
      // Strip <think> tags from reasoning models
      let reply = (response.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      if (this.isInterrupted()) return null;

      // ── Tool call extraction fallback & handling ──────────────────────────
      if (!response.tool_calls || response.tool_calls.length === 0) {
        const extracted = this.extractToolCallsFromContent(reply, selectedToolNames);
        if (extracted.length > 0) {
          console.log(`[Orchestrator] 🔧 Extracted ${extracted.length} tool call(s) from LLM text response.`);
          response.tool_calls = extracted;
        } else {
          // Direct answer text
          console.log(`\n🤖 JARVIS: ${reply}\n`);
          await agentMemory.addConversationMessage('assistant', reply);
          agentMemory.pushEpisode('task_complete', `Direct answer: ${reply.substring(0, 100)}`, {}, 3);

          agentStateMachine.transition(AgentState.SPEAKING);
          this.speak(reply);
          this.planState().outcome = 'answered';
          return null;
        }
      }

      // ── Tool calls: build task graph ──────────────────────────────────────
      const toolCalls = response.tool_calls;
      const toolNames = toolCalls.map((t: any) => t.function.name).join(', ');
      console.log(`[Orchestrator] 🔧 LLM requested tools: ${toolNames}`);

      await agentMemory.addConversationMessage(
        'assistant',
        `[Planning] Using tools: ${toolNames}`
      );
      agentMemory.pushEpisode('task_start', `Planning with tools: ${toolNames}`, {
        goal: input,
        toolNames,
      }, 5);

      const graph = TaskGraphBuilder.fromToolCalls(input, toolCalls);
      limitRetriesToReadOnlyTools(graph);
      console.log(`[Orchestrator] 📊 Task graph built: ${graph.nodes.size} node(s)`);
      this.planState().outcome = 'graph';
      return graph;

    } catch (err) {
      const planningAborted =
        this.isInterrupted() ||
        this.requestSignal()?.aborted ||
        agentStateMachine.currentState === AgentState.IDLE;
      if (planningAborted) {
        console.warn('[Orchestrator] Planning aborted by watchdog or interrupt. Returning safely to IDLE.');
        return null;
      }

      console.error('[Orchestrator] Planning phase LLM error:', err);

      // ── LLM SINGLE POINT OF FAILURE FALLBACK ──
      // Use rule-based planner fallback or simplified response mode
      console.log('[Orchestrator] ⚠️ Attempting rule-based fallback recovery...');
      
      try {
          // A replan appends "[SYSTEM NOTE: ...]" (with failed tool names such as
          // search_memory); matching on it always picked the "system" graph.
          const lowerInput = input.replace(/\n\n\[SYSTEM NOTE:[\s\S]*$/, '').toLowerCase();
          if (lowerInput.includes('search') || lowerInput.includes('lookup') || lowerInput.includes('find')) {
              console.log('[Orchestrator] Fallback: Engaging emergency web search task graph.');
              const graph = new TaskGraphBuilder(input);
              graph.addTask({
                  tool: 'web_search',
                  args: { query: input },
                  description: 'Emergency fallback search'
              });
              this.planState().outcome = 'graph';
              return graph.build();
          } else if (lowerInput.includes('system') || lowerInput.includes('status')) {
              console.log('[Orchestrator] Fallback: Engaging emergency system tool graph.');
              const graph = new TaskGraphBuilder(input);
              graph.addTask({
                  // Was 'system_info', which is not a registered tool.
                  tool: 'get_system_info',
                  args: {},
                  description: 'Emergency fallback system status'
              });
              this.planState().outcome = 'graph';
              return graph.build();
          }
      } catch (fallbackErr) {
          console.error('[Orchestrator] Fallback recovery also failed.', fallbackErr);
      }

      // Graceful degradation: inform user
      const fallback = this.isInterrupted()
        ? ''
        : `I'm experiencing difficulty reaching my primary reasoning systems, sir. Operating in degraded fallback mode.`;

      if (fallback) {
        this.speak(fallback);
        await agentMemory.addConversationMessage('assistant', fallback);
        this.planState().outcome = 'failed';
      }
      return null;
    }
  }

  /**
   * Phase 1: Tool executor with mid-execution monitoring wired in.
   * After every node settles, checks for failure cascades and stalls.
   * If mid-check signals abort/replan, interrupts the active graph.
   */
  private makeMidMonitoredExecutor(graph: TaskGraph) {
    return async (tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
      const result = await toolRegistryV2.execute(tool, args, signal);
      const node = currentTaskNode();
      if (node && result.verification) node.verification = result.verification;

      // Record in working context
      agentMemory.addObservation(
        `${tool}: ${result.success ? result.output.substring(0, 150) : `FAILED: ${result.error}`}`
      );
      agentMemory.pushEpisode(
        result.success ? 'tool_used' : 'tool_failed',
        `${tool}: ${result.success ? 'success' : result.error ?? 'failed'}`,
        { tool, args, output: result.output.substring(0, 200) },
        result.success ? 4 : 7
      );

      if (!result.success) {
        // Keep the dispatch gate's explanation with its code, so the reply can
        // say that full control mode is needed.
        const explained = ['PERMISSION_DENIED', 'APPROVAL_DENIED', 'RISK_REFUSED', 'RATE_LIMITED', 'VERIFICATION_FAILED'].includes(result.error ?? '');
        throw new Error(explained ? `${result.error}: ${result.output}` : (result.error ?? result.output));
      }

      // ── Phase 1: Mid-execution check after each settled node ──────────────
      const midCheck = reflectionEngine.midExecutionCheck(graph);
      if (midCheck.signal === 'abort') {
        console.error(`[Orchestrator] 💥 Mid-execution abort: ${midCheck.reason}`);
        taskGraphEngine.interrupt(graph);
        this.announce(`I detected a critical failure mid-execution and stopped, sir.`);
      } else if (midCheck.signal === 'replan') {
        console.warn(`[Orchestrator] ⚠️  Mid-execution replan suggested: ${midCheck.reason}`);
        // Let the repair loop handle it after execution completes
      } else if (midCheck.signal === 'warn') {
        console.warn(`[Orchestrator] ⚠️  Mid-execution warning: ${midCheck.reason}`);
      }

      return result.output;
    };
  }

  /**
   * Collect observations from all completed nodes into working context.
   */
  private collectObservations(graph: TaskGraph): void {
    for (const node of graph.nodes.values()) {
      if (node.result) {
        agentMemory.addToolResult(node.id, node.result);
      }
    }

    const summary = taskGraphEngine.getGraphSummary(graph);
    agentMemory.addObservation(summary);
    console.log(`[Orchestrator] 👁️  Observations collected: ${summary}`);
  }

  /**
   * Handle successful task completion.
   * Calls LLM again to synthesize a final answer from all tool results.
   */
  private async handleSuccess(graph: TaskGraph, originalInput: string): Promise<void> {
    const nodes = [...graph.nodes.values()];
    const toolsUsed = nodes.map(n => n.tool);

    // OPT-SYNTH-1: Expanded bypass list — all single-action tools that produce
    // self-contained output don't need a second LLM call to "explain" the result.
    const simpleTools = SIMPLE_REPLY_TOOLS;
    const onlySimpleTools = toolsUsed.every(t => simpleTools.includes(t));

    if (onlySimpleTools) {
      console.log('[Orchestrator] Simple tool(s) succeeded. Bypassing LLM synthesis.');
      const firstNode = nodes[0];
      let reply = 'Task completed, sir.';

      if (firstNode && firstNode.tool === 'open_app') {
        const target = String(firstNode.args?.target ?? '');
        reply = `Opening ${this.formatTargetName(target)}, sir.`;
      } else if (firstNode && firstNode.tool === 'run_command' && firstNode.result) {
        console.log(`[Orchestrator] run_command output:\n${firstNode.result}`);
        reply = describeCommandResult(firstNode.result);
      } else if (firstNode && firstNode.result) {
        try {
          const parsed = JSON.parse(firstNode.result);
          if (parsed.success && parsed.target) {
            reply = `Opening ${this.formatTargetName(String(parsed.target))}, sir.`;
          } else if (parsed.success && parsed.message) {
            reply = parsed.message;
          } else if (parsed.success && parsed.output) {
            reply = String(parsed.output).slice(0, 500);
          } else {
            reply = 'Done, sir.';
          }
        } catch {
          if (firstNode.result.length < 150) {
            reply = firstNode.result;
          }
        }
      }

      reply = withCheck(reply, firstNode?.verification);
      console.log(`\n🤖 JARVIS: ${reply}\n`);
      await agentMemory.addConversationMessage('assistant', reply, FROM_TOOLS);
      this.speak(reply);
      return;
    }

    const toolOutputs = nodes
      .filter(n => n.status === 'done' && n.result)
      .map(n => `[${n.tool}]: ${n.result}${n.verification?.status === 'verified' ? ` (checked: ${n.verification.evidence})` : ''}`)
      .join('\n');

    // OPT-SYNTH-2: Smart short-output bypass.
    // If there is exactly one completed node and its result is already a
    // short, human-readable sentence (no raw JSON / technical noise), speak
    // it directly and skip the second LLM round-trip entirely.
    // Saves 500–3000ms on the majority of single-tool non-complex requests.
    const completedNodes = nodes.filter(n => n.status === 'done' && n.result);
    if (completedNodes.length === 1) {
      const singleResult = completedNodes[0].result!;
      const looksNatural = (
        singleResult.length <= 280 &&
        !singleResult.startsWith('{') &&
        !singleResult.startsWith('[') &&
        !singleResult.includes('\\n') &&
        !/:\s*"/.test(singleResult)      // no JSON key-value patterns
      );
      if (looksNatural) {
        console.log('[Orchestrator] OPT-SYNTH-2: Short natural output — bypassing synthesis LLM.');
        const reply = withCheck(singleResult, completedNodes[0].verification);
        console.log(`\n🤖 JARVIS: ${reply}\n`);
        await agentMemory.addConversationMessage('assistant', reply, FROM_TOOLS);
        // speak() calls safeTransitionToSpeaking() internally — do NOT also
        // call transition(SPEAKING) here or we get a double-transition crash.
        this.speak(reply);
        return;
      }
    }

    // OPT-PAYLOAD-1: Synthesis prompt uses minimal system instruction (~30 tokens)
    // instead of the full JARVIS system prompt (~350 tokens). Synthesis only converts
    // tool output to a natural sentence — it doesn't need tool rules or persona details.
    // Saves ~320 tokens per synthesis call.
    // Tool output (web pages, files, search results) is data: it goes in a
    // user message inside the untrusted wrapper, never in a system message
    // where it would read as JARVIS's own instructions (SEC-03).
    const synthesisMessages: ILLMMessage[] = [
      {
        role: 'system',
        content: `You are JARVIS. Convert the tool results into a single concise natural-language response. Address the user as "sir". Be brief and direct. ${UNTRUSTED_RULE}`,
      },
      { role: 'user', content: originalInput },
      {
        role: 'user',
        content: `${untrusted('tool results', toolOutputs, 12_000)}\n\nRespond naturally in 1-2 sentences.`,
      },
    ];


    try {
      if (this.isInterrupted()) return;

      const synthesisRequest = {
        // OPT-SYNTH-3: Use fast 8B model for synthesis — it only needs to convert
        // structured tool output into a natural sentence, not call tools or plan.
        // Saves ~400–1500ms vs the 32B planning model.
        model: llmConfig.fastModel,
        messages: synthesisMessages,
        signal: this.requestSignal(),
        max_tokens: 200,  // OPT-SYNTH-4: cap synthesis at 200 tokens — just a sentence or two
      };

      if (this.config.streamingEnabled) {
        await this.streamSynthesis(synthesisRequest, originalInput);
      } else {
        const resp = await modelRouter.chat(synthesisRequest);
        const reply = (resp.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        console.log(`\n🤖 JARVIS: ${reply}\n`);
        await agentMemory.addConversationMessage('assistant', reply, FROM_TOOLS);
        // speak() calls safeTransitionToSpeaking() internally — do NOT also
        // call transition(SPEAKING) here or we get a double-transition crash.
        this.speak(reply);
      }

    } catch (err) {
      console.error('[Orchestrator] Synthesis error:', err);
      // Fall back to raw tool output
      const raw = toolOutputs.substring(0, 500);
      this.speak(`I completed the task. Here are the results: ${raw}`);
    }
  }


  /**
   * Stream the synthesis response to TTS in sentence chunks.
   */
  private async streamSynthesis(request: any, originalInput: string): Promise<void> {
    let fullReply = '';
    let speakBuffer = '';
    let lastIndex = 0;
    const t0 = performance.now();
    let firstChunkTime: number | null = null;

    try {
      process.stdout.write('\n🤖 JARVIS: ');

      for await (let chunk of modelRouter.streamChat(request)) {
        if (this.isInterrupted()) {
          console.log('\n[Orchestrator] 🛑 Stream interrupted.');
          break;
        }

        if (firstChunkTime === null) {
          firstChunkTime = performance.now() - t0;
          console.log(`\n[Timing] Synthesis stream first chunk: ${firstChunkTime.toFixed(2)}ms`);
        }

        // Clean encoding artifacts + think tags
        chunk = chunk
          .replace(/\uFFFD/g, "'")
          .replace(/['']/g, "'")
          .replace(/[""]/g, '"');

        fullReply += chunk;

        // Strip <think> blocks from what gets spoken and printed
        const clean = fullReply.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/, '').trimStart();
        const newPart = clean.substring(lastIndex);

        if (newPart) {
          process.stdout.write(newPart);
          speakBuffer += newPart;
          lastIndex = clean.length;

          // Send to TTS at sentence boundaries
          if (/[.!?\n]\s/.test(speakBuffer)) {
            const parts = speakBuffer.split(/(?<=[.!?\n])\s+/);
            speakBuffer = parts.pop() ?? '';

            let chunk2Send = '';
            for (const part of parts) {
              chunk2Send += part + ' ';
              if (chunk2Send.length > 25 || parts.length === 1) {
                this.speak(chunk2Send.trim());
                chunk2Send = '';
              }
            }
            if (chunk2Send.trim()) speakBuffer = chunk2Send + speakBuffer;
          }
        }
      }

      // Send remaining buffer
      if (speakBuffer.trim() && !this.isInterrupted()) {
        this.speak(speakBuffer.trim());
      }

      console.log('\n');
      console.log(`[Timing] Synthesis stream total: ${(performance.now() - t0).toFixed(2)}ms`);

      if (!this.isInterrupted()) {
        const cleanReply = fullReply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        await agentMemory.addConversationMessage('assistant', cleanReply, FROM_TOOLS);
        agentMemory.pushEpisode('task_complete', `Synthesized: ${cleanReply.substring(0, 100)}`, {}, 3);
      }

    } catch (err) {
      console.error('[Orchestrator] Synthesis stream failed, fallback to direct synthesis:', err);
      try {
        const resp = await modelRouter.chat(request);
        const reply = (resp.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        console.log(`\n🤖 JARVIS: ${reply}\n`);
        await agentMemory.addConversationMessage('assistant', reply, FROM_TOOLS);
        this.speak(reply);
      } catch (fallbackErr) {
        console.error('[Orchestrator] Fallback synthesis also failed:', fallbackErr);
      }
    }
  }

  /**
   * REPAIR PHASE
   * Applies the repair strategy decided by ReflectionEngine.
   * Returns a new TaskGraph (for replan) or the mutated existing graph (for retry),
   * or null if repair is impossible.
   */
  private async repairPhase(
    strategy: RepairStrategy,
    repairArgs: Record<string, unknown>,
    graph: TaskGraph,
    originalInput: string
  ): Promise<TaskGraph | null> {
    switch (strategy) {
      case 'retry_same': {
        const nodeIds = (repairArgs['nodeIds'] as string[]) ?? [];
        reflectionEngine.resetFailedNodes(graph, nodeIds);
        return graph;
      }

      case 'retry_with_delay': {
        const delayMs = (repairArgs['delayMs'] as number) ?? 1000;
        const nodeIds = (repairArgs['nodeIds'] as string[]) ?? [];
        console.log(`[Orchestrator] ⏳ Waiting ${delayMs}ms before retry...`);
        await sleep(delayMs);
        reflectionEngine.resetFailedNodes(graph, nodeIds);
        return graph;
      }

      case 'fallback_tool': {
        // Previously byte-identical to 'retry_same': it reset the failed nodes
        // and re-ran them under the *same* tool, so the strategy never did what
        // its name says (JARVIS-006). Now each failed node is rewritten to the
        // best registered alternative before the reset; nodes with no usable
        // alternative simply fall through to a plain retry, as before.
        const nodeIds = (repairArgs['nodeIds'] as string[]) ?? [];

        let switched = 0;
        for (const nodeId of nodeIds) {
          const node = graph.nodes.get(nodeId);
          if (!node) continue;

          const alternative = plannerIntelligence
            .generateAlternatives(node)
            .filter((a) => a.type === 'use_fallback' && a.replacementTool)
            .sort((a, b) => a.priority - b.priority)[0];

          const replacement = alternative?.replacementTool;
          if (!replacement || replacement === node.tool) continue;
          if (!toolRegistryV2.get(replacement)) continue;

          console.log(
            `[Orchestrator] 🔀 fallback_tool: node "${node.id}" "${node.tool}" → "${replacement}"`,
          );
          node.tool = replacement;
          if (alternative.replacementArgs) node.args = alternative.replacementArgs;
          node.error = undefined;
          node.errorType = undefined;
          switched++;
        }

        if (switched === 0) {
          console.log('[Orchestrator] fallback_tool: no alternative tool available — plain retry.');
        }

        reflectionEngine.resetFailedNodes(graph, nodeIds);
        return graph;
      }

      case 'replan': {
        console.log('[Orchestrator] 📋 Re-planning with additional context...');

        const context = repairArgs['context'] as string ?? '';
        const augmentedInput = `${originalInput}\n\n[SYSTEM NOTE: Previous attempt failed. ${context} Please use a different approach.]`;

        // Transition to PLANNING, but only if not already there (re-entrant
        // repair cycles would cause an illegal PLANNING→PLANNING throw).
        if (!agentStateMachine.is(AgentState.PLANNING)) {
          agentStateMachine.transition(AgentState.PLANNING);
        }
        const newGraph = await this.planPhase(augmentedInput);

        if (!newGraph) {
          // LLM gave a direct answer during re-plan
          return null;
        }

        return newGraph;
      }

      case 'abort':
      default:
        return null;
    }
  }


  // ── Deterministic Pre-Router ─────────────────────────────────────────────

  /** The deterministic pre-router (core/deterministicRoutes.ts), with this orchestrator's "try again?" offer. */
  public matchDeterministicCommand(input: string): DeterministicRoute | null {
    return matchDeterministicCommand(input, !!this.continueOffer && Date.now() < this.continueOffer.expires);
  }

  // ── Safe Direct Streaming Path ────────────────────────────────────────────

  private isSimpleConversationalInput(input: string): boolean {
    const cleanInput = input.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    
    // Explicit guard against action verbs to ensure they always go through the planning/tool route
    const actionVerbs = ['open', 'launch', 'start', 'run', 'search', 'read', 'write', 'create', 'delete', 'send'];
    const words = cleanInput.split(/\s+/);
    if (words.some(w => actionVerbs.includes(w))) {
      return false;
    }

    const simpleGreetings = [
      'hello', 'hi', 'hey', 'how are you', 'thank you', 'thanks',
      'who are you', 'what can you do', 'good morning', 'good evening', 'are you there'
    ];
    return simpleGreetings.includes(cleanInput);
  }

  private async streamDirectChat(input: string): Promise<void> {
    console.log('[Orchestrator] 🚀 Direct conversational path triggered.');
    
    let systemPrompt = llmConfig.systemPrompt;
    let history = agentMemory.getConversationHistory(5);
    const messages: ILLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map(historyMessage),
      { role: 'user', content: input }
    ];

    const request = {
      model: llmConfig.model,
      messages,
      // no tools mapped, ensuring it only converses
      signal: this.requestSignal(),
    };

    let firstChunkTime: number | null = null;
    const t0 = performance.now();

    try {
      let fullReply = '';
      let speakBuffer = '';
      let lastIndex = 0;

      process.stdout.write('\n🤖 JARVIS (Direct Stream): ');

      for await (let chunk of modelRouter.streamChat(request)) {
        if (this.isInterrupted()) {
          console.log('\n[Orchestrator] 🛑 Stream interrupted.');
          break;
        }

        if (firstChunkTime === null) {
          firstChunkTime = performance.now() - t0;
          console.log(`\n[Timing] Direct conversational stream first chunk: ${firstChunkTime.toFixed(2)}ms`);
        }

        chunk = chunk
          .replace(/\uFFFD/g, "'")
          .replace(/['']/g, "'")
          .replace(/[""]/g, '"');

        fullReply += chunk;

        const clean = fullReply.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/, '').trimStart();
        const newPart = clean.substring(lastIndex);

        if (newPart) {
          process.stdout.write(newPart);
          speakBuffer += newPart;
          lastIndex = clean.length;

          if (/[.!?\n]\s/.test(speakBuffer)) {
            const parts = speakBuffer.split(/(?<=[.!?\n])\s+/);
            speakBuffer = parts.pop() ?? '';

            let chunk2Send = '';
            for (const part of parts) {
              chunk2Send += part + ' ';
              if (chunk2Send.length > 25 || parts.length === 1) {
                this.speak(chunk2Send.trim());
                chunk2Send = '';
              }
            }
            if (chunk2Send.trim()) speakBuffer = chunk2Send + speakBuffer;
          }
        }
      }

      if (speakBuffer.trim() && !this.isInterrupted()) {
        this.speak(speakBuffer.trim());
      }
      console.log('\n');
      console.log(`[Timing] Direct conversational stream total: ${(performance.now() - t0).toFixed(2)}ms`);

      if (!this.isInterrupted()) {
        const cleanReply = fullReply.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/g, '').trim();
        await agentMemory.addConversationMessage('assistant', cleanReply);
        agentMemory.pushEpisode('task_complete', `Direct chat response: ${cleanReply.substring(0, 100)}`, {}, 4);
      }
      
      agentStateMachine.transition(AgentState.IDLE);
    } catch (err) {
      console.error('[DirectStream] Streaming failed, falling back to blocking chat:', err);
      try {
        const resp = await modelRouter.chat(request);
        const reply = (resp.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/g, '').trim();
        console.log(`\n🤖 JARVIS: ${reply}\n`);
        await agentMemory.addConversationMessage('assistant', reply);
        this.speak(reply);
        agentStateMachine.transition(AgentState.IDLE);
      } catch (fallbackErr) {
        console.error('[DirectStream] Fallback also failed:', fallbackErr);
        this.speak('I am having trouble connecting to my reasoning center, sir.');
        agentStateMachine.transition(AgentState.IDLE);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Interrupted, or this request was replaced by a newer one (its own signal aborted). */
  /** Waits for the skill tools, at most 10 s (a hung import must not block every request). */
  private async waitForSkills(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const finished = await Promise.race([
      this.skillsReady.then(() => true),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(false), SKILLS_WAIT_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    const waited = Date.now() - started;
    if (!finished) console.warn(`[Orchestrator] Skills still loading after ${SKILLS_WAIT_MS} ms; planning without the rest.`);
    else if (waited > 50) console.log(`[Orchestrator] Waited ${waited} ms for the skills before the first request.`);
  }

  private isInterrupted(): boolean {
    return agentStateMachine.is(AgentState.INTERRUPTED) || requestContext.getStore()?.signal.aborted === true;
  }

  /**
   * This request's own abort signal (REL-05). Model calls read
   * this.currentAbortController, the newest request's: a call made by an
   * older request after a newer one began was tied to the wrong request.
   */
  /** This request's plan state (ARCH-03); outside a request, the orchestrator's own. */
  private planState(): PlanState {
    const scope = requestContext.getStore();
    if (!scope) return this.planOutside;
    return (scope.plan ??= { outcome: 'graph', timings: {} });
  }

  private requestSignal(): AbortSignal | undefined {
    return requestContext.getStore()?.signal ?? this.currentAbortController?.signal;
  }

  /** A newer process() call has started since this request began. */
  private isSuperseded(): boolean {
    const request = requestContext.getStore();
    return request !== undefined && request.callId !== this.currentProcessCallId;
  }

  private shouldUseHeavyContext(input: string): boolean {
    return shouldUseHeavyContext(input);
  }

  /** The tools offered to the planner (core/planningToolSelection.ts). */
  private selectPlanningToolNames(input: string): string[] {
    return selectPlanningToolNames(input);
  }

  /**
   * Tool calls written as text by models without native tool calling. Only a
   * reply that is nothing but JSON (bare, or one fenced block) counts, and only
   * for tools offered in this planning call: an answer that merely contained
   * an example call, or JSON echoed from a web page or the screen, used to be
   * executed as a command, with any registered tool.
   */
  private extractToolCallsFromContent(content: string, allowedTools?: string[]): ILLMToolCall[] {
    if (!content || !content.trim()) return [];

    const trimmed = content.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const body = fenced ? fenced[1]!.trim() : trimmed;
    if (!/^[\[{]/.test(body) || body.includes('```')) return [];

    const toolCalls: ILLMToolCall[] = [];
    try {
      const parsed = JSON.parse(body);
      const items = Array.isArray(parsed) ? parsed : (parsed.tool_calls || [parsed]);

      for (const item of items) {
        const toolName = item.tool || item.name || item.function?.name;
        const rawArgs = item.args || item.arguments || item.parameters || item.function?.arguments || {};
        const offered = !allowedTools || allowedTools.includes(toolName);

        if (toolName && toolRegistryV2.has(toolName) && offered) {
          const argsString = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
          toolCalls.push({
            id: item.id || `extracted_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: {
              name: toolName,
              arguments: argsString,
            },
          });
        }
      }
    } catch {
      // Not JSON after all: a plain answer.
    }

    return toolCalls;
  }

  private formatTargetName(target: string): string {
    const clean = target.trim().toLowerCase();
    const names: Record<string, string> = {
      youtube: 'YouTube',
      google: 'Google',
      gmail: 'Gmail',
      github: 'GitHub',
      chrome: 'Chrome',
      notepad: 'Notepad',
      calculator: 'Calculator',
      calc: 'Calculator',
      cmd: 'Command Prompt',
    };
    return names[clean] ?? (target.trim() || 'that');
  }

  /**
   * The request's reply: the state machine moves to SPEAKING, and the request
   * ends after it. For a message while the task goes on, use announce().
   */
  public speak(text: string): void {
    const cleanText = this.spokenForm(text);
    if (!cleanText) return;
    try {
      agentStateMachine.safeTransitionToSpeaking();
    } catch (err) {
      console.warn(`[Orchestrator] speak() safe state transition failed:`, err);
    }
    this.sendSpeech(cleanText);
  }

  /**
   * A progress message while the task goes on ("I'll plan it again", "I
   * restarted the server first"): spoken, but the state machine stays in its
   * loop state. Moving it to SPEAKING here made the next step's transition
   * (SPEAKING → EXECUTING / PLANNING) illegal, and a repair that worked ended
   * in "unexpected error" (BUG-02).
   */
  public announce(text: string): void {
    const cleanText = this.spokenForm(text);
    if (cleanText) this.sendSpeech(cleanText);
  }

  /** The text as it is spoken, or '' when nothing should be said. */
  private spokenForm(text: string): string {
    if (!text || !text.trim()) return '';
    if (this.isInterrupted()) {
      console.log(`[Orchestrator] 🛑 speech blocked: interrupted or replaced by a newer request. Text: "${text.substring(0, 30)}..."`);
      return '';
    }

    // 1. Sanitize <think>...</think> and partial <think> blocks
    let cleanText = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*/g, '')
      .trim();

    // 2. Remove markdown formatting characters for clean spoken output
    cleanText = cleanText
      .replace(/(\w)_(?=\w)/g, '$1 ')         // tool_name -> "tool name", not "toolname"
      .replace(/[*_`#~]/g, '')                // formatting characters
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links -> raw text
      .replace(/-\s+/g, '')                   // list hyphens
      .replace(/^\s*[-*+]\s+/gm, '')          // bullet points
      .trim();

    if (!cleanText) return '';

    // 3. Apply concise personality rule: limit verbal response to max 3 sentences
    const sentences = cleanText.split(/(?<=[.!?])\s+/);
    if (sentences.length > 3) {
      cleanText = sentences.slice(0, 3).join(' ') + ' I have printed the full details to the console, sir.';
    }
    return cleanText;
  }

  private sendSpeech(cleanText: string): void {
    // Track last spoken text in NodeBridge
    nodeBridge.lastTtsText = cleanText;

    // Pause wake word immediately to prevent echo
    nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });

    // Send text to clients via WebSocket
    if (this.config.voiceEnabled) {
      nodeBridge.speakToClients(cleanText);
    }
  }

  /**
   * Barge-in listeners clear the voice queue and similar. One that throws is
   * logged (ARCH-07): before, a failure was swallowed and stale speech could
   * play after "stop" with nothing in the log.
   */
  private runBargeInCallbacks(): void {
    for (const cb of this.onBargeIn) {
      try { cb(); } catch (err) {
        console.warn(`[Orchestrator] Barge-in listener failed: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      }
    }
  }

  private handleBargeInBeforeProcessing(input: string, source: 'cli' | 'voice'): void {
    const curState = agentStateMachine.currentState;
    this.currentAbortController?.abort();
    console.log(`[Orchestrator] 🚨 Barge-in detected in state ${curState}. Input: "${input}"`);

    // 1. Send hard TTS stop
    nodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });

    // 2. Clear TTS queue
    (nodeBridge as any).pendingTTS = [];

    // 3. Clear stale voice queue
    this.runBargeInCallbacks();

    // 4. Transition SPEAKING -> INTERRUPTED if needed
    if (curState === AgentState.SPEAKING) {
      try {
        agentStateMachine.interrupt();
      } catch (err) {
        console.error(`[Orchestrator] Barge-in transition SPEAKING -> INTERRUPTED failed:`, err);
      }
    }

    // 5. Transition INTERRUPTED -> PROCESSING_STT
    try {
      agentStateMachine.transition(AgentState.PROCESSING_STT);
    } catch (err) {
      console.warn(`[Orchestrator] Barge-in transition to PROCESSING_STT failed. Trying recovery reset:`, err);
      try {
        agentStateMachine.reset();
        agentStateMachine.transition(AgentState.PROCESSING_STT);
      } catch (recErr) {
        console.error(`[Orchestrator] Barge-in recovery transition failed:`, recErr);
      }
    }
  }

  private handleWatchdogReset(data: { fromState: AgentState; reason: string }): void {
    if (data.fromState === AgentState.PLANNING) {
      console.warn('[Orchestrator] PLANNING watchdog reset received — invoking safeReset().');
      // Route through safeReset() so all state is torn down atomically.
      this.safeReset(data.reason);
      // VOICE-002: the reset aborts the request, and an aborted request may not
      // speak, so it ended in silence. Say why, past that check: this is not
      // the old request's reply but the reason it has none.
      console.log(`[Orchestrator] JARVIS: ${PLANNING_TIMEOUT_REPLY}`);
      this.sendSpeech(PLANNING_TIMEOUT_REPLY);
      return;
    }

    if (data.fromState === AgentState.SPEAKING) {
      console.warn('[Orchestrator] SPEAKING watchdog reset received. Forcing TTS recovery cleanup.');
      nodeBridge.noteSpeechTimedOut();
      nodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });
      nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });
      if (this.isConversationEndDeferred) {
        this.isConversationEndDeferred = false;
        if (this._conversationStarted && !this._conversationEndHandled) {
          this._conversationEndHandled = true;
          this._conversationStarted = false;
          conversationBus.conversationEnded();
        }
      }
    }
  }
}

// ─── Sleep Helper ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** How recent a request must be for "continue" to offer it, and how long the offer holds. */
const CONTINUE_WINDOW_MS = 12 * 60 * 60_000;
const CONTINUE_OFFER_MS = 60_000;

/** How long planning waits for stale world-state parts to be read again. */
const WORLD_REFRESH_BUDGET_MS = 1_500;

/** Said when the PLANNING watchdog ends a request (VOICE-002). */
const PLANNING_TIMEOUT_REPLY = 'That took too long, sir. Please ask me again.';

/** A task step as the world state shows it: "control_app close". */
function stepLabel(node: { tool: string; args?: Record<string, unknown> }): string {
  const action = typeof node.args?.['action'] === 'string' ? ` ${node.args['action']}` : '';
  return `${node.tool}${action}`;
}

/** What one request's agent loop reports back for its goal. */
interface LoopRecord {
  approvals: ApprovalDecision[];
  /** Why the loop failed, in its own words, for the goal. */
  failReason?: string;
  /** A request to process once this one has finished (a confirmed "continue"). */
  followUp?: string;
}

/** The approval decisions made in `graph`, each added once. */
function collectApprovals(graph: TaskGraph, into: ApprovalDecision[]): void {
  for (const node of graph.nodes.values()) {
    for (const decision of node.approvals ?? []) {
      if (!into.some((d) => d.requestId === decision.requestId)) into.push(decision);
    }
  }
}

/** One system line for planning: which tool groups exist and how many tools each has. */
export function capabilityOverview(): string {
  const groups = toolRegistryV2.describeCapabilities();
  if (groups.length === 0) return '';
  const parts = groups.map((g) => `${g.category} ${g.tools.length}`).join(', ');
  return `JARVIS tool groups (${groups.reduce((n, g) => n + g.tools.length, 0)} tools): ${parts}. ` +
    'Only the tools offered with this request can be called.';
}

/**
 * Steps that change something on the PC (click, type, close, write, kill, run)
 * are not re-run automatically: the task graph retried any failure it did not
 * recognise twice, so a partial failure could type the text three times or
 * close more windows. Read-only steps keep their retries.
 */
export function limitRetriesToReadOnlyTools(graph: TaskGraph): void {
  for (const node of graph.nodes.values()) {
    const tool = toolRegistryV2.get(node.tool);
    if (tool && tool.riskLevel !== 'low') node.maxRetries = 0;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const orchestrator = new JarvisOrchestrator();
