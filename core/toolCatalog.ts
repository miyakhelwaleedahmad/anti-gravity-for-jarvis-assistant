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
  git_overview: observation('Reads branch, changes and recent commits of the git repositories in the project folders.',
    { format: 'json', description: 'repositories[]: path, branch, ahead, behind, changed, untracked, files, lastCommits, diffSummary' }, 'DEVELOPMENT'),
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
