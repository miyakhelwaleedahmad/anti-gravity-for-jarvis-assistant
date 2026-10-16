/**
 * core/deterministicRoutes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The deterministic pre-router: requests JARVIS answers without the LLM
 * (stop, greetings, time, open/close an app, status, browser tabs, "what's
 * running", app trouble, "continue what I was doing", agent and goal
 * commands, desktop searches). Moved out of core/orchestrator.ts (ARCH-01,
 * step 4); tests/routeGoldenTest.ts records the route for a fixed set of
 * phrases, with the "try again?" offer open and expired, and fails on any
 * difference.
 *
 * The one change in the move: whether the orchestrator's "Shall I try it
 * again?" offer still holds is passed in (`continueOfferOpen`) instead of
 * read from the orchestrator. Matching only; nothing here runs a tool.
 */

import { normalizeVoiceInput } from './voiceInput.js';
import { matchDesktopRoute } from './desktopRouting.js';
import { matchAgentRoute } from './agentRouting.js';
import { capabilitiesReply, capabilityListReply } from './replyText.js';

export interface DeterministicRoute { type: string; target?: string; reply: string; specialist?: string }

const CAPABILITY_LIST_PHRASES = new Set([
  'list your tools', 'list your capabilities', 'list all your tools', 'show your tools',
  'what tools do you have', 'which tools do you have',
]);

/** Questions about the browser's tabs, answered from browser_state without the LLM. */
const BROWSER_TABS_PHRASES = new Set([
  'what is open in chrome', 'whats open in chrome', 'what is open in my browser', 'whats open in my browser',
  'what is open in the browser', 'whats open in the browser', 'which tabs are open', 'what tabs are open',
  'what tabs do i have open', 'which tabs do i have open',
]);

/** "What's running?": open apps and local servers. */
const RUNNING_PHRASES = new Set([
  'whats running', 'what is running', 'whats running on my pc', 'what is running on my pc',
  'whats running on my computer', 'what is running on my computer', 'what apps are running',
]);

/** "What is (currently) open in my browser?" and the like (P13; the fixed phrases above stay). */
const BROWSER_TABS_QUESTION =
  /^(?:(?:whats|what is|what do i have)(?: currently| now)? open(?: right now| now)? (?:in|on) (?:my |the )?(?:browser|chrome|google chrome)|(?:what|which) tabs? (?:is|are|do i have)(?: currently| now)? open(?: right now| now)?(?: (?:in|on) (?:my |the )?(?:browser|chrome|google chrome))?)$/;

/** "Why isn't my application working?" and the like: diagnosed from real readings (P13). */
const APP_NOUN = '(?:app|application|website|web site|site|web app|webapp|backend|back end|frontend|front end|server|dev server|local server|web server|api|page|project)';
const NOT_WORKING = '(?:working|loading|responding|running|opening|starting|work|load|respond|run|open|start|up)';
const BROKEN = '(?:down|broken|failing|crashing|crashed|dead)';
const CHECK = '(?:(?:check|find out|tell me|see|figure out|look at|look into|investigate) )?';
const APP_TROUBLE: readonly RegExp[] = [
  new RegExp(`^${CHECK}why (?:is|isnt|does|doesnt|wont|cant|did|didnt) (?:my|the) ${APP_NOUN} (?:not )?(?:${NOT_WORKING}|${BROKEN})$`),
  new RegExp(`^${CHECK}why (?:my|the) ${APP_NOUN} (?:isnt|is not|doesnt|does not|wont|will not|cant|cannot|can not|didnt|did not) ${NOT_WORKING}$`),
  new RegExp(`^${CHECK}why (?:my|the) ${APP_NOUN} is ${BROKEN}$`),
  new RegExp(`^(?:my|the) ${APP_NOUN} (?:isnt|is not|doesnt|does not|wont|will not|cant|cannot|can not|stopped|has stopped) ${NOT_WORKING}$`),
  new RegExp(`^(?:my|the) ${APP_NOUN} (?:is |keeps |seems )?${BROKEN}$`),
  new RegExp(`^(?:whats|what is) (?:wrong|going on|the problem|the issue) with (?:my|the) ${APP_NOUN}$`),
  new RegExp(`^(?:fix|repair|debug|diagnose|troubleshoot) (?:my|the) ${APP_NOUN}$`),
  new RegExp(`^(?:is|are) (?:my|the) ${APP_NOUN} working$`),
];

/** "Continue what I was doing" and the like (P13), and the answers to its offer. */
const CONTINUE_QUESTION =
  /^(?:continue|resume|carry on with|pick up|go back to|get back to|keep going with) (?:what i was doing|where i left off|where we left off|what we were doing|my (?:last )?(?:task|work))$|^what was i doing$|^where was i$/;
const CONTINUE_YES = /^(?:yes|yes please|yeah|yep|try again|yes try again|go ahead)$/;
const CONTINUE_NO = /^(?:no|no thanks|nope|leave it|dont)$/;

/** "status" and its plain variants: answered from system_overview. */
const SYSTEM_STATUS_PHRASES = new Set([
  'status', 'system status', 'pc status', 'computer status', 'system check',
  'how is my pc', 'how is my computer', 'how is my pc doing', 'how is my computer doing',
  'how is my system doing', 'how is the system doing',
]);

/** "Is my backend running?" and the like: answered from dev_status. */
const DEV_STATUS_QUESTION =
  /^(is|are) (my|the) (backend|frontend|api|server|servers|dev server|development server|local server|app server) (still )?(running|up|on)$|^(what|which) (local |dev |development )?servers are running$|^check (my|the) (dev |local )?servers$/;

/**
 * ⚡ Fast-path for known "open/launch/start X", greetings, status, time commands.
 * Returns a DeterministicRoute structure if matched; null means fall through to LLM.
 */
export function matchDeterministicCommand(input: string, continueOfferOpen = false): DeterministicRoute | null {
  const normalized = normalizeVoiceInput(input);
  const clean = normalized.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  // 1. Stop / Interrupt commands
  if (clean === 'stop' || clean === 'cancel' || clean === 'jarvis stop' || clean === 'jarvis cancel') {
    return { type: 'stop', reply: 'Stopped, sir.' };
  }
  if (clean === 'pause') {
    return { type: 'stop', reply: 'Paused, sir.' };
  }
  if (clean === 'resume') {
    return { type: 'stop', reply: 'Resuming, sir.' };
  }
  if (clean === 'shutdown') {
    return { type: 'stop', reply: 'Shutting down, sir.' };
  }

  // ── Agents (core/agents): status questions, stopping, research ──────────
  // A delegated task keeps the user's own words (case and all), minus the wake word.
  const agentRoute = matchAgentRoute(clean, input.trim().replace(/^(?:(?:hey|ok|okay)\s+)?jarvis[\s,.:!-]+/i, '').replace(/[\s,]+please[.!?]*$/i, ''));
  if (agentRoute) return agentRoute;

  // YouTube and site searches on screen, and what is trending (core/desktopRouting.ts).
  const desktop = matchDesktopRoute(input);
  if (desktop) return { type: desktop.type, target: JSON.stringify(desktop), reply: '' };

  // ── Pre-defined Mappings ──────────────────────────────────────────────────
  if (clean === 'close youtube') {
    return { type: 'close_browser_tab', target: 'youtube', reply: 'Closing YouTube, sir.' };
  }
  if (clean === 'close current tab') {
    return { type: 'close_current_tab', reply: 'Closing current tab, sir.' };
  }
  if (clean === 'close notepad') {
    return { type: 'close_app', target: 'notepad', reply: 'Closing Notepad, sir.' };
  }
  if (clean === 'close current window') {
    return { type: 'close_current_window', reply: 'Closing current window, sir.' };
  }
  if (clean === 'what is open') {
    return { type: 'get_system_state', reply: 'Checking what is open, sir.' };
  }
  if (BROWSER_TABS_PHRASES.has(clean) || BROWSER_TABS_QUESTION.test(clean)) {
    return { type: 'get_browser_tabs', reply: 'Checking open Chrome tabs, sir.' };
  }
  if (RUNNING_PHRASES.has(clean)) {
    return { type: 'whats_running', reply: '' };
  }
  if (CONTINUE_QUESTION.test(clean)) {
    return { type: 'continue_work', reply: '' };
  }
  // The answer to "Shall I try it again?", while that offer holds.
  if (continueOfferOpen) {
    if (CONTINUE_YES.test(clean)) return { type: 'continue_confirmed', reply: '' };
    if (CONTINUE_NO.test(clean)) return { type: 'continue_declined', reply: 'Understood, sir. I will leave it.' };
  }
  if (clean === 'is youtube open') {
    return { type: 'is_tab_open', target: 'youtube', reply: 'Checking if YouTube is open, sir.' };
  }
  if (clean === 'enable full control mode') {
    return { type: 'enable_full_control_session', reply: 'Enabling full control mode, sir.' };
  }

  // 2. Simple conversational phrases (no Groq)
  const simplePhrases: Record<string, string> = {
    'how are you': 'Operational and ready, sir.',
    'thank you': 'Anytime, sir.',
    'thanks': 'Anytime, sir.',
    'good morning': 'Good morning, sir.',
    'good evening': 'Good evening, sir.',
    'good night': 'Good night, sir.',
    'okay': 'Understood.',
    'ok': 'Understood.',
    // Nothing is waiting for an answer here (a pending approval takes "yes"
    // before routing): "Confirmed." suggested that something was approved.
    'yes': 'Understood, sir. Nothing is waiting for your approval.',
    'no': 'Understood.',
  };
  if (clean in simplePhrases) {
    return { type: 'simple_reply', reply: simplePhrases[clean] };
  }

  const greetings = ['hello', 'hi', 'hey', 'are you there', 'jarvis hello', 'jarvis hi'];
  if (greetings.includes(clean)) {
    return { type: 'greeting', reply: 'Hello, sir. How may I assist you today?' };
  }

  // 3. Capabilities / Identity — from the tool registry, not a fixed sentence.
  // "can you" is stripped as filler above, so "what can you do" arrived as
  // "what do", never matched, and went to the LLM.
  const asked = input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(hey )?jarvis /, '');
  if (asked === 'what can you do' || clean === 'who are you') {
    return { type: 'what_can_you_do', reply: capabilitiesReply(clean === 'who are you') };
  }
  if (CAPABILITY_LIST_PHRASES.has(clean)) {
    return { type: 'list_capabilities', reply: capabilityListReply() };
  }

  // 4. Time
  if (clean === 'what time is it' || clean === 'time' || clean === 'what is the time') {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { type: 'time', reply: `It is ${timeStr}, sir.` };
  }

  // 5. System status, read from the machine. It used to answer "All systems
  //    are operational" without looking at anything.
  if (SYSTEM_STATUS_PHRASES.has(clean)) {
    return { type: 'status', reply: '' };
  }
  if (DEV_STATUS_QUESTION.test(clean)) {
    return { type: 'dev_status', reply: '' };
  }
  // "Why isn't my application working?": diagnosed, repaired through the
  // registry where a repair is known, and checked again (P13).
  if (APP_TROUBLE.some((pattern) => pattern.test(clean))) {
    return { type: 'diagnose_app', reply: '' };
  }

  // 6. Help
  if (clean === 'help') {
    return { type: 'help', reply: 'I can assist you with local automation, calculations, and general queries. Just say the word, sir.' };
  }

  // 7. open_app aliases
  const ALIASES: Record<string, string> = {
    'youtube':          'youtube',
    'you tube':         'youtube',   // FIX: Whisper split-word fallback
    'google':           'google',
    'gmail':            'gmail',
    'github':           'github',
    'git hub':          'github',    // FIX: Whisper split-word fallback
    'whatsapp':         'whatsapp',
    'whats app':        'whatsapp',
    'vscode':           'vscode',
    'vs code':          'vscode',
    'code':             'vscode',
    'visual studio code': 'vscode',
    'notepad':          'notepad',
    'cmd':              'cmd',
    'command prompt':   'cmd',
    'terminal':         'cmd',
    'calculator':       'calculator',
    'calc':             'calculator',
    'spotify':          'spotify',
    'chrome':           'chrome',
    'firefox':          'firefox',
    'edge':             'edge',
    'browser':          'chrome',
    'settings':         'settings',
    'ms-settings':      'settings',
    'downloads':        'downloads',
  };

  const triggers = ['open', 'launch', 'start'];
  for (const trigger of triggers) {
    const idx = clean.indexOf(trigger);
    if (idx === -1) continue;
    // Ensure trigger is a whole word at start or preceded by space
    if (idx > 0 && clean[idx - 1] !== ' ') continue;

    const afterTrigger = clean.substring(idx + trigger.length).trim();
    // Strip filler words — extended list to handle natural speech variants:
    // "open youtube for me" / "open youtube now" / "open youtube right now"
    const stripped = afterTrigger
      .replace(/\bfor me\b/g, '')
      .replace(/\bplease\b/g, '')
      .replace(/\bthe\b/g, '')
      .replace(/\ba\b/g, '')
      .replace(/\bright now\b/g, '')
      .replace(/\bnow\b/g, '')
      .replace(/\bquickly\b/g, '')
      .replace(/\bimmediately\b/g, '')
      .replace(/\basap\b/g, '')
      .replace(/\bup\b/g, '')
      .trim();

    for (const [alias, target] of Object.entries(ALIASES)) {
        // Exact match: stripped is exactly the alias
        if (stripped === alias) {
          return { type: 'open_app', target, reply: `Opening ${target}, sir.` };
        }
        // Prefix match: alias followed by a space
        if (stripped.startsWith(alias + ' ')) {
          const remainder = stripped.substring(alias.length).trim()
            .replace(/\bfor me\b/g, '')
            .replace(/\bplease\b/g, '')
            .replace(/\bthe\b/g, '')
            .replace(/\ba\b/g, '')
            .trim();
          if (remainder === '') {
            return { type: 'open_app', target, reply: `Opening ${target}, sir.` };
          }
        }
      }
  }
  return null;
}
