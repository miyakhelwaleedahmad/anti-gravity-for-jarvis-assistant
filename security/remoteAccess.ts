/**
 * security/remoteAccess.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Groundwork for remote access (OPS-02). Remote access is NOT available:
 * every JARVIS listener binds loopback only, and this module is the one rule
 * for that. The request policy below decides what a remote request could do
 * if a remote listener is ever added; today no listener passes remote
 * requests to it, and with the defaults it refuses everything.
 *
 * Threat model and requirements: docs/remediation/REMOTE_ACCESS.md.
 *
 * What a remote request must have before anything else is considered:
 *   - TLS (a remote listener without TLS is refused at the policy level)
 *   - a registered, unrevoked device, proved by its key (per-device identity)
 *   - a fresh request (signed time within 60 s) and a nonce not seen before
 * And what it can never do remotely, whatever the device may:
 *   - approve an action (approvals stay at the PC: console or voice)
 *   - run a tool above the device's risk cap, which is at most level 1
 *   - change permissions, full control, devices or the policy itself
 */

export const LOOPBACK_BIND_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

/** Throws unless `host` is a loopback address. Every JARVIS listener calls this. */
export function assertLoopbackBind(host: string, service: string): void {
  if (!LOOPBACK_BIND_HOSTS.has(String(host ?? '').trim().toLowerCase())) {
    throw new Error(`${service} listens only on this PC (127.0.0.1, ::1 or localhost), not "${host}". Remote access is not available.`);
  }
}

/** Remote access is off; there is no switch for it yet (OPS-02 groundwork only). */
export function remoteAccessEnabled(): boolean {
  return false;
}

/** The highest tool risk a remote device could ever be given. */
export const REMOTE_MAX_RISK = 1;
/** How old a signed remote request may be. */
export const REMOTE_MAX_AGE_MS = 60_000;

export interface RemoteDevice {
  id: string;
  /** Fingerprint of the device's public key, recorded when it was paired at the PC. */
  keyFingerprint: string;
  revokedAt?: number;
  /** Highest tool risk this device may run (capped at REMOTE_MAX_RISK). */
  maxRisk: number;
  /** Tool names this device may call; nothing else. */
  tools: string[];
}

export interface RemoteRequest {
  tls: boolean;
  deviceId?: string;
  /** Fingerprint of the key that signed this request (checked by the listener). */
  signedBy?: string;
  signatureValid: boolean;
  sentAt: number;
  nonce: string;
  kind: 'tool' | 'approve' | 'admin' | 'status';
  tool?: string;
  /** The tool call's risk as the risk engine assessed it (0–4). */
  risk?: number;
}

export interface RemoteDecision {
  allowed: boolean;
  reason: string;
}

/**
 * What a remote request may do. Pure: the caller supplies the devices and
 * the nonces already seen. With remote access off (always, for now), the
 * answer is no; the later checks are the order a future listener must apply.
 */
export function decideRemoteRequest(
  req: RemoteRequest,
  devices: ReadonlyMap<string, RemoteDevice>,
  seenNonces: Set<string>,
  now = Date.now(),
  enabled = remoteAccessEnabled(),
): RemoteDecision {
  const no = (reason: string): RemoteDecision => ({ allowed: false, reason });
  if (!enabled) return no('Remote access is not available.');
  if (!req.tls) return no('Remote requests need TLS.');
  const device = req.deviceId ? devices.get(req.deviceId) : undefined;
  if (!device) return no('Unknown device.');
  if (device.revokedAt !== undefined && device.revokedAt <= now) return no('This device was revoked.');
  if (!req.signatureValid || req.signedBy !== device.keyFingerprint) return no('The request is not signed by this device\'s key.');
  if (!Number.isFinite(req.sentAt) || Math.abs(now - req.sentAt) > REMOTE_MAX_AGE_MS) return no('The request is too old or from the future.');
  if (!req.nonce || seenNonces.has(req.nonce)) return no('The request was already used.');
  seenNonces.add(req.nonce);
  if (req.kind === 'approve') return no('Approvals are given at the PC only.');
  if (req.kind === 'admin') return no('Permissions, full control and devices are changed at the PC only.');
  if (req.kind === 'status') return { allowed: true, reason: 'Status is read-only.' };
  if (!req.tool || !device.tools.includes(req.tool)) return no('This device may not call that tool.');
  const cap = Math.min(device.maxRisk, REMOTE_MAX_RISK);
  if (typeof req.risk !== 'number' || req.risk > cap) return no(`Remote calls are limited to risk level ${cap}.`);
  return { allowed: true, reason: 'Within this device\'s tools and risk cap.' };
}
