/**
 * control/desktopControl.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Screenshots and the clipboard (P14, docs/upgrade/PC_CONTROL.md), through
 * control/desktop.ps1.
 *
 * - A screenshot is a PNG in the data folder (data/screenshots/, not in git).
 *   Only its path and size are returned: the image goes nowhere else.
 * - Clipboard text read is redacted before it reaches the model (the
 *   registry redacts every result; the cap here keeps it short).
 * - New clipboard text goes to PowerShell in a temporary file, never in the
 *   command or the script.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPsFile } from '../perception/windowsProbe.js';
import { dataRoot, getWorkspaceRoot } from '../core/workspaceRoot.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const CLIPBOARD_READ_LIMIT = 2_000;
export const CLIPBOARD_WRITE_LIMIT = 100_000;

export function screenshotsDir(): string {
  return path.join(dataRoot(getWorkspaceRoot()), 'data', 'screenshots');
}

/** A file is a PNG when it starts with the PNG signature. */
export function isPng(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(8);
      fs.readSync(fd, head, 0, 8, 0);
      return head.equals(PNG_SIGNATURE);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** All displays, or the window in front. */
export async function takeScreenshot(mode: 'screen' | 'window' = 'screen'): Promise<{ file: string; width: number; height: number; bytes: number }> {
  const dir = screenshotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `desktop-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  const result = await runPsFile('desktop', { JARVIS_DESKTOP_ACTION: 'screenshot', JARVIS_DESKTOP_FILE: file, JARVIS_DESKTOP_MODE: mode }, 20_000);
  if (!result.ok) throw new Error(`The screenshot was not taken: ${String(result.error ?? 'no reason given').slice(0, 160)}`);
  const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return { file, width: Number(result['width']) || 0, height: Number(result['height']) || 0, bytes };
}

/** The clipboard's text, cut to `limit` characters (2 000 for the model). */
export async function readClipboard(limit = CLIPBOARD_READ_LIMIT): Promise<{ text: string; length: number; truncated: boolean }> {
  const result = await runPsFile('desktop', { JARVIS_DESKTOP_ACTION: 'clipboard_read' }, 10_000);
  if (!result.ok) throw new Error(`The clipboard could not be read: ${String(result.error ?? 'no reason given').slice(0, 160)}`);
  const text = String(result['text'] ?? '');
  return { text: text.slice(0, limit), length: text.length, truncated: text.length > limit };
}

/** Put text on the clipboard; read back to check it is there. */
export async function writeClipboard(text: string): Promise<{ length: number; same: boolean }> {
  if (!text) throw new Error('There is no text to put on the clipboard.');
  if (text.length > CLIPBOARD_WRITE_LIMIT) throw new Error('That text is longer than 100 000 characters.');
  const file = path.join(os.tmpdir(), `jarvis-clip-${crypto.randomBytes(8).toString('hex')}.txt`);
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  try {
    const result = await runPsFile('desktop', { JARVIS_DESKTOP_ACTION: 'clipboard_write', JARVIS_DESKTOP_FILE: file }, 10_000);
    if (!result.ok) throw new Error(`The clipboard was not changed: ${String(result.error ?? 'no reason given').slice(0, 160)}`);
    return { length: Number(result['length']) || text.length, same: result['same'] === true };
  } finally {
    fs.rmSync(file, { force: true });
  }
}
