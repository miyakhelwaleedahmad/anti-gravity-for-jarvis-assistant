/**
 * control/appMatch.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Which open windows belong to the app the user named, for closing, focusing
 * and checking apps and windows (audit 2026-10-25, TRA-04, TRA-18).
 *
 * Windows reports a program's name as Process.ProcessName, without ".exe"
 * ("notepad", "chrome"). The launch aliases ("notepad.exe") are for
 * `cmd /c start` only: compared with ProcessName they never matched, so
 * "close notepad" found nothing.
 *
 * A browser window's title is its page's title ("YouTube - Google Chrome"),
 * so a site name used to close whole browser windows. By the owner's
 * decision (D3, 2026-10-25) app, window and process tools never close the
 * browser: tabs are closed with the tab tools, and only JARVIS's own Chrome
 * may be closed as a whole.
 */

export interface AppWindow {
  name: string;
  pid: number;
  windowTitle: string;
  hwnd?: string;
}

/** A window that can be acted on: it has a handle. */
export function hasHandle<T extends { hwnd?: string }>(w: T): w is T & { hwnd: string } {
  return !!w.hwnd;
}

/** What the user calls an app → its program name (ProcessName, no ".exe"). */
const PROGRAM_NAMES: Readonly<Record<string, string>> = {
  'command prompt': 'cmd',
  'windows terminal': 'windowsterminal',
  'windows powershell': 'powershell',
  'google chrome': 'chrome',
  edge: 'msedge',
  'microsoft edge': 'msedge',
  'mozilla firefox': 'firefox',
  'brave browser': 'brave',
};

/** Browser programs (ProcessName, lower case). Yandex Browser's program is called "browser". */
const BROWSERS: Readonly<Record<string, string>> = {
  chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', brave: 'Brave', opera: 'Opera', opera_gx: 'Opera GX', vivaldi: 'Vivaldi',
  iexplore: 'Internet Explorer', chromium: 'Chromium', arc: 'Arc', thorium: 'Thorium', waterfox: 'Waterfox', librewolf: 'LibreWolf',
  floorp: 'Floorp', zen: 'Zen', palemoon: 'Pale Moon', seamonkey: 'SeaMonkey', browser: 'Yandex Browser', duckduckgo: 'DuckDuckGo',
};

/**
 * How an app's window is recognised, by its title or program. calc.exe
 * exits once Calculator is up (its window belongs to ApplicationFrameHost),
 * and VS Code's program is "Code": the name asked for is not always the
 * program's.
 */
const APP_WINDOWS: Readonly<Record<string, RegExp>> = {
  calculator: /calculator/i, calc: /calculator/i,
  vscode: /visual studio code|^code$/i, 'vs code': /visual studio code|^code$/i, code: /visual studio code|^code$/i,
  // Not Windows Terminal itself: it also runs PowerShell, and JARVIS (R4-1).
  cmd: /command prompt|^cmd$/i, 'command prompt': /command prompt|^cmd$/i,
  settings: /^settings$/i, 'ms-settings': /^settings$/i,
};

/**
 * The windows that are those apps themselves: their program, and for shared
 * hosts the window's title too. ApplicationFrameHost shows every Store app
 * ("calculator.png - Photos" is not Calculator); Windows Terminal and conhost
 * run any shell, JARVIS included. Anything else that matched is only a title
 * match ("calculator.py - Notepad", a Chrome tab about calculators): asked first.
 */
type AppHost = { program: string; title?: RegExp };
const CALCULATOR: readonly AppHost[] = [{ program: 'calculatorapp' }, { program: 'calculator' }, { program: 'applicationframehost', title: /^calculator$/i }];
const VSCODE: readonly AppHost[] = [{ program: 'code' }];
const COMMAND_PROMPT: readonly AppHost[] = [
  { program: 'cmd' },
  { program: 'windowsterminal', title: /command prompt|cmd\.exe/i },
  { program: 'conhost', title: /command prompt|cmd\.exe/i },
];
const SETTINGS: readonly AppHost[] = [{ program: 'systemsettings' }, { program: 'applicationframehost', title: /^settings$/i }];
const APP_HOSTS: Readonly<Record<string, readonly AppHost[]>> = {
  calculator: CALCULATOR, calc: CALCULATOR,
  vscode: VSCODE, 'vs code': VSCODE, code: VSCODE,
  cmd: COMMAND_PROMPT, 'command prompt': COMMAND_PROMPT,
  settings: SETTINGS, 'ms-settings': SETTINGS,
};

function isAppItself(hosts: readonly AppHost[], w: AppWindow): boolean {
  const program = programKey(w.name);
  return hosts.some((h) => h.program === program && (!h.title || h.title.test(w.windowTitle)));
}

/** A program name as ProcessName gives it: lower case, no ".exe". */
export function programKey(name: string): string {
  return name.toLowerCase().trim().replace(/\.exe$/, '');
}

/** The program the user means by `target` ("google chrome" → "chrome"). */
export function programFor(target: string): string {
  const key = programKey(target);
  return PROGRAM_NAMES[key] ?? key;
}

/** The browser's name when `program` is a web browser. */
export function browserName(program: string): string | undefined {
  return BROWSERS[programKey(program)];
}

export function appWindowMatcher(target: string): RegExp {
  const key = target.toLowerCase().trim();
  return APP_WINDOWS[key] ?? new RegExp(key.replace(/\.exe$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

export interface AppMatch {
  /**
   * "program": the program's name is the one asked for; "partial": one
   * program's name contains it ("notepad" → Notepad++ when Notepad is not
   * open); "title": only window titles matched.
   */
  by: 'program' | 'partial' | 'title' | 'none';
  windows: AppWindow[];
}

/** Shorter names are not matched inside program names ("e" is in most of them). */
const MIN_PARTIAL_NAME = 3;

/** The windows of the app named `target`: by program name first, else by window title. */
export function matchAppWindows(target: string, windows: readonly AppWindow[]): AppMatch {
  const program = programFor(target);
  if (!program) return { by: 'none', windows: [] };
  // The exact program first: "notepad" is not "notepad++".
  const exact = windows.filter((w) => programKey(w.name) === program);
  if (exact.length > 0) return { by: 'program', windows: exact };
  // An app listed above, in its own window ("close calculator" → CalculatorApp,
  // or ApplicationFrameHost titled "Calculator"), before any partial name.
  const hosts = APP_HOSTS[target.toLowerCase().trim()];
  const own = hosts ? windows.filter((w) => isAppItself(hosts, w)) : [];
  if (own.length > 0) return { by: 'program', windows: own };
  // Inside a program's name only when that leaves one program.
  if (program.length >= MIN_PARTIAL_NAME) {
    const partial = windows.filter((w) => programKey(w.name).includes(program));
    if (partial.length > 0 && new Set(partial.map((w) => programKey(w.name))).size === 1) return { by: 'partial', windows: partial };
  }
  // Program names are matched here only for the apps listed above (VS Code's
  // "Code"); otherwise "host" would reach every *host program after all.
  const matcher = appWindowMatcher(target);
  const byTitle = windows.filter((w) => matcher.test(w.windowTitle) || (!!hosts && matcher.test(w.name)));
  return byTitle.length > 0 ? { by: 'title', windows: byTitle } : { by: 'none', windows: [] };
}

export type ClosePlan =
  | { kind: 'none' }
  | { kind: 'browser'; browser: string }
  | { kind: 'browser-page'; browser: string }
  /** `exact`: the program asked for; otherwise only a part of a name or a title matched. */
  | { kind: 'close'; windows: AppWindow[]; exact: boolean };

/**
 * What closing the app `target` may close. A browser named as the app is
 * not closed this way; a site or tab name that only browser windows carry
 * in their titles is a tab, not an app. Other windows that matched the title
 * are closed, never a browser window with them.
 */
export function planAppClose(target: string, windows: readonly AppWindow[]): ClosePlan {
  const match = matchAppWindows(target, windows);
  if (match.by === 'none') return { kind: 'none' };
  const browserWindow = match.windows.find((w) => browserName(w.name));
  if (match.by !== 'title' && browserWindow) return { kind: 'browser', browser: browserName(browserWindow.name)! };
  const others = match.windows.filter((w) => !browserName(w.name));
  if (others.length === 0) return { kind: 'browser-page', browser: browserName(browserWindow!.name)! };
  return { kind: 'close', windows: others, exact: match.by === 'program' };
}

/** The windows a close of `target` would close that are still open: what its check looks for. */
export function appWindowsLeft(target: string, windows: readonly AppWindow[]): AppWindow[] {
  const plan = planAppClose(target, windows);
  return plan.kind === 'close' ? plan.windows : [];
}

/** True when the window belongs to a web browser. */
export function isBrowserWindow(w: Pick<AppWindow, 'name'>): boolean {
  return !!browserName(w.name);
}

/** The refusal for a browser named as an app (D3). */
export function browserCloseRefusal(browser: string): string {
  return `I don't close the ${browser} browser through app, window or process control: that would close your own ${browser} windows too. I can close a tab.`;
}

/** The refusal for a site or tab name given to an app or window tool. */
export function browserPageRefusal(target: string, browser: string): string {
  return `"${target}" is a page open in ${browser}, not an app. Ask me to close the ${target} tab instead.`;
}
