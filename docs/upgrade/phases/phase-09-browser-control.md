# Phase 9 — Browser control

## Goal
Navigate, back, forward, reload, open/close/switch tabs, click, type, select,
scroll, screenshot, download, upload — on elements JARVIS has observed,
verified after each action, with risk levels and approvals.

## Current system context
After P8: DevTools client, browser state, page reader with element references.
`control/browserController.ts` (HTTP endpoints, Ctrl+R refresh) stays for
existing tools.

## Required changes
1. `control/browserAgent.ts` with the actions.
2. Observe-before / verify-after for each.
3. Skills `browser_navigate`, `browser_tab`, `browser_click`, `browser_type`,
   `browser_select`, `browser_scroll`, `browser_screenshot`, `browser_download`,
   `browser_upload` with metadata.

## Implementation steps
1. Navigation: `Page.navigate` (http/https only; `javascript:`, `file:`,
   `data:` refused), `history.back/forward` via `Page.navigateToHistoryEntry`,
   `Page.reload`; tabs via `Target.createTarget`, `Target.activateTarget`,
   `Target.closeTarget`. Verify: URL / visibility / target gone.
2. Element actions by reference: resolve the reference in the page (fixed
   script); require present, visible, enabled; click via `DOM.scrollIntoView`
   + `Input.dispatchMouseEvent` at the element's centre (from its box) or
   `element.click()` for links/buttons; type via `Input.insertText` after
   focusing; select by setting the option and dispatching `change`; scroll by
   `window.scrollBy`. Verify: URL change or DOM change (click), field value
   (type/select), scroll position.
3. Password fields: refuse typing (level 4 refusal) — JARVIS never enters credentials.
4. Screenshot: `Page.captureScreenshot` → PNG under the data folder; path returned.
5. Download: `Browser.setDownloadBehavior` to `~/Downloads/jarvis` (created),
   click the link, wait for `Browser.downloadProgress` complete; verify file.
6. Upload: `DOM.setFileInputFiles` with a path inside approved folders; verify
   the input lists the file name.
7. Metadata: navigate/back/forward/reload/new/switch 1; close 2; click 1 (2 when
   the element submits a form or is in a form with a password field); type 1 for
   search inputs, 2 for other form fields; select 1/2 likewise; scroll 1;
   screenshot 1; download 2; upload 3.

## Files to inspect
P8 files, `control/browserController.ts`, `security/riskEngine.ts`,
`core/toolRegistryV2.ts` (verify hook from P5).

## Files that may be modified
`control/browserAgent.ts` (new), `skills/browser_*` (new), `core/toolCatalog.ts`,
`security/riskEngine.ts` (browser classifiers), tests, docs.

## Dependencies
P2, P3, P5, P8.

## Tests
`tests/browserControlAgentTest.ts` with real Chromium and the local test site:
each action changes the page and the check confirms it; clicking a stale or
missing reference is refused without acting; `javascript:` URL refused;
typing into a password field refused; form submit asks for approval (policy
`ask`) and nothing is submitted when denied; download lands on disk; upload
from outside approved folders refused.

## Acceptance criteria (here)
All actions verified against the real page.

## Security requirements
No model-written scripts; no credential entry; downloads only to the JARVIS
download folder; uploads only from approved folders.

## Failure conditions
A click without a prior observation; an unverified success; a password typed.

## Completion requirements
Gate; checklist; PHASE_STATUS; BROWSER_CONTROL; commit `phase-09-browser-control`; CI green.

## As built (alignment note)
- Tools in `core/tools/browserActionTools.ts` (one file, registered with the
  other built-in tools) rather than nine `skills/browser_*` folders; metadata
  in `core/toolCatalog.ts`, rules in `security/browserPolicy.ts`.
- Tabs through the DevTools HTTP endpoints (`/json/new` with PUT,
  `/json/activate`, `/json/close`) rather than `Target.*`.
- Element references are short ids kept by JARVIS (`perception/browserRefs.ts`)
  with a fingerprint checked before each action.
- Downloads use `allowAndName` and are renamed to the site's (cleaned) file
  name in the JARVIS download folder.
- Also repaired: `control_browser` open_url, close_current, refresh (see
  BROWSER_CONTROL.md); per-level rate-limit counting.

