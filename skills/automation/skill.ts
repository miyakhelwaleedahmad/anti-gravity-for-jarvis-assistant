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
import { resolveTargetUrl } from '../../security/openAppPolicy.js';
import { showInJarvisChrome } from '../../control/jarvisChrome.js';

// open_app's allow-lists and checks live in security/openAppPolicy.ts (ARCH-04).
export { resolveTargetUrl };

type OpenAppSource = 'voice' | 'text' | 'llm';

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
    const platform = process.platform;

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

    try {
      const proc = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
        // The app JARVIS opens does not get JARVIS's keys and tokens (SEC-06).
        env: childEnv(),
        ...(platform === 'win32' ? { windowsHide: true } : {})
      });

      let errorOccurred = false;
      proc.on('error', (err) => {
        errorOccurred = true;
        resolve(JSON.stringify({
          success: false,
          target,
          resolvedTarget,
          platform,
          method,
          error: err.message
        }));
      });

      proc.unref();

      // Give Node event loop a tick to register immediate spawn failures
      setTimeout(() => {
        if (!errorOccurred) {
          resolve(JSON.stringify({
            success: true,
            target,
            resolvedTarget,
            platform,
            method
          }));
        }
      }, 50);
    } catch (err: any) {
      resolve(JSON.stringify({
        success: false,
        target,
        resolvedTarget,
        platform,
        method,
        error: String(err)
      }));
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
  return openTarget(target, resolved.resolvedTarget);
}

export default { execute };
