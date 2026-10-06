/**
 * core/tools/browserActionTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Browser actions (docs/upgrade/BROWSER_CONTROL.md), carried out by
 * control/browserAgent.ts. Element actions take a reference from
 * browser_page_structure; the risk engine decides from what that element is
 * (security/browserPolicy.ts). Each action checks the page afterwards; `verify`
 * hands that check to the registry (P5), so an action whose effect was not
 * seen is reported as not done.
 */

import type { AgentTool, ToolSchemaProperty } from '../toolRegistryV2.js';
import type { Verifier } from '../verifiers.js';
import * as agent from '../../control/browserAgent.js';

/** The check the action made itself. */
const ownCheck: Verifier = async (_args, output) => {
  try {
    const report = JSON.parse(output) as agent.ActionReport;
    if (report.check && ['verified', 'failed', 'unverifiable'].includes(report.check.status)) {
      return { status: report.check.status, evidence: String(report.check.evidence) };
    }
  } catch {
    // not a report
  }
  return { status: 'unverifiable', evidence: 'the action reported no check' };
};

const result = (report: agent.ActionReport): string => JSON.stringify(report, null, 2);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const flag = (value: unknown, fallback: boolean): boolean => (value === undefined ? fallback : value === true || value === 'true');

const REF: ToolSchemaProperty = { type: 'string', description: 'A reference from browser_page_structure, such as "e12".', required: true };
const TAB: ToolSchemaProperty = {
  type: 'string', description: 'Which tab: its id, or words from its title or address. Default: the tab on screen.', required: false,
};

export const browserNavigateTool: AgentTool = {
  name: 'browser_navigate',
  description:
    'Use to open a web address in a tab, or to go back, forward or reload. Parameters: action (go, back, forward, reload), ' +
    'url (for go; http or https), tab (optional). JARVIS checks that the tab shows the page afterwards.',
  riskLevel: 'medium',
  inputSchema: {
    action: { type: 'string', description: 'go, back, forward or reload', required: true, enum: ['go', 'back', 'forward', 'reload'] },
    url: { type: 'string', description: 'The address to open (action go).', required: false },
    tab: TAB,
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return result(await agent.navigate({ action: args['action'], url: args['url'], tab: args['tab'] }));
  },
};

export const browserTabTool: AgentTool = {
  name: 'browser_tab',
  description:
    'Use to open a new tab (with an optional address), switch to a tab, or close a tab. Parameters: action (new, switch, close), ' +
    'url (for new), tab (for switch and close: id or words from its title or address; close defaults to the tab on screen).',
  riskLevel: 'medium',
  inputSchema: {
    action: { type: 'string', description: 'new, switch or close', required: true, enum: ['new', 'switch', 'close'] },
    url: { type: 'string', description: 'Address for a new tab.', required: false },
    tab: TAB,
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return result(await agent.tab({ action: args['action'], url: args['url'], tab: args['tab'] }));
  },
};

export const browserClickTool: AgentTool = {
  name: 'browser_click',
  description:
    'Use to click a link, button or field on a web page. Parameter: ref — a reference from browser_page_structure (read the page ' +
    'first). JARVIS checks the element is still there and visible, clicks it, and reports what changed. Buttons that submit, ' +
    'send, delete or pay need approval.',
  riskLevel: 'medium',
  inputSchema: { ref: REF },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return result(await agent.click(args['ref']));
  },
};

export const browserTypeTool: AgentTool = {
  name: 'browser_type',
  description:
    'Use to type text into a field on a web page. Parameters: ref (from browser_page_structure), text, clear (default true: ' +
    'replace what is there), enter (default false: press Enter after typing). Never types into password, card or ' +
    'one-time-code fields. JARVIS checks the field holds the text.',
  riskLevel: 'medium',
  inputSchema: {
    ref: REF,
    text: { type: 'string', description: 'What to type.', required: true },
    clear: { type: 'boolean', description: 'Replace the field\'s text (default true).', required: false },
    enter: { type: 'boolean', description: 'Press Enter afterwards (default false).', required: false },
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return result(await agent.type(args['ref'], args['text'], { clear: flag(args['clear'], true), enter: flag(args['enter'], false) }));
  },
};

export const browserSelectTool: AgentTool = {
  name: 'browser_select',
  description:
    'Use to choose an option in a drop-down list on a web page. Parameters: ref (from browser_page_structure), option (its ' +
    'visible text or value). JARVIS checks the list shows it afterwards.',
  riskLevel: 'medium',
  inputSchema: { ref: REF, option: { type: 'string', description: 'The option\'s text or value.', required: true } },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return result(await agent.choose(args['ref'], args['option']));
  },
};

export const browserScrollTool: AgentTool = {
  name: 'browser_scroll',
  description:
    'Use to scroll a web page: to an element (ref from browser_page_structure) or up, down, to the top or to the bottom ' +
    '(direction). Optional tab. JARVIS checks the page moved.',
  riskLevel: 'medium',
  inputSchema: {
    ref: { type: 'string', description: 'Scroll this element into view.', required: false },
    direction: { type: 'string', description: 'up, down, top or bottom (default down)', required: false, enum: ['up', 'down', 'top', 'bottom'] },
    tab: TAB,
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return result(await agent.scroll({ ref: args['ref'], direction: args['direction'], tab: args['tab'] }));
  },
};

export const browserScreenshotTool: AgentTool = {
  name: 'browser_screenshot',
  description:
    'Use to save a picture of a tab on this PC (it is not sent anywhere or shown to the model). Optional tab. Returns the file path.',
  riskLevel: 'medium',
  inputSchema: { tab: TAB },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return result(await agent.screenshot(str(args['tab'])));
  },
};

export const browserDownloadTool: AgentTool = {
  name: 'browser_download',
  description:
    'Use to download the file a link points to, into the JARVIS download folder (Downloads\\jarvis). Parameter: ref of the ' +
    'link (from browser_page_structure). JARVIS checks the file is on disk. Downloaded files are never opened.',
  riskLevel: 'medium',
  inputSchema: { ref: REF },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return result(await agent.download(args['ref']));
  },
};

export const browserUploadTool: AgentTool = {
  name: 'browser_upload',
  description:
    'Use to put a file into a file field on a web page (it is sent when the form is submitted). Parameters: ref of the file ' +
    'field (from browser_page_structure), path of the file — only from approved folders (JARVIS folder, Desktop, Documents, ' +
    'Downloads, temp); never keys or credential files. Always asks for approval.',
  riskLevel: 'medium',
  inputSchema: { ref: REF, path: { type: 'string', description: 'The file to upload.', required: true } },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return result(await agent.upload(args['ref'], args['path']));
  },
};

export const browserActionTools: AgentTool[] = [
  browserNavigateTool, browserTabTool, browserClickTool, browserTypeTool, browserSelectTool,
  browserScrollTool, browserScreenshotTool, browserDownloadTool, browserUploadTool,
];
