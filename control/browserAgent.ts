/**
 * control/browserAgent.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Browser actions on the Chrome JARVIS reads (docs/upgrade/BROWSER_CONTROL.md):
 * open an address, back, forward, reload; new, switch and close tabs; click,
 * type, choose and scroll on elements JARVIS has looked at; screenshot;
 * download; upload.
 *
 * Each action looks before it acts — the element is still the one JARVIS saw
 * (perception/browserRefs.ts), on the same page, visible, enabled and not
 * covered — and checks after: address, value, page change, file on disk. The
 * check is part of the report; the tools hand it to the registry's verify
 * step (P5). Only the fixed functions in perception/cdpScripts.ts run in a
 * page; typed text and references are passed to them as data.
 *
 * The risk engine has already decided with security/browserPolicy.ts; the
 * same rules are checked again here before acting.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CdpSession, activateTab, callFixed, cdpPort, closeTabById, evaluateFixed, inTurn, isolatedWorld, listPages,
  openTab, releaseHandle, type CdpTarget,
} from '../perception/cdpClient.js';
import {
  CHANGES_FN, ELEMENT_FN, FILE_NAMES_FN, FOCUS_FN, PAGE_STATE_SCRIPT, RESOLVE_FN, SCROLL_FN, SELECTED_FN,
  SELECT_FN, VALUE_IS_FN, VISIBILITY_SCRIPT, WATCH_FN,
} from '../perception/cdpScripts.js';
import { describeElement, forgetTab, lookupRef, type ElementKind, type ObservedElement } from '../perception/browserRefs.js';
import { findTab } from '../perception/browserState.js';
import { NOT_OBSERVED, NO_CREDENTIALS, normalizeUrl, realUploadPath, uploadPathProblem, urlProblem } from '../security/browserPolicy.js';
import { redact } from '../security/redactor.js';
import { dataRoot, getWorkspaceRoot } from '../core/workspaceRoot.js';

export type CheckStatus = 'verified' | 'failed' | 'unverifiable';
export interface ActionCheck { status: CheckStatus; evidence: string }

export interface ActionReport {
  success: boolean;
  action: string;
  target: string;
  /** What JARVIS did, in words. */
  did?: string;
  /** What it saw afterwards. */
  check?: ActionCheck;
  /** The page afterwards (its own text: address and title). */
  page?: { url: string; title: string };
  file?: string;
  error?: string;
}

interface PageState { url: string; title: string; readyState: string; timeOrigin: number; visibility: string; scrollY: number }
interface Resolved { found: boolean; why?: string; visible?: boolean; disabled?: boolean; covered?: boolean; x?: number; y?: number; url?: string }
interface Changes { mutations: number; url: string; checkedChanged: boolean; checked: boolean; focused: boolean }

/** A request JARVIS does not carry out, with the reason. */
class NotDone extends Error {}

const MAX_TYPED = 2_000;
const CLICK_WATCH_MS = 2_000;
const LOAD_MS = 15_000;
const DOWNLOAD_START_MS = 5_000;
const DOWNLOAD_MS = 120_000;

const verified = (evidence: string): ActionCheck => ({ status: 'verified', evidence });
const failed = (evidence: string): ActionCheck => ({ status: 'failed', evidence });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Page text for a reply: redacted, no angle brackets, one line. */
function clean(text: unknown, max = 200): string {
  return redact(String(text ?? '')).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function withoutHash(url: string): string {
  return url.split('#')[0] ?? url;
}

async function run(action: string, target: string, fn: () => Promise<Omit<ActionReport, 'success' | 'action'>>): Promise<ActionReport> {
  try {
    return { success: true, action, ...(await fn()) };
  } catch (err) {
    return { success: false, action, target, error: clean(err instanceof Error ? err.message : String(err), 400) };
  }
}

async function tabById(id: string): Promise<CdpTarget | undefined> {
  return (await listPages(cdpPort())).find((p) => p.id === id);
}

async function chooseTab(query?: string): Promise<CdpTarget> {
  const target = await findTab(query, cdpPort());
  if (!target) throw new NotDone(query ? `No open tab matches "${clean(query, 60)}".` : 'No tab is open.');
  return target;
}

/** A connection to the tab outside the turn queue (callers hold the tab's turn). */
async function withSession<T>(target: CdpTarget, fn: (s: CdpSession) => Promise<T>): Promise<T> {
  const session = await CdpSession.connect(target, cdpPort());
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

async function pageState(target: CdpTarget, timeoutMs = 3_000): Promise<PageState> {
  return withSession(target, (s) => evaluateFixed<PageState>(s, PAGE_STATE_SCRIPT, timeoutMs));
}

/** Reads the tab until `done` holds or time runs out; the last reading either way. */
async function waitForPage(tabId: string, done: (p: PageState) => boolean, timeoutMs = LOAD_MS): Promise<{ state?: PageState; done: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let state: PageState | undefined;
  while (Date.now() < deadline) {
    const target = await tabById(tabId);
    if (!target) return { state, done: false };
    try {
      state = await pageState(target, Math.max(500, Math.min(3_000, deadline - Date.now())));
      if (done(state)) return { state, done: true };
    } catch {
      // between two documents
    }
    await sleep(150);
  }
  return { state, done: false };
}

function pageOf(state: PageState | undefined): ActionReport['page'] | undefined {
  return state ? { url: clean(state.url, 300), title: clean(state.title, 120) } : undefined;
}

// ── Elements JARVIS has seen ─────────────────────────────────────────────────

function observed(ref: unknown, kinds: ElementKind[], verb: string): ObservedElement {
  const element = lookupRef(ref);
  if (!element) throw new NotDone(NOT_OBSERVED);
  if (!kinds.includes(element.kind)) {
    throw new NotDone(`JARVIS can ${verb} ${kinds.join(', ')} elements; ${String(ref)} is a ${element.kind}.`);
  }
  return element;
}

async function elementTab(element: ObservedElement): Promise<CdpTarget> {
  const target = await tabById(element.tabId);
  if (!target) throw new NotDone('The tab JARVIS looked at is closed.');
  return target;
}

/** The element is still there, the same, on the same page; and as usable as `need` says. */
async function resolve(
  s: CdpSession, ctx: number, element: ObservedElement,
  need: { visible?: boolean; enabled?: boolean; uncovered?: boolean },
): Promise<Resolved> {
  const name = describeElement(element);
  const r = await callFixed<Resolved>(s, ctx, RESOLVE_FN, [element.css, element.kind, element.fp], 3_000);
  if (!r?.found) throw new NotDone(`JARVIS did not act on the ${name}: ${r?.why ?? 'it is not there'}. Look at the page again (browser_page_structure).`);
  if (withoutHash(r.url ?? '') !== withoutHash(element.pageUrl)) {
    throw new NotDone(`The tab shows another page than when JARVIS looked at it. Look at the page again (browser_page_structure).`);
  }
  if (need.visible && !r.visible) throw new NotDone(`JARVIS did not act: the ${name} cannot be seen on the page.`);
  if (need.enabled && r.disabled) throw new NotDone(`JARVIS did not act: the ${name} is disabled.`);
  if (need.uncovered && r.covered) throw new NotDone(`JARVIS did not act: something on the page covers the ${name}.`);
  return r;
}

/**
 * The last input event of a click or key press. A page that opens a dialog
 * (alert, confirm) in its handler holds the command until someone answers
 * the dialog; once a dialog is seen, JARVIS stops waiting and reports it.
 */
async function lastInput(s: CdpSession, method: string, params: Record<string, unknown>, dialogs: string[]): Promise<void> {
  const sent = s.send(method, params, 10_000);
  sent.catch(() => undefined);
  const deadline = Date.now() + 10_000;
  let done = false;
  void sent.then(() => { done = true; }, () => { done = true; });
  while (!done && !dialogs.length && Date.now() < deadline) await sleep(50);
  if (!dialogs.length) await sent;
}

async function mouseClick(s: CdpSession, x: number, y: number, dialogs: string[] = []): Promise<void> {
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, 2_000);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, 2_000);
  await lastInput(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, dialogs);
}

async function pressEnter(s: CdpSession, dialogs: string[]): Promise<void> {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await lastInput(s, 'Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key }, dialogs);
  if (!dialogs.length) await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, 2_000);
}

/**
 * What a click or Enter changed, watched for up to 2 s: a dialog, a new tab,
 * a new document, the address, a checkbox, the page's content, the focus.
 */
async function watchAfter(
  s: CdpSession, ctx: number, element: ObservedElement, target: CdpTarget,
  before: { pages: Set<string>; state: PageState }, dialogs: string[],
): Promise<{ check: ActionCheck; state?: PageState }> {
  const deadline = Date.now() + CLICK_WATCH_MS;
  while (Date.now() < deadline) {
    await sleep(100);
    if (dialogs.length) {
      return { check: verified(`the page opened a dialog saying "${dialogs[0]}" — JARVIS does not answer page dialogs; please answer it in Chrome`) };
    }
    const opened = (await listPages(cdpPort())).find((p) => !before.pages.has(p.id));
    if (opened) return { check: verified(`a new tab opened (${clean(opened.url, 150)})`) };
    let changes: Changes;
    try {
      changes = await callFixed<Changes>(s, ctx, CHANGES_FN, [element.css], 1_000);
    } catch (err) {
      if (dialogs.length) continue;
      if (/did not answer within/.test(err instanceof Error ? err.message : '')) continue; // busy
      // The document went away: the click started a navigation.
      const loaded = await waitForPage(target.id, (p) => p.timeOrigin !== before.state.timeOrigin && p.readyState !== 'loading');
      return loaded.done
        ? { check: verified(`the page went to ${clean(loaded.state?.url, 150)}`), state: loaded.state }
        : { check: failed('the page started to change but did not finish loading within 15 seconds'), state: loaded.state };
    }
    if (changes.url !== before.state.url) return { check: verified(`the address changed to ${clean(changes.url, 150)}`) };
    if (changes.checkedChanged) return { check: verified(`it is now ${changes.checked ? 'checked' : 'unchecked'}`) };
    if (changes.mutations > 0) return { check: verified(`the page changed (${changes.mutations} update${changes.mutations === 1 ? '' : 's'})`) };
    if (element.kind === 'field' && changes.focused) return { check: verified('the field has the focus') };
  }
  return { check: failed(`nothing on the page changed within ${CLICK_WATCH_MS / 1000} seconds`) };
}

async function prepareWatch(s: CdpSession, ctx: number, element: ObservedElement, dialogs: string[]): Promise<{ pages: Set<string>; state: PageState; stop: () => void }> {
  const state = await evaluateFixed<PageState>(s, PAGE_STATE_SCRIPT, 2_000);
  const pages = new Set((await listPages(cdpPort())).map((p) => p.id));
  await s.send('Page.enable', {}, 2_000);
  const stop = s.on('Page.javascriptDialogOpening', (p: { message?: string }) => { dialogs.push(clean(p.message, 120)); });
  await callFixed(s, ctx, WATCH_FN, [element.css], 2_000);
  return { pages, state, stop };
}

// ── Element actions ──────────────────────────────────────────────────────────

export async function click(ref: unknown): Promise<ActionReport> {
  return run('click', String(ref ?? ''), async () => {
    const element = observed(ref, ['link', 'button', 'field', 'heading'], 'click');
    if (element.kind === 'link' && element.download) {
      throw new NotDone('That link downloads a file: use browser_download, which saves it in the JARVIS download folder.');
    }
    const target = await elementTab(element);
    const name = describeElement(element);
    return inTurn(target.id, async () => {
      await activateTab(target.id, cdpPort());
      return withSession(target, async (s) => {
        const ctx = await isolatedWorld(s, 3_000);
        const at = await resolve(s, ctx, element, { visible: true, enabled: true, uncovered: true });
        const dialogs: string[] = [];
        const watch = await prepareWatch(s, ctx, element, dialogs);
        try {
          await mouseClick(s, at.x!, at.y!, dialogs);
          const after = await watchAfter(s, ctx, element, target, watch, dialogs);
          if (after.state && after.state.url !== element.pageUrl) forgetTab(target.id);
          return { target: name, did: `clicked the ${name}`, check: after.check, ...(after.state ? { page: pageOf(after.state) } : {}) };
        } finally {
          watch.stop();
        }
      });
    });
  });
}

export async function type(ref: unknown, text: unknown, options: { clear?: boolean; enter?: boolean } = {}): Promise<ActionReport> {
  return run('type', String(ref ?? ''), async () => {
    const element = observed(ref, ['field'], 'type into');
    if (element.credential) throw new NotDone(NO_CREDENTIALS);
    if (typeof text !== 'string' || !text) throw new NotDone('Say what to type.');
    if (text.length > MAX_TYPED) throw new NotDone(`JARVIS types at most ${MAX_TYPED} characters at a time.`);
    const clear = options.clear !== false;
    const target = await elementTab(element);
    const name = describeElement(element);
    return inTurn(target.id, async () => {
      await activateTab(target.id, cdpPort());
      return withSession(target, async (s) => {
        const ctx = await isolatedWorld(s, 3_000);
        await resolve(s, ctx, element, { visible: true, enabled: true });
        const focus = await callFixed<{ focused: boolean; editable: boolean }>(s, ctx, FOCUS_FN, [element.css, clear], 2_000);
        if (!focus.editable) throw new NotDone(`The ${name} does not take typed text.`);
        if (!focus.focused) throw new NotDone(`JARVIS could not put the cursor in the ${name}.`);
        await s.send('Input.insertText', { text }, 3_000);
        const holds = await callFixed<boolean>(s, ctx, VALUE_IS_FN, [element.css, text, clear], 2_000);
        const did = `typed ${text.length} character${text.length === 1 ? '' : 's'} into the ${name}`;
        if (!holds) return { target: name, did, check: failed('the field does not hold what was typed') };
        if (!options.enter) return { target: name, did, check: verified(`the field holds the ${text.length} characters typed`) };
        const dialogs: string[] = [];
        const watch = await prepareWatch(s, ctx, element, dialogs);
        try {
          await pressEnter(s, dialogs);
          const after = await watchAfter(s, ctx, element, target, watch, dialogs);
          if (after.state && after.state.url !== element.pageUrl) forgetTab(target.id);
          return {
            target: name, did: `${did} and pressed Enter`,
            check: { status: after.check.status, evidence: `the field held the text; after Enter ${after.check.evidence}` },
            ...(after.state ? { page: pageOf(after.state) } : {}),
          };
        } finally {
          watch.stop();
        }
      });
    });
  });
}

export async function choose(ref: unknown, option: unknown): Promise<ActionReport> {
  return run('select', String(ref ?? ''), async () => {
    const element = observed(ref, ['field'], 'choose in');
    if (!String(element.type ?? '').startsWith('select')) throw new NotDone(`The ${describeElement(element)} is not a list to choose from.`);
    if (typeof option !== 'string' || !option.trim()) throw new NotDone('Say which option to choose.');
    const target = await elementTab(element);
    const name = describeElement(element);
    return inTurn(target.id, async () => {
      await activateTab(target.id, cdpPort());
      return withSession(target, async (s) => {
        const ctx = await isolatedWorld(s, 3_000);
        await resolve(s, ctx, element, { visible: true, enabled: true });
        const r = await callFixed<{ ok: boolean; why?: string; options?: string[]; value?: string; text?: string }>(
          s, ctx, SELECT_FN, [element.css, option], 2_000);
        if (!r.ok) {
          const offered = r.options?.length ? `; it offers: ${r.options.map((o) => clean(o, 40)).join(', ')}` : '';
          throw new NotDone(`JARVIS did not choose: the ${name} — ${r.why ?? 'no such option'}${offered}.`);
        }
        const now = await callFixed<string | null>(s, ctx, SELECTED_FN, [element.css], 2_000);
        return {
          target: name,
          did: `chose "${clean(r.text, 60)}" in the ${name}`,
          check: now === r.value ? verified(`the list now shows "${clean(r.text, 60)}"`) : failed('the list did not keep the choice'),
        };
      });
    });
  });
}

const DIRECTIONS = new Set(['up', 'down', 'top', 'bottom']);

export async function scroll(args: { ref?: unknown; direction?: unknown; tab?: unknown }): Promise<ActionReport> {
  const direction = typeof args.direction === 'string' && DIRECTIONS.has(args.direction.toLowerCase()) ? args.direction.toLowerCase() : 'down';
  return run('scroll', String(args.ref ?? direction), async () => {
    const element = args.ref !== undefined && args.ref !== '' ? observed(args.ref, ['link', 'button', 'field', 'heading', 'table', 'form'], 'scroll to') : undefined;
    const target = element ? await elementTab(element) : await chooseTab(typeof args.tab === 'string' ? args.tab : undefined);
    const name = element ? describeElement(element) : `the page ${direction}`;
    return inTurn(target.id, async () => withSession(target, async (s) => {
      const ctx = await isolatedWorld(s, 3_000);
      if (element) await resolve(s, ctx, element, {});
      const r = await callFixed<{ ok: boolean; why?: string; before: number; after: number; max: number; inView?: boolean }>(
        s, ctx, SCROLL_FN, [element?.css ?? '', direction], 2_000);
      if (!r.ok) throw new NotDone(`JARVIS did not scroll: ${r.why ?? 'the element is not there'}.`);
      let check: ActionCheck;
      if (element) {
        check = r.inView ? verified(`the ${describeElement(element)} is in view`) : failed('the element is still out of view');
      } else if (r.after !== r.before) {
        check = verified(`the page is now ${Math.round(r.after)} pixels from the top (it was ${Math.round(r.before)})`);
      } else if ((direction === 'up' || direction === 'top') && r.after <= 0) {
        check = verified('the page is already at the top');
      } else if ((direction === 'down' || direction === 'bottom') && r.after >= r.max - 1) {
        check = verified('the page is already at the bottom');
      } else {
        check = failed('the page did not move; it may scroll inside a panel — name an element to scroll to');
      }
      return { target: name, did: element ? `scrolled to the ${describeElement(element)}` : `scrolled ${direction}`, check };
    }));
  });
}

// ── Navigation and tabs ──────────────────────────────────────────────────────

export async function navigate(args: { action?: unknown; url?: unknown; tab?: unknown }): Promise<ActionReport> {
  const action = typeof args.action === 'string' ? args.action.toLowerCase() : 'go';
  const rawUrl = typeof args.url === 'string' ? args.url : '';
  return run(action, action === 'go' ? clean(rawUrl, 160) : action, async () => {
    if (!['go', 'back', 'forward', 'reload'].includes(action)) throw new NotDone(`Unknown browser_navigate action "${clean(action, 20)}".`);
    const url = normalizeUrl(rawUrl);
    if (action === 'go') {
      const problem = urlProblem(url);
      if (problem) throw new NotDone(problem);
    }
    const target = await chooseTab(typeof args.tab === 'string' ? args.tab : undefined);
    return inTurn(target.id, async () => {
      const before = await pageState(target);
      let wanted: (p: PageState) => boolean;
      let entryUrl = '';
      if (action === 'go') {
        const nav = await withSession(target, (s) => s.send<{ errorText?: string }>('Page.navigate', { url }, 10_000));
        if (nav.errorText) throw new NotDone(`Chrome could not open ${clean(url, 150)}: ${clean(nav.errorText, 80)}.`);
        wanted = (p) => p.timeOrigin !== before.timeOrigin && p.readyState !== 'loading';
      } else if (action === 'reload') {
        await withSession(target, (s) => s.send('Page.reload', {}, 5_000));
        wanted = (p) => p.timeOrigin > before.timeOrigin && p.readyState !== 'loading';
      } else {
        const history = await withSession(target, (s) => s.send<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>(
          'Page.getNavigationHistory', {}, 3_000));
        const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
        if (!entry) throw new NotDone(`There is no page to go ${action} to in this tab.`);
        entryUrl = entry.url;
        await withSession(target, (s) => s.send('Page.navigateToHistoryEntry', { entryId: entry.id }, 5_000));
        wanted = (p) => p.url === entryUrl && p.readyState !== 'loading';
      }
      forgetTab(target.id);
      const loaded = await waitForPage(target.id, wanted);
      const shown = clean(loaded.state?.url, 200);
      const did = action === 'go' ? `opened ${clean(url, 150)}` : action === 'reload' ? 'reloaded the page' : `went ${action}`;
      if (!loaded.done) {
        return { target: clean(target.title, 80), did, check: failed('the page did not finish loading within 15 seconds'), page: pageOf(loaded.state) };
      }
      let evidence = action === 'reload' ? 'the page loaded again' : `the tab shows ${shown}`;
      if (action === 'go') {
        try {
          if (new URL(loaded.state!.url).host !== new URL(url).host) evidence += ' (the site sent it on to another address)';
        } catch { /* not comparable */ }
      }
      return { target: clean(target.title, 80), did, check: verified(evidence), page: pageOf(loaded.state) };
    });
  });
}

export async function tab(args: { action?: unknown; url?: unknown; tab?: unknown }): Promise<ActionReport> {
  const action = typeof args.action === 'string' ? args.action.toLowerCase() : '';
  const query = typeof args.tab === 'string' ? args.tab : undefined;
  return run(action, query ?? clean(args.url, 160), async () => {
    if (action === 'new') {
      const url = normalizeUrl(typeof args.url === 'string' ? args.url : '') || 'about:blank';
      const problem = urlProblem(url, true);
      if (problem) throw new NotDone(problem);
      const created = await openTab(url, cdpPort());
      const loaded = url === 'about:blank'
        ? { done: !!(await tabById(created.id)), state: undefined }
        : await waitForPage(created.id, (p) => p.readyState !== 'loading' && p.url !== 'about:blank');
      return {
        target: clean(url, 160),
        did: `opened a new tab${url === 'about:blank' ? '' : ` with ${clean(url, 150)}`}`,
        check: loaded.done ? verified(`a new tab shows ${clean(loaded.state?.url ?? url, 150)}`) : failed('the new tab did not finish loading within 15 seconds'),
        ...(loaded.state ? { page: pageOf(loaded.state) } : {}),
      };
    }
    if (action !== 'switch' && action !== 'close') throw new NotDone(`Unknown browser_tab action "${clean(action, 20)}".`);
    const target = await chooseTab(query);
    const title = clean(target.title, 80);
    return inTurn(target.id, async () => {
      if (action === 'switch') {
        await activateTab(target.id, cdpPort());
        await sleep(150);
        const visibility = await withSession(target, (s) => evaluateFixed<string>(s, VISIBILITY_SCRIPT, 2_000));
        return {
          target: title,
          did: `switched to the tab "${title}"`,
          check: visibility === 'visible' ? verified('the tab is on screen') : failed('the tab is not on screen (is Chrome minimized?)'),
        };
      }
      await closeTabById(target.id, cdpPort());
      forgetTab(target.id);
      const deadline = Date.now() + 2_000;
      let gone = false;
      while (!gone && Date.now() < deadline) {
        gone = !(await tabById(target.id));
        if (!gone) await sleep(100);
      }
      return { target: title, did: `closed the tab "${title}"`, check: gone ? verified('the tab is gone') : failed('the tab is still open') };
    });
  });
}

// ── Screenshot, download, upload ─────────────────────────────────────────────

export function screenshotDir(): string {
  return path.join(dataRoot(getWorkspaceRoot()), 'data', 'screenshots');
}

export async function screenshot(query?: unknown): Promise<ActionReport> {
  return run('screenshot', typeof query === 'string' ? query : 'the tab on screen', async () => {
    const target = await chooseTab(typeof query === 'string' ? query : undefined);
    return inTurn(target.id, async () => {
      const shot = await withSession(target, (s) => s.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, 10_000));
      const png = Buffer.from(shot.data ?? '', 'base64');
      const dir = screenshotDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `browser-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      fs.writeFileSync(file, png);
      const written = fs.statSync(file).size;
      const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return {
        target: clean(target.title, 80),
        did: 'took a screenshot of the tab (saved on this PC, not sent anywhere)',
        check: isPng && written === png.length && written > 0
          ? verified(`${Math.max(1, Math.round(written / 1024))} KB image saved as ${path.basename(file)}`)
          : failed('the saved file is not a complete image'),
        file,
      };
    });
  });
}

/** JARVIS_DOWNLOAD_DIR (absolute), or Downloads\jarvis in the user's folder. */
export function downloadDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env['JARVIS_DOWNLOAD_DIR']?.trim();
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), 'Downloads', 'jarvis');
}

function safeFileName(name: string): string {
  let base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 120);
  if (!base || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = `download-${base || Date.now()}`;
  return base;
}

function freePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

export async function download(ref: unknown): Promise<ActionReport> {
  return run('download', String(ref ?? ''), async () => {
    const element = observed(ref, ['link'], 'download from');
    if (/^javascript:/i.test(element.href ?? '')) throw new NotDone('JARVIS does not download from a javascript: link.');
    const target = await elementTab(element);
    const name = describeElement(element);
    const dir = downloadDir();
    fs.mkdirSync(dir, { recursive: true });
    return inTurn(target.id, async () => {
      const browser = await CdpSession.connectBrowser(cdpPort());
      const started = new Map<string, string>();
      const finished = new Map<string, { state: string; totalBytes?: number }>();
      browser.on('Browser.downloadWillBegin', (p: { guid: string; suggestedFilename?: string }) => started.set(p.guid, p.suggestedFilename ?? ''));
      browser.on('Browser.downloadProgress', (p: { guid: string; state: string; totalBytes?: number }) => {
        if (p.state === 'completed' || p.state === 'canceled') finished.set(p.guid, p);
      });
      try {
        await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true }, 3_000);
        await activateTab(target.id, cdpPort());
        await withSession(target, async (s) => {
          const ctx = await isolatedWorld(s, 3_000);
          const at = await resolve(s, ctx, element, { visible: true, enabled: true, uncovered: true });
          await mouseClick(s, at.x!, at.y!);
        });
        const did = `clicked the ${name} to download it`;
        let deadline = Date.now() + DOWNLOAD_START_MS;
        while (!started.size && Date.now() < deadline) await sleep(100);
        const [guid, suggested] = [...started][0] ?? [];
        if (!guid) return { target: name, did, check: failed('clicking it did not start a download') };
        deadline = Date.now() + DOWNLOAD_MS;
        while (!finished.has(guid) && Date.now() < deadline) await sleep(150);
        const end = finished.get(guid);
        if (end?.state !== 'completed') {
          return { target: name, did, check: failed(end ? 'Chrome cancelled the download' : 'the download did not finish within 2 minutes') };
        }
        const file = freePath(dir, safeFileName(suggested ?? ''));
        fs.renameSync(path.join(dir, guid), file);
        const size = fs.statSync(file).size;
        const complete = end.totalBytes === undefined || end.totalBytes === 0 || size === end.totalBytes;
        return {
          target: name, did, file,
          check: complete ? verified(`${path.basename(file)} (${size} bytes) is in ${dir}`) : failed(`${path.basename(file)} has ${size} of ${end.totalBytes} bytes`),
        };
      } finally {
        await browser.send('Browser.setDownloadBehavior', { behavior: 'default' }, 2_000).catch(() => undefined);
        browser.close();
      }
    });
  });
}

export async function upload(ref: unknown, file: unknown): Promise<ActionReport> {
  return run('upload', String(ref ?? ''), async () => {
    const element = observed(ref, ['field'], 'upload into');
    if (element.type !== 'file') throw new NotDone(`The ${describeElement(element)} is not a file field.`);
    const problem = uploadPathProblem(typeof file === 'string' ? file : '');
    if (problem) throw new NotDone(problem);
    const real = realUploadPath(file as string);
    const target = await elementTab(element);
    const name = describeElement(element);
    return inTurn(target.id, async () => withSession(target, async (s) => {
      const ctx = await isolatedWorld(s, 3_000);
      await resolve(s, ctx, element, { enabled: true }); // file fields are often hidden behind a button
      const handle = await callFixed<string>(s, ctx, ELEMENT_FN, [element.css], 2_000, { handle: true });
      try {
        await s.send('DOM.setFileInputFiles', { files: [real], objectId: handle }, 5_000);
      } finally {
        await releaseHandle(s, handle);
      }
      const names = await callFixed<string[] | null>(s, ctx, FILE_NAMES_FN, [element.css], 2_000);
      return {
        target: name,
        did: `put ${path.basename(real)} in the ${name} (nothing is sent until the form is submitted)`,
        check: names?.includes(path.basename(real)) ? verified(`the field holds ${path.basename(real)}`) : failed('the field does not list the file'),
      };
    }));
  });
}
