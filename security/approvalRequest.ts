/**
 * security/approvalRequest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What JARVIS shows before an action that needs the user's approval, and how
 * an answer to it is read (docs/upgrade/PERMISSION_MODEL.md, "Approval
 * request").
 *
 *   ACTION / WHY / TARGET / EXPECTED EFFECT / RISK / REVERSIBILITY
 *   Do you approve this action?
 *
 * Level 4 asks for a code typed in the console; voice cannot approve it.
 */

import { randomInt } from 'node:crypto';
import { redact } from './redactor.js';

export type ApprovalSource = 'cli' | 'voice' | 'text' | 'llm';
export type ApprovalChannel = 'console' | 'voice';
export type ReversibilityText = 'yes' | 'partial' | 'no' | 'unknown';

export interface ApprovalRequest {
  id: string;
  tool?: string;
  /** Short title: "End process". */
  action: string;
  why: string;
  target: string;
  expectedEffect: string;
  /** 0–4. */
  risk: number;
  /** Why the level is what it is, when an argument rule decided it. */
  riskDetail?: string;
  reversibility: ReversibilityText;
  source: ApprovalSource;
  /** Level 4: approved only with `APPROVE <code>` typed in the console. */
  strong: boolean;
  code?: string;
  createdAt: number;
}

export interface ApprovalDecision {
  requestId: string;
  tool?: string;
  action: string;
  target: string;
  risk: number;
  approved: boolean;
  /** Who or what decided: an answer, the approved call it belongs to, or the clock. */
  by: 'console' | 'voice' | 'scope' | 'timeout' | 'unavailable';
  /** The answer as given (redacted, at most 40 characters). */
  answer?: string;
  /** For `by: 'scope'`: the request whose approval covered this one. */
  partOf?: string;
  at: number;
}

const RISK_NAMES = ['safe', 'low', 'moderate', 'high', 'critical'] as const;

/** Titles for the calls that can need approval. */
const ACTION_TITLES: Record<string, string> = {
  'control_app open': 'Open app',
  'control_app focus': 'Focus app',
  'control_app close': 'Close app',
  'control_app restart': 'Restart app',
  'control_window close': 'Close window',
  'control_window close_current': 'Close the current window',
  'control_window move': 'Move window',
  'control_window resize': 'Resize window',
  'control_browser close': 'Close browser tab',
  'browser_navigate go': 'Open a web address',
  'browser_navigate back': 'Go back a page',
  'browser_navigate forward': 'Go forward a page',
  'browser_navigate reload': 'Reload the page',
  'browser_tab new': 'Open a new tab',
  'browser_tab switch': 'Switch tab',
  'browser_tab close': 'Close a tab',
  'browser_click': 'Click on a web page',
  'browser_type': 'Type into a web page',
  'browser_select': 'Choose an option on a web page',
  'browser_scroll': 'Scroll a web page',
  'browser_screenshot': 'Save a screenshot of a tab',
  'browser_download': 'Download a file',
  'browser_upload': 'Upload a file to a web page',
  'control_browser close_current': 'Close the current browser tab',
  'control_keyboard type': 'Type text',
  'control_keyboard press_key': 'Press a key',
  'control_keyboard press_hotkey': 'Press a keyboard shortcut',
  'control_mouse click': 'Click',
  'control_mouse right_click': 'Right-click',
  'control_mouse double_click': 'Double-click',
  'control_mouse drag': 'Drag with the mouse',
  'control_mouse move': 'Move the mouse',
  'control_mouse scroll': 'Scroll',
  'control_file write': 'Write file',
  'control_file copy': 'Copy file',
  'control_file move': 'Move file',
  'control_file rename': 'Rename file',
  'control_file delete': 'Delete file',
  'control_file create_folder': 'Create folder',
  'control_file delete_folder': 'Delete folder',
  'control_process kill': 'End process',
  'control_process restart': 'Restart process',
  'control_system shell': 'Run a Command Prompt command',
  'control_system powershell': 'Run a PowerShell command',
  'control_system start_service': 'Start service',
  'control_system stop_service': 'Stop service',
  'control_system restart_service': 'Restart service',
  'control_system restart_jarvis': 'Restart JARVIS services',
  'control_system settings': 'Open a Settings page',
  run_command: 'Run a developer command',
  write_file: 'Write file',
  open_app: 'Open app',
  enable_full_control_session: 'Turn on full control mode',
};

/** No 0/O or 1/I, so the code reads unambiguously. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function newRequestId(): string {
  return `apr_${Date.now().toString(36)}_${randomInt(36 ** 4).toString(36).padStart(4, '0')}`;
}

function oneLine(text: string, max: number): string {
  const flat = redact(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function riskName(level: number): string {
  return RISK_NAMES[Math.max(0, Math.min(4, Math.round(level)))] ?? 'high';
}

/** "HIGH_RISK", "LEVEL_3", "CRITICAL_RISK" … as the old callers pass it. */
export function riskFromLabel(label: string | undefined): number {
  const text = String(label ?? '').toUpperCase();
  const level = /LEVEL_([0-4])/.exec(text);
  if (level) return Number(level[1]);
  if (text.startsWith('CRITICAL')) return 4;
  if (text.startsWith('MEDIUM')) return 2;
  if (text.startsWith('LOW')) return 1;
  if (text.startsWith('SAFE')) return 0;
  return 3;
}

export function buildApprovalRequest(input: {
  tool?: string;
  action?: string;
  /** Title to show when the call has none in the table (old callers' action names). */
  title?: string;
  target?: string;
  /** The user's request, if any; shown as WHY. */
  request?: string;
  /** Why approval is needed; WHY when there is no request text. */
  reason?: string;
  risk: number;
  riskDetail?: string;
  effect?: string;
  reversible?: ReversibilityText;
  source?: ApprovalSource;
}): ApprovalRequest {
  const key = input.action ? `${input.tool} ${input.action}` : String(input.tool ?? '');
  const action = ACTION_TITLES[key]
    ?? input.title
    ?? (input.tool ? (input.action ? `${input.tool} ${input.action}` : input.tool) : 'Action');
  const request = input.request?.trim();
  const why = request
    ? `You asked: "${oneLine(request, 140)}"`
    : oneLine(input.reason || 'JARVIS planned this step.', 160);
  const risk = Math.max(0, Math.min(4, Math.round(input.risk)));
  const strong = risk >= 4;
  return {
    id: newRequestId(),
    ...(input.tool ? { tool: input.tool } : {}),
    action,
    why,
    target: oneLine(input.target || '—', 160),
    expectedEffect: oneLine(input.effect || input.reason || 'Not described by this tool.', 160),
    risk,
    ...(input.riskDetail ? { riskDetail: oneLine(input.riskDetail, 100) } : {}),
    reversibility: input.reversible ?? 'unknown',
    source: input.source ?? 'cli',
    strong,
    ...(strong ? { code: newCode() } : {}),
    createdAt: Date.now(),
  };
}

const REVERSIBILITY_TEXT: Record<ReversibilityText, string> = {
  yes: 'Yes',
  partial: 'Partly',
  no: 'No',
  unknown: 'Not stated',
};

/** The console block. */
export function formatApprovalRequest(r: ApprovalRequest, timeoutSecs: number): string {
  const rule = '='.repeat(65);
  const thin = '-'.repeat(65);
  const risk = `Level ${r.risk} — ${riskName(r.risk)}${r.riskDetail ? ` (${r.riskDetail})` : ''}`;
  const answer = r.strong
    ? [`  Type APPROVE ${r.code} within ${timeoutSecs} s. Voice cannot approve this.`,
       '  Anything else, or no answer, cancels it.']
    : [`  Type APPROVE, YES or CONFIRM within ${timeoutSecs} s.`,
       '  Anything else, or no answer, cancels it.'];
  return [
    '',
    rule,
    `JARVIS NEEDS YOUR APPROVAL  (request ${r.id})`,
    thin,
    `  ACTION:           ${r.action}`,
    `  WHY:              ${r.why}`,
    `  TARGET:           ${r.target}`,
    `  EXPECTED EFFECT:  ${r.expectedEffect}`,
    `  RISK:             ${risk}`,
    `  REVERSIBILITY:    ${REVERSIBILITY_TEXT[r.reversibility]}`,
    thin,
    '  Do you approve this action?',
    ...answer,
    rule,
    '',
  ].join('\n');
}

const SPOKEN_REVERSIBILITY: Record<ReversibilityText, string> = {
  yes: 'It can be undone.',
  partial: 'It can only partly be undone.',
  no: 'It cannot be undone.',
  unknown: '',
};

/** The spoken version: short, with the target cut to a few words. */
export function spokenApprovalRequest(r: ApprovalRequest): string {
  // Older callers write the target as "Close app: code"; say only "code".
  const named = r.target.replace(/^[A-Za-z][A-Za-z ]{1,40}:\s+/, '');
  const target = named && named !== '—' ? ` on ${oneLine(named, 60)}` : '';
  if (r.strong) {
    return `Sir, this is a critical action: ${r.action.toLowerCase()}${target}. ` +
      'It needs the code shown in the console. Voice cannot approve it.';
  }
  return [
    `Sir, I need your approval to ${r.action.toLowerCase()}${target}.`,
    `Risk level ${r.risk}.`,
    SPOKEN_REVERSIBILITY[r.reversibility],
    'Do you approve this action? Say approve or confirm.',
  ].filter(Boolean).join(' ');
}

/** A typed answer: approves only the exact words, and for level 4 only the code. */
export function isConsoleApproval(answer: string, r: ApprovalRequest): boolean {
  const clean = String(answer ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (r.strong) return !!r.code && clean === `APPROVE ${r.code}`;
  return clean === 'APPROVE' || clean === 'YES' || clean === 'CONFIRM';
}

/**
 * A spoken answer. "yes" counts only because it is heard inside the window
 * right after JARVIS asked; the caller checks that window.
 */
export function classifyVoiceAnswer(text: string): 'approve' | 'deny' | 'other' {
  const clean = String(text ?? '').toLowerCase().replace(/[^a-z'\s]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:hey )?jarvis /, '')
    .replace(/ (?:sir|please|jarvis)$/, '')
    .replace(/^(?:ok|okay) /, '');
  if (/^(?:yes )?(?:i )?(?:approve|approved|confirm|confirmed)(?: it| that)?$/.test(clean) || clean === 'yes') {
    return 'approve';
  }
  if (/^(?:no|nope|deny|denied|cancel|cancel it|stop|abort|reject|don't|do not|no don't|no do not)(?: it| that)?$/.test(clean)) {
    return 'deny';
  }
  return 'other';
}
