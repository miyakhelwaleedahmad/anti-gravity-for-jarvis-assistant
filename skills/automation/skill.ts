/**
 * skills/automation/skill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Automation skill: opens apps, URLs, files on the local OS.
 * Uses platform-native open commands (start on Windows, open on macOS, xdg-open on Linux).
 * Web pages and Chrome itself open in JARVIS's own Chrome instead (owner
 * decision D1 and answer Q1, 2026-10-27; control/jarvisChrome.ts), never in
 * the default browser: JARVIS can see, check and close only that Chrome.
 */

import { spawn } from 'child_process';
import { securityAuditLogger } from '../../security/securityAuditLogger.js';
import { approvalGate } from '../../security/approvalGate.js';
import { childEnv } from '../../system/childEnv.js';
import { getRequestSource } from '../../core/traceContext.js';
import { resolveTargetUrl, windowsOnlyTarget } from '../../security/openAppPolicy.js';
import { showInJarvisChrome } from '../../control/jarvisChrome.js';

// open_app's allow-lists and checks live in security/openAppPolicy.ts (ARCH-04).
export { resolveTargetUrl };

type OpenAppSource = 'voice' | 'text' | 'llm';

/**
 * The launcher and the platform, so tests can stand in for them on any OS
 * (phase A5d). Nothing else changes them.
 */
export const openAppDeps = {
  // Calls the live binding, as the code did before: a patched child_process.spawn still applies.
  // Always with the filtered environment (SEC-101).
  spawn: ((cmd: string, args: string[], options: Record<string, unknown>) => spawn(cmd, args, { ...options, env: childEnv() } as any)) as (cmd: string, args: string[], options: Record<string, unknown>) => { on(event: string, fn: (...a: any[]) => void): unknown; unref(): void },
  platform: (): NodeJS.Platform => process.platform,
};

/**
 * How long the answer waits for the launcher to finish (phase A5d, TRA-19).
 * A launcher that has handed the open on exits at once. One still running then
 * (some `xdg-open`s stay with the app; on Windows, `start` may wait on a "cannot
 * find" dialog) counts as started, and the verifier checks apps afterwards.
 */
const LAUNCHER_WAIT_MS = 3_000;

/**
 * A web page in a new tab of JARVIS's Chrome, or (for "chrome") that Chrome
 * brought forward; started first when needed. When it cannot be, the result
 * says why and what to do, and nothing is opened elsewhere (owner, Q2).
 */
async function openInJarvisChrome(target: string, resolvedTarget: string): Promise<string> {
  const url = /^https?:\/\//i.test(resolvedTarget) ? resolvedTarget : undefined;
  try {
    const shown = await showInJarvisChrome(url);
    console.log(`[open_app] target="${target}" shown in JARVIS's Chrome (port ${shown.port}, tab ${shown.tabId})`);
    return JSON.stringify({ success: true, target, resolvedTarget, method: 'jarvis-chrome', port: shown.port, tabId: shown.tabId });
  } catch (err) {
    const spoken = (err as { spoken?: unknown })?.spoken;
    return JSON.stringify({
      success: false, target, resolvedTarget, method: 'jarvis-chrome', error: err instanceof Error ? err.message : String(err),
      ...(typeof spoken === 'string' ? { spoken } : {}),
    });
  }
}

function openTarget(target: string, resolvedTarget: string): Promise<string> {
  return new Promise((resolve) => {
    const platform = openAppDeps.platform();

    console.log(`[open_app] target="${target}" resolved="${resolvedTarget}"`);

    let cmd: string;
    let args: string[];
    let method = 'spawn';

    if (platform === 'win32') {
      cmd = 'cmd.exe';
      args = ['/c', 'start', '', resolvedTarget];
      method = 'cmd-start';
    } else if (platform === 'darwin') {
      cmd = 'open';
      args = [resolvedTarget];
      method = 'open';
    } else {
      cmd = 'xdg-open';
      args = [resolvedTarget];
      method = 'xdg-open';
    }

    console.log(`[open_app] platform=${platform} command=${cmd} args=${args.join(',')}`);

    // The answer waits for the launcher's own outcome (phase A5d, TRA-19): it
    // used to be "success" 50 ms after the spawn, whatever the launcher did next.
    let settled = false;
    const answer = (body: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(JSON.stringify({ target, resolvedTarget, platform, method, ...body }));
    };
    const timer = setTimeout(() => answer({ success: true, launcherStillRunning: true }), LAUNCHER_WAIT_MS);

    try {
      const proc = openAppDeps.spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
        // The app JARVIS opens does not get JARVIS's keys and tokens (SEC-06).
        env: childEnv(),
        ...(platform === 'win32' ? { windowsHide: true } : {})
      });

      proc.on('error', (err: Error) => answer({ success: false, error: err.message }));
      proc.on('exit', (code: number | null) => answer(code === 0 || code === null
        ? { success: true }
        : { success: false, error: `The launcher (${cmd}) exited with code ${code}, so ${target} may not have opened.` }));

      proc.unref();
    } catch (err: any) {
      answer({ success: false, error: String(err) });
    }
  });
}

export async function execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const target = String(args['target'] ?? '').trim();
  // How the request really arrived wins over the `source` the model wrote:
  // it decides how approval is asked and what the audit records.
  const arrived = getRequestSource();
  const source: OpenAppSource = arrived === 'voice' ? 'voice'
    : arrived === 'cli' ? 'text'
    : (['voice', 'text', 'llm'].includes(String(args['source'] ?? '')) ? String(args['source']) as OpenAppSource : 'llm');
  if (!target) {
    return JSON.stringify({
      success: false,
      error: 'Error: target is required to open an application or URL.'
    });
  }
  if (signal?.aborted) throw new Error('ABORTED');

  const resolved = resolveTargetUrl(target);
  const dryRun = !!args['dryRun'];

  if (resolved.requiresApproval && !dryRun) {
    const approved = await approvalGate.requestApproval(
      'Open Command Prompt',
      resolved.resolvedTarget,
      'HIGH_RISK',
      resolved.reason ?? 'Opening Command Prompt requires explicit approval.',
      source,
      source === 'voice' ? 10 : undefined,
    );
    if (approved) {
      resolved.allowed = true;
      resolved.reason = undefined;
    }
  }

  securityAuditLogger.openAppAttempt(
    resolved.requestedTarget,
    resolved.resolvedTarget,
    resolved.allowed,
    source,
    resolved.reason,
  );

  if (!resolved.allowed) {
    return JSON.stringify({
      success: false,
      target,
      resolvedTarget: resolved.resolvedTarget,
      dryRun,
      error: resolved.reason ?? 'Target rejected by open_app policy.'
    });
  }

  if (dryRun) {
    return JSON.stringify({
      success: true,
      target,
      resolvedTarget: resolved.resolvedTarget,
      dryRun: true
    });
  }

  if (/^https?:\/\//i.test(resolved.resolvedTarget) || resolved.resolvedTarget === 'chrome.exe') {
    return openInJarvisChrome(target, resolved.resolvedTarget);
  }
  // A Windows program or page cannot be opened elsewhere: say so, launch nothing
  // (phase A5d, owner Q2). A dry run above still shows what it resolves to.
  if (openAppDeps.platform() !== 'win32' && windowsOnlyTarget(resolved.resolvedTarget)) {
    return JSON.stringify({
      success: false, target, resolvedTarget: resolved.resolvedTarget, platform: openAppDeps.platform(),
      error: `${target} needs Windows: "${resolved.resolvedTarget}" is a Windows program or page, and this computer is not running Windows.`,
    });
  }
  return openTarget(target, resolved.resolvedTarget);
}

export default { execute };
