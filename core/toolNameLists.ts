/**
 * core/toolNameLists.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tool names the orchestrator treats specially (ARCH-06).
 *
 * These lists lived inline in orchestrator.ts and had drifted: 13 of the 28
 * "low-risk" names and 29 of the 36 "simple" names were not tools at all
 * (get_time, calc, click, type_text …). They never matched anything, and a
 * tool renamed later would silently drop out. Only registered names are kept;
 * tests/toolNameListsTest.ts fails when one is not a registered tool.
 */

/**
 * A graph whose steps all succeeded and are all in this list (or read only)
 * skips the reflection step (OPT-3).
 */
export const LOW_RISK_TOOLS: readonly string[] = [
  'open_app', 'get_weather', 'get_system_info', 'get_system_state', 'get_pc_state',
  'get_active_window', 'get_browser_tabs', 'get_open_apps', 'is_app_open', 'is_tab_open',
  'search_memory', 'web_search', 'deep_search', 'read_file', 'explain_code',
];

/** Single-action tools whose output is the reply: no synthesis call (OPT-SYNTH-1). */
export const SIMPLE_REPLY_TOOLS: readonly string[] = [
  'open_app', 'get_system_info', 'search_memory', 'read_file', 'get_weather', 'run_command', 'get_active_window',
];
