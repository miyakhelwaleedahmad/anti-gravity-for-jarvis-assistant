# Diagnosis — browser contracts (phase B2)

Read-only, on `f8b1c8d`. The probes ran from temporary copies; the mutation run restored its files (md5).

## Mutations MB, MD, ME

All three are caught on the current code, by `tabTargetingA4Test` (A4's mutation script, `MUT_ONLY=MB,MD,ME`; `evidence/b2_mbmdme_on_f8b1c8d.txt`). Nothing to do.

## The seven contracts

| # | Contract | State | Where |
|---|---|---|---|
| 1 | close one tab ≠ close the browser | covered | `tabTargetingA4Test` "the last tab: it closes (Q4)…" (Chrome stays, on a blank tab); `browserControlAgentTest` "close_current closes the tab on screen, checked" |
| 2 | close a tab ≠ disconnect | **no test** | JARVIS opens one DevTools connection per call (`perception/cdpClient.ts` `withPage`, `browserAgent.ts` `withSession`) and closes it after, so a tab close cannot break another tab's connection. No test closes a tab and then uses another one |
| 3 | close JARVIS's Chrome ≠ kill the owner's Chrome | covered | `jarvisChromeTest` §5 (close the browser: JARVIS's Chrome only, asked every time); `closeByNameTest` (app, window and process tools refuse a browser) |
| 4 | dispatch success ≠ verified | covered | `browserControlAgentTest` (each browser tool has its own after-action check), `verifyAfterActTest`, `diagnosticsA6Test`; MD caught |
| 5 | recoverable ≠ irrecoverable connection failure | **broken** | D1, D2 |
| 6 | browser unavailable ≠ false success | covered for "not running" (`honestReadToolsA5aTest`, `tabTargetingA4Test`, `browserControlTest`, `browserObservationTest`); **broken** for a slow Chrome | D1 |
| 7 | no name or ambiguous → the tab on screen or a question | covered | `tabTargetingA4Test` (A4); MB caught |

## Findings

| ID | Finding | Evidence |
|---|---|---|
| D1 | `perception/cdpClient.ts` `tabEndpoint` (open, close, bring forward a tab) and `getJson` (tab list, version) turn **any** failed request into `CdpUnavailableError`: "Chrome is not reachable … JARVIS's own Chrome is not running". A timeout is one of them: Chrome got the request and answered after 3 s (2 s for a read). JARVIS then says Chrome is not running while it is | `cdpClient.ts:54-63`, `:78-84` |
| D2 | The kernel's action queue retries a failure once unless it matches `FINAL_FAILURE` (`control/actionQueue.ts:18`). The "not running" wording does not match, so the request is sent again. For "open this address" (`pcControlKernel.ts:295` → `browserController.openUrl` → `openTab`) a slow Chrome opens **two tabs**. The registry does not repeat a change (REL-06), but the kernel's queue does | `evidence/b2_probe_slow_chrome.txt`: a fake Chrome that opens the tab at once and answers after 3.5 s: 2 requests, 2 tabs, then "JARVIS's own Chrome is not running". `evidence/b2_probe_retry.txt`: which browser failures the queue retries |
| D3 | "Connection refused" (Chrome really not running) is retried once too. For opening a page that is a real recovery: the retry runs `ensure()`, which starts JARVIS's Chrome. The tab tools already stop at once ("JARVIS's own Chrome is not running, so no tab was changed" is final) | `browserController.ts:164`, `jarvisChrome.ts` `checkedChromePort` |

## Seen, not in B2's plan (recorded)

- `control/browserAgent.ts` checks the port with `checkedChromePort()`, then makes later calls with `cdpPort()`. Both read JARVIS_CDP_PORT or the profile's port file, so they agree in practice.
- A dropped page connection is reported as "DevTools: the tab closed the connection" even when the tab did not close it.
- `youtubeControl.ts:122` reads "not reachable", "connect" or "debugging port" in an error as "Chrome is down" and then opens YouTube another way.
