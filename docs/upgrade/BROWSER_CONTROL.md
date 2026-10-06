# Browser observation and control

Observation: P8 ([prompt](phases/phase-08-browser-observation.md)).
Control: P9 ([prompt](phases/phase-09-browser-control.md)).

## Today

Since P8 JARVIS reads the browser through the DevTools protocol, and since P9
it acts in pages: the tools in "Observation" and "Actions" below.
`control/browserController.ts` (`control_browser`: list, focus, open, refresh,
close tabs) stays for the existing commands, repaired in P9 (see the end).
`tools/browserTool.py` is a placeholder that returns fake text and is not used.

## Requirement on the owner's PC

Since Chrome 136, Chrome ignores `--remote-debugging-port` for the default
profile; a separate `--user-data-dir` is required
([Chrome developer blog](https://developer.chrome.com/blog/remote-debugging-port)).
JARVIS already tells the user to start:

```
start chrome.exe --remote-debugging-port=9222 --user-data-dir="W:\jarvis-chrome-profile"
```

The port is `JARVIS_CDP_PORT` (default 9222); when Chrome is not reachable the
browser tools answer with the line to start it with, including that port.

So JARVIS sees and controls that Chrome window, not the owner's everyday Chrome
profile. This is also the safer arrangement: the everyday profile's logins and
cookies are never exposed to automation. For other browser windows JARVIS can
read only window titles (P14).

## Design

- **Protocol:** DevTools over WebSocket using the `ws` package JARVIS already
  depends on. No Playwright (heavy for the 2010 iMac).
- **Fixed in-page scripts:** the model never supplies JavaScript. Each
  capability is a fixed script in `perception/cdpScripts.ts` that returns data.
- **Element references:** the page reader returns elements with references
  (a CSS path computed in the page). Actions take a reference, so a click
  targets an element JARVIS has seen, never a guessed position.
- **Observe before, verify after:** before an action the element must exist,
  be visible and enabled; after it, a check confirms the expected change (URL,
  field value, new content, file on disk).
- **Untrusted content:** page text, titles and labels go to the model inside
  `<untrusted_context>` tags; instructions in a page are never followed.
- **Never read or typed:** password field values, cookies, local storage.

## Observation (level 0) — built in P8

| Tool | Returns |
|---|---|
| browser_state | browser version, windows, tabs (title, URL, on screen or not; since P13 the HTTP `status` of the page's last load and, when Chrome shows its error page, the `error` code such as `ERR_CONNECTION_REFUSED`), the tab on screen |
| browser_read_page | title, URL, page text capped at 4 000 characters |
| browser_page_structure | headings (h1–h3, ≤ 30), links (≤ 50), buttons (≤ 40, with `submits` for a form's submit button), forms (≤ 10; fields ≤ 30 with label, name, type, required; a value only for text, search and select fields), fields outside forms (≤ 20: search boxes, chat boxes), tables (≤ 5; caption, header, first 5 rows, total rows), each with a reference such as `e12` |

References (P9, `perception/browserRefs.ts`): the model sees only `e12`; the
CSS path, a fingerprint of the element (kind, tag, type, name, id, label, and
whether it submits, sits in a sign-in form or is a password/card/code field)
and the page address stay in JARVIS. A new look at a tab replaces its earlier
references; they expire after 10 minutes. (In P8 the reference was the CSS
path itself.)

`browser_read_page` and `browser_page_structure` take an optional `tab`: its
id, or words from its title or address; without it, the tab on screen. Output
is JSON inside `<untrusted_context source="web-page">`, with `<` and `>`
escaped (`\u003c`, `\u003e`) so the page cannot close the wrapper; the JSON
stays valid. Secrets in page text are redacted (P4).

As built (`perception/cdpClient.ts`, `cdpScripts.ts`, `browserState.ts`,
`core/tools/browserTools.ts`):

- **127.0.0.1 only.** A tab's WebSocket address must be `ws://127.0.0.1` (or
  `localhost`) on the configured port with a `/devtools/` path; anything else
  is refused before connecting.
- **Fixed scripts only.** `Runtime.evaluate` is sent from one function,
  `evaluateFixed`, and every caller passes one of the three constants in
  `cdpScripts.ts`. The tools take no script parameter. (The test checks both
  by reading the source.)
- **Isolated world.** The scripts run in an isolated world of the tab's main
  frame: the page's DOM, not its JavaScript. A page that replaces
  `String.prototype.slice`, `Array.from`, `JSON.stringify` or the `innerText`
  getter does not change what JARVIS reads (tested; in the page's own world
  the same page made the read hang until the time limit).
- **Named elements cannot shadow what is read.** `<img name="title">` makes
  `document.title` return the image, and an input named `action` hides
  `form.action`; the scripts read DOM properties through the prototypes' own
  getters, so such pages are read correctly (tested).
- **Never read:** password, hidden, email and textarea values; cookies;
  storage. Page text never includes field values.
- **Time limits:** 2 s per tab for the tab list; 5 s for a page read, for the
  whole call. A frozen page fails with "The page did not answer within … ms;
  it may be busy or frozen."; the tab list still answers and shows that tab
  without "on screen". One DevTools connection per tab at a time.
- **Not reachable:** "Chrome is not reachable for JARVIS on 127.0.0.1:<port>.
  Start it with chrome.exe --remote-debugging-port=<port>
  --user-data-dir=<a separate profile folder> (Chrome 136 and later ignore the
  port for the everyday profile)."

`get_browser_tabs` and `is_tab_open` are unchanged: they answer from the
background observer's last reading, which uses `JARVIS_CDP_PORT` since P8.
The planner is offered the three tools when a request mentions the browser,
a tab, a page, a site, a link, a form or a button.

## Actions — built in P9

`control/browserAgent.ts`, tools in `core/tools/browserActionTools.ts`, rules
in `security/browserPolicy.ts`. Levels: [PERMISSION_MODEL.md](PERMISSION_MODEL.md)
("Browser actions").

| Tool | Does | Looks before | Checks after |
|---|---|---|---|
| browser_navigate | go (http/https), back, forward, reload | the history has the page (back, forward) | the tab shows the address (and says when the site sent it on); reload: a new document |
| browser_tab | new, switch, close | the tab exists | new: the tab shows the address; switch: the tab is on screen; close: the tab is gone |
| browser_click | click a link, button, field or heading | same element, same page, visible, enabled, not covered | within 2 s: a dialog, a new tab, a new page, the address, a checkbox, page content, the focus — or "nothing changed", reported as not done |
| browser_type | type text, replacing (default) or adding; optional Enter | same element, visible, enabled, takes text, has the cursor | the field holds the text (compared in the page; the value is never returned) |
| browser_select | choose an option by text or value | same element, a list, the option exists and is enabled | the list shows the option |
| browser_scroll | to an element, or up, down, top, bottom | the element is still there | the element is in view, or the page moved (or is already at the end) |
| browser_screenshot | save a PNG of the tab in `data/screenshots` | — | a complete PNG of the expected size is on disk |
| browser_download | click a link with downloads directed to the JARVIS download folder | as for a click | the download completed and the file has its full size |
| browser_upload | put a file from an approved folder into a file field | same element, a file field, enabled (it may be hidden) | the field lists the file name |

As built:

- Clicks are real mouse events at the element's centre (after scrolling it
  into view), so a page sees them as a user's; typing is `Input.insertText`
  after the field has the cursor; Enter is a key press.
- A page dialog (alert, confirm) opened by a click is reported — "the page
  opened a dialog saying …; please answer it in Chrome" — and never answered by
  JARVIS.
- An action takes the tab's turn: one JARVIS operation per tab at a time. The
  tab is brought to the front first.
- Download folder: `JARVIS_DOWNLOAD_DIR` (absolute) or `Downloads\jarvis` in
  the user's folder. The file gets the site's name, cleaned of path parts and
  reserved names; an existing file is not overwritten (`name (1).ext`).
  Downloads are never opened. Chrome's download setting returns to its
  default afterwards.
- Upload: the field holds the file; the site receives it when the form is
  submitted, or at once on pages that upload on selection — hence level 3.
- After a navigation, the tab's references are forgotten; an action on the
  page before it asks to look again.

## control_browser, repaired in P9

| Before | Now |
|---|---|
| open_url sent GET to `/json/new`; current Chrome answers 405, so every URL opened in the system's default browser instead | PUT, with the address encoded; the tab opens in the Chrome JARVIS reads, checked |
| "close current tab" looked the tab up by its id among titles and URLs, found nothing, and answered "Tab matching "<id>" is not open." — reported as done | the tab on screen is closed by its id, checked ("the tab is gone") |
| refresh looked the tab up the same way and failed; with no match it pressed Ctrl+R in whatever window had the keyboard | reload through DevTools, checked (a new document); Ctrl+R only when Chrome cannot be reached and a browser window is in front (Windows) |
| close_current without DevTools pressed Ctrl+W in whatever window had the keyboard | the same browser-in-front condition |
| port 9222 fixed | `JARVIS_CDP_PORT` |
| no check after the action | focus, open, close and refresh checked in the browser |

## Not possible through this protocol

Reading the everyday Chrome profile; operating-system notifications; browsers
without a debugging port (Edge can be started the same way; Firefox has a
different protocol and is out of scope).
