/**
 * core/toolCatalog.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Metadata for every built-in tool: what kind of tool it is, how risky each
 * of its actions is (0 observe … 4 critical), whether the effect can be
 * undone, whether it reaches outside the PC, and what it returns.
 *
 * The registry attaches an entry at registration. A skill may instead declare
 * `meta` in its description.json, which takes precedence. A tool with neither
 * gets derived defaults and a startup warning, and toolRegistryMetadataTest
 * fails until it is given an entry here.
 *
 * Risk levels: docs/upgrade/PERMISSION_MODEL.md. This file only describes;
 * the risk engine (phase P2) enforces.
 */

import type { AgentTool, ActionMeta, RiskTier, ToolMeta } from './toolRegistryV2.js';

const JSON_RESULT = 'JSON: success, action, target, message or error';
const BROWSER_RESULT = 'JSON: success, action, target, did, check (status, evidence), page, or error';

/** Builds the metadata of a tool whose `action` argument selects what it does. */
function withActions(
  base: Omit<ToolMeta, 'risk' | 'actions'>,
  actions: Record<string, ActionMeta>,
): ToolMeta {
  const risk = Math.max(...Object.values(actions).map((a) => a.risk)) as RiskTier;
  return { ...base, risk, actions };
}

function observation(effect: string, output: ToolMeta['output'], category: ToolMeta['category'] = 'OBSERVATION'): ToolMeta {
  return { category, risk: 0, reversible: 'yes', external: 'none', effect, output };
}

export const TOOL_CATALOG: Readonly<Record<string, ToolMeta>> = {
  // ── Observation ─────────────────────────────────────────────────────────────
  get_system_info: observation('Reads OS, CPU, memory and uptime.',
    { format: 'text', description: 'System specification lines' }),
  get_system_state: observation('Reads the last observed system snapshot.',
    { format: 'json', description: 'Active window, open apps, Chrome tabs, services, system stats' }),
  get_pc_state: observation('Reads windows, apps, browser and JARVIS service state.',
    { format: 'text', description: 'Snapshot as JSON text' }),
  get_open_apps: observation('Lists applications with open windows.',
    { format: 'json', description: 'Array of apps: name, pid, window title' }),
  get_active_window: observation('Reads the focused window.',
    { format: 'json', description: 'Title, process name, pid' }),
  is_app_open: observation('Checks whether an application has an open window.',
    { format: 'text', description: '"true" or "false"' }),
  get_jarvis_service_status: observation("Reads which of JARVIS's own services are connected.",
    { format: 'json', description: 'Service name → connected / disconnected' }),

  // ── Browser ─────────────────────────────────────────────────────────────────
  get_browser_tabs: observation('Lists tabs of the Chrome debugging profile.',
    { format: 'json', description: 'Array of tabs: title, url, active' }, 'BROWSER'),
  is_tab_open: observation('Checks whether a tab title or URL matches.',
    { format: 'text', description: '"true" or "false"' }, 'BROWSER'),
  control_browser: withActions(
    { category: 'BROWSER', reversible: 'partial', external: 'query',
      effect: 'Lists, focuses, opens, refreshes or closes browser tabs.',
      output: { format: 'json', description: JSON_RESULT } },
    {
      list: { risk: 0, reversible: 'yes', effect: 'Lists open tabs.' },
      focus: { risk: 1, reversible: 'yes', effect: 'Brings a tab to the front.' },
      open_url: { risk: 1, reversible: 'yes', effect: 'Opens a web page in a new tab.' },
      refresh: { risk: 1, reversible: 'partial', effect: 'Reloads a tab; unsent form input is lost.' },
      close: { risk: 2, reversible: 'partial', effect: 'Closes a tab; it can be reopened, unsaved input is lost.' },
      close_current: { risk: 2, reversible: 'partial', effect: 'Closes the active tab; unsaved input is lost.' },
    },
  ),

  // ── Computer ────────────────────────────────────────────────────────────────
  open_app: {
    category: 'COMPUTER', risk: 1, reversible: 'yes', external: 'none',
    effect: 'Opens an allow-listed application or website.',
    output: { format: 'json', description: 'success, target, resolvedTarget or error' },
  },
  control_app: withActions(
    { category: 'COMPUTER', reversible: 'partial', external: 'none',
      effect: 'Opens, focuses, closes or restarts an application.',
      output: { format: 'json', description: JSON_RESULT } },
    {
      open: { risk: 1, reversible: 'yes', effect: 'Starts the application.' },
      focus: { risk: 1, reversible: 'yes', effect: 'Brings the application to the front.' },
      close: { risk: 2, reversible: 'partial', effect: 'Closes the application; unsaved work may be lost.' },
      restart: { risk: 2, reversible: 'partial', effect: 'Closes and reopens the application; unsaved work may be lost.' },
    },
  ),
  control_window: withActions(
    { category: 'COMPUTER', reversible: 'partial', external: 'none',
      effect: 'Focuses, moves, resizes, minimises, maximises or closes a window.',
      output: { format: 'json', description: JSON_RESULT } },
    {
      focus: { risk: 1, reversible: 'yes', effect: 'Brings the window to the front.' },
      minimize: { risk: 1, reversible: 'yes', effect: 'Minimises the window.' },
      maximize: { risk: 1, reversible: 'yes', effect: 'Maximises the window.' },
      // WindowController checks level 2 for these two.
      move: { risk: 2, reversible: 'yes', effect: 'Moves the window.' },
      resize: { risk: 2, reversible: 'yes', effect: 'Resizes the window.' },
      close: { risk: 2, reversible: 'partial', effect: 'Closes the window; unsaved work may be lost.' },
      close_current: { risk: 2, reversible: 'partial', effect: 'Closes the active window; unsaved work may be lost.' },
    },
  ),
  control_keyboard: withActions(
    { category: 'COMPUTER', reversible: 'no', external: 'none',
      effect: 'Types text or presses keys in the focused window.',
      output: { format: 'json', description: JSON_RESULT } },
    {
      type: { risk: 2, reversible: 'no', effect: 'Types text into the focused window.' },
      press_key: { risk: 2, reversible: 'no', effect: 'Presses one key in the focused window.' },
      press_hotkey: { risk: 2, reversible: 'no', effect: 'Presses a key combination in the focused window.' },
    },
  ),
  control_mouse: withActions(
    { category: 'COMPUTER', reversible: 'no', external: 'none',
      effect: 'Moves the pointer, clicks, scrolls or drags at screen coordinates.',
      output: { format: 'json', description: JSON_RESULT } },
    {
      move: { risk: 1, reversible: 'yes', effect: 'Moves the pointer.' },
      scroll: { risk: 1, reversible: 'yes', effect: 'Scrolls at the pointer.' },
      click: { risk: 2, reversible: 'no', effect: 'Clicks at a screen position.' },
      right_click: { risk: 2, reversible: 'no', effect: 'Right-clicks at a screen position.' },
      double_click: { risk: 2, reversible: 'no', effect: 'Double-clicks at a screen position.' },
      drag: { risk: 2, reversible: 'no', effect: 'Drags from one position to another.' },
    },
  ),

  // ── Files ───────────────────────────────────────────────────────────────────
  read_file: {
    category: 'FILESYSTEM', risk: 0, reversible: 'yes', external: 'none',
    effect: 'Reads a text file inside the JARVIS folder.',
    output: { format: 'text', description: 'File contents' },
  },
  write_file: {
    category: 'FILESYSTEM', risk: 2, reversible: 'no', external: 'none',
    effect: 'Creates or overwrites a text file inside the JARVIS folder.',
    output: { format: 'text', description: 'Confirmation or error' },
  },
  control_file: withActions(
    { category: 'FILESYSTEM', reversible: 'partial', external: 'none',
      effect: 'Searches, reads, writes, copies, moves, renames or deletes files in approved folders.',
      output: { format: 'json', description: JSON_RESULT } },
    {
      search: { risk: 0, reversible: 'yes', effect: 'Lists matching files.' },
      read: { risk: 0, reversible: 'yes', effect: 'Reads a file.' },
      create_folder: { risk: 2, reversible: 'yes', effect: 'Creates a folder.' },
      write: { risk: 2, reversible: 'no', effect: 'Writes a file; an existing file is overwritten.' },
      copy: { risk: 2, reversible: 'yes', effect: 'Copies a file.' },
      move: { risk: 2, reversible: 'yes', effect: 'Moves a file.' },
      rename: { risk: 2, reversible: 'yes', effect: 'Renames a file.' },
      delete: { risk: 3, reversible: 'no', effect: 'Deletes a file.' },
      delete_folder: { risk: 3, reversible: 'no', effect: 'Deletes a folder and everything in it.' },
    },
  ),

  // ── Terminal and development ────────────────────────────────────────────────
  run_command: {
    category: 'TERMINAL', risk: 3, reversible: 'no', external: 'none',
    effect: 'Runs an allow-listed developer command in the JARVIS folder.',
    output: { format: 'text', description: 'Exit code and command output' },
  },
  explain_code: {
    category: 'DEVELOPMENT', risk: 0, reversible: 'yes', external: 'none',
    effect: 'Reads a source file for explanation.',
    output: { format: 'text', description: 'File header (language, lines, size) and contents' },
  },

  // ── Network ─────────────────────────────────────────────────────────────────
  web_search: {
    category: 'NETWORK', risk: 1, reversible: 'yes', external: 'query',
    effect: 'Sends the query to the web search service.',
    output: { format: 'text', description: 'Search result summary' },
  },
  deep_search: {
    category: 'NETWORK', risk: 1, reversible: 'yes', external: 'query',
    effect: 'Sends several related queries to the web search service.',
    output: { format: 'text', description: 'Merged search findings' },
  },
  get_weather: {
    category: 'NETWORK', risk: 1, reversible: 'yes', external: 'query',
    effect: 'Sends a place name to the weather service.',
    output: { format: 'text', description: 'Current weather and forecast' },
  },

  // ── Memory ──────────────────────────────────────────────────────────────────
  search_memory: {
    category: 'MEMORY', risk: 0, reversible: 'yes', external: 'none',
    effect: 'Searches remembered facts.',
    output: { format: 'text', description: 'Matching facts' },
  },
  search_documents: {
    category: 'MEMORY', risk: 0, reversible: 'yes', external: 'none',
    effect: 'Searches ingested documents.',
    output: { format: 'text', description: 'Matching passages with sources' },
  },
  save_relation: {
    category: 'MEMORY', risk: 1, reversible: 'partial', external: 'none',
    effect: 'Stores a fact in long-term memory.',
    output: { format: 'text', description: 'Confirmation' },
  },
  ingest_documents: {
    category: 'MEMORY', risk: 1, reversible: 'partial', external: 'none',
    effect: 'Indexes files or a folder for document search.',
    output: { format: 'text', description: 'Files and chunks indexed, or error' },
  },

  // ── System ──────────────────────────────────────────────────────────────────
  control_process: withActions(
    { category: 'SYSTEM', reversible: 'no', external: 'none',
      effect: 'Lists, finds, kills or restarts processes.',
      output: { format: 'json', description: JSON_RESULT } },
    {
      list: { risk: 0, reversible: 'yes', effect: 'Lists running processes.' },
      find: { risk: 0, reversible: 'yes', effect: 'Finds processes by name or PID.' },
      kill: { risk: 3, reversible: 'no', effect: 'Ends a process; its unsaved work is lost.' },
      restart: { risk: 3, reversible: 'partial', effect: 'Ends and restarts a process; unsaved work is lost.' },
    },
  ),
  control_system: withActions(
    { category: 'SYSTEM', reversible: 'no', external: 'none',
      effect: 'Reads network and disk status, opens settings, controls services, runs shell commands.',
      output: { format: 'json', description: JSON_RESULT } },
    {
      network_status: { risk: 0, reversible: 'yes', effect: 'Reads network interfaces.' },
      disk_status: { risk: 0, reversible: 'yes', effect: 'Reads disk volumes.' },
      // The controllers' own checks: settings needs level 2, a restart always asks.
      settings: { risk: 2, reversible: 'yes', effect: 'Opens a Windows Settings page.' },
      restart_jarvis: { risk: 3, reversible: 'partial', effect: "Restarts JARVIS's own services." },
      shell: { risk: 3, reversible: 'no', effect: 'Runs a Command Prompt command.' },
      powershell: { risk: 3, reversible: 'no', effect: 'Runs a PowerShell command.' },
      start_service: { risk: 3, reversible: 'yes', effect: 'Starts a Windows service.' },
      stop_service: { risk: 3, reversible: 'yes', effect: 'Stops a Windows service.' },
      restart_service: { risk: 3, reversible: 'partial', effect: 'Restarts a Windows service.' },
    },
  ),
  get_permission_status: observation("Reads JARVIS's permission level and session time left.",
    { format: 'text', description: 'Level and remaining time' }, 'SYSTEM'),
  enable_full_control_session: {
    category: 'SYSTEM', risk: 3, reversible: 'yes', external: 'none',
    effect: 'Turns on full control mode for a limited time after your approval.',
    output: { format: 'text', description: 'Permission status' },
  },
  disable_full_control_session: {
    category: 'SYSTEM', risk: 1, reversible: 'partial', external: 'none',
    effect: 'Turns off full control mode.',
    output: { format: 'text', description: 'Permission status' },
  },
  cancel_current_action: {
    category: 'SYSTEM', risk: 1, reversible: 'no', external: 'none',
    effect: 'Stops the action that is running.',
    output: { format: 'text', description: 'Confirmation' },
  },
  list_capabilities: observation('Lists the tools JARVIS has, grouped, with their risk.',
    { format: 'json', description: 'Groups of tools: name, summary, risk range, approval, reversible, external' }, 'SYSTEM'),
  system_overview: observation('Reads OS, CPU load, memory, uptime, disk space and network addresses (no MAC).',
    { format: 'json', description: 'platform, cpu {model, cores, usagePercent}, memory, uptimeHours, disks[], network[]' }),
  dev_status: observation('Checks local development ports (127.0.0.1) and what answers on them.',
    { format: 'json', description: 'ports[]: port, open, http {status, server, title (untrusted)}' }, 'DEVELOPMENT'),
  diagnose_app: observation('Checks why a local application or website is not working: the servers JARVIS started, their last log lines, the ports and the browser tabs. Proposes repairs; runs none.',
    { format: 'json', description: 'faults[] (text, line, repairs, note), healthy[], question, servers[], tabs[] (untrusted titles), ports[]' }, 'DEVELOPMENT'),
  git_overview: observation('Reads branch, changes and recent commits of the git repositories in the project folders.',
    { format: 'json', description: 'repositories[]: path, branch, ahead, behind, changed, untracked, files, lastCommits, diffSummary' }, 'DEVELOPMENT'),
  browser_state: observation('Reads the browser JARVIS can reach: version, windows, tabs, the tab on screen.',
    { format: 'json', description: 'Untrusted page text: browser, windows[], tabs[] (title, url, visible), visibleTab' }, 'BROWSER'),
  browser_read_page: observation("Reads a tab's title, address and visible text.",
    { format: 'json', description: 'Untrusted page text: title, url, text (≤ 4000 chars)' }, 'BROWSER'),
  browser_page_structure: observation("Reads a tab's headings, links, buttons, forms (no password values) and tables.",
    { format: 'json', description: 'Untrusted page text: headings, links, buttons, forms, tables, each with a CSS ref' }, 'BROWSER'),
  browser_navigate: withActions(
    { category: 'BROWSER', reversible: 'partial', external: 'query',
      effect: 'Opens a web address in a tab, or goes back, forward or reloads; checks the tab shows the page.',
      output: { format: 'json', description: BROWSER_RESULT } },
    {
      go: { risk: 1, reversible: 'yes', effect: 'The tab shows the web address.' },
      back: { risk: 1, reversible: 'yes', effect: 'The tab shows the previous page.' },
      forward: { risk: 1, reversible: 'yes', effect: 'The tab shows the next page.' },
      reload: { risk: 1, reversible: 'partial', effect: 'The page loads again; unsent form input is lost.' },
    },
  ),
  browser_tab: withActions(
    { category: 'BROWSER', reversible: 'partial', external: 'query',
      effect: 'Opens, switches to or closes a tab; checks the result.',
      output: { format: 'json', description: BROWSER_RESULT } },
    {
      new: { risk: 1, reversible: 'yes', effect: 'A new tab opens.' },
      switch: { risk: 1, reversible: 'yes', effect: 'The tab comes to the front.' },
      close: { risk: 2, reversible: 'partial', effect: 'The tab closes; unsaved input in it is lost.' },
    },
  ),
  browser_click: {
    category: 'BROWSER', risk: 1, reversible: 'partial', external: 'query',
    effect: 'Clicks a link, button or field JARVIS has looked at; checks what changed.',
    output: { format: 'json', description: BROWSER_RESULT },
  },
  browser_type: {
    category: 'BROWSER', risk: 1, reversible: 'yes', external: 'none',
    effect: 'Types text into a field JARVIS has looked at (never a password); checks the field holds it.',
    output: { format: 'json', description: BROWSER_RESULT },
  },
  browser_select: {
    category: 'BROWSER', risk: 1, reversible: 'yes', external: 'none',
    effect: 'Chooses an option in a list JARVIS has looked at; checks the list shows it.',
    output: { format: 'json', description: BROWSER_RESULT },
  },
  browser_scroll: {
    category: 'BROWSER', risk: 1, reversible: 'yes', external: 'none',
    effect: 'Scrolls the page, or to an element JARVIS has looked at; checks it moved.',
    output: { format: 'json', description: BROWSER_RESULT },
  },
  browser_screenshot: {
    category: 'BROWSER', risk: 1, reversible: 'yes', external: 'none',
    effect: 'Saves a picture of a tab on this PC (not sent anywhere).',
    output: { format: 'json', description: `${BROWSER_RESULT}, file` },
  },
  browser_download: {
    category: 'BROWSER', risk: 2, reversible: 'yes', external: 'query',
    effect: 'Downloads a linked file into the JARVIS download folder; checks it is on disk.',
    output: { format: 'json', description: `${BROWSER_RESULT}, file` },
  },
  browser_upload: {
    category: 'BROWSER', risk: 3, reversible: 'partial', external: 'change',
    effect: 'Puts a file from an approved folder into a page\'s file field; the site may receive it.',
    output: { format: 'json', description: BROWSER_RESULT },
  },

  // ── Windows (P14) ───────────────────────────────────────────────────────────
  windows_overview: observation('Reads this Windows PC: graphics cards, displays, audio devices, cameras, installed apps, services, listening ports with their program, windows with their program.',
    { format: 'json', description: 'section and its entries (at most 80, optionally filtered), count' }),
  ui_elements: observation('Lists the buttons, fields, menus and texts of a Windows app window, each with a reference; never a password field\'s contents.',
    { format: 'json', description: 'window {hwnd, title, process}, elements[] (ref, name, type, value, patterns) — the app\'s own text' }, 'COMPUTER'),
  ui_action: withActions(
    { category: 'COMPUTER', reversible: 'partial', external: 'none',
      effect: 'Presses, fills or focuses an element of a Windows app that JARVIS listed; checks the result.',
      output: { format: 'json', description: 'JSON: success, action, target, did, check (status, evidence), or error' } },
    {
      focus: { risk: 1, reversible: 'yes', effect: 'The element has the keyboard focus.' },
      set_value: { risk: 2, reversible: 'yes', effect: 'The field holds the text; what it held is replaced.' },
      invoke: { risk: 2, reversible: 'partial', effect: 'The element is pressed: a button, a box, a list item or a menu.' },
    },
  ),
  screenshot: {
    category: 'COMPUTER', risk: 1, reversible: 'yes', external: 'none',
    effect: 'Saves a picture of the screen or of the window in front in the JARVIS data folder (not sent anywhere).',
    output: { format: 'json', description: 'file, width, height, bytes, check' },
  },
  clipboard: withActions(
    { category: 'COMPUTER', reversible: 'partial', external: 'none',
      effect: 'Reads the clipboard\'s text (secrets hidden) or replaces it.',
      output: { format: 'json', description: 'read: text (≤ 2 000 characters, redacted), length; write: length, check' } },
    {
      read: { risk: 1, reversible: 'yes', effect: 'Reads the clipboard text; secrets in it are hidden.' },
      write: { risk: 2, reversible: 'partial', effect: 'The clipboard holds the new text; what it held before is replaced.' },
    },
  ),
  files: withActions(
    { category: 'FILESYSTEM', reversible: 'yes', external: 'none',
      effect: 'Lists, searches, compares, creates, changes, renames, moves and deletes files in the approved folders; deleted items go to the JARVIS trash.',
      output: { format: 'json', description: 'JSON: success, action, path, did, check (status, evidence), or error' } },
    {
      list: { risk: 0, reversible: 'yes', effect: 'Lists a folder.' },
      search: { risk: 0, reversible: 'yes', effect: 'Finds files by name or text.' },
      compare: { risk: 0, reversible: 'yes', effect: 'Shows the line differences of two files.' },
      trash: { risk: 0, reversible: 'yes', effect: 'Lists the JARVIS trash.' },
      create: { risk: 2, reversible: 'yes', effect: 'Creates a file or folder.' },
      modify: { risk: 2, reversible: 'yes', effect: 'Changes a file; the previous version is kept in the JARVIS trash.' },
      rename: { risk: 2, reversible: 'yes', effect: 'Renames a file or folder.' },
      move: { risk: 2, reversible: 'yes', effect: 'Moves a file or folder.' },
      delete: { risk: 3, reversible: 'yes', effect: 'Moves the item to the JARVIS trash; it can be restored until the trash is emptied.' },
      restore: { risk: 2, reversible: 'yes', effect: 'Puts an item from the JARVIS trash back where it was.' },
      empty_trash: { risk: 3, reversible: 'no', effect: 'Deletes everything in the JARVIS trash for good.' },
    },
  ),
  git: withActions(
    { category: 'DEVELOPMENT', reversible: 'yes', external: 'none',
      effect: 'Reads and changes git repositories in the project folders: status, diff, branches, log, commit, switch.',
      output: { format: 'json', description: 'JSON: success, action, repo, did, check (status, evidence), or error' } },
    {
      status: { risk: 0, reversible: 'yes', effect: 'Shows the branch and the changed files.' },
      diff: { risk: 0, reversible: 'yes', effect: 'Shows the changes.' },
      branches: { risk: 0, reversible: 'yes', effect: 'Lists the branches.' },
      log: { risk: 0, reversible: 'yes', effect: 'Lists recent commits.' },
      commit: { risk: 2, reversible: 'yes', effect: 'Records the changes as a commit on this PC (nothing is sent).' },
      switch: { risk: 2, reversible: 'yes', effect: 'Changes the branch the folder shows.' },
    },
  ),
  git_push: {
    category: 'DEVELOPMENT', risk: 3, reversible: 'partial', external: 'change',
    effect: 'Sends the branch\'s commits to the remote, where others can see them.',
    output: { format: 'json', description: 'JSON: success, branch, target, did, check (status, evidence), or error' },
  },
  dev: withActions(
    { category: 'DEVELOPMENT', reversible: 'yes', external: 'none',
      effect: 'Runs test, build, lint and typecheck scripts; starts and stops development servers JARVIS started.',
      output: { format: 'json', description: 'JSON: success, action, exitCode or port, output, check (status, evidence), or error' } },
    {
      scripts: { risk: 0, reversible: 'yes', effect: 'Lists the package scripts.' },
      servers: { risk: 0, reversible: 'yes', effect: 'Lists the servers JARVIS started.' },
      run: { risk: 1, reversible: 'partial', effect: 'Runs a test, build, lint or typecheck script; a build writes its output files.' },
      start_server: { risk: 1, reversible: 'yes', effect: 'Starts a development server on a local port.' },
      stop_server: { risk: 2, reversible: 'yes', effect: 'Stops a server JARVIS started.' },
    },
  ),
  action_history: observation('Lists JARVIS\'s last tool calls and approval decisions, without credentials.',
    { format: 'json', description: 'calls (tool, args, success, error, at) and approvals (action, target, approved, by, at)' }, 'SYSTEM'),
};

/**
 * Defaults for a tool with no catalogue entry and no declared metadata. Never
 * risk 0: an undescribed tool is not assumed to be harmless.
 */
export function deriveMeta(tool: AgentTool): ToolMeta {
  const risk: RiskTier = tool.riskLevel === 'high' ? 3 : tool.riskLevel === 'medium' ? 2 : 1;
  return {
    category: 'SYSTEM',
    risk,
    reversible: 'no',
    external: 'none',
    effect: tool.description.split(/(?<=\.)\s/)[0] ?? tool.name,
    output: { format: 'text', description: 'Not described' },
  };
}
