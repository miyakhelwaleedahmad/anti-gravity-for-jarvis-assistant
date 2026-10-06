/**
 * security/approvalGate.ts
 * Real human-in-the-loop approval gate.
 *
 * Before an action that needs approval, JARVIS shows ACTION, WHY, TARGET,
 * EXPECTED EFFECT, RISK and REVERSIBILITY and asks "Do you approve this
 * action?" (security/approvalRequest.ts). Only an answer to the request on
 * display counts:
 *  - typed: APPROVE, YES or CONFIRM while it is displayed (30 s); for level 4
 *    only `APPROVE <code>`;
 *  - spoken: "approve", "confirm" or "yes" within 10 s after JARVIS has
 *    finished asking; never for level 4.
 * Anything else, silence, or no way to answer denies. One request is on
 * display at a time; each decision is recorded on the task step and in the
 * security audit log.
 */

import * as readline from 'readline';
import { securityAuditLogger } from './securityAuditLogger.js';
import { currentApproval } from './approvalScope.js';
import {
  buildApprovalRequest,
  classifyVoiceAnswer,
  formatApprovalRequest,
  isConsoleApproval,
  riskFromLabel,
  spokenApprovalRequest,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalSource,
} from './approvalRequest.js';
import { redact } from './redactor.js';
import { currentTaskNode } from '../core/taskContext.js';
import { getRequestSource, getRequestText } from '../core/traceContext.js';

const DEFAULT_TIMEOUT_SECONDS = 30;
const VOICE_TIMEOUT_SECONDS = 10;
const DEFAULT_REASON = 'This action requires explicit human confirmation.';
/** Spoken answers are prefixed so that they are never read as typed ones. */
const VOICE_PREFIX = 'VOICE:';
/** JARVIS's own voice can still reach the microphone just after it stops. */
const ECHO_TAIL_MS = 300;
/** If nothing starts saying the request by then, no speaker is connected. */
const SPEECH_START_WAIT_MS = 2_000;
const SPEECH_MAX_MS = 15_000;
const HISTORY_LIMIT = 50;

interface Pending {
  request: ApprovalRequest;
  console: boolean;
  voice: boolean;
  /** Spoken answers count from here: JARVIS has finished asking. */
  listeningFrom: number;
  expiresAt: number;
  toldVoiceCannot?: boolean;
  settle: (answer: string | null) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function words(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export class ApprovalGate {
  private pending: Pending | null = null;
  private turn: Promise<void> = Promise.resolve();
  private consoleAttached = false;
  private history: ApprovalDecision[] = [];

  /**
   * The CLI loop owns stdin and hands typed lines to `offerConsoleAnswer`.
   * Without it, the gate reads one line itself (a second reader on stdin would
   * also have run the answer as a command).
   */
  attachConsole(): void {
    this.consoleAttached = true;
  }

  /**
   * Ask for approval. Takes a request built with `buildApprovalRequest`, or —
   * for the controllers' own checks — the older arguments, from which one is
   * built.
   */
  public async requestApproval(
    actionOrRequest: string | ApprovalRequest,
    command: string = '',
    riskLevel: string = 'HIGH_RISK',
    reason: string = DEFAULT_REASON,
    sourceOrTimeout?: ApprovalSource | number,
    timeoutSecs?: number,
  ): Promise<boolean> {
    // A controller that names no source asks the way the request came in.
    const source: ApprovalSource = typeof sourceOrTimeout === 'string'
      ? sourceOrTimeout
      : getRequestSource() ?? 'cli';
    const userRequest = getRequestText();
    const request = typeof actionOrRequest === 'string'
      ? buildApprovalRequest({
          title: actionOrRequest,
          target: command,
          request: userRequest,
          reason,
          ...(userRequest && reason !== DEFAULT_REASON ? { effect: reason } : {}),
          risk: riskFromLabel(riskLevel),
          source,
        })
      : actionOrRequest;
    const seconds = timeoutSecs ?? (typeof sourceOrTimeout === 'number' ? sourceOrTimeout : undefined);

    // The registry already asked for this call; the controller it reached
    // (process kill, services, shell) used to ask a second time.
    const approvedCall = currentApproval();
    if (approvedCall) {
      console.log(`[ApprovalGate] "${request.action}" is part of the approved ${approvedCall.tool} call — not asking again.`);
      this.record(request, { approved: true, by: 'scope' }, approvedCall.requestId);
      return true;
    }

    // One request on display at a time: parallel steps wait their turn.
    const previous = this.turn;
    let release!: () => void;
    this.turn = new Promise<void>((r) => { release = r; });
    await previous;
    try {
      return await this.ask(request, seconds);
    } finally {
      release();
    }
  }

  /** A line typed while a request is displayed. True when it was taken as the answer. */
  offerConsoleAnswer(line: string): boolean {
    const p = this.pending;
    if (!p?.console || Date.now() > p.expiresAt) return false;
    p.settle(line);
    return true;
  }

  /**
   * Something the user said. True when it was taken as the answer (it must
   * then not run as a command). Words heard while JARVIS is still asking are
   * its own voice; anything other than an answer denies the request and is
   * left to run as a command.
   */
  offerVoiceAnswer(text: string): boolean {
    const p = this.pending;
    const kind = classifyVoiceAnswer(text);
    if (!p?.voice) {
      if (kind === 'approve') {
        console.log(`[ApprovalGate] "${text}" heard with no approval pending — it approves nothing.`);
      }
      return false;
    }
    const now = Date.now();
    if (now < p.listeningFrom || now > p.expiresAt) return false;
    if (kind === 'other') {
      const heard = words(text);
      if (heard && words(spokenApprovalRequest(p.request)).includes(heard)) return false; // the request, heard back
      p.settle(`${VOICE_PREFIX}${text}`);
      return false;
    }
    if (kind === 'approve' && p.request.strong) {
      if (!p.toldVoiceCannot) {
        p.toldVoiceCannot = true;
        this.speak('Voice cannot approve this one, sir. Type the code shown in the console.');
      }
      return true;
    }
    p.settle(`${VOICE_PREFIX}${text}`);
    return true;
  }

  /** The request on display, in a few words, if one is waiting for an answer. */
  pendingSummary(): string | undefined {
    const r = this.pending?.request;
    return r ? `${r.action} — ${r.target} (level ${r.risk})` : undefined;
  }

  /** The latest decisions, oldest first. */
  recentDecisions(limit = 20): ApprovalDecision[] {
    return this.history.slice(-limit);
  }

  private async ask(request: ApprovalRequest, timeoutSecs?: number): Promise<boolean> {
    const voice = request.source === 'voice';
    const seconds = timeoutSecs ?? (voice && !request.strong ? VOICE_TIMEOUT_SECONDS : DEFAULT_TIMEOUT_SECONDS);
    securityAuditLogger.approvalRequest(request);
    console.log(formatApprovalRequest(request, seconds));

    let raw: string;
    try {
      raw = voice
        ? await this._voiceOrTextPromptWithTimeout(request, seconds * 1000)
        : await this._promptWithTimeout('  Your decision: ', seconds * 1000, request);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'APPROVAL_UNAVAILABLE') {
        console.warn('\n  No console or voice to answer on - action DENIED.\n');
        this.record(request, { approved: false, by: 'unavailable' });
      } else if (message === 'APPROVAL_TIMEOUT') {
        console.warn('\n  Approval timeout - action DENIED by default.\n');
        this.record(request, { approved: false, by: 'timeout' });
      } else {
        console.error(`\n  Approval gate error: ${message} - action DENIED.\n`);
        this.record(request, { approved: false, by: 'unavailable', answer: message });
      }
      return false;
    }

    const spoken = raw.startsWith(VOICE_PREFIX);
    const answer = spoken ? raw.slice(VOICE_PREFIX.length) : raw;
    const approved = spoken
      ? !request.strong && classifyVoiceAnswer(answer) === 'approve'
      : isConsoleApproval(answer, request);
    console.log(approved ? '  Approved by user.\n' : '  Denied by user input.\n');
    this.record(request, { approved, by: spoken ? 'voice' : 'console', answer });
    return approved;
  }

  private record(
    request: ApprovalRequest,
    outcome: { approved: boolean; by: ApprovalDecision['by']; answer?: string },
    partOf?: string,
  ): ApprovalDecision {
    const decision: ApprovalDecision = {
      requestId: request.id,
      ...(request.tool ? { tool: request.tool } : {}),
      action: request.action,
      target: request.target,
      risk: request.risk,
      approved: outcome.approved,
      by: outcome.by,
      ...(outcome.answer !== undefined ? { answer: redact(outcome.answer).slice(0, 40) } : {}),
      ...(partOf ? { partOf } : {}),
      at: Date.now(),
    };
    this.history.push(decision);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    const node = currentTaskNode();
    if (node) (node.approvals ??= []).push(decision);
    securityAuditLogger.approvalDecision(request, decision);
    return decision;
  }

  /** Make `request` the one on display; answers settle it, the clock denies it. */
  private openPending(request: ApprovalRequest, channels: { console: boolean; voice: boolean }) {
    let resolve!: (answer: string | null) => void;
    const answer = new Promise<string | null>((r) => { resolve = r; });
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const pending: Pending = {
      request,
      ...channels,
      listeningFrom: Number.POSITIVE_INFINITY,
      expiresAt: Number.POSITIVE_INFINITY,
      settle: (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (this.pending === pending) this.pending = null;
        resolve(value);
      },
    };
    this.pending = pending;
    return {
      answer,
      settle: pending.settle,
      isSettled: () => settled,
      startClock: (timeoutMs: number, listeningFrom = Date.now()) => {
        pending.listeningFrom = listeningFrom;
        pending.expiresAt = listeningFrom + timeoutMs;
        timer = setTimeout(() => pending.settle(null), Math.max(0, pending.expiresAt - Date.now()));
      },
    };
  }

  /** A typed answer: through the CLI loop when it owns stdin, else one line read here. */
  private async _promptWithTimeout(prompt: string, timeoutMs: number, request?: ApprovalRequest): Promise<string> {
    if (this.consoleAttached && request) {
      const pending = this.openPending(request, { console: true, voice: false });
      pending.startClock(timeoutMs);
      const answer = await pending.answer;
      if (answer === null) throw new Error('APPROVAL_TIMEOUT');
      return answer;
    }
    if (!process.stdin.isTTY) throw new Error('APPROVAL_UNAVAILABLE');
    const line = await this.readLine(prompt, timeoutMs).promise;
    if (line === null) throw new Error('APPROVAL_TIMEOUT');
    return line;
  }

  /** One line from stdin, or null when the time is up or stdin closes. */
  private readLine(prompt: string, timeoutMs: number): { promise: Promise<string | null>; close: () => void } {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let finish!: (value: string | null) => void;
    const promise = new Promise<string | null>((resolve) => {
      finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        rl.close();
        resolve(value);
      };
    });
    timer = setTimeout(() => finish(null), timeoutMs);
    rl.question(prompt, (answer) => finish(answer));
    rl.on('close', () => finish(null));
    return { promise, close: () => finish(null) };
  }

  /**
   * A spoken request: JARVIS says it, then listens. Typed answers count at
   * once; spoken ones only after JARVIS has finished asking, so that its own
   * "say approve or confirm" cannot approve anything.
   */
  private async _voiceOrTextPromptWithTimeout(request: ApprovalRequest, timeoutMs: number): Promise<string> {
    const { nodeBridge } = await import('../bridge/nodeBridge.js');
    const pending = this.openPending(request, { console: this.consoleAttached, voice: true });
    // Without the CLI loop, read a typed answer here as before.
    const typed = !this.consoleAttached && process.stdin.isTTY
      ? this.readLine('  Your decision: ', SPEECH_MAX_MS + timeoutMs)
      : null;
    typed?.promise.then((line) => { if (line !== null) pending.settle(line); });

    const askedAt = Date.now();
    nodeBridge.speakToClients(spokenApprovalRequest(request), { allowRepeat: true });

    // Wait until JARVIS has finished saying it, or nothing is saying it.
    // Never start listening while it is saying anything at all.
    while (!pending.isSettled()) {
      const elapsed = Date.now() - askedAt;
      const speakingNow = nodeBridge.ttsStartedMs > nodeBridge.ttsEndedMs;
      const started = nodeBridge.ttsStartedMs > askedAt;
      if (started && !speakingNow) break;
      // Nothing has started saying it since JARVIS last went quiet: no speaker.
      const quietFor = Date.now() - Math.max(askedAt, nodeBridge.ttsEndedMs);
      if (!started && !speakingNow && quietFor >= SPEECH_START_WAIT_MS) break;
      if (elapsed >= SPEECH_MAX_MS) break;
      await sleep(100);
    }
    if (!pending.isSettled()) {
      pending.startClock(timeoutMs, Math.max(Date.now(), nodeBridge.ttsEndedMs + ECHO_TAIL_MS));
    }

    const answer = await pending.answer;
    typed?.close();
    if (answer === null) throw new Error('APPROVAL_TIMEOUT');
    return answer;
  }

  private speak(text: string): void {
    import('../bridge/nodeBridge.js')
      .then(({ nodeBridge }) => nodeBridge.speakToClients(text, { allowRepeat: true }))
      .catch(() => { /* no bridge: the console shows it */ });
  }
}

export const approvalGate = new ApprovalGate();
