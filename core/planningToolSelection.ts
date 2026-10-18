/**
 * core/planningToolSelection.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Which tools the planner is offered for a request, and whether the request
 * needs the heavy planning context. Moved out of core/orchestrator.ts
 * unchanged (ARCH-01, step 2); tests/routeGoldenTest.ts records the answers
 * for a fixed set of phrases and fails on any difference.
 *
 * Only tools the registry holds are offered, at most 8. The planner decides;
 * offering a tool grants nothing (the risk engine and approval gate still
 * apply to every call).
 */

import { toolRegistryV2 } from './toolRegistryV2.js';
import { delegationFit, goalIntent } from './delegationRouting.js';
import { normalizeVoiceInput } from './voiceInput.js';

const CAPABILITY_QUESTION =
  /\b(what|which) (tools|capabilities)\b|\bwhat can you do\b|\byour (tools|capabilities|abilities)\b|\blist (your |all )?(tools|capabilities)\b/;

/** Questions the planner should get system, server or git tools for. */
const SYSTEM_QUESTION = /\b(cpu|processor|memory|ram|disk|storage|free space|uptime|ip address|network address)\b/;
const DEV_QUESTION = /\b(port|ports|localhost|backend|frontend|dev server|server running|servers running)\b/;
const GIT_QUESTION = /\b(git|commit|commits|branch|uncommitted|repository|repo|diff)\b/;
const BROWSER_QUESTION = /\b(browser|tab|tabs|web ?page|page|website|site|chrome|link|links|form|button)\b/;
const FILE_ACTION = /\b(files?|folders?|directory|rename|move|delete|trash|restore|compare)\b/;
const GIT_ACTION = /\b(git|commit|commits|branch|branches|push|repo|repository)\b/;
// "stop my web server" did not offer `dev` (P13): the server may have a name.
const DEV_ACTION = /\b(tests?|build|lint|typecheck|type check|dev server|(?:start|stop|restart) (?:the |my )?(?:[a-z]+ )?server|npm|pnpm|script|scripts)\b/;
const SELF_QUESTION = /\b(?:yourself|your (?:health|errors?|issues|problems|status|repairs?)|self ?check|self ?test|(?:are|were) you (?:stuck|broken|ok|okay))\b/;
const TROUBLE_WORDS = /\b(not working|isnt working|doesnt work|wont load|not loading|broken|crash(?:ed|es|ing)?|(?:is|went|keeps going) down|error page|blank page|failing)\b/;
/** Pressing or typing in a Windows app, a dialog or a window (P14). */
const DESKTOP_UI = /\b(dialog|window|notepad|calculator|explorer|settings|app|application|program|desktop|popup|pop up|message box|installer)\b/;
const UI_ACTION_WORDS = /\b(click|press|tap|type|fill|enter|select|choose|tick|check|uncheck|focus)\b/;
const SCREENSHOT_WORDS = /\b(screenshot|screen shot|capture (?:the |my )?screen|picture of (?:the |my )?screen)\b/;
/** Questions about this PC's hardware and software the other tools do not answer (P14). */
const WINDOWS_QUESTION = /\b(gpu|graphics card|video card|display|displays|monitor|monitors|screen resolution|resolution|sound device|audio device|speakers?|microphones?|mic|webcam|camera|cameras|installed|programs|services?|listening|which program|what program)\b/;
const BROWSER_CONTEXT = /\b(browser|tab|tabs|web ?page|page|website|site|chrome|link|links|form|button|field|box|url|address)\b/;
const BROWSER_ACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(click|press|tap|tick|check|uncheck)\b/, 'browser_click'],
  [/\b(type|fill|enter|write|search for)\b/, 'browser_type'],
  [/\b(select|choose|pick)\b/, 'browser_select'],
  [/\bscroll\b/, 'browser_scroll'],
  [/\b(go back|go forward|back|forward|reload|refresh|navigate|go to|open)\b/, 'browser_navigate'],
  [/\b(new tab|switch|close)\b/, 'browser_tab'],
  [/\b(screenshot|screen shot)\b/, 'browser_screenshot'],
  [/\bdownload\b/, 'browser_download'],
  [/\b(upload|attach)\b/, 'browser_upload'],
];

/** A question about what JARVIS has just done. */
const HISTORY_QUESTION =
  /\bwhat (did|have) you (just )?(do|done|run|change|changed)\b|\b(recent|last|your) (actions|commands|tool calls)\b|\baction history\b/;

export function shouldUseHeavyContext(input: string): boolean {
  const clean = normalizeVoiceInput(input).toLowerCase();
  if (!clean) return false;

  const simplePatterns = [
    /^(open|launch|start)\s+[a-z0-9 ]{1,40}$/,
    /^(close|stop|pause|resume)\b/,
    /^(what time is it|time|status|system status|help)$/,
    /^(is .+ open|what is open|what is open in chrome)$/,
  ];

  return !simplePatterns.some((pattern) => pattern.test(clean));
}

export function selectPlanningToolNames(input: string): string[] {
  const clean = normalizeVoiceInput(input).toLowerCase();
  const requested = new Set<string>();

  const addIfRegistered = (...names: string[]) => {
    for (const name of names) {
      if (toolRegistryV2.has(name)) requested.add(name);
    }
  };

  if (CAPABILITY_QUESTION.test(clean)) {
    addIfRegistered('list_capabilities');
  }
  if (HISTORY_QUESTION.test(clean)) {
    addIfRegistered('action_history');
  }
  // Larger work for the specialist agents, and questions about them (core/agents):
  // offered when the request is substantial (core/delegationRouting.ts); the planner decides.
  if (/\b(research|investigate|compare|comparison|in the background|delegate|specialist)\b/.test(clean) || delegationFit(clean).delegate) {
    addIfRegistered('delegate_task');
  }
  // Goals the Goal Runtime keeps working on (core/goalTools.ts).
  if (goalIntent(clean)) {
    addIfRegistered('goal_create', 'goal_status', 'goal_control');
  }
  // YouTube on screen; news and trending in the background.
  if (/\byou ?tube\b/.test(clean) && /\b(search|find|play|watch|video|videos|results|look)\b/.test(clean) && clean.split(/\s+/).length > 2) {
    addIfRegistered('youtube_search', 'youtube_play');
  }
  if (/\b(news|latest|headlines|trending|this week|today'?s|developments)\b/.test(clean)) {
    addIfRegistered('news_search');
  }
  if (/\b(trending|popular)\b/.test(clean) && /\b(you ?tube|videos?)\b/.test(clean)) {
    addIfRegistered('youtube_trending');
  }
  // A site's results on screen: "open Wikipedia and search for X", "search X on Amazon" (with a query, not "search Google").
  if (/\b(google|bing|wikipedia|amazon|reddit|stack ?overflow|duckduckgo)\b/.test(clean)
    && /\b(?:open|go to|show)\b.*\bsearch\b|\bsearch \w+ for \w+|\bsearch .+ on \w+/.test(clean) && clean.split(/\s+/).length >= 4) {
    addIfRegistered('site_search');
  }
  if (/\b(agents?|sub ?agents|workers?)\b/.test(clean)) {
    addIfRegistered('agent_status', 'cancel_agent_task');
  }
  if (/\bgithub\b/.test(clean) && /\b(find|search|projects?|repos?|repositor(?:y|ies)|librar(?:y|ies))\b/.test(clean)) {
    addIfRegistered('github_search', 'github_repo');
  }
  const isKillOrClose = /\b(close|kill|stop|terminate|exit|minimize|maximize)\b/i.test(clean);
  const isLaunchIntent = !isKillOrClose && /\b(open|launch|start|run|app|application|desktop|whatsapp|youtube|chrome|calculator|vscode|code|notepad|spotify|browser|gmail|github)\b/i.test(clean);
  const isExplicitSearch = /\b(search|lookup|find|internet|online|research)\b/i.test(clean);

  // 1. App / Desktop launch requests: ALWAYS include open_app & control_app at top priority
  if (isLaunchIntent) {
    addIfRegistered('open_app', 'control_app');
  }

  // Close / minimize requests need the tools that can do them, first so the
  // 8-tool cap below never drops them. "close chrome" used to offer only
  // read-only state tools, so the model had no way to close anything.
  if (isKillOrClose) {
    addIfRegistered('control_app', 'control_window');
  }

  // Browser actions (P9), when the request is about a page or a tab: after
  // the launch and close tools, before the read-only ones.
  if (BROWSER_CONTEXT.test(clean)) {
    for (const [words, tool] of BROWSER_ACTIONS) {
      if (words.test(clean)) addIfRegistered(tool);
    }
  }

  // Windows apps, the screen and the clipboard (P14).
  if (DESKTOP_UI.test(clean) && UI_ACTION_WORDS.test(clean)) addIfRegistered('ui_elements', 'ui_action');
  if (SCREENSHOT_WORDS.test(clean) && !BROWSER_CONTEXT.test(clean)) addIfRegistered('screenshot');
  if (/\b(clipboard|copied|paste)\b/.test(clean)) addIfRegistered('clipboard');
  if (WINDOWS_QUESTION.test(clean)) addIfRegistered('windows_overview');

  // Files, git and project scripts (P10).
  if (FILE_ACTION.test(clean)) addIfRegistered('files');
  if (GIT_ACTION.test(clean)) {
    addIfRegistered('git');
    if (/\bpush\b/.test(clean)) addIfRegistered('git_push');
  }
  if (DEV_ACTION.test(clean)) addIfRegistered('dev');
  // Something does not work: the diagnosis, for phrasings the route above does not take (P13).
  if (TROUBLE_WORDS.test(clean)) addIfRegistered('diagnose_app');

  // The read-only observation tools (P6, P8) come after the launch and close
  // tools, so "open chrome" still offers open_app first, and before the
  // generic lists below, so the 8-tool cap does not drop them.
  if (SYSTEM_QUESTION.test(clean)) {
    addIfRegistered('system_overview');
  }
  if (DEV_QUESTION.test(clean)) {
    addIfRegistered('dev_status');
  }
  if (GIT_QUESTION.test(clean)) {
    addIfRegistered('git_overview');
  }
  if (BROWSER_QUESTION.test(clean)) {
    addIfRegistered('browser_state', 'browser_read_page', 'browser_page_structure');
  }
  // Questions about JARVIS itself that the fixed routes do not take (core/selfCheck.ts).
  if (SELF_QUESTION.test(clean)) addIfRegistered('self_check');

  // 2. Web search: ONLY if explicit search intent or not a pure app launch request
  if (isExplicitSearch || (!isLaunchIntent && /\b(google|web|internet|online|research)\b/i.test(clean))) {
    addIfRegistered('web_search', 'deep_search');
  }

  if (/\b(weather|forecast|temperature|rain|humidity)\b/.test(clean)) {
    addIfRegistered('get_weather');
  }

  if (/\b(file|folder|read|write|save|edit|create)\b/.test(clean)) {
    addIfRegistered('read_file', 'write_file', 'control_file');
  }

  if (/\b(keyboard|type|press|key|hotkey|shortcut)\b/.test(clean)) {
    addIfRegistered('control_keyboard');
  }

  if (/\b(mouse|click|right click|double click|scroll|drag|cursor)\b/.test(clean)) {
    addIfRegistered('control_mouse');
  }

  if (/\b(kill|process|task|pid|stop app|terminate)\b/.test(clean)) {
    addIfRegistered('control_process');
  }

  if (/\b(screenshot|screen|volume|mute|service|network|disk|powershell|settings|system control)\b/.test(clean)) {
    addIfRegistered('control_system');
  }

  if (/\b(window|minimize|maximize|resize|move window|close window)\b/.test(clean)) {
    addIfRegistered('control_window');
  }

  if (/\b(tab|browser|url|open url|close tab|refresh)\b/.test(clean)) {
    addIfRegistered('control_browser');
  }

  if (/\b(cancel|abort|stop action)\b/.test(clean)) {
    addIfRegistered('cancel_current_action');
  }

  if (/\b(full control|admin|permission|level 2|session)\b/.test(clean)) {
    addIfRegistered('enable_full_control_session', 'disable_full_control_session', 'get_permission_status');
  }

  if (/\b(system|status|pc|computer|windows|chrome|browser|app|running|open apps|active window)\b/.test(clean)) {
    addIfRegistered(
      'get_system_info',
      'get_system_state',
      'get_pc_state',
      'get_open_apps',
      'get_active_window',
      'get_browser_tabs',
      'is_app_open',
      'is_tab_open'
    );
  }

  if (/\b(memory|remember|recall|forget|relation|preference)\b/.test(clean)) {
    addIfRegistered('search_memory', 'save_relation');
  }

  if (/\b(code|explain|debug|typescript|javascript|python|error|stack trace)\b/.test(clean)) {
    addIfRegistered('explain_code', 'read_file');
  }

  if (/\b(command|terminal|shell|npm|pnpm|npx|git|test|build|tsc)\b/.test(clean)) {
    addIfRegistered('run_command');
  }

  // Default fallback: if no tool selected, provide general utility tools so LLM is never given 0 tools
  if (requested.size === 0) {
    addIfRegistered('open_app', 'web_search', 'get_system_info', 'run_command');
  }

  return [...requested].slice(0, 8);
}
