/**
 * jarvis.ts — Main Entry Point (v2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Upgraded to route all input through the new Central Orchestration Kernel.
 *
 * Changes from v1:
 *   - jarvisBrain.execute() → orchestrator.process()
 *   - agentStateMachine handles interrupt state (via systemController shim)
 *   - All voice pipeline events still work exactly as before
 *   - Self-healing, watchdog, fsWatcher unchanged
 *   - Reflection is now inline TypeScript (see core/reflectionEngine.ts)
 *     The Python reflectionEngine.py is still scheduled as a backup summary job
 */

import 'dotenv/config';
import { wireExecutionTracing } from './monitoring/traceWiring.js';
import { configValidator } from './config/configValidator.js';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

import { memoryManager }   from './memory/memoryManager.js';
import { nodeBridge }      from './bridge/nodeBridge.js';
import { orchestrator, normalizeVoiceInput }    from './core/orchestrator.js';
import { brainLoop }       from './core/brainLoop.js';
import { terminalTools }   from './core/terminalTools.js';
import { conversationBus } from './core/conversationBus.js';
import { agentStateMachine, AgentState } from './core/agentStateMachine.js';
import { evaluateEcho }    from './core/voiceEchoFilter.js';
import { mergePendingVoiceContinuation, shouldUseContinuationContext, accumulateContinuationFragment } from './core/voiceContinuation.js';

// Compat shim — unchanged API surface
import { systemController, SystemState } from './core/stateShim.js';

// Self-healing system
import { selfHealingManager } from './self_healing/selfHealingManager.js';
import { pipelineRegistry }   from './self_healing/pipelineRegistry.js';
import { pipelineWatchdog }   from './self_healing/pipelineWatchdog.js';
import { fsWatcher }          from './self_healing/fsWatcher.js';

// NEW: Phase 1 — shutdown hook imports
import { goalManager }           from './core/goalManager.js';
// NEW: Phase 2 — Runtime health dashboard
import { runtimeDashboard }      from './monitoring/runtimeDashboard.js';
// NEW: Phase 3 — Vector memory supervisor
import { vectorMemorySupervisor } from './memory/vectorMemorySupervisor.js';
// NEW: PC State Observer
import { systemStateObserver }    from './perception/systemStateObserver.js';
import { healthManager }          from './monitoring/healthManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOICE_DIR  = path.join(__dirname, 'voice');

// ─── Global Error Handlers ────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[JARVIS] UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[JARVIS] UNHANDLED PROMISE REJECTION:', err);
});

// ─── Phase 4: Mic Ownership State Machine ──────────────────────────────────────────────────────────────
// Only one subsystem can "own" the microphone at a time:
//   NONE       — mic is released, not actively captured by any subsystem
//   WAKE_WORD  — wakeWords.py is capturing for wake detection
//   STT        — stt.py is capturing for command transcription
//
// This prevents the classic race where WakeWord resumes while STT is still
// recording, causing double-capture and phantom wake-word triggers.

const enum MicOwner { NONE = 'NONE', WAKE_WORD = 'WAKE_WORD', STT = 'STT' }
let _micOwner: MicOwner = MicOwner.NONE;
let _micOwnerSince = 0;

function takeMic(owner: MicOwner, reason: string): boolean {
  if (_micOwner === owner) return true; // already owner
  if (_micOwner !== MicOwner.NONE) {
    console.warn(`[MicOwner] ${owner} tried to take mic but it is owned by ${_micOwner} (${reason}). Rejected.`);
    return false;
  }
  console.log(`[MicOwner] ${owner} now owns mic (${reason})`);
  _micOwner = owner;
  _micOwnerSince = Date.now();
  return true;
}

function releaseMic(owner: MicOwner, reason: string): void {
  if (_micOwner !== owner) {
    if (_micOwner !== MicOwner.NONE) {
      console.warn(`[MicOwner] ${owner} tried to release mic but owner is ${_micOwner} (${reason}). Ignoring.`);
    }
    return;
  }
  const held = Date.now() - _micOwnerSince;
  console.log(`[MicOwner] ${owner} released mic after ${held}ms (${reason})`);
  _micOwner = MicOwner.NONE;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

console.log('===================================');
console.log('🚀 JARVIS AI SYSTEM STARTING... v2');
console.log('===================================');

let hasStarted = false;

// ─── Voice Input Arbitration Queue ───────────────────────────────────────────
// Holds voice commands that arrived while orchestrator was busy (PLANNING /
// EXECUTING / OBSERVING / REFLECTING / REPAIRING). Replayed after the current
// task completes and the state machine returns to IDLE.
interface QueuedVoiceInput {
  text: string;
  timestamp: number;
}
const voiceInputQueue: QueuedVoiceInput[] = [];
let _isDraining = false; // PHASE2-QUEUE-1: drain-lock prevents concurrent races

// ─── JS-Side STT Debug Logging ───────────────────────────────────────────────
// Part B (TS side): also log STT events from the NodeBridge handler.

const JS_STT_LOG = path.join(__dirname, 'data', 'logs', 'stt_debug.log');
let sttLogDirReady: Promise<void> | null = null;

function appendSttLogLine(entry: string): void {
  sttLogDirReady ??= fs.promises.mkdir(path.dirname(JS_STT_LOG), { recursive: true }).then(() => undefined);
  void sttLogDirReady
    .then(() => fs.promises.appendFile(JS_STT_LOG, entry + '\n', 'utf8'))
    .catch(() => {
      // STT debug logging must never block or crash the voice path.
    });
}

function sttJsLog(event: string, text: string, note?: string): void {
  try {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      source: 'jarvis.ts',
      event,
      text: text.slice(0, 200),
      ...(note ? { note: note.slice(0, 120) } : {}),
    });
    appendSttLogLine(entry);
  } catch {
    // log errors must never crash the main process
  }
}

// ─── Echo Filter (Part E) ─────────────────────────────────────────────────────
// Protects command keywords (open, launch, start, youtube, …) from being
// wrongly discarded when word-overlap ratio is borderline.

const COMMAND_KEYWORDS_SET = new Set([
  'open', 'launch', 'start', 'close', 'run', 'stop', 'play', 'search',
  'youtube', 'google', 'chrome', 'notepad', 'calculator', 'spotify',
]);

function hasCommandKeyword(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  return words.some(w => COMMAND_KEYWORDS_SET.has(w));
}

function isCommandLike(text: string): boolean {
  const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  
  const commandVerbs = ['open', 'launch', 'start', 'run', 'play', 'search', 'close', 'stop'];
  const hasVerb = words.some(w => commandVerbs.includes(w));
  return hasVerb;
}

function drainVoiceInputQueue(): void {
  if (_isDraining) return; // PHASE2-QUEUE-1: prevent concurrent drain
  if (voiceInputQueue.length === 0) return;
  _isDraining = true;

  const now = Date.now();
  const item = voiceInputQueue.shift();
  _isDraining = false;
  if (!item) return;

  // PHASE2-QUEUE-1: Reduced stale threshold 10s → 6s. Voice commands older
  // than 6s have lost conversational context and should be discarded.
  if (now - item.timestamp > 6000) {
    console.log(`[JARVIS] Dropped stale queued command: "${item.text}" (age: ${((now - item.timestamp) / 1000).toFixed(1)}s)`);
    sttJsLog('STT_QUEUE_STALE_DROPPED', item.text, `age=${((now - item.timestamp) / 1000).toFixed(1)}s`);
    drainVoiceInputQueue();
    return;
  }

  const cur = agentStateMachine.currentState;
  const BUSY_STATES: AgentState[] = [
    AgentState.PLANNING,
    AgentState.EXECUTING,
    AgentState.OBSERVING,
    AgentState.REFLECTING,
    AgentState.REPAIRING,
    AgentState.SPEAKING,
  ];

  if (BUSY_STATES.includes(cur)) {
    // Put back if still busy
    voiceInputQueue.unshift(item);
    return;
  }

  console.log(`[JARVIS] Draining queued command: "${item.text}"`);
  sttJsLog('STT_QUEUE_DRAINED', item.text);

  try {
    agentStateMachine.transition(AgentState.PROCESSING_STT);
  } catch {}

  orchestrator.process(item.text, 'voice').catch(err => {
    console.error('[Voice] Queued command execution error:', err);
  });
}

function isEcho(sttText: string, lastTtsText: string): boolean {
  // Phase 4: Pass ttsStartedMs for barge-in echo detection
  const decision = evaluateEcho(
    sttText,
    lastTtsText,
    orchestrator,
    nodeBridge.lastTtsTimestamp,
    nodeBridge.ttsStartedMs,
  );
  const accepted = !decision.isEcho;
  console.log(
    `[EchoFilter] ${accepted ? 'accepted' : 'rejected'} reason="${decision.reason}" ` +
    `combined=${decision.overlapScore.toFixed(2)} uni=${decision.unigramScore.toFixed(2)} bi=${decision.bigramScore.toFixed(2)} ` +
    `stt="${sttText}" lastTts="${lastTtsText}"`
  );
  try {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      source: 'jarvis.ts',
      event: accepted ? 'ECHO_ACCEPTED' : 'ECHO_REJECTED',
      decision: accepted ? 'accepted' : 'rejected',
      reason: decision.reason,
      overlapScore: decision.overlapScore,
      lastTtsText,
      sttText,
    });
    appendSttLogLine(entry);
  } catch {
    // ignore log write errors
  }
  return decision.isEcho;
}

async function startJarvis() {
  if (hasStarted) {
    console.warn('[JARVIS] startJarvis() called again. Ignoring duplicate startup.');
    return;
  }
  hasStarted = true;
  
  const startTime = Date.now();
  const timings: Record<string, number> = {};

  try {
    console.log('🔹 Loading configuration...');

    // 0. Validate configuration BEFORE any subsystem starts (JARVIS-011).
    // configValidator existed but was called from nowhere, so a missing
    // GROQ_API_KEY surfaced as a 401 midway through the first request instead
    // of as a clear message at startup.
    const configReport = configValidator.validate();
    console.log(configReport.summary);
    if (!configReport.canStart) {
      console.error('\n❌ JARVIS cannot start with the current configuration:\n');
      for (const issue of configReport.issues.filter(i => i.level === 'CRITICAL')) {
        console.error(`   [${issue.field}] ${issue.message}`);
        console.error(`   → ${issue.fix}\n`);
      }
      process.exit(1);
    }

    // 0b. Join the structured logger to the task graph's event stream so a
    // request produces one traceable, correlated record (JARVIS-015).
    wireExecutionTracing();

    // 1. Parallel Core Systems Init (Memory + Goals)
    const tMemory = Date.now();
    console.log('🔹 Initializing memory & core systems in parallel...');
    await Promise.all([
      memoryManager.init(),
      goalManager.init(),
    ]);
    timings['Core Memory & Goals'] = Date.now() - tMemory;

    // 1a. Vector Memory Supervisor (Phase 3) — non-blocking fire-and-forget
    const tVector = Date.now();
    console.log('🔹 Starting vector memory supervisor...');
    vectorMemorySupervisor.start().catch(err =>
      console.warn('[Startup] Vector supervisor non-fatal error:', err)
    );
    timings['Vector Memory Supervisor'] = Date.now() - tVector;

    console.log('🔹 Active Brain Model:', process.env.JARVIS_BRAIN_MODEL);

    // 2. WebSocket server & Brain loop
    const tBridge = Date.now();
    nodeBridge.start();
    brainLoop.start();
    timings['NodeBridge & Brain Loop'] = Date.now() - tBridge;

    // 3. Deferred Non-Critical Background Observers (started right after core online)
    setImmediate(() => {
      systemStateObserver.start();
      runtimeDashboard.start(60_000, true);
    });

    // Register barge-in hook to clear voice command queue
    orchestrator.onBargeIn.push(() => {
      console.log('[JARVIS] Clearing voiceInputQueue on orchestrator barge-in.');
      voiceInputQueue.length = 0;
    });

    // 4. Voice services via SelfHealingManager
    const tServices = Date.now();
    const launchPythonServiceStaggered = (script: string, label: string, delayMs: number) => {
      console.log(`[Startup] Scheduling ${label} startup in ${delayMs}ms (${script}).`);
      const startService = () => {
        console.log(`[Startup] Launching ${label} (${script}).`);
        selfHealingManager.launchPythonService(script, label);
      };
      if (delayMs <= 0) {
        startService();
        return;
      }
      setTimeout(startService, delayMs).unref?.();
    };

    launchPythonServiceStaggered('tts.py', 'TTS', 0);
    launchPythonServiceStaggered('stt.py', 'STT', 0);
    launchPythonServiceStaggered('wakeWords.py', 'WakeWord', 500);
    launchPythonServiceStaggered('../vision/screen_capture.py', 'Vision', 5000);
    timings['Python Services Launch'] = Date.now() - tServices;

    // ── Voice Loop Part 1: Wake word → trigger STT listen ──────────────────
    let isSttListening = false;
    let pendingVoicePrefix: string | null = null;
    let pendingVoicePrefixExpiresAt = 0;
    const CONTINUATION_DURATION_SECONDS = 10;

    const activateWakeWordContinuation = (reason: string) => {
      console.warn(`[JARVIS] WakeWord continuation active (${reason}) for ${CONTINUATION_DURATION_SECONDS}s.`);
      nodeBridge.sendToRole('wakeword', {
        type: 'command',
        payload: { action: 'context_active', duration: CONTINUATION_DURATION_SECONDS },
      });
    };

    const rememberVoicePrefix = (partialCommand: string | undefined) => {
      const partial = normalizeVoiceInput(partialCommand ?? '');
      if (!shouldUseContinuationContext(partial)) return;
      pendingVoicePrefix = partial;
      pendingVoicePrefixExpiresAt = Date.now() + CONTINUATION_DURATION_SECONDS * 1000;
      console.log(`[JARVIS] Waiting for voice continuation after partial command: "${pendingVoicePrefix}"`);
      activateWakeWordContinuation('partial_command');
    };

    /**
     * Phase 4: accumulateContinuationFragment is used for multi-pause speech.
     * Each time a continuation fragment arrives, the expiry window resets from NOW.
     */
    const accumulateVoicePrefix = (fragment: string): void => {
      pendingVoicePrefix = accumulateContinuationFragment(pendingVoicePrefix, fragment);
      pendingVoicePrefixExpiresAt = Date.now() + CONTINUATION_DURATION_SECONDS * 1000;
      console.log(`[JARVIS] Accumulated continuation buffer: "${pendingVoicePrefix}" (expires in ${CONTINUATION_DURATION_SECONDS}s)`);
    };

    const applyPendingVoicePrefix = (text: string): string => {
      if (!pendingVoicePrefix) return text;
      if (Date.now() > pendingVoicePrefixExpiresAt) {
        console.log(`[JARVIS] Continuation prefix expired: "${pendingVoicePrefix}"`);
        pendingVoicePrefix = null;
        pendingVoicePrefixExpiresAt = 0;
        return text;
      }

      const merged = mergePendingVoiceContinuation(pendingVoicePrefix, text);
      if (merged !== text) {
        console.log(`[JARVIS] Merged voice continuation: "${pendingVoicePrefix}" + "${text}" -> "${merged}"`);
      }
      pendingVoicePrefix = null;
      pendingVoicePrefixExpiresAt = 0;
      return merged;
    };

    nodeBridge.on('client_ready', (msg) => {
      const role = (msg.payload as any)?.role;
      if (role === 'stt')      console.log('🔹 STT Ready!');
      else if (role === 'tts') console.log('🔹 TTS Ready!');
      else if (role === 'wakeword') console.log('🔹 WakeWord Ready!');
    });

    nodeBridge.onBridgeEvent('client_connected', (role: string) => {
      console.log(`[JARVIS] 🟢 Voice client connected: ${role} — refreshing dashboard...`);
      runtimeDashboard.refresh().catch(() => {});
    });

    nodeBridge.onBridgeEvent('stt_unavailable', (data: { reason?: string; pendingMs?: number }) => {
      const pendingMs = data?.pendingMs ?? 0;
      console.warn(`[JARVIS] STT unavailable while waiting for listen_start (${pendingMs}ms). Keeping WakeWord continuation enabled.`);
      sttJsLog('STT_UNAVAILABLE', '', data?.reason ?? 'listen_start_timeout');
      activateWakeWordContinuation('stt_unavailable');
    });

    nodeBridge.on('wake_word', async (msg) => {
      const detected    = (msg.payload as any)?.detected as boolean | undefined;
      const hasCommand  = (msg.payload as any)?.has_command as boolean | undefined;
      const partialCommand = (msg.payload as any)?.partial_command as string | undefined;

      if (detected) {
        console.log(`[NodeBridge] RX type=wake_word role=wakeword has_command=${hasCommand ?? false}`);
        if (!hasCommand) {
          rememberVoicePrefix(partialCommand);
        }

        // Phase 4: WakeWord is releasing mic; STT will take ownership
        releaseMic(MicOwner.WAKE_WORD, 'wake_word_detected');
        
        const cur = agentStateMachine.currentState;
        const isSpeaking = conversationBus.isSpeaking || cur === AgentState.SPEAKING;
        const BUSY_STATES: AgentState[] = [
          AgentState.PLANNING,
          AgentState.EXECUTING,
          AgentState.OBSERVING,
          AgentState.REFLECTING,
          AgentState.REPAIRING,
        ];

        if (isSpeaking || BUSY_STATES.includes(cur)) {
          console.log(`[JARVIS] Wake word accepted as barge-in/interrupt during state=${cur}`);
          // Stop TTS
          nodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });
          // Pause/clear WakeWord
          nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'clear' } });
          nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });
          // Clear voice queue
          voiceInputQueue.length = 0;

          // Transition to INTERRUPTED safely
          agentStateMachine.interrupt();

          if (!hasCommand) {
            isSttListening = true;
            takeMic(MicOwner.STT, 'interrupt_listen');
            try { agentStateMachine.transition(AgentState.LISTENING); } catch {}
            console.log('[JARVIS] Requesting STT listen_start after interrupt');
            const listenStarted = nodeBridge.sendListenStart();
            if (!listenStarted) {
              activateWakeWordContinuation('stt_not_ready_after_interrupt');
            }
          }
          return;
        }

        console.log('[JARVIS] 🗣️  Wake word detected — pausing WakeWord & signalling STT...');
        nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });

        if (!hasCommand) {
          // No inline command — ask STT to listen
          if (!isSttListening) {
            isSttListening = true;
            takeMic(MicOwner.STT, 'wake_no_command');
            try { agentStateMachine.transition(AgentState.LISTENING); } catch {}
            console.log('[JARVIS] Wake word detected; requesting STT listen_start');
            const listenStarted = nodeBridge.sendListenStart();
            if (!listenStarted) {
              activateWakeWordContinuation('stt_not_ready');
            }
          } else {
            console.log('[JARVIS] STT already listening, ignoring duplicate listen_start.');
          }
        }
        // If hasCommand=true, wakeWords.py already sent stt_result inline — no listen_start needed
      }
    });

    // ── Voice Loop Part 2: STT result → orchestrator → TTS ─────────────────
    nodeBridge.on('stt_result', async (msg) => {
      isSttListening = false;
      // Phase 4: STT is done — release mic ownership
      releaseMic(MicOwner.STT, 'stt_result_received');

      const rawText = (msg.payload as any).text as string | undefined;

      // Part B (JS side): log what arrived
      sttJsLog('STT_RECEIVED', rawText ?? '', rawText ? '' : 'empty payload');

      if (!rawText) {
        console.warn('[JARVIS] Received stt_result message with empty payload text.');
        sttJsLog('STT_DROPPED_EMPTY', '', 'stt_result arrived with no text');
        return;
      }

      // Voice Input Normalization (Requirement 2)
      let text = normalizeVoiceInput(rawText);
      text = applyPendingVoicePrefix(text);
      console.log(`[JARVIS] Normalized voice input: "${text}" (raw: "${rawText}")`);

      if (!text) {
        console.warn('[JARVIS] STT result normalized to empty string.');
        sttJsLog('STT_DROPPED_EMPTY_NORMALIZED', rawText, 'normalized to empty string');
        nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });
        return;
      }

      // Echo Suppression Check (Part E)
      if (isEcho(text, nodeBridge.lastTtsText)) {
        console.log(`[JARVIS] Echo detected and suppressed: "${text}" (last TTS was: "${nodeBridge.lastTtsText}")`);
        sttJsLog('ECHO_SUPPRESSED', text, `last TTS: ${nodeBridge.lastTtsText.slice(0, 60)}`);
        nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });
        return;
      }

      // Drop low-value fragment (under 2 words unless they match action verbs, stop triggers, or registered aliases)
      const cleanInput = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      const words = cleanInput.split(/\s+/).filter(Boolean);
      
      const actionVerbs = ['open', 'launch', 'start', 'close', 'kill', 'stop', 'exit', 'press', 'type', 'click', 'run', 'show', 'get', 'is', 'help', 'status', 'cancel', 'pause', 'resume', 'shutdown', 'focus', 'switch', 'list', 'what', 'move', 'copy', 'delete', 'rename'];
      const aliases = ['youtube', 'google', 'gmail', 'github', 'notepad', 'cmd', 'calculator', 'spotify', 'chrome', 'firefox', 'edge'];
      const simplePhrases = ['hello', 'hi', 'hey', 'how are you', 'thank you', 'thanks', 'good morning', 'good evening', 'good night', 'okay', 'ok', 'yes', 'no'];

      const isAction = words.some(w => actionVerbs.includes(w));
      const isAlias = words.some(w => aliases.includes(w));
      const isSimplePhrase = simplePhrases.includes(cleanInput);

      const isValidCommand = words.length >= 2 || isAction || isAlias || isSimplePhrase;

      if (!isValidCommand) {
        console.log(`[JARVIS] Dropped low-value fragment: "${text}"`);
        sttJsLog('STT_DROPPED_FRAGMENT', text, `words=${words.length}, no action verb/alias/phrase matched`);
        nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });
        return;
      }

      pipelineRegistry.recordSuccess('wake_to_stt');
      pipelineRegistry.recordSuccess('stt_to_brain');
      nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });

      const cur = agentStateMachine.currentState;
      const isSpeaking = conversationBus.isSpeaking || cur === AgentState.SPEAKING;

      if (isSpeaking) {
        console.log('[JARVIS] STT result received during SPEAKING. Treating as barge-in.');
        
        // Stop TTS
        nodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });
        // Pause/clear WakeWord
        nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'clear' } });
        nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });
        // Clear queue
        voiceInputQueue.length = 0;
        
        // Transition SPEAKING -> INTERRUPTED
        agentStateMachine.interrupt();
      }

      // Now the state is INTERRUPTED (or IDLE/LISTENING/etc. or busy)
      const nextState = agentStateMachine.currentState;

      // ── Busy-state arbitration ──────────────────────────────────────────────
      const BUSY_STATES: AgentState[] = [
        AgentState.PLANNING,
        AgentState.EXECUTING,
        AgentState.OBSERVING,
        AgentState.REFLECTING,
        AgentState.REPAIRING,
      ];

      if (BUSY_STATES.includes(nextState)) {
        // Check if this is a safe deterministic command (open YouTube, stop, etc.)
        const route = orchestrator.matchDeterministicCommand(text);

        if (route) {
          console.log(`[JARVIS] Voice input received during ${nextState}; using safe arbitration path.`);
          console.log(`[JARVIS] 🧠 Routing to Orchestrator (arbitrated): "${text}"`);
          orchestrator.process(text, 'voice').catch(err => {
            pipelineRegistry.recordFailure('stt_to_brain', String(err));
            console.error('[Voice] Arbitrated orchestrator error:', err);
          });
          return;
        }

        // max queue size should be 1. Replace the existing item.
        voiceInputQueue.length = 0;
        console.log(`[JARVIS] Queued voice input because assistant is busy (state=${nextState}): "${text}"`);
        voiceInputQueue.push({ text, timestamp: Date.now() });
        nodeBridge.speakToClients('One moment, sir. I will get to that right after this.');
        return;
      }

      // ── Normal path: safe states ────────────────────────────────────────────
      const PROCESSING_STT_ALLOWED: AgentState[] = [
        AgentState.IDLE,
        AgentState.LISTENING,
        AgentState.INTERRUPTED,
      ];
      if (PROCESSING_STT_ALLOWED.includes(nextState)) {
        if (nextState === AgentState.INTERRUPTED) {
          console.log('[JARVIS] 🔄 Seamless handoff: INTERRUPTED → PROCESSING_STT');
        }
        try {
          agentStateMachine.transition(AgentState.PROCESSING_STT);
        } catch { /* already in PROCESSING_STT — idempotent */ }
      }

      try {
        console.log(`[JARVIS] 🧠 Routing to Orchestrator: "${text}"`);
        await orchestrator.process(text, 'voice');
      } catch (err) {
        pipelineRegistry.recordFailure('stt_to_brain', String(err));
        selfHealingManager.reportError(err, 'brain');
        console.error('[Voice] Orchestrator execution error:', err);
      } finally {
        // Guarantee voice queue drains after execution regardless of error/success
        drainVoiceInputQueue();
      }
    });

    // ── Voice Loop Part 3: Interrupt Handling ──────────────────────────────
    nodeBridge.on('speech_detected' as any, () => {
      const curState = agentStateMachine.currentState;
      const isSpeaking = conversationBus.isSpeaking || agentStateMachine.is(AgentState.SPEAKING);

      if (isSpeaking) {
        console.log('[JARVIS] speech_detected accepted as barge-in during SPEAKING');
        // Stop TTS
        nodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });
        // Clear/pause WakeWord
        nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'clear' } });
        nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });
        // Clear queue
        voiceInputQueue.length = 0;

        agentStateMachine.interrupt();
      } else {
        console.log(`[JARVIS] speech_detected ignored because assistant is not speaking. state=${curState}`);
      }
    });

    // ── Voice Loop Part 4: Conversation Continuity ─────────────────────────
    conversationBus.on('idle', () => {
      if (!agentStateMachine.is(AgentState.IDLE)) {
        agentStateMachine.transition(AgentState.IDLE);
      }
      console.log('[JARVIS] ⏱️  Context active for follow-ups (15s)...');
      nodeBridge.sendToRole('wakeword', {
        type: 'command',
        payload: { action: 'context_active', duration: 15 },
      });
    });

    // ── Voice Loop Part 5: Echo Prevention ────────────────────────────────
    conversationBus.on('speaking:start', () => {
      const cur = agentStateMachine.currentState;
      const speakingAllowedFrom: AgentState[] = [
        AgentState.IDLE,
        AgentState.REFLECTING,
        AgentState.INTERRUPTED,
      ];
      if (cur !== AgentState.SPEAKING) {
        if (speakingAllowedFrom.includes(cur)) {
          agentStateMachine.transition(AgentState.SPEAKING);
        }
      }
      console.log('[JARVIS] 🔇 TTS Started — Pausing mic to prevent echo.');
      // Phase 4: Take mic ownership; prevent WakeWord from re-enabling during playback
      takeMic(MicOwner.WAKE_WORD, 'tts_speaking_pause'); // WAKE_WORD owns it but is paused
      nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });
    });

    conversationBus.on('speaking:end', () => {
      console.log('[JARVIS] 🔉 TTS Finished — Resuming mic.');
      // Phase 4: Release mic so WakeWord can take it back
      releaseMic(MicOwner.WAKE_WORD, 'tts_speaking_end');
      nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });
      takeMic(MicOwner.WAKE_WORD, 'wakeword_resume');
      drainVoiceInputQueue();
    });

    agentStateMachine.on('watchdog_reset', (data) => {
      console.log(`[JARVIS] Watchdog reset from ${data.fromState} (${data.reason}) — resuming mic & draining queue.`);
      nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });
      drainVoiceInputQueue();
    });

    agentStateMachine.on('state_changed', (state) => {
      if (state === AgentState.IDLE) {
        // Safety guard: ensure mic is resumed when system enters IDLE
        nodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });
        drainVoiceInputQueue();
      }
    });

    // 5. Health checks + watchdogs
    selfHealingManager.startHealthChecks();
    pipelineWatchdog.start();
    fsWatcher.start(__dirname);

    // 6. Backup reflection schedule (Python — every 30 min, idle-aware)
    //    The primary reflection is now inline in core/reflectionEngine.ts (runs every task).
    //    This remains as a periodic summary / long-term consolidation job.
    const REFLECTION_INTERVAL_MS = 30 * 60 * 1000;
    const reflectionScript = path.join(VOICE_DIR, 'reflectionEngine.py');

    function scheduleReflection() {
      setTimeout(async () => {
        if (!conversationBus.isIdle) {
          console.log('[Reflection] ⏸  Deferred — JARVIS is not idle. Retry in 30 min.');
        } else {
          console.log('[JARVIS] 🧘 Running periodic Python reflection cycle...');
          try {
            const result = await terminalTools.runPython(reflectionScript);
            if (!result.success) {
              console.warn('[JARVIS] Reflection engine exited with error:', result.stderr);
            }
          } catch (err) {
            console.warn('[JARVIS] Reflection engine failed:', err);
          }
        }
        // DISABLED: scheduleReflection();
      }, REFLECTION_INTERVAL_MS);
    }

    // DISABLED: scheduleReflection();

    const totalStartupTime = Date.now() - startTime;

    console.log('==================================================');
    console.log('⚙️  JARVIS STARTUP TIMING SUMMARY');
    for (const [name, ms] of Object.entries(timings)) {
      console.log(`   - ${name.padEnd(28)}: ${ms}ms`);
    }
    console.log(`   - Total Core Bootstrap Time  : ${totalStartupTime}ms`);
    console.log('==================================================');

    // Defer non-critical health probe to background
    setImmediate(() => {
      healthManager.probe().then(snapshot => {
        console.log(`[HealthProbe] System Initial Status: ${snapshot.overallStatus.toUpperCase()}`);
      }).catch(() => {});
    });

    console.log('===================================');
    console.log('✅ JARVIS v2 IS NOW ONLINE');
    console.log('   Orchestration Kernel: ACTIVE');
    console.log('   Task Graph Engine:    ACTIVE');
    console.log('   Reflection Engine:    ACTIVE');
    console.log('   Agent Memory:         ACTIVE');
    console.log('===================================');

    nodeBridge.speakToClients('JARVIS version 2 is online, sir. Autonomous systems are fully operational.');

    startCLI();

  } catch (err) {
    console.error('❌ JARVIS FAILED TO START:', err);
    process.exit(1);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function startCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      await shutdown();
      return;
    }

    if (input.toLowerCase() === 'status') {
      const engines = selfHealingManager.getEngineStatus();
      console.log(`[JARVIS] State: ${agentStateMachine.currentState}`);
      console.log(`[JARVIS] Engines — TTS: ${engines.tts} | STT: ${engines.stt}`);
      console.log(`[JARVIS] State history:`, agentStateMachine.getStats());
      console.log(pipelineRegistry.getHealth());
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === 'memory') {
      const { agentMemory } = await import('./memory/agentMemory.js');
      console.log('[JARVIS] Memory stats:', JSON.stringify(agentMemory.getStats(), null, 2));
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === 'tools') {
      const { toolRegistryV2 } = await import('./core/toolRegistryV2.js');
      console.log('[JARVIS] Registered tools:', toolRegistryV2.names().join(', '));
      rl.prompt();
      return;
    }

    try {
      // ✅ NEW: route through orchestrator
      await orchestrator.process(input, 'cli');
    } catch (err) {
      selfHealingManager.reportError(err, 'brain:cli');
      console.error('[CLI] Orchestrator execution failed:', err);
    }

    rl.prompt();

  }).on('close', async () => {
    await shutdown();
  });
}

// NEW: shutdown hook — double-call guard
let isShuttingDown = false;

async function shutdown(signal = 'manual') {
  if (isShuttingDown) return;   // Prevent double-shutdown
  isShuttingDown = true;

  console.log(`\n[JARVIS] 🛑 Shutdown initiated (${signal})...`);

  // 1. Persist critical state
  try {
    console.log('[JARVIS] 💾 Persisting memory...');
    await memoryManager.flush();
  } catch (err) {
    console.error('[JARVIS] ⚠️  Memory flush failed:', err);
  }

  try {
    // Fail any in-progress goals so they don't stay stale
    const activeGoals = goalManager.getActiveGoals();
    for (const goal of activeGoals) {
      console.log(`[JARVIS] 💾 Saving goal "${goal.id}" as paused...`);
      await goalManager.updateGoalStatus(goal.id, 'paused');
    }
    console.log(`[JARVIS] ✅ ${activeGoals.length} goal(s) saved.`);
  } catch (err) {
    console.error('[JARVIS] ⚠️  Goal persistence failed:', err);
  }

  // 2. Stop subsystems (non-throwing)
  try { systemStateObserver.stop(); } catch {}
  try { selfHealingManager.stopHealthChecks(); } catch {}
  try { pipelineWatchdog.stop(); } catch {}
  try { fsWatcher.stop(); } catch {}
  try { brainLoop.stop(); } catch {}
  try { conversationBus.shutdown(); } catch {}
  try { nodeBridge.stop(); } catch {}

  console.log('[JARVIS] 👋 JARVIS shut down cleanly. Goodbye, sir.');
  process.exit(0);
}

// NEW: Wire process signals for graceful shutdown
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startJarvis();
