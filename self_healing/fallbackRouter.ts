/**
 * fallbackRouter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Maintains the active engine selections for TTS and STT, and provides
 * ordered fallback chains so the system never fully loses voice capability.
 */

import { EventEmitter } from "events";

// ─── Engine enums ─────────────────────────────────────────────────────────────

export type TTSEngine  = "edge_tts" | "pyttsx3" | "system";
export type STTEngine  = "whisper"  | "speech_recognition" | "offline";

// ─── Engine metadata ──────────────────────────────────────────────────────────

export interface EngineInfo {
  name: string;
  available: boolean;
  lastFailedAt?: Date;
}

// ─── Fallback Router ──────────────────────────────────────────────────────────

export class FallbackRouter extends EventEmitter {
  private static instance: FallbackRouter;

  // Ordered chains — first element is preferred
  private ttsChain: TTSEngine[]  = ["edge_tts", "pyttsx3", "system"];
  private sttChain: STTEngine[]  = ["whisper", "speech_recognition", "offline"];

  private disabledTTS = new Set<TTSEngine>();
  private disabledSTT = new Set<STTEngine>();

  private activeTTS: TTSEngine = "edge_tts";
  private activeSTT: STTEngine = "whisper";

  private constructor() {
    super();
  }

  static getInstance(): FallbackRouter {
    if (!FallbackRouter.instance) {
      FallbackRouter.instance = new FallbackRouter();
    }
    return FallbackRouter.instance;
  }

  // ── TTS ───────────────────────────────────────────────────────────────────

  getTTSEngine(): TTSEngine {
    return this.activeTTS;
  }

  markTTSFailed(engine: TTSEngine): TTSEngine | null {
    this.disabledTTS.add(engine);
    const next = this.ttsChain.find((e) => !this.disabledTTS.has(e)) ?? null;

    if (next) {
      console.warn(`[FallbackRouter] TTS engine "${engine}" failed. Switching to "${next}".`);
      this.activeTTS = next;
      this.emit("tts_engine_changed", next);
    } else {
      console.error("[FallbackRouter] All TTS engines exhausted. Voice output disabled.");
      this.emit("tts_exhausted");
    }

    return next;
  }

  resetTTS(): void {
    this.disabledTTS.clear();
    this.activeTTS = "edge_tts";
    console.log("[FallbackRouter] TTS chain reset to primary engine.");
  }

  // ── STT ───────────────────────────────────────────────────────────────────

  getSTTEngine(): STTEngine {
    return this.activeSTT;
  }

  markSTTFailed(engine: STTEngine): STTEngine | null {
    this.disabledSTT.add(engine);
    const next = this.sttChain.find((e) => !this.disabledSTT.has(e)) ?? null;

    if (next) {
      console.warn(`[FallbackRouter] STT engine "${engine}" failed. Switching to "${next}".`);
      this.activeSTT = next;
      this.emit("stt_engine_changed", next);
    } else {
      console.error("[FallbackRouter] All STT engines exhausted. Voice input disabled.");
      this.emit("stt_exhausted");
    }

    return next;
  }

  resetSTT(): void {
    this.disabledSTT.clear();
    this.activeSTT = "whisper";
    console.log("[FallbackRouter] STT chain reset to primary engine.");
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getStatus(): { tts: TTSEngine; stt: STTEngine } {
    return { tts: this.activeTTS, stt: this.activeSTT };
  }
}

export const fallbackRouter = FallbackRouter.getInstance();
