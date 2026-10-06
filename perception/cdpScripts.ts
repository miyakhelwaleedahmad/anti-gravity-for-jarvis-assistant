/**
 * perception/cdpScripts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The only JavaScript JARVIS runs in a page: fixed, read-only, returning plain
 * values. The model never supplies script; tools pick one of these.
 *
 * They run in an isolated world (cdpClient.evaluateFixed), so a page that
 * replaces built-ins cannot change them. Named elements can still shadow DOM
 * properties (`<img name="title">` makes `document.title` the image), so the
 * helpers read DOM properties through the prototypes' own getters.
 *
 * Field values are read only for text, search and select fields — never for
 * passwords, hidden fields or anything else. No cookies, no storage.
 */

/** Shared helpers, as source. */
const HELPERS = String.raw`
  const get = (proto, name, obj) => Object.getOwnPropertyDescriptor(proto, name).get.call(obj);
  const attr = (el, name) => Element.prototype.getAttribute.call(el, name);
  const all = (selector, max) => Array.from(Document.prototype.querySelectorAll.call(document, selector)).slice(0, max);
  const body = get(Document.prototype, 'body', document);
  const tagOf = (el) => String(get(Element.prototype, 'tagName', el)).toLowerCase();
  const textOf = (el) => (!el ? '' : el instanceof HTMLElement ? get(HTMLElement.prototype, 'innerText', el) : get(Node.prototype, 'textContent', el));
  const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const pageTitle = () => clip(get(Document.prototype, 'title', document), 200);
  const uniqueId = (el) => {
    const id = get(Element.prototype, 'id', el);
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
`;

/** document.visibilityState, to find the tab on screen. */
export const VISIBILITY_SCRIPT = `Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get.call(document)`;

/** Title, URL and visible text (at most 4 000 characters). */
export const PAGE_TEXT_SCRIPT = `(() => {
  ${HELPERS}
  const text = String(textOf(body) || '');
  return {
    title: pageTitle(),
    url: location.href.slice(0, 500),
    text: text.replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000),
    truncated: text.length > 4000,
  };
})()`;

/** Headings, links, buttons, forms and tables, each with a CSS reference. */
export const PAGE_STRUCTURE_SCRIPT = `(() => {
  ${HELPERS}
  const VALUE_TYPES = new Set(['text', 'search', 'select-one']);
  const form = (name, f) => get(HTMLFormElement.prototype, name, f);
  const headings = all('h1, h2, h3', 30).map((h) => ({ level: tagOf(h), text: clip(textOf(h), 120), ref: cssPath(h) }));
  const hrefOf = (a) => (a instanceof HTMLAnchorElement ? a.href : String(attr(a, 'href') || ''));
  const links = all('a[href]', 50).map((a) => ({ text: clip(textOf(a) || attr(a, 'aria-label'), 80), href: hrefOf(a).slice(0, 300), ref: cssPath(a) }));
  const buttons = all('button, input[type=submit], input[type=button], input[type=reset], [role=button]', 40).map((b) => ({
    text: clip(textOf(b) || b.value || attr(b, 'aria-label'), 80),
    type: clip(b.type || attr(b, 'role'), 20),
    disabled: b.disabled === true,
    ref: cssPath(b),
  }));
  const forms = all('form', 10).map((f) => ({
    action: String(form('action', f)).slice(0, 300),
    method: clip(form('method', f), 10),
    ref: cssPath(f),
    fields: Array.from(form('elements', f)).filter((e) => tagOf(e) !== 'button' && e.type !== 'submit' && e.type !== 'button').slice(0, 30).map((e) => {
      const type = clip(e.type || tagOf(e), 20).toLowerCase();
      const field = { label: labelOf(e), name: clip(e.name, 60), type, required: e.required === true, ref: cssPath(e) };
      if (VALUE_TYPES.has(type)) field.value = clip(e.value, 100);
      return field;
    }),
  }));
  const tables = all('table', 5).map((t) => {
    const rows = Array.from(t.rows);
    const headerRow = t.tHead && t.tHead.rows[0] ? t.tHead.rows[0] : rows.find((r) => r.querySelector('th'));
    const header = headerRow ? Array.from(headerRow.cells).map((c) => clip(textOf(c), 60)) : [];
    const body = rows.filter((r) => r !== headerRow).slice(0, 5).map((r) => Array.from(r.cells).slice(0, 10).map((c) => clip(textOf(c), 60)));
    return { caption: clip(t.caption ? textOf(t.caption) : '', 120), header, rows: body, totalRows: rows.length, ref: cssPath(t) };
  });
  return { title: pageTitle(), url: location.href.slice(0, 500), headings, links, buttons, forms, tables };
})()`;
