/**
 * control/tabClose.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The one rule for closing a tab of JARVIS's Chrome, whichever tool closes it
 * (control_browser close, browser_tab close): phase A4, owner decision Q2,
 * review R1/R2.
 *
 *   - level 1 for a YouTube tab (its address is on youtube.com) or a blank
 *     tab; level 2 (full control) for any other tab. Decided from the tab
 *     that was found, not from the words asked: "youtube" can match a Google
 *     sign-in page or a GitHub repository.
 *   - a sensitive tab (GitHub, Antigravity) asks the owner first.
 */

import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import type { CdpTarget } from '../perception/cdpClient.js';

/** A tab whose address is on youtube.com (any subdomain), or about:blank. */
export function isYouTubeOrBlankTab(tab: Pick<CdpTarget, 'url'>): boolean {
  if (tab.url.trim().toLowerCase() === 'about:blank') return true;
  try {
    const u = new URL(tab.url);
    const host = u.hostname.toLowerCase();
    return /^https?:$/.test(u.protocol) && (host === 'youtube.com' || host.endsWith('.youtube.com'));
  } catch {
    return false;
  }
}

function isSensitiveTab(tab: Pick<CdpTarget, 'title' | 'url'>): boolean {
  const text = `${tab.title} ${tab.url}`.toLowerCase();
  return text.includes('antigravity') || text.includes('github');
}

const short = (t: string) => (t.length > 60 ? `${t.slice(0, 59)}…` : t);

/**
 * Throws when this tab may not be closed now: the session's level is too low
 * for it, or it is sensitive and the owner did not approve.
 */
export async function checkTabClose(
  tab: Pick<CdpTarget, 'title' | 'url'>,
  approve: (title: string, command: string) => Promise<boolean> = (title, command) => approvalGate.requestApproval(title, command),
): Promise<void> {
  const level = isYouTubeOrBlankTab(tab) ? 1 : 2;
  if (!permissionSession.checkPermission(level, `Close tab: ${tab.title}`)) {
    throw new Error(`Permission level ${level} required to close the tab "${short(tab.title || tab.url)}".`);
  }
  if (isSensitiveTab(tab)) {
    const approved = await approve('Close browser tab', `Close sensitive tab: "${short(tab.title || tab.url)}"`);
    if (!approved) throw new Error('Action cancelled by user.');
  }
}

/**
 * What JARVIS says when a fast tab route did not act and the reason is for the
 * owner (owner's approval of 2026-11-01): the question about which tab, alone
 * (not after "I tried … but encountered an issue"), or that JARVIS's Chrome is
 * not running (that reason is too long for the route's 120 characters, so
 * only "encountered an issue" was said). Anything else: undefined, and the
 * route says what it said before.
 */
export function tabRouteReply(result: { error?: string; output?: string } | undefined): string | undefined {
  const reason = (result?.error ?? '').replace(/^Error:\s*/, '').trim();
  if (/^(?:Which tab, sir\?|No tab is on screen)/.test(reason) && reason.length <= 160) return reason;
  // At the start of the reason only: a refusal can quote a page title, and a page chooses its title (review R18).
  if (/^JARVIS's own Chrome is not running, so no tab was changed/.test(reason)) {
    return 'My Chrome is not running, sir, so I did not change any tab.';
  }
  return undefined;
}
