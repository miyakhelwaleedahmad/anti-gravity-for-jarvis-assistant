/**
 * control/uiAutomation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * UI Automation (P14, docs/upgrade/PC_CONTROL.md): the elements of a window,
 * and invoke, set the value of, or focus one of them — through control/uia.ps1,
 * with every value in an environment variable and text in a temporary file.
 *
 * The model sees references such as `u12` (control/uiRefs.ts). An element is
 * acted on only after JARVIS has looked at it, and only while it still has
 * the name and control type JARVIS saw (uia.ps1 checks both first).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { probeWindows, runPsFile, type WindowInfo } from '../perception/windowsProbe.js';
import { normalizeHwnd } from '../perception/windowsState.js';
import { describeUiElement, lookupUiRef, rememberUi, type UiElement, type UiWindow } from './uiRefs.js';

export { lookupUiRef, rememberUi, UI_REF_MAX_AGE_MS, type UiElement, type UiRef, type UiWindow } from './uiRefs.js';

// Each call starts a fresh Windows PowerShell: on a slow PC (the owner's 2010
// iMac) that alone takes many seconds, so the first limits of 15 s and 10 s
// were raised. A dialog that blocks the app's caller ends an action at 30 s.
const UIA_TIMEOUT_MS = 60_000;
const ACT_TIMEOUT_MS = 30_000;

/**
 * The window a request names: a handle, or words of its title or its program
 * (among all visible windows, not one per program), or — empty — the one in
 * front.
 */
async function windowHandle(target: unknown): Promise<string> {
  const query = typeof target === 'string' ? target.trim() : '';
  if (!query) return '';
  const hex = normalizeHwnd(query);
  if (hex) return BigInt(hex).toString();
  const windows = await probeWindows('windows') as WindowInfo[];
  const lower = query.toLowerCase();
  const match = windows.find((w) => w.title.toLowerCase().includes(lower)) ?? windows.find((w) => w.process.toLowerCase().includes(lower));
  if (!match?.hwnd) throw new Error(`No open window matches "${query.slice(0, 60)}".`);
  return BigInt(match.hwnd).toString();
}

export interface UiList {
  window: UiWindow;
  elements: Array<UiElement & { ref: string }>;
  more: boolean;
  /** What could not be read in the window, said instead of left out. */
  problems: string[];
  /** Whether the helpers that describe classic Win32 controls were registered. */
  classicControlHelpers: string;
}

/** The elements of a window (the one in front when `target` is empty), breadth first to depth 6, at most 200. */
export async function listUiElements(target?: unknown): Promise<UiList> {
  const hwnd = await windowHandle(target);
  const result = await runPsFile('uia', { JARVIS_UIA_ACTION: 'list', JARVIS_UIA_HWND: hwnd }, UIA_TIMEOUT_MS);
  if (!result.ok) throw new Error(`UI Automation could not read the window: ${String(result.error ?? 'no reason given').slice(0, 160)}`);
  const w = (result['window'] ?? {}) as Record<string, unknown>;
  const window: UiWindow = { hwnd: String(w['hwnd'] ?? ''), title: String(w['title'] ?? '').slice(0, 160), process: String(w['process'] ?? '').slice(0, 60) };
  if (!/^\d{1,19}$/.test(window.hwnd)) throw new Error('UI Automation did not name the window it read.');
  const raw = Array.isArray(result['elements']) ? result['elements'] as Array<Record<string, unknown>> : [];
  const elements: UiElement[] = raw.map((e) => ({
    // As uia.ps1 compares it before acting: spaces collapsed, 160 characters.
    id: String(e['id'] ?? ''), name: String(e['name'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 160), type: String(e['type'] ?? '').slice(0, 40),
    automationId: String(e['automationId'] ?? '').slice(0, 80), className: String(e['className'] ?? '').slice(0, 80),
    enabled: e['enabled'] === true, focused: e['focused'] === true, password: e['password'] === true, offscreen: e['offscreen'] === true,
    patterns: Array.isArray(e['patterns']) ? (e['patterns'] as unknown[]).map(String) : typeof e['patterns'] === 'string' ? [e['patterns']] : [],
    value: e['password'] === true ? '' : String(e['value'] ?? '').slice(0, 200), depth: Number(e['depth']) || 0,
  })).filter((e) => /^-?\d+(\.-?\d+)*$/.test(e.id));
  const problems = Array.isArray(result['problems']) ? (result['problems'] as unknown[]).slice(0, 20).map((p) => String(p).slice(0, 240)) : [];
  const classicControlHelpers = String(result['helpers'] ?? 'unknown').slice(0, 200);
  return { window, elements: rememberUi(window, elements), more: result['more'] === true, problems, classicControlHelpers };
}

export type UiAction = 'invoke' | 'set_value' | 'focus';

/** Invoke, set the value of, or focus an element JARVIS has looked at. */
export async function actOnUi(action: UiAction, refArg: unknown, text?: string): Promise<Record<string, unknown>> {
  const element = lookupUiRef(refArg);
  if (!element) throw new Error('JARVIS has not looked at that element (or it was more than 10 minutes ago): list the window\'s elements first.');
  const env: Record<string, string> = {
    JARVIS_UIA_ACTION: action, JARVIS_UIA_HWND: element.hwnd, JARVIS_UIA_REF: element.id,
    JARVIS_UIA_NAME: element.name, JARVIS_UIA_TYPE: element.type,
  };
  let textFile: string | undefined;
  if (action === 'set_value') {
    if (typeof text !== 'string') throw new Error('set_value needs the text.');
    if (element.password) throw new Error('JARVIS does not type passwords. Please type it yourself.');
    textFile = path.join(os.tmpdir(), `jarvis-uia-${crypto.randomBytes(8).toString('hex')}.txt`);
    fs.writeFileSync(textFile, text, { encoding: 'utf8', mode: 0o600 });
    env['JARVIS_UIA_TEXT_FILE'] = textFile;
  }
  try {
    const result = await runPsFile('uia', env, ACT_TIMEOUT_MS);
    if (!result.ok) throw new Error(String(result.error ?? 'UI Automation did not do it.').slice(0, 200));
    return { ...result, target: describeUiElement(element) };
  } finally {
    if (textFile) fs.rmSync(textFile, { force: true });
  }
}
