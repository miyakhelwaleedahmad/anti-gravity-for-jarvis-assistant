/**
 * security/browserPolicy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The rules browser actions follow (docs/upgrade/BROWSER_CONTROL.md), shared by
 * the risk engine, which decides before anything runs, and control/browserAgent,
 * which checks again before it acts.
 *
 * The words rules are a heuristic on the label of the element JARVIS saw:
 * they raise the risk of a click, never lower it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { approvedFolders } from '../control/fileController.js';
import { isPathInside, isProtectedSystemPath } from '../core/workspaceRoot.js';

export const NOT_OBSERVED =
  'JARVIS acts only on page elements it has looked at: read the page with browser_page_structure, then use one of its references.';
export const NO_CREDENTIALS = 'JARVIS does not type passwords, card numbers or one-time codes. Please type it yourself.';

/** An address as typed ("example.com/x") made complete ("https://example.com/x"). */
export function normalizeUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(text)) return `http://${text}`;
  if (/^[a-z0-9.-]+\.[a-z0-9-]+:\d+([/?#]|$)/i.test(text)) return `https://${text}`; // host:port
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  return /^[^\s/:]+\.[^\s/:]+([/?#:]|$)/.test(text) ? `https://${text}` : text;
}

/** Why JARVIS will not open `raw`, or undefined. `allowBlank`: an empty new tab is fine. */
export function urlProblem(raw: string, allowBlank = false): string | undefined {
  const text = normalizeUrl(raw);
  if (allowBlank && (text === '' || text === 'about:blank')) return undefined;
  let url: URL;
  try { url = new URL(text); } catch { return `"${text.slice(0, 80)}" is not a web address.`; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `JARVIS opens only http and https addresses, not ${url.protocol} ones.`;
  }
  if (url.username || url.password) return 'JARVIS does not open addresses with a user name or password in them.';
  return undefined;
}

/**
 * A loopback, private-network, link-local or .local address (SEC-17): local
 * admin pages (a router, a dev server's /docs, the vector service on :8000)
 * that a page read by JARVIS could try to make it open.
 */
export function isPrivateAddress(raw: string): boolean {
  let host: string;
  try { host = new URL(normalizeUrl(raw)).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0' || host === '::1' || host === '::') return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** The address's host appears in `text` (the user's request, or an agent's task). */
export function hostNamedIn(raw: string, text: string | undefined): boolean {
  if (!text) return false;
  let host: string;
  try { host = new URL(normalizeUrl(raw)).hostname.toLowerCase(); } catch { return false; }
  const t = text.toLowerCase();
  if (t.includes(host)) return true;
  // "localhost:3000", "port 3000" for a local server the user asked about.
  const port = (() => { try { return new URL(normalizeUrl(raw)).port; } catch { return ''; } })();
  return isPrivateAddress(raw) && !!port && new RegExp(`\\b(?:localhost|port)\\s*:?\\s*${port}\\b`).test(t);
}

/**
 * The level of opening `raw` (0 = no change), from where it points and who
 * asked (SEC-04, SEC-17). Decided here, in code: a web page or document read
 * along the way cannot lower it.
 *   - a local or private address the request did not name: 2 (asks)
 *   - an agent opening a site its task does not name: 2 (an agent's limit is
 *     1, so it is refused; the agent cannot carry data to a new site)
 */
export function navigationLevel(
  raw: string,
  requestText: string | undefined,
  byAgent: boolean,
  /** A local address JARVIS itself serves (a dev server it started): not a foreign admin page. */
  trustedLocal: (url: string) => boolean = () => false,
): { level: 0 | 2; why?: string } {
  if (!raw || raw === 'about:blank') return { level: 0 };
  if (isPrivateAddress(raw) && trustedLocal(raw)) return { level: 0 };
  if (isPrivateAddress(raw) && !hostNamedIn(raw, requestText)) {
    return { level: 2, why: 'a local or private network address the request did not name' };
  }
  if (byAgent && !hostNamedIn(raw, requestText)) {
    return { level: 2, why: "an agent opening a site its task does not name" };
  }
  return { level: 0 };
}

const LEVEL4_WORDS = /\b(pay|pay now|payment|buy|buy now|purchase|place (?:your |my )?order|complete (?:your |my )?(?:order|purchase)|checkout|check out|donate|transfer|send money|confirm (?:and )?pay(?:ment)?)\b/i;
const LEVEL3_WORDS = /\b(delete|remove|erase|deactivate|close (?:my |your )?account|unsubscribe|cancel (?:my |your )?(?:subscription|order|plan|account))\b/i;
const LEVEL2_WORDS = /\b(send|submit|post|publish|share|reply|comment|tweet|upload|save|confirm|apply|sign ?up|register|log ?in|sign ?in|follow|like|subscribe|accept|book|reserve|vote|invite)\b/i;

/** The risk a click on an element with this label carries by its words alone (0 = none). */
export function wordsLevel(label: string): { level: 0 | 2 | 3 | 4; why?: string } {
  if (LEVEL4_WORDS.test(label)) return { level: 4, why: 'the button pays, buys or sends money' };
  if (LEVEL3_WORDS.test(label)) return { level: 3, why: 'the button deletes, removes or cancels something' };
  if (LEVEL2_WORDS.test(label)) return { level: 2, why: 'the button sends, posts, saves or signs in' };
  return { level: 0 };
}

/** Keys, passwords and credential stores: never uploaded. */
const SENSITIVE_FILE = /(^|[\\/])(\.env(\.[^\\/]*)?|id_[a-z0-9]+(\.pub)?|credentials(\.json)?|[^\\/]*\.(pem|key|p12|pfx|kdbx|ppk|asc|gpg|keychain|keychain-db))$/i;
const SENSITIVE_FOLDER = /(^|[\\/])\.(ssh|aws|gnupg|azure|kube|docker)([\\/]|$)/i;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function realRoots(): string[] {
  return approvedFolders().map((root) => {
    try { return fs.realpathSync(root); } catch { return root; }
  });
}

/** Why `file` cannot be uploaded, or undefined. Links are followed before the folder check. */
export function uploadPathProblem(file: string): string | undefined {
  if (!file.trim()) return 'Name the file to upload.';
  let real: string;
  try { real = fs.realpathSync(path.resolve(file)); } catch { return `${path.basename(file)} does not exist.`; }
  if (isProtectedSystemPath(real) || !realRoots().some((root) => isPathInside(root, real))) {
    return 'JARVIS uploads files only from your approved folders (the JARVIS folder, Desktop, Documents, Downloads, temp).';
  }
  if (SENSITIVE_FILE.test(real) || SENSITIVE_FOLDER.test(real)) return 'JARVIS does not upload keys, passwords or credential files.';
  const stat = fs.statSync(real);
  if (!stat.isFile()) return 'Only a file can be uploaded, not a folder.';
  if (stat.size > MAX_UPLOAD_BYTES) return `${path.basename(real)} is larger than 100 MB.`;
  return undefined;
}

/** The real path of an upload that passed `uploadPathProblem`. */
export function realUploadPath(file: string): string {
  return fs.realpathSync(path.resolve(file));
}
