/**
 * control/helper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared utilities for running the Windows UI automation script.
 */

import { execa } from 'execa';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runAutomateScript(args: string[]): Promise<string> {
  const scriptPath = path.join(__dirname, 'win_automate.ps1');
  const result = await execa('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...args
  ], { reject: false });
  
  if (result.exitCode !== 0) {
    throw new Error(`WinAutomate script failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  
  return result.stdout.trim();
}
