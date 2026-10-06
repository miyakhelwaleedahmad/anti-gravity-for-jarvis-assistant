/**
 * perception/cdpScripts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The only JavaScript JARVIS runs in a page: fixed, returning plain values.
 * The model never supplies script; tools pick one of these. The `_SCRIPT`
 * constants are expressions (cdpClient.evaluateFixed); the `_FN` constants
 * are functions that take plain values as arguments (cdpClient.callFixed) —
 * a reference or a typed text is passed as data, never pasted into source.
 *
 * They run in an isolated world, so a page that replaces built-ins cannot
 * change them. Named elements can still shadow DOM properties
 * (`<img name="title">` makes `document.title` the image), so the helpers
 * read DOM properties and call DOM methods through the prototypes.
 *
 * Field values are read only for text, search and select fields — never for
 * passwords, hidden fields or anything else. No cookies, no storage.
 */

/** Shared helpers, as source. */
const HELPERS = String.raw`
  const get = (proto, name, obj) => Object.getOwnPropertyDescriptor(proto, name).get.call(obj);
  const call = (proto, name, obj, ...args) => proto[name].apply(obj, args);
  const attr = (el, name) => call(Element.prototype, 'getAttribute', el, name);
  const all = (selector, max) => Array.from(call(Document.prototype, 'querySelectorAll', document, selector)).slice(0, max);
  const find = (css) => { try { return call(Document.prototype, 'querySelector', document, css); } catch (e) { return null; } };
  const body = get(Document.prototype, 'body', document);
  const tagOf = (el) => String(get(Element.prototype, 'tagName', el)).toLowerCase();
  const idOf = (el) => get(Element.prototype, 'id', el);
  const contains = (outer, inner) => !!inner && call(Node.prototype, 'contains', outer, inner);
  const textOf = (el) => (!el ? '' : el instanceof HTMLElement ? get(HTMLElement.prototype, 'innerText', el) : get(Node.prototype, 'textContent', el));
  const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const pageTitle = () => clip(get(Document.prototype, 'title', document), 200);
  const uniqueId = (el) => {
    const id = idOf(el);
    return id && all('#' + CSS.escape(id), 2).length === 1 ? '#' + CSS.escape(id) : '';
  };
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node !== body && parts.length < 8) {
      const id = uniqueId(node);
      if (id) { parts.unshift(id); break; }
      let part = tagOf(node);
      const parent = get(Node.prototype, 'parentElement', node);
      if (parent) {
        const same = Array.from(get(Element.prototype, 'children', parent)).filter((c) => tagOf(c) === part);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return (parts[0] && parts[0].startsWith('#') ? '' : 'body > ') + parts.join(' > ');
  };
  const labelOf = (el) => {
    if (el.labels && el.labels.length) return clip(textOf(el.labels[0]), 80);
    return clip(attr(el, 'aria-label') || attr(el, 'placeholder') || attr(el, 'title'), 80);
  };
  const formOf = (el) => (el.form instanceof HTMLFormElement ? el.form : call(Element.prototype, 'closest', el, 'form'));
  const formFields = (f) => (f ? Array.from(get(HTMLFormElement.prototype, 'elements', f)) : []);
  const passwordForm = (el) => formFields(formOf(el)).some((e) => e.type === 'password');
  const submits = (el) => {
    const tag = tagOf(el);
    const type = String(el.type || '').toLowerCase();
    if (tag === 'button') return type === 'submit' && !!formOf(el);
    if (tag === 'input') return (type === 'submit' || type === 'image') && !!formOf(el);
    return false;
  };
  const CREDENTIAL_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)$/i;
  const CREDENTIAL_WORDS = /pass ?word|passwd|passcode|\bpin\b(?! ?code)|\bcvv\b|\bcvc\b|security code|card ?number|one.?time|\botp\b|\b2fa\b|verification code|auth(?:entication)? code/i;
  const credential = (el) => el.type === 'password'
    || CREDENTIAL_AUTOCOMPLETE.test(String(attr(el, 'autocomplete') || '').trim().split(/\s+/).pop())
    || CREDENTIAL_WORDS.test([attr(el, 'name'), idOf(el), labelOf(el), attr(el, 'placeholder'), attr(el, 'aria-label')].join(' '));
  const search = (el) => el.type === 'search' || attr(el, 'role') === 'searchbox'
    || /search|query|^q$/i.test([attr(el, 'name'), idOf(el), attr(el, 'placeholder'), attr(el, 'aria-label')].join(' '));
  const labelFor = (el, kind) => kind === 'link' ? clip(textOf(el) || attr(el, 'aria-label'), 80)
    : kind === 'button' ? clip(textOf(el) || (tagOf(el) === 'input' ? el.value : '') || attr(el, 'aria-label'), 80)
    : kind === 'field' ? labelOf(el) : clip(textOf(el), 80);
  /** What an element is, so that a later action can tell it is still the same one. */
  const fingerprint = (el, kind) => [kind, tagOf(el), String(el.type || ''), String(attr(el, 'name') || ''), idOf(el),
    kind === 'link' ? String(attr(el, 'href') || '') : '', clip(labelFor(el, kind), 40),
    submits(el), passwordForm(el), kind === 'field' && credential(el)].join('|');
`;

/** document.visibilityState, to find the tab on screen. */
export const VISIBILITY_SCRIPT = `Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get.call(document)`;

/** Title, URL and visible text (at most 4 000 characters). */
export const PAGE_TEXT_SCRIPT = String.raw`(() => {
  ${HELPERS}
  const text = String(textOf(body) || '');
  return {
    title: pageTitle(),
    url: location.href.slice(0, 500),
    text: text.replace(/\n{3,}/g, '\n\n').slice(0, 4000),
    truncated: text.length > 4000,
  };
})()`;

/**
 * Headings, links, buttons, forms, fields outside forms and tables. Each
 * element carries `info` (CSS path, fingerprint, what an action on it would
 * do), which browserState keeps for later actions and does not show the model.
 */
export const PAGE_STRUCTURE_SCRIPT = String.raw`(() => {
  ${HELPERS}
  const VALUE_TYPES = new Set(['text', 'search', 'select-one']);
  const form = (name, f) => get(HTMLFormElement.prototype, name, f);
  const info = (el, kind, extra) => Object.assign({ kind, css: cssPath(el), fp: fingerprint(el, kind), label: clip(labelFor(el, kind), 80), tag: tagOf(el) }, extra || {});
  const field = (e) => {
    const type = clip(e.type || (e.isContentEditable ? 'contenteditable' : tagOf(e)), 20).toLowerCase();
    const out = { label: labelOf(e) || clip(attr(e, 'aria-label'), 80), name: clip(attr(e, 'name'), 60), type, required: e.required === true };
    if (VALUE_TYPES.has(type)) out.value = clip(e.value, 100);
    out.info = info(e, 'field', { type, credential: credential(e), search: search(e), inForm: !!formOf(e), passwordForm: passwordForm(e) });
    return out;
  };
  const headings = all('h1, h2, h3', 30).map((h) => ({ level: tagOf(h), text: clip(textOf(h), 120), info: info(h, 'heading') }));
  const hrefOf = (a) => (a instanceof HTMLAnchorElement ? a.href : String(attr(a, 'href') || ''));
  const links = all('a[href]', 50).map((a) => ({
    text: clip(textOf(a) || attr(a, 'aria-label'), 80),
    href: hrefOf(a).slice(0, 300),
    info: info(a, 'link', { href: hrefOf(a).slice(0, 300), download: call(Element.prototype, 'hasAttribute', a, 'download') }),
  }));
  const buttons = all('button, input[type=submit], input[type=button], input[type=reset], input[type=image], [role=button]', 40).map((b) => ({
    text: labelFor(b, 'button'),
    type: clip(b.type || attr(b, 'role'), 20),
    disabled: b.disabled === true,
    submits: submits(b),
    info: info(b, 'button', { submits: submits(b), passwordForm: passwordForm(b) }),
  }));
  const forms = all('form', 10).map((f) => ({
    action: String(form('action', f)).slice(0, 300),
    method: clip(form('method', f), 10),
    fields: formFields(f).filter((e) => tagOf(e) !== 'button' && !['submit', 'button', 'reset', 'image'].includes(e.type)).slice(0, 30).map(field),
    info: info(f, 'form'),
  }));
  const loose = all('input, select, textarea, [contenteditable=""], [contenteditable="true"], [role=textbox]', 200)
    .filter((e) => !formOf(e) && !['submit', 'button', 'reset', 'image', 'hidden'].includes(e.type)).slice(0, 20).map(field);
  const tables = all('table', 5).map((t) => {
    const rows = Array.from(t.rows);
    const headerRow = t.tHead && t.tHead.rows[0] ? t.tHead.rows[0] : rows.find((r) => r.querySelector('th'));
    const header = headerRow ? Array.from(headerRow.cells).map((c) => clip(textOf(c), 60)) : [];
    const rest = rows.filter((r) => r !== headerRow).slice(0, 5).map((r) => Array.from(r.cells).slice(0, 10).map((c) => clip(textOf(c), 60)));
    return { caption: clip(t.caption ? textOf(t.caption) : '', 120), header, rows: rest, totalRows: rows.length, info: info(t, 'table') };
  });
  return { title: pageTitle(), url: location.href.slice(0, 500), headings, links, buttons, forms, fields: loose, tables };
})()`;

/** Address, title, load state, document start time, visibility and scroll position of the page. */
export const PAGE_STATE_SCRIPT = String.raw`(() => ({
  url: location.href.slice(0, 500),
  title: String(Object.getOwnPropertyDescriptor(Document.prototype, 'title').get.call(document)).slice(0, 200),
  readyState: Object.getOwnPropertyDescriptor(Document.prototype, 'readyState').get.call(document),
  timeOrigin: performance.timeOrigin,
  visibility: Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get.call(document),
  scrollY: window.scrollY,
}))()`;

/**
 * (css, kind, fingerprint) → is the element still there and the same, can it
 * be seen and used, where is its centre. Scrolls it into view first.
 */
export const RESOLVE_FN = String.raw`function (css, kind, fp) {
  ${HELPERS}
  const el = find(css);
  if (!el) return { found: false, why: 'it is no longer on the page' };
  if (fingerprint(el, kind) !== fp) return { found: false, why: 'it changed since JARVIS looked at the page' };
  call(Element.prototype, 'scrollIntoView', el, { block: 'center', inline: 'center', behavior: 'instant' });
  const r = call(Element.prototype, 'getBoundingClientRect', el);
  const shown = typeof Element.prototype.checkVisibility === 'function'
    ? call(Element.prototype, 'checkVisibility', el, { opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })
    : true;
  const visible = shown && r.width > 0 && r.height > 0;
  const disabled = el.disabled === true || attr(el, 'aria-disabled') === 'true';
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = call(Document.prototype, 'elementFromPoint', document, x, y);
  const labels = el.labels ? Array.from(el.labels) : [];
  const covered = visible && !(hit === el || contains(el, hit) || labels.some((l) => hit === l || contains(l, hit)));
  return { found: true, visible, disabled, covered, x, y, url: location.href.slice(0, 500) };
}`;

/** (css) → starts counting page changes and remembers the element's state. */
export const WATCH_FN = String.raw`function (css) {
  ${HELPERS}
  const el = find(css);
  if (globalThis.__jarvisObserver) globalThis.__jarvisObserver.disconnect();
  globalThis.__jarvisWatch = { mutations: 0, checked: el ? el.checked : undefined };
  globalThis.__jarvisObserver = new MutationObserver((list) => { globalThis.__jarvisWatch.mutations += list.length; });
  globalThis.__jarvisObserver.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  return true;
}`;

/** (css) → what changed since WATCH_FN: page updates, address, checked state, focus. */
export const CHANGES_FN = String.raw`function (css) {
  ${HELPERS}
  const w = globalThis.__jarvisWatch || { mutations: 0 };
  const el = find(css);
  return {
    mutations: w.mutations,
    url: location.href.slice(0, 500),
    checkedChanged: !!el && w.checked !== undefined && el.checked !== w.checked,
    checked: el ? el.checked === true : false,
    focused: !!el && get(Document.prototype, 'activeElement', document) === el,
  };
}`;

/** (css, clear) → focuses a field (and empties it when `clear`); can it take text. */
export const FOCUS_FN = String.raw`function (css, clear) {
  ${HELPERS}
  const el = find(css);
  if (!el) return { focused: false, editable: false };
  const editable = el.isContentEditable === true;
  const textual = el instanceof HTMLTextAreaElement
    || (el instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'number'].includes(el.type));
  if (!editable && !textual) return { focused: false, editable: false };
  call(HTMLElement.prototype, 'focus', el);
  if (editable) {
    const selection = getSelection();
    selection.selectAllChildren(el);
    if (!clear) selection.collapseToEnd();
  } else if (clear) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
    call(EventTarget.prototype, 'dispatchEvent', el, new Event('input', { bubbles: true }));
  } else {
    try { const n = String(el.value).length; el.setSelectionRange(n, n); } catch (e) { /* email and number have no caret API */ }
  }
  return { focused: get(Document.prototype, 'activeElement', document) === el, editable: true };
}`;

/** (css, text, whole) → does the field now hold `text` (as its whole value, or at its end). Never returns the value. */
export const VALUE_IS_FN = String.raw`function (css, text, whole) {
  ${HELPERS}
  const el = find(css);
  if (!el) return false;
  if (el.isContentEditable) return String(textOf(el)).includes(text);
  const value = String(el.value);
  return whole ? value === text : value.endsWith(text);
}`;

/** (css, wanted) → chooses an option by value or visible text. */
export const SELECT_FN = String.raw`function (css, wanted) {
  ${HELPERS}
  const el = find(css);
  if (!(el instanceof HTMLSelectElement)) return { ok: false, why: 'it is not a list to choose from' };
  const options = Array.from(el.options);
  const want = String(wanted).trim().toLowerCase();
  const option = options.find((o) => o.value === wanted) || options.find((o) => clip(o.text, 100).toLowerCase() === want);
  if (!option) return { ok: false, why: 'it has no such option', options: options.slice(0, 20).map((o) => clip(o.text, 60)) };
  if (option.disabled) return { ok: false, why: 'that option cannot be chosen' };
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
  call(EventTarget.prototype, 'dispatchEvent', el, new Event('input', { bubbles: true }));
  call(EventTarget.prototype, 'dispatchEvent', el, new Event('change', { bubbles: true }));
  return { ok: true, value: option.value, text: clip(option.text, 60) };
}`;

/** (css) → the value of a select list, to check a choice. */
export const SELECTED_FN = String.raw`function (css) {
  ${HELPERS}
  const el = find(css);
  return el instanceof HTMLSelectElement ? el.value : null;
}`;

/** (css or '', direction) → scrolls to an element, or the page up, down, to the top or to the bottom. */
export const SCROLL_FN = String.raw`function (css, direction) {
  ${HELPERS}
  const before = window.scrollY;
  const root = document.scrollingElement || document.documentElement;
  const max = Math.max(0, get(Element.prototype, 'scrollHeight', root) - window.innerHeight);
  if (css) {
    const el = find(css);
    if (!el) return { ok: false, why: 'it is no longer on the page' };
    call(Element.prototype, 'scrollIntoView', el, { block: 'center', behavior: 'instant' });
    const r = call(Element.prototype, 'getBoundingClientRect', el);
    return { ok: true, before, after: window.scrollY, max, inView: r.bottom > 0 && r.top < window.innerHeight };
  }
  const step = Math.round(window.innerHeight * 0.8);
  const top = direction === 'up' ? before - step : direction === 'top' ? 0 : direction === 'bottom' ? max : before + step;
  window.scrollTo({ top, behavior: 'instant' });
  return { ok: true, before, after: window.scrollY, max };
}`;

/** (css) → the element itself, as a handle (for DOM.setFileInputFiles). */
export const ELEMENT_FN = String.raw`function (css) {
  ${HELPERS}
  return find(css);
}`;

/** (css) → the names (only) of the files a file field holds. */
export const FILE_NAMES_FN = String.raw`function (css) {
  ${HELPERS}
  const el = find(css);
  return el instanceof HTMLInputElement && el.files ? Array.from(el.files).map((f) => f.name) : null;
}`;
