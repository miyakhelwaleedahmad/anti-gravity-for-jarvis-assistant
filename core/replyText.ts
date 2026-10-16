/**
 * core/replyText.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What JARVIS says about a result: the spoken replies built from tool output
 * (desktop and YouTube actions, trending videos, system and server status,
 * terminal commands, repairs) and the capability summaries. Moved out of
 * core/orchestrator.ts unchanged (ARCH-01, step 3); tests/replyGoldenTest.ts
 * records the replies for fixed inputs and fails on any difference.
 *
 * Text only: nothing here runs a tool or speaks.
 */

import { toolRegistryV2, type ToolCategory, type ToolResult } from './toolRegistryV2.js';
import { APPROVAL_DENIED_REPLY, isPermissionDenial } from '../control/permissionDenial.js';
import { describeSnapshot } from '../perception/systemProbe.js';
import { describeServers } from '../perception/devProbe.js';
import { parseItems } from './agents/behaviors/news.js';

const CATEGORY_PHRASES: Record<ToolCategory, string> = {
  OBSERVATION: 'check the state of your PC',
  BROWSER: 'work with browser tabs',
  COMPUTER: 'control your apps and windows',
  FILESYSTEM: 'read and write files',
  TERMINAL: 'run approved terminal commands',
  DEVELOPMENT: 'read code for you',
  NETWORK: 'look things up online',
  COMMUNICATION: 'send messages',
  SCHEDULING: 'manage your schedule',
  MEMORY: 'remember facts and search documents',
  SYSTEM: 'manage processes and services',
};

/** What JARVIS says after a YouTube or site search on screen: what it saw, not only what it did. */
export function desktopReply(type: string, d: Record<string, string>, result: ToolResult | undefined): string {
  const r = (result?.output ? parseJson(result.output) : null) as {
    success?: boolean; did?: string; error?: string; check?: { status: string; evidence: string };
    results?: { title: string; channel?: string }[]; chosen?: { title: string; channel?: string };
  } | null;
  if (!r) return result?.error === 'APPROVAL_DENIED' ? APPROVAL_DENIED_REPLY : 'I could not do that, sir.';
  if (!r.success) return `I could not do that, sir. ${(r.error ?? '').slice(0, 160)}`;
  const status = r.check?.status;
  const evidence = (r.check?.evidence ?? '').replace(/\.$/, '');
  if (status === 'unverifiable') return `I opened it in your browser, sir, but I could not check it: ${evidence.slice(0, 160)}.`;
  if (type === 'youtube_search') {
    if (r.chosen) {
      const who = r.chosen.channel ? ` by ${r.chosen.channel}` : '';
      return status === 'verified' ? `Playing "${r.chosen.title.slice(0, 90)}"${who}, sir.` : `I opened "${r.chosen.title.slice(0, 90)}"${who}, sir, but ${evidence}.`;
    }
    if (status === 'verified' && r.results?.length) return `Here are the YouTube results for "${(d['query'] ?? '').slice(0, 60)}", sir. The first is "${r.results[0]!.title.slice(0, 90)}".`;
    return `I opened YouTube for "${(d['query'] ?? '').slice(0, 60)}", sir, but ${evidence || 'I could not read the results'}.`;
  }
  if (type === 'youtube_play') return status === 'verified' ? (d['action'] === 'pause' ? 'Paused, sir.' : 'Playing, sir.') : `I tried, sir, but ${evidence}.`;
  return status === 'verified' ? `Here are the ${d['site']} results for "${(d['query'] ?? '').slice(0, 60)}", sir.` : `I opened ${d['site']}, sir, but ${evidence || 'could not check the page'}.`;
}

/** The trending answer: the source, then the first three, from the tool's own text. */
export function trendingReply(result: ToolResult | undefined): string {
  const out = result?.output ?? '';
  if (!result?.success || /^\s*Error/.test(out)) return `I can't get trending videos right now, sir. ${out.replace(/^\s*Error:\s*/, '').slice(0, 200)}`;
  const items = parseItems(out);
  if (!items.length) return out.split('\n')[0]!.slice(0, 200);
  const official = /mostPopular/.test(out.split('\n')[0] ?? '');
  const region = /region (\w{2})/.exec(out)?.[1] ?? '';
  const top = items.slice(0, 3).map((i) => `${i.n}. ${i.title.slice(0, 70)}${i.meta.split(' · ')[0] ? ` by ${i.meta.split(' · ')[0]}` : ''}`).join('; ');
  return official
    ? `On YouTube's most-popular chart${region ? ` for ${region}` : ''} right now, sir: ${top}. The full list is in the console.`
    : `I don't have YouTube's own chart without a YouTube API key, sir. Video search shows these recent popular videos: ${top}. That is search order, not a ranking; the list is in the console.`;
}

/** Why a repair step did not run, or failed, in words. */
export function repairFailure(result: ToolResult | undefined): string {
  if (result?.error === 'APPROVAL_DENIED') return 'it was not approved';
  if (result?.error === 'RATE_LIMITED') return 'too many actions ran in the last minute';
  if (isPermissionDenial(result?.error ?? '') || isPermissionDenial(result?.output ?? '')) {
    return 'it needs full control mode; say "enable full control mode" and ask again';
  }
  if (result?.error === 'RISK_REFUSED') {
    return `the safety policy refused it (${(result.output ?? '').replace(/^Refused by safety policy:\s*/, '').slice(0, 120)})`;
  }
  return `that failed: ${(result?.verification?.evidence ?? result?.output ?? 'no result').slice(0, 120)}`;
}

export function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

/** The spoken summary of a system_overview result. */
export function systemStatusReply(output: string): string {
  try {
    return describeSnapshot(JSON.parse(output));
  } catch {
    return 'I could not read the system state, sir.';
  }
}

/** The spoken summary of a dev_status result. */
export function devStatusReply(output: string): string {
  try {
    return describeServers(JSON.parse(output).ports ?? []);
  } catch {
    return 'I could not check the local servers, sir.';
  }
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** "what can you do" / "who are you", from the registry's metadata. */
export function capabilitiesReply(withIdentity = false): string {
  const groups = toolRegistryV2.describeCapabilities();
  const count = groups.reduce((n, g) => n + g.tools.length, 0);
  const lead = withIdentity ? 'I am JARVIS, your assistant, sir. ' : '';
  if (count === 0) return `${lead}My tools are still loading, sir.`;
  const things = joinWords(groups.map((g) => CATEGORY_PHRASES[g.category]));
  return `${lead}I have ${count} tools: I can ${things}. Say "list your tools" for each tool and its risk.`;
}

export function capabilityListReply(): string {
  const groups = toolRegistryV2.describeCapabilities();
  const count = groups.reduce((n, g) => n + g.tools.length, 0);
  const needApproval = groups.flatMap((g) => g.tools).filter((t) => t.approval === 'required').length;
  return `I have ${count} tools in ${groups.length} groups, sir; ${needApproval} of them include high-risk actions. ` +
    'The full list with the risk of each is in the console.';
}

/**
 * What to say after run_command. Its output starts "Exit code: N"; a failed
 * command with long output used to be reported as "Task completed, sir."
 */
export function describeCommandResult(result: string): string {
  const match = /^Exit code: (-?\d+|null)(?:\s*Output:)?([\s\S]*)$/.exec(result.trim());
  if (!match) return result.length < 150 ? result : 'Done, sir. The output is in the console.';
  const [, code, rest = ''] = match;
  const output = rest.trim();
  const firstLine = output.split('\n').map((l) => l.trim()).find((l) => l && l !== '(no output)') ?? '';
  if (code === '0') {
    if (!firstLine) return 'Done, sir.';
    return output.length < 150 ? `Done, sir. ${firstLine}` : 'Done, sir. The output is in the console.';
  }
  const why = firstLine && firstLine.length <= 120 ? ` ${firstLine}` : ' The output is in the console.';
  return code === 'null'
    ? `The command did not finish normally, sir.${why}`
    : `The command failed with exit code ${code}, sir.${why}`;
}
