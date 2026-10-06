# Browser observation and control

Observation: P8 ([prompt](phases/phase-08-browser-observation.md)).
Control: P9 ([prompt](phases/phase-09-browser-control.md)).

## Today

Since P8 JARVIS reads the browser through the DevTools protocol: the tools in
"Observation" below. Control is still what it was before P9:
`control/browserController.ts` uses the DevTools **HTTP** endpoints (list tabs,
activate, open, close); refresh presses Ctrl+R; nothing clicks inside a page or
types into it. `tools/browserTool.py` is a placeholder that returns fake text
and is not used.

Found in P8, for P9: current Chrome answers 405 to the GET that
`browserController.openUrl` sends to `/json/new`; it needs PUT (checked on
Chromium 141), so "open a URL" always falls back to `start`. `browserController` still uses port
9222 directly; `perception/chromeState.ts` reads `JARVIS_CDP_PORT` since P8.

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
| browser_state | browser version, windows, tabs (title, URL, on screen or not), the tab on screen |
| browser_read_page | title, URL, page text capped at 4 000 characters |
| browser_page_structure | headings (h1–h3, ≤ 30), links (≤ 50), buttons (≤ 40), forms (≤ 10; fields ≤ 30 with label, name, type, required; a value only for text, search and select fields), tables (≤ 5; caption, header, first 5 rows, total rows), each with a CSS reference |

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

## Actions

| Action | Risk | Check after |
|---|---|---|
| navigate (http/https only) | 1 | URL and load state |
| back, forward, reload | 1 | URL / load |
| new tab, switch tab | 1 | tab present / visible |
| close tab | 2 | tab gone |
| click link or button | 1; 2 if it submits a form | URL or DOM change |
| type into a field | 1 search box; 2 form field; password field refused | field value |
| select option | 1 / 2 as above | selected value |
| scroll | 1 | scroll position |
| screenshot | 1 (saved locally, not sent to the model by default) | file exists |
| download | 2 | file appears in Downloads |
| upload | 3 (file must be in an approved folder) | input lists the file |

## Not possible through this protocol

Reading the everyday Chrome profile; operating-system notifications; browsers
without a debugging port (Edge can be started the same way; Firefox has a
different protocol and is out of scope).
