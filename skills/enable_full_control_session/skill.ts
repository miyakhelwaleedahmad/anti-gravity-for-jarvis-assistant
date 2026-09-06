/**
 * skills/enable_full_control_session/skill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 — Full Control Session lifecycle management.
 *
 * Supports:
 *   - enable  (default)  — request approval then activate
 *   - renew              — extend active session without re-approval
 *   - disable            — immediately revoke
 *   - status             — read current session state
 *
 * Voice approval is threaded through to permissionSession.activateFullControl()
 * so it shows in the session log.
 */

import { permissionSession } from '../../control/permissionSession.js';
import { approvalGate } from '../../security/approvalGate.js';
import { securityAuditLogger } from '../../security/securityAuditLogger.js';

export async function execute(args: Record<string, unknown> = {}): Promise<string> {
  const action = String(args['action'] ?? 'enable').toLowerCase();

  // ── Validate source ─────────────────────────────────────────────────────
  const source = (['voice', 'cli', 'gui', 'auto'].includes(String(args['source'] ?? ''))
    ? String(args['source'])
    : 'cli') as 'voice' | 'cli' | 'gui' | 'auto';

  const durationMinutes = Math.min(Math.max(Number(args['durationMinutes'] ?? 10), 1), 120);

  // ── action: status ──────────────────────────────────────────────────────
  if (action === 'status') {
    const snap = permissionSession.getSessionSnapshot();
    const remaining = permissionSession.getRemainingSeconds();
    const remainStr = remaining !== null
      ? `${Math.floor(remaining / 60)}m ${remaining % 60}s`
      : 'N/A';
    return (
      `${permissionSession.getStatus()} | ` +
      `Session: ${snap.sessionId ?? 'none'} | ` +
      `Remaining: ${remainStr} | ` +
      `Activated by: ${snap.activatedBy ?? 'N/A'}`
    );
  }

  // ── action: disable ─────────────────────────────────────────────────────
  if (action === 'disable') {
    permissionSession.deactivateFullControl(`manual_by_${source}`);
    return permissionSession.getStatus();
  }

  // ── action: renew ───────────────────────────────────────────────────────
  if (action === 'renew') {
    if (!permissionSession.isFullControlActive()) {
      return 'No active full control session to renew. Please enable a session first, sir.';
    }
    const renewed = permissionSession.extendSession(durationMinutes);
    if (!renewed) {
      return 'Session renewal failed, sir. The session may have already expired.';
    }
    return `Full control session renewed by ${durationMinutes} min. ${permissionSession.getStatus()}`;
  }

  // ── action: enable (default) ────────────────────────────────────────────
  const isVoice = source === 'voice';
  const approved = await approvalGate.requestApproval(
    'Enable Full Control Session',
    `enable_full_control_session for ${durationMinutes} minute(s)`,
    'HIGH_RISK',
    'Full control permits keyboard, mouse, file, and app control. It is denied by default.',
    isVoice ? 'voice' : source as any,
    isVoice ? 10 : undefined,
  );

  if (!approved) {
    securityAuditLogger.fullControlSession(
      'activate_denied',
      false,
      'Full Control Session was not explicitly approved.',
    );
    return 'Error: Full control session was cancelled because explicit approval was not provided, sir.';
  }

  // Activate with voice-approval flag threaded through
  permissionSession.activateFullControl(durationMinutes, source, isVoice);
  return permissionSession.getStatus();
}

export default { execute };
