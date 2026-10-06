import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "events";
import { pythonBridgeConfig } from "../config/llmconfig.js";
import { failureDetector } from "../self_healing/failureDetector.js";
import { pipelineRegistry } from "../self_healing/pipelineRegistry.js";
import { conversationBus } from "../core/conversationBus.js";
import { systemController } from "../core/stateShim.js";
import { agentStateMachine } from "../core/agentStateMachine.js";
import http from "http";

const LOCALHOST_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const BRIDGE_DEV_MODE = process.env.JARVIS_BRIDGE_DEV_MODE === "true";
const BRIDGE_TOKEN = process.env.JARVIS_BRIDGE_TOKEN ?? "";
const DEBUG_LOGS = process.env.LOG_LEVEL?.toLowerCase() === "debug";
const STT_READY_TIMEOUT_MS = Number.parseInt(process.env.JARVIS_STT_READY_TIMEOUT_MS ?? "5000", 10);

/** Phase 4: Maximum pending TTS phrases while TTS client is not ready.
 *  Drops the middle item (keep head + tail) to avoid stale queue buildup. */
const MAX_PENDING_TTS = 3;

export function getBridgeAuthStatus(): { requiresToken: boolean; devMode: boolean; tokenConfigured: boolean } {
  const isDev = (process.env.JARVIS_BRIDGE_DEV_MODE ?? "false").toLowerCase() === "true";
  const token = process.env.JARVIS_BRIDGE_TOKEN ?? BRIDGE_TOKEN;
  return {
    requiresToken: !isDev,
    devMode: isDev,
    tokenConfigured: token.length > 0,
  };
}

export function isBridgeTokenValid(token: unknown): boolean {
  const isDev = (process.env.JARVIS_BRIDGE_DEV_MODE ?? "false").toLowerCase() === "true";
  if (isDev) return true;
  const validToken = process.env.JARVIS_BRIDGE_TOKEN ?? BRIDGE_TOKEN;
  return typeof token === "string" && token.length > 0 && token === validToken;
}




// ─── Types ────────────────────────────────────────────────────────────────────

export interface VisionFrameData {
  data: string;
  width: number;
  height: number;
  active_window: string;
  ocr_text: string;
}

export interface BridgeMessage {
  type: "tts" | "stt_result" | "wake_word" | "command" | "response" | "error" | "status" | "client_ready" | "hardware_error" | "speaking_start" | "speaking_end" | "listen_start" | "vision_frame" | "vision_start" | "vision_stop";
  payload: any;
  id?: string;
}

type MessageHandler = (msg: BridgeMessage, ws: WebSocket) => void | Promise<void>;
type BridgeEvent = "client_connected" | "stt_text" | "stt_unavailable" | "speaking_start" | "speaking_end";

interface QueuedCommand {
  message: object;
  timestamp: number;
}

// ─── Node Bridge (WebSocket Server) ──────────────────────────────────────────

export class NodeBridge {
  public lastTtsText: string = "";
  public lastTtsTimestamp: number = 0;  // when last TTS was sent (for echo filter expiry)
  /** Phase 4: when TTS playback actually started (speaking_start from tts.py) */
  public ttsStartedMs: number = 0;
  /** When TTS playback finished (speaking_end) — the echo window runs from here. */
  public ttsEndedMs: number = 0;

  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private authenticatedClients: Set<WebSocket> = new Set();
  private readyClients: Map<string, WebSocket> = new Map();
  private clientRoles: Map<WebSocket, string> = new Map();
  private commandQueue: Map<string, QueuedCommand[]> = new Map();
  private pendingListen: boolean = false;
  private pendingListenStart: boolean = false;
  private pendingListenStartedAt: number | null = null;
  private pendingListenWarningTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTTS: string[] = [];
  /** Phase 4: last TTS text sent — prevents enqueueing identical adjacent phrases */
  private _lastQueuedTts: string = "";

  // Bridge-level event emitter for internal events (client_connected, etc.)
  // Kept separate from the message-handler Map to avoid TypeScript conflicts.
  private readonly _bridgeEvents = new EventEmitter();

  // Commands expire after 30 seconds
  private readonly COMMAND_TTL_MS = 30000;

  private latestScreenFrame: VisionFrameData | null = null;
  private lastFrameTimestamp: number = 0;

  // Internal message-handler registry (separate from EventEmitter.on)
  private handlers: Map<string, MessageHandler[]> = new Map();

  constructor() {
    // NodeBridge does not extend any class; _bridgeEvents provides internal events.
  }

  getLatestScreenFrame(): VisionFrameData | null {
    // Consider frame outdated if older than 10 seconds
    if (Date.now() - this.lastFrameTimestamp > 10000) {
      return null;
    }
    return this.latestScreenFrame;
  }

  getReadyClients(): string[] {
    return Array.from(this.readyClients.keys());
  }

  isRoleReady(role: string): boolean {
    const client = this.readyClients.get(role);
    return !!client && client.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (this.wss) {
      console.log('[NodeBridge] start() ignored — already started on existing singleton');
      return;
    }

    if (!LOCALHOST_HOSTS.has(pythonBridgeConfig.host)) {
      throw new Error(`[NodeBridge] Refusing to bind WebSocket bridge to non-localhost host: ${pythonBridgeConfig.host}`);
    }

    if (!BRIDGE_TOKEN && !BRIDGE_DEV_MODE) {
      throw new Error('[NodeBridge] JARVIS_BRIDGE_TOKEN is required. Set it in .env, or explicitly set JARVIS_BRIDGE_DEV_MODE=true for local insecure development.');
    }

    this.wss = new WebSocketServer({
      host: pythonBridgeConfig.host,
      port: pythonBridgeConfig.port,
    });

    const authStatus = BRIDGE_DEV_MODE ? "INSECURE DEV MODE (no token)" : "TOKEN PROTECTED (production)";
    console.log(
      `[NodeBridge] WebSocket server started on ws://${pythonBridgeConfig.host}:${pythonBridgeConfig.port} (Auth Mode: ${authStatus})`
    );

    // PART B-5: Add health status endpoint
    const healthPort = parseInt(process.env.HEALTH_PORT || "9001", 10);
    const healthServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pipelineRegistry.getHealth(), null, 2));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    
    healthServer.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`[NodeBridge] ⚠️  Health port ${healthPort} is already in use. Skipping health server startup.`);
      } else {
        console.error(`[NodeBridge] Health server error:`, err);
      }
    });

    healthServer.listen(healthPort, pythonBridgeConfig.host, () => {
      console.log(`[NodeBridge] Health endpoint started on http://${pythonBridgeConfig.host}:${healthPort}/health`);
    });

    // Internal handler: client_ready handshake
    this.on("client_ready", (msg, ws) => {
      // ✅ FIX: Support role in both msg.role and msg.payload.role
      const role = (msg.payload?.role as string | undefined)
        ?? ((msg as any).role as string | undefined)
        ?? "unknown";

      console.log(`[NodeBridge] RX type=client_ready role=${role}`);

      if (!this.authenticatedClients.has(ws)) {
        console.warn(`[NodeBridge] Rejected unauthenticated client_ready for role=${role}`);
        try {
          ws.close(1008, "Authentication required");
        } catch {}
        return;
      }

      // Validate the role
      if (!["stt", "tts", "wakeword", "vision"].includes(role)) {
        console.warn(`[NodeBridge] ⚠️ WARNING: Unknown client role attempting ready handshake: ${role}`);
      }

      this.clientRoles.set(ws, role);

      // Remove stale entry if client reconnected
      this.readyClients.delete(role);

      // Register the new connection
      this.readyClients.set(role, ws);
      console.log(`[NodeBridge] ✅ READY client registered: ${role}`);
      console.log(`[NodeBridge] 📋 Ready clients: ${[...this.readyClients.keys()].join(", ")}`);

      // ✅ Sync pipelineRegistry so dashboard shows connected immediately
      if (role === "wakeword") {
        pipelineRegistry.recordSuccess("wake_to_stt");
      } else if (role === "stt") {
        pipelineRegistry.recordSuccess("wake_to_stt");
        pipelineRegistry.recordSuccess("stt_to_brain");
      } else if (role === "tts") {
        pipelineRegistry.recordSuccess("brain_to_tts");
      }

      // Emit bridge-level event so jarvis.ts can refresh dashboard immediately
      this._bridgeEvents.emit('client_connected', role);

      // ✅ FIX: Flush queued TTS to the first TTS client that signals ready
      if ((role === "tts" || role === "all") && this.pendingTTS.length > 0) {
        console.log(`[NodeBridge] Flushing ${this.pendingTTS.length} queued TTS message(s).`);
        const flush = [...this.pendingTTS];
        this.pendingTTS = [];
        for (const text of flush) {
          this.send(ws, { type: "tts", payload: { text } });
        }
      }

      // ✅ FIX: Flush queued listen_start to STT when it becomes ready
      if ((role === "stt" || role === "all") && this.pendingListenStart) {
        this.pendingListenStart = false;
        this.pendingListenStartedAt = null;
        this.clearPendingListenWarning();
        console.log(`[NodeBridge] STT ready; flushing queued listen_start`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "listen_start" }));
        }
      }

      // Drain queued commands for this role
      const now = Date.now();
      const queued = this.commandQueue.get(role) ?? [];
      const validQueued = queued.filter(cmd => (now - cmd.timestamp) <= this.COMMAND_TTL_MS);

      if (validQueued.length > 0) {
        console.log(`[NodeBridge] 📤 Draining ${validQueued.length} queued command(s) for: ${role}`);
        for (const cmd of validQueued) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(cmd.message));
          }
        }
      }
      this.commandQueue.delete(role);

      // Legacy listen flush (action: listen)
      if ((role === "stt" || role === "all") && this.pendingListen) {
        console.log(`[NodeBridge] Flushing pending listen command to STT.`);
        this.pendingListen = false;
        this.send(ws, { type: "command", payload: { action: "listen" } });
      }
    });

    // CRIT-4: Hardware error from Python voice module
    this.on("hardware_error", (msg) => {
      const device = msg.payload?.device as string | undefined;
      console.error(`[NodeBridge] ⚠️  Hardware error reported by: ${device ?? "unknown"}`);
    });

    this.wss.on("connection", (ws, req) => {
      const clientId = Date.now().toString() + Math.random().toString(36).substring(7);
      (ws as any).clientId = clientId;
      
      const ip = req.socket.remoteAddress ?? "unknown";
      console.log(`[NodeBridge] Client ${clientId} connected from ${ip} (awaiting READY)`);
      this.clients.add(ws);

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as BridgeMessage;
          if (!this.authenticatedClients.has(ws)) {
            const token = msg.payload?.token ?? (msg as any).token;
            if (msg.type !== "client_ready" || !isBridgeTokenValid(token)) {
              console.warn(`[NodeBridge] Rejecting unauthenticated client message type=${msg.type}`);
              try {
                ws.send(JSON.stringify({ type: "error", payload: { error: "Authentication required" } }));
              } catch {}
              ws.close(1008, "Authentication required");
              return;
            }
            this.authenticatedClients.add(ws);
          }

          if (DEBUG_LOGS && msg.type !== "client_ready") {
            console.log(`[NodeBridge] ← [${msg.type}]`);
          }

          // CONV-GUARD: Update speaking state from tts.py playback signals
          if (msg.type === "speaking_start") {
            this.handleSpeakingLifecycleSignal("speaking_start", msg.payload);
            return;
          }
          if (msg.type === "speaking_end") {
            this.handleSpeakingLifecycleSignal("speaking_end", msg.payload);
            return;
          }

          if (msg.type === "wake_word") {
            console.log(`[NodeBridge] 🔍 Ready clients at wake word: ${[...this.readyClients.keys()].join(", ") || "NONE"}`);
          }

          // ✅ FIXED: Missing ACK System handling
          if (msg.type === ("ack" as any) && msg.id) {
            const pending = (this as any).pendingAcks?.get(msg.id);
            if (pending) {
              clearTimeout(pending.timeout);
              pending.resolve();
              (this as any).pendingAcks.delete(msg.id);
            }
            return;
          }

          if (msg.type === "stt_result" && msg.payload?.text) {
            const text = msg.payload.text;
            const role = this.clientRoles.get(ws) || "unknown";
            if (DEBUG_LOGS) {
              console.log(`[NodeBridge] RX type=stt_result role=${role} text="${text}"`);
              console.log(`[NodeBridge] Forwarding STT result to orchestrator.process(...)`);
            }
            this._bridgeEvents.emit("stt_text", text);
          }

          if (msg.type === "vision_frame") {
            // ✅ FIXED: Throttle vision frames to prevent memory overflow (max 1 frame per sec)
            const now = Date.now();
            if (now - this.lastFrameTimestamp < 1000) {
              return; // Ignore frames if received too fast
            }
            this.latestScreenFrame = msg.payload as VisionFrameData;
            this.lastFrameTimestamp = now;
            pipelineRegistry.recordSuccess("vision_to_bridge");
            console.log(`[NodeBridge] 👁️ Vision frame stored (size: ${msg.payload?.data?.length || 0} bytes)`);
            return;
          }

          const typeHandlers = this.handlers.get(msg.type);
          if (typeHandlers && typeHandlers.length > 0) {
            for (const handler of typeHandlers) {
              await handler(msg, ws);
            }
          } else {
            console.warn(`[NodeBridge] No handler for type: ${msg.type}`);
          }
        } catch (err) {
          failureDetector.reportWebSocketFailure(err, "message-handler");
          console.error("[NodeBridge] Message handling error:", err);
        }
      });

      ws.on("close", () => {
        const role = this.clientRoles.get(ws);
        this.clients.delete(ws);
        this.authenticatedClients.delete(ws);
        
        // ✅ FIXED: Phantom Client Bug - Match by exact socket identity and clientId
        for (const [r, client] of this.readyClients.entries()) {
          if (client === ws || (client as any).clientId === (ws as any).clientId) {
            this.readyClients.delete(r);
            console.log(`[NodeBridge] ⚠️ Client disconnected and removed: ${r} (${(ws as any).clientId})`);
            break;
          }
        }
        
        this.clientRoles.delete(ws);
        console.log(`[NodeBridge] Client disconnected (role: ${role ?? "unknown"}).`);
      });

      ws.on("error", (err) => {
        const role = this.clientRoles.get(ws);
        failureDetector.reportWebSocketFailure(err, "client-socket");
        this.clients.delete(ws);
        this.authenticatedClients.delete(ws);

        for (const [r, client] of this.readyClients.entries()) {
          if (client === ws) {
            this.readyClients.delete(r);
            console.log(`[NodeBridge] ⚠️ Client error and removed: ${r}`);
            break;
          }
        }

        this.clientRoles.delete(ws);
      });

      // Handshake: tell client it's connected; it must reply with client_ready
      this.send(ws, {
        type: "status",
        payload: { status: "connected", server: "Jarvis NodeBridge" },
      });
    });

    this.wss.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[NodeBridge] ⚠️ WARNING: Port ${pythonBridgeConfig.port} is already in use! WebSocket server failed to bind.`);
        console.error(`[NodeBridge] ⚠️ FIX: Run: Get-Process node,python | Stop-Process -Force  then restart.`);
        // ✅ CRITICAL FIX: Reset wss to null so start() idempotency guard
        // does not permanently block a retry after the old process is killed.
        this.wss = null;
      } else {
        failureDetector.reportWebSocketFailure(err, "server");
        console.error("[NodeBridge] Server error:", err);
      }
    });
  }

  on(type: BridgeMessage["type"], handler: MessageHandler): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  onBridgeEvent(event: BridgeEvent, handler: (...args: any[]) => void): void {
    this._bridgeEvents.on(event, handler);
  }

  handleSpeakingLifecycleSignal(type: "speaking_start" | "speaking_end", payload: any = {}): void {
    if (type === "speaking_start") {
      console.log("[NodeBridge] RX type=speaking_start role=tts");
      // Phase 4: record when TTS playback actually began for barge-in detection
      this.ttsStartedMs = Date.now();
      conversationBus.speakingStarted();
      this._bridgeEvents.emit("speaking_start", payload);
      return;
    }

    console.log("[NodeBridge] RX type=speaking_end role=tts");
    this.ttsEndedMs = Date.now();
    agentStateMachine.noteSpeechFinished();
    conversationBus.speakingEnded();
    this._bridgeEvents.emit("speaking_end", payload);
  }

  removeListener(type: BridgeMessage["type"], handler: MessageHandler): void {
    const existing = this.handlers.get(type);
    if (existing) {
      this.handlers.set(type, existing.filter(h => h !== handler));
    }
  }

  async askForConfirmation(action: string, timeoutMs: number = 10000): Promise<boolean> {
    return new Promise((resolve) => {
      console.log(`[NodeBridge] Security Action required: ${action}. Waiting for CLI confirmation...`);
      // Ask through the CLI for safety instead of voice which is prone to hallucinations
      this.speakToClients(`Sir, I need your confirmation to ${action}. Please type confirm in the console.`);
      
      const timeout = setTimeout(() => {
        console.log("\n[NodeBridge] Confirmation timed out. Aborting.");
        resolve(false);
      }, timeoutMs);

      // Check stdin for confirmation
      const onData = (data: Buffer) => {
        const input = data.toString().trim().toLowerCase();
        if (["confirm", "yes", "y", "proceed", "do it"].includes(input)) {
           clearTimeout(timeout);
           process.stdin.removeListener('data', onData);
           resolve(true);
        } else if (["cancel", "no", "n", "abort", "stop"].includes(input)) {
           clearTimeout(timeout);
           process.stdin.removeListener('data', onData);
           resolve(false);
        }
      };
      
      process.stdin.on('data', onData);
    });
  }

  waitForTextConfirmation(timeoutMs: number = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      const accepted = new Set(["confirm", "yes", "approve", "approved", "proceed", "do it"]);
      const denied = new Set(["cancel", "no", "deny", "abort", "stop"]);
      let settled = false;

      const finish = (value?: string, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._bridgeEvents.removeListener("stt_text", onText);
        if (error) reject(error);
        else resolve(value ?? "");
      };

      const onText = (text: string) => {
        const clean = String(text).trim().toLowerCase();
        if (accepted.has(clean)) finish("CONFIRM");
        if (denied.has(clean)) finish("DENY");
      };

      const timer = setTimeout(() => finish(undefined, new Error("APPROVAL_TIMEOUT")), timeoutMs);
      this._bridgeEvents.on("stt_text", onText);
    });
  }

  send(ws: WebSocket, msg: BridgeMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  broadcast(msg: BridgeMessage): void {
    const json = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  }

  sendToRole(role: string, msg: BridgeMessage): void {
    if (role === 'tts' && msg.type === 'command' && msg.payload?.action === 'stop') {
      console.log('[NodeBridge] 🛑 Stop command for TTS received. Clearing pendingTTS queue.');
      this.pendingTTS = [];
      agentStateMachine.noteSpeechFinished();
    }

    let sent = false;
    const json = JSON.stringify(msg);
    for (const [r, ws] of this.readyClients.entries()) {
      if (
        (r === role || r === "all") &&
        ws.readyState === WebSocket.OPEN
      ) {
        ws.send(json);
        sent = true;
      }
    }

    if (!sent) {
      // ✅ FIXED: Prevent excessive queueing delays for transient wakeword commands
      if (role === "wakeword" && msg.type === "command") {
        const action = (msg.payload as any)?.action;
        if (["pause", "resume", "context_active"].includes(action)) {
          return; // Drop transient commands if wakeword is not ready
        }
      }

      console.log(`[NodeBridge] ⏳ ${role} not READY — queueing command`);
      const existing = this.commandQueue.get(role) ?? [];
      existing.push({ message: msg, timestamp: Date.now() });
      this.commandQueue.set(role, existing);
    }
  }

  sendToClient(role: string, message: object): void {
    const client = this.readyClients.get(role);
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
      console.log(`[NodeBridge] 📨 Sent to ${role}:`, message);
    } else {
      console.log(`[NodeBridge] ⏳ ${role} not READY — queueing command`);
      const existing = this.commandQueue.get(role) ?? [];
      existing.push({ message, timestamp: Date.now() });
      this.commandQueue.set(role, existing);
    }
  }

  /** `allowRepeat`: say it even if it is the same as the last phrase (a second approval request). */
  speakToClients(text: string, opts: { allowRepeat?: boolean } = {}): void {
    if (!systemController.can("tts_output")) {
      console.log("[NodeBridge] 🛑 TTS blocked due to active interrupt.");
      return;
    }

    // Strip thinking tags if any leaked here
    let cleanText = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*/g, '')
      .trim();

    if (!cleanText) return;

    // Phase 4: Dedup — do not queue identical text twice in a row
    if (cleanText === this._lastQueuedTts && !opts.allowRepeat) {
      console.log(`[NodeBridge] TTS dedup: identical phrase already queued — skipping: "${cleanText.slice(0, 60)}"`);
      return;
    }
    this._lastQueuedTts = cleanText;

    this.lastTtsText = cleanText;
    this.lastTtsTimestamp = Date.now();
    // Lets the SPEAKING watchdog allow for everything queued, not a fixed 12 s.
    agentStateMachine.noteSpeechQueued(cleanText);

    const msg: BridgeMessage = { type: "tts", payload: { text: cleanText } };
    const ttsClient = this.readyClients.get("tts");

    if (!ttsClient || ttsClient.readyState !== WebSocket.OPEN) {
      // Phase 4: Bounded pending queue — max 3 items.
      // If queue is full, drop the middle item (keep first intention + latest).
      if (this.pendingTTS.length >= MAX_PENDING_TTS) {
        const dropped = this.pendingTTS.splice(1, 1)[0]; // remove middle
        console.warn(`[NodeBridge] pendingTTS overflow — dropped: "${dropped?.slice(0, 40)}"`);
      }
      console.warn("[NodeBridge] No READY clients yet — queueing TTS.");
      this.pendingTTS.push(cleanText);
      return;
    }

    console.log(`[NodeBridge] → [tts] speak`);
    ttsClient.send(JSON.stringify(msg));
    pipelineRegistry.recordSuccess("brain_to_tts");
  }

  /**
   * ✅ FIX: Send listen_start to STT. If STT isn't ready yet, queue it.
   */
  sendListenStart(timeoutMs: number = STT_READY_TIMEOUT_MS): boolean {
    const sttClient = this.readyClients.get("stt");
    if (sttClient && sttClient.readyState === WebSocket.OPEN) {
      this.pendingListenStart = false;
      this.pendingListenStartedAt = null;
      this.clearPendingListenWarning();
      console.log(`[NodeBridge] → [stt] listen_start`);
      sttClient.send(JSON.stringify({ type: "listen_start" }));
      return true;
    } else {
      console.log(`[NodeBridge] STT not ready — queued listen_start`);
      this.pendingListenStart = true;
      this.pendingListenStartedAt ??= Date.now();
      this.armPendingListenWarning(timeoutMs);
      return false;
    }
  }

  private armPendingListenWarning(timeoutMs: number): void {
    this.clearPendingListenWarning();
    this.pendingListenWarningTimer = setTimeout(() => {
      if (!this.pendingListenStart || this.isRoleReady("stt")) return;
      const pendingMs = Date.now() - (this.pendingListenStartedAt ?? Date.now());
      const payload = { reason: "listen_start_timeout", pendingMs };
      console.warn(`[NodeBridge] STT still not READY after ${pendingMs}ms. Keeping wake-word continuation fallback active.`);
      this._bridgeEvents.emit("stt_unavailable", payload);
    }, Math.max(1, timeoutMs));
    this.pendingListenWarningTimer.unref?.();
  }

  private clearPendingListenWarning(): void {
    if (this.pendingListenWarningTimer) {
      clearTimeout(this.pendingListenWarningTimer);
      this.pendingListenWarningTimer = null;
    }
  }

  stop(): void {
    this.clearPendingListenWarning();
    this.wss?.close(() => console.log("[NodeBridge] Server stopped."));
  }

  get connectedCount(): number {
    return this.clients.size;
  }
}

// ─── Singleton Export ─────────────────────────────────────────────────────────

const globalAny: any = globalThis;
if (!globalAny.__nodeBridge__) {
  globalAny.__nodeBridge__ = new NodeBridge();
}
export const nodeBridge = globalAny.__nodeBridge__ as NodeBridge;
