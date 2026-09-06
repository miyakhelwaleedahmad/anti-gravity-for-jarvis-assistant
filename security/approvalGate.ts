/**
 * security/approvalGate.ts
 * Real human-in-the-loop approval gate.
 *
 * Dangerous actions require explicit confirmation. Console/text mode accepts
 * YES, APPROVE, or CONFIRM. Voice mode speaks the request, accepts voice or
 * typed confirmation, and denies quickly on timeout.
 */

import * as readline from 'readline';
import { securityAuditLogger } from './securityAuditLogger.js';

type ApprovalSource = 'cli' | 'voice' | 'text' | 'llm';

const DEFAULT_TIMEOUT_SECONDS = 30;
const VOICE_TIMEOUT_SECONDS = 10;

export class ApprovalGate {
  public async requestApproval(
    action: string,
    command: string,
    riskLevel: string = 'HIGH_RISK',
    reason: string = 'This action requires explicit human confirmation.',
    sourceOrTimeout: ApprovalSource | number = 'cli',
    timeoutSecs?: number,
  ): Promise<boolean> {
    const source: ApprovalSource = typeof sourceOrTimeout === 'number' ? 'cli' : sourceOrTimeout;
    const effectiveTimeoutSecs = timeoutSecs ?? (typeof sourceOrTimeout === 'number'
      ? sourceOrTimeout
      : source === 'voice'
        ? VOICE_TIMEOUT_SECONDS
        : DEFAULT_TIMEOUT_SECONDS);

    securityAuditLogger.approvalRequested(action, command, riskLevel);

    console.log('\n' + '='.repeat(65));
    console.log('JARVIS SECURITY GATE - APPROVAL REQUIRED');
    console.log('='.repeat(65));
    console.log(`  Action Type  : ${action}`);
    console.log(`  Command/Path : ${command}`);
    console.log(`  Risk Level   : ${riskLevel}`);
    console.log(`  Source       : ${source}`);
    console.log(`  Reason       : ${reason}`);
    console.log('-'.repeat(65));
    console.log('  Type YES, APPROVE, or CONFIRM to allow.');
    console.log(`  Anything else - or no response in ${effectiveTimeoutSecs}s - will DENY.`);
    console.log('='.repeat(65) + '\n');

    let approved = false;

    try {
      const response = source === 'voice'
        ? await this._voiceOrTextPromptWithTimeout(action, command, effectiveTimeoutSecs * 1000)
        : await this._promptWithTimeout('  Your decision: ', effectiveTimeoutSecs * 1000);

      const clean = response.trim().toUpperCase();
      approved = clean === 'YES' || clean === 'APPROVE' || clean === 'CONFIRM';
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'APPROVAL_TIMEOUT') {
        console.warn('\n  Approval timeout - action DENIED by default.\n');
        securityAuditLogger.approvalTimeout(action, command);
        return false;
      }
      console.error(`\n  Approval gate error: ${String(err)} - action DENIED.\n`);
      securityAuditLogger.approvalDenied(action, command, `Error during approval: ${String(err)}`);
      return false;
    }

    if (approved) {
      console.log('  Approved by user.\n');
      securityAuditLogger.approvalGranted(action, command);
    } else {
      console.log('  Denied by user input.\n');
      securityAuditLogger.approvalDenied(action, command, 'User did not type YES, APPROVE, or CONFIRM');
    }

    return approved;
  }

  private _promptWithTimeout(prompt: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!process.stdin.isTTY) {
        reject(new Error('APPROVAL_TIMEOUT'));
        return;
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rl.close();
          reject(new Error('APPROVAL_TIMEOUT'));
        }
      }, timeoutMs);

      rl.question(prompt, (answer) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rl.close();
          resolve(answer);
        }
      });

      rl.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('APPROVAL_TIMEOUT'));
        }
      });
    });
  }

  private async _voiceOrTextPromptWithTimeout(
    action: string,
    command: string,
    timeoutMs: number,
  ): Promise<string> {
    const seconds = Math.ceil(timeoutMs / 1000);
    const spoken = `Approval required to ${action}. Say confirm or type APPROVE within ${seconds} seconds. Otherwise I will cancel it.`;

    try {
      const { nodeBridge } = await import('../bridge/nodeBridge.js');
      nodeBridge.speakToClients(spoken);

      const voicePromise = nodeBridge.waitForTextConfirmation(timeoutMs);
      const textPromise = process.stdin.isTTY
        ? this._promptWithTimeout('  Voice action decision: ', timeoutMs)
        : new Promise<string>(() => {});

      const response = await Promise.race([voicePromise, textPromise]);
      if (!response) {
        nodeBridge.speakToClients(`Approval timed out. I cancelled ${action}.`);
        throw new Error('APPROVAL_TIMEOUT');
      }
      return response;
    } catch (err) {
      if (err instanceof Error && err.message === 'APPROVAL_TIMEOUT') {
        try {
          const { nodeBridge } = await import('../bridge/nodeBridge.js');
          nodeBridge.speakToClients(`Approval timed out. I cancelled ${action}.`);
        } catch {}
      }
      throw err;
    }
  }
}

export const approvalGate = new ApprovalGate();
