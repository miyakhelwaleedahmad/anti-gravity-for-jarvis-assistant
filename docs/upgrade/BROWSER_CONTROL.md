# Browser observation and control

Observation: P8 ([prompt](phases/phase-08-browser-observation.md)).
Control: P9 ([prompt](phases/phase-09-browser-control.md)).

## Today

`control/browserController.ts` and `perception/chromeState.ts` use only the
DevTools **HTTP** endpoints on `127.0.0.1:9222`: list tabs, activate, open,
close. Refresh presses Ctrl+R. Nothing reads a page, clicks inside it or types
into it. `tools/browserTool.py` is a placeholder that returns fake text and is
not used.

## Requirement on the owner's PC

Since Chrome 136, Chrome ignores `--remote-debugging-port` for the default
profile; a separate `--user-data-dir` is required
([Chrome developer blog](https://developer.chrome.com/blog/remote-debugging-port)).
JARVIS already tells the user to start:

```
start chrome.exe --remote-debugging-port=9222 --user-data-dir="W:\jarvis-chrome-profile"
```

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

## Observation (level 0)

| Tool | Returns |
|---|---|
| browser_state | browser version, windows, tabs (title, URL), the visible tab per window |
| browser_read_page | page text, capped at 4 000 characters |
| browser_page_structure | headings, links, buttons, forms (label, type, required; value only for non-sensitive fields), tables (header and first rows), each with a reference |

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
