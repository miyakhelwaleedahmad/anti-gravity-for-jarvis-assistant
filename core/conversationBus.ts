/**
 * core/conversationBus.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Singleton event bus that tracks whether JARVIS is actively in a conversation
 * or currently speaking. All autonomous subsystems (self-heal, watchdog,
 * reflection, fsWatcher) MUST check conversationBus.isIdle before acting.
 *
 * Phase 1 — Core Runtime Stability hardening:
 *   - MaxListeners cap raised and dynamically adjusted.
 *   - Automatic listener cleanup via disposable subscriptions.
 *   - Leak detection: periodic audit of listener counts per event.
 *   - Listener statistics API for diagnostics.
 *   - Scoped subscriptions: `subscribe()` returns a disposer function.
 *   - Coalesced `once('idle')` — prevents repeated registrations from fsWatcher.
 *
 * Events emitted:
 *   "conversation:start"  — user input received, brain processing
 *   "conversation:end"    — brain done, TTS queued or skipped
 *   "speaking:start"      — TTS playback began (signal from tts.py via bridge)
 *   "speaking:end"        — TTS playback finished (signal from tts.py via bridge)
 *   "idle"                — both conversation and speaking ended
 */

import { EventEmitter } from "events";
import { agentStateMachine } from "./agentStateMachine.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A disposer function returned by subscribe(). Calling it removes the listener. */
export type Unsubscribe = () => void;

/** Snapshot of listener counts per event, for diagnostics / dashboard. */
export interface ListenerStats {
  /** Total listeners across all events. */
  total: number;
  /** Listener count keyed by event name. */
  byEvent: Record<string, number>;
  /** Peak total listener count since last reset. */
  peakTotal: number;
  /** Number of leaked once-listeners cleaned up by the auditor. */
  leakedOnceCleanups: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Known events emitted by ConversationBus. */
const KNOWN_EVENTS = [
  "conversation:start",
  "conversation:end",
  "speaking:start",
  "speaking:end",
  "idle",
] as const;

/**
 * Soft limit per event. If a single event has more listeners than this,
 * the leak auditor will log a warning. This is NOT the Node.js
 * maxListeners cap (which is set higher to avoid false positives).
 */
const SOFT_LISTENER_LIMIT_PER_EVENT = 8;

/**
 * Leak audit interval (ms). Every this many ms, we scan listener counts
 * and warn if any event exceeds the soft limit.
 */
const LEAK_AUDIT_INTERVAL_MS = 60_000;

// ─── ConversationBus ──────────────────────────────────────────────────────────

class ConversationBus extends EventEmitter {
  private _isActive   = false;  // true while brain is processing a user request
  private _isSpeaking = false;  // true while TTS is playing back audio

  // ── Speaking timeout guard ────────────────────────────────────────────────
  // Auto-reset isSpeaking after timeout if speaking_end never arrives
  // (e.g. TTS client disconnects mid-playback).
  // The time allowed is the state machine's SPEAKING allowance: 12 s by
  // default, longer for the speech actually queued. A fixed 12 s ended
  // "speaking" while JARVIS was still talking on the owner's PC, so the mic
  // reopened and JARVIS heard itself.
  private _speakingTimer: ReturnType<typeof setTimeout> | null = null;
  private _speakingGuardMs = 0;

  // ── Leak detection state ──────────────────────────────────────────────────
  private _leakAuditTimer: ReturnType<typeof setInterval> | null = null;
  private _peakListenerCount = 0;
  private _leakedOnceCleanups = 0;

  // ── Coalesced idle listeners ──────────────────────────────────────────────
  // Multiple subsystems (fsWatcher, etc.) register once('idle') listeners
  // every time they need to defer work. Without coalescing, rapid file saves
  // can stack dozens of once-listeners. We track pending once-idle callbacks
  // and deduplicate them by reference.
  private _pendingOnceIdle: Set<(...args: any[]) => void> = new Set();

  // ── Managed subscriptions ────────────────────────────────────────────────
  // Every subscribe() / subscribeOnce() call pushes a cleanup entry here.
  // disposeAll() tears them all down at shutdown or test cleanup.
  private _managedDisposers: Set<Unsubscribe> = new Set();

  constructor() {
    super();
    // Raise the Node.js cap well above any realistic listener count.
    // We rely on the soft-limit auditor for leak warnings instead.
    this.setMaxListeners(50);

    // Start the periodic leak auditor.
    this._startLeakAudit();
  }

  // ── Public state getters ──────────────────────────────────────────────────

  /** True if brain is currently processing a user request */
  get isActive(): boolean  { return this._isActive; }

  /** True if TTS audio is currently playing */
  get isSpeaking(): boolean { return this._isSpeaking; }

  /**
   * True ONLY when neither a conversation nor speech is in progress.
   * Autonomous subsystems should only act when this is true.
   */
  get isIdle(): boolean { return !this._isActive && !this._isSpeaking; }

  // ── Conversation lifecycle ─────────────────────────────────────────────────

  /** Call at the start of every user interaction (voice or CLI). */
  conversationStarted(): void {
    this._isActive = true;
    this.emit("conversation:start");
    console.log("[ConvBus] 🟢 Conversation started — autonomous tasks paused.");
  }

  /** Call after brain is done and TTS has been dispatched. */
  conversationEnded(): void {
    this._isActive = false;
    this.emit("conversation:end");
    if (this.isIdle) {
      console.log("[ConvBus] 💤 JARVIS idle — autonomous tasks may resume.");
      this._emitIdle();
    }
  }

  // ── Speaking lifecycle (driven by tts.py signals via nodeBridge) ──────────

  /** Call when TTS playback starts. */
  speakingStarted(): void {
    this._isSpeaking = true;
    this.emit("speaking:start");
    console.log("[ConvBus] 🔊 Speaking started.");

    // Auto-reset isSpeaking after timeout in case speaking_end never fires
    this._armSpeakingGuard();
  }

  /** More speech was queued: while speaking, stretch the guard to cover it. */
  noteSpeechQueued(): void {
    if (this._isSpeaking) this._armSpeakingGuard();
  }

  /** The time the speaking guard was last given, in ms (0 before the first). */
  get speakingGuardMs(): number { return this._speakingGuardMs; }

  private _armSpeakingGuard(): void {
    if (this._speakingTimer) clearTimeout(this._speakingTimer);
    const ms = agentStateMachine.speakingWatchdogMs();
    this._speakingGuardMs = ms;
    this._speakingTimer = setTimeout(() => {
      if (this._isSpeaking) {
        console.warn(
          `[ConvBus] ⚠️ Speaking timeout (${ms}ms) — ` +
          `auto-resetting isSpeaking. TTS speaking_end was never received.`
        );
        this.speakingEnded();
      }
    }, ms);
  }

  /** Call when TTS playback ends. */
  speakingEnded(): void {
    this._isSpeaking = false;
    // Cancel pending auto-reset timer
    if (this._speakingTimer) {
      clearTimeout(this._speakingTimer);
      this._speakingTimer = null;
    }
    this.emit("speaking:end");
    if (this.isIdle) {
      console.log("[ConvBus] 💤 JARVIS idle — autonomous tasks may resume.");
      this._emitIdle();
    }
  }

  // ── Subscription management ───────────────────────────────────────────────

  /**
   * Subscribe to an event. Returns an unsubscribe function (disposer).
   * The listener is automatically tracked and can be cleaned up via
   * `disposeAll()` or by calling the returned disposer.
   *
   * Prefer this over raw `.on()` for any non-permanent listener.
   */
  subscribe(event: string, listener: (...args: any[]) => void): Unsubscribe {
    this.on(event, listener);

    let disposed = false;
    const disposer: Unsubscribe = () => {
      if (disposed) return; // idempotent
      disposed = true;
      this.off(event, listener);
      this._managedDisposers.delete(disposer);
    };

    this._managedDisposers.add(disposer);
    return disposer;
  }

  /**
   * Subscribe to an event for a single firing. Returns an unsubscribe function.
   * The listener self-disposes after firing, or can be cancelled early via
   * the returned disposer.
   */
  subscribeOnce(event: string, listener: (...args: any[]) => void): Unsubscribe {
    let disposed = false;

    const wrappedListener = (...args: any[]) => {
      if (disposed) return;
      disposed = true;
      this._managedDisposers.delete(disposer);
      listener(...args);
    };

    this.once(event, wrappedListener);

    const disposer: Unsubscribe = () => {
      if (disposed) return;
      disposed = true;
      this.off(event, wrappedListener);
      this._managedDisposers.delete(disposer);
    };

    this._managedDisposers.add(disposer);
    return disposer;
  }

  /**
   * Coalesced once-idle registration. Multiple callers can register the
   * SAME callback reference and only one listener will be active.
   * This prevents listener stacking from repeated deferred work
   * (e.g. fsWatcher deferring file changes).
   *
   * Returns an unsubscribe function.
   */
  onceIdle(callback: (...args: any[]) => void): Unsubscribe {
    if (this._pendingOnceIdle.has(callback)) {
      // Already registered — return a no-op disposer.
      return () => {};
    }

    this._pendingOnceIdle.add(callback);

    const wrappedCallback = (...args: any[]) => {
      this._pendingOnceIdle.delete(callback);
      callback(...args);
    };

    return this.subscribeOnce("idle", wrappedCallback);
  }

  /**
   * Remove ALL managed subscriptions at once.
   * Call this at shutdown or during test teardown.
   */
  disposeAll(): void {
    // Copy the set because each disposer mutates it.
    const disposers = [...this._managedDisposers];
    for (const dispose of disposers) {
      try { dispose(); } catch { /* never throw during cleanup */ }
    }
    this._managedDisposers.clear();
    this._pendingOnceIdle.clear();
    console.log(`[ConvBus] 🧹 disposeAll() — cleaned up ${disposers.length} managed listener(s).`);
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /**
   * Returns a snapshot of current listener statistics.
   */
  getListenerStats(): ListenerStats {
    const eventNames = this.eventNames() as string[];
    const byEvent: Record<string, number> = {};
    let total = 0;

    for (const name of eventNames) {
      const count = this.listenerCount(name);
      byEvent[String(name)] = count;
      total += count;
    }

    // Track peak
    if (total > this._peakListenerCount) {
      this._peakListenerCount = total;
    }

    return {
      total,
      byEvent,
      peakTotal: this._peakListenerCount,
      leakedOnceCleanups: this._leakedOnceCleanups,
    };
  }

  /**
   * Reset peak statistics (e.g. after a dashboard snapshot).
   */
  resetPeakStats(): void {
    this._peakListenerCount = 0;
    this._leakedOnceCleanups = 0;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Emit "idle" and drain any coalesced once-idle callbacks.
   */
  private _emitIdle(): void {
    this.emit("idle");
  }

  /**
   * Periodic leak auditor. Scans every event and warns if any exceeds
   * the soft listener limit. Also cleans up clearly leaked once-listeners
   * on events that should not have persistent listeners.
   */
  private _startLeakAudit(): void {
    this._leakAuditTimer = setInterval(() => {
      const eventNames = this.eventNames() as string[];
      let totalListeners = 0;

      for (const name of eventNames) {
        const count = this.listenerCount(name);
        totalListeners += count;

        if (count > SOFT_LISTENER_LIMIT_PER_EVENT) {
          console.warn(
            `[ConvBus] ⚠️ LEAK DETECTED: Event "${String(name)}" has ${count} listeners ` +
            `(soft limit: ${SOFT_LISTENER_LIMIT_PER_EVENT}). ` +
            `This may indicate a listener leak.`
          );
        }
      }

      // Track peak
      if (totalListeners > this._peakListenerCount) {
        this._peakListenerCount = totalListeners;
      }
    }, LEAK_AUDIT_INTERVAL_MS);

    // Don't prevent Node.js from exiting when only this timer is left.
    if (this._leakAuditTimer && typeof this._leakAuditTimer === 'object' && 'unref' in this._leakAuditTimer) {
      this._leakAuditTimer.unref();
    }
  }

  /**
   * Stop the leak auditor. Call during shutdown.
   */
  stopLeakAudit(): void {
    if (this._leakAuditTimer) {
      clearInterval(this._leakAuditTimer);
      this._leakAuditTimer = null;
    }
  }

  /**
   * Full cleanup — stop auditor, dispose all listeners, clear timers.
   */
  shutdown(): void {
    this.stopLeakAudit();
    this.disposeAll();
    if (this._speakingTimer) {
      clearTimeout(this._speakingTimer);
      this._speakingTimer = null;
    }
    this.removeAllListeners();
    console.log("[ConvBus] 🛑 ConversationBus shut down.");
  }
}

export const conversationBus = new ConversationBus();
