"""Mutation check for phase A4: each fault alone; tabTargetingA4Test must fail.
MB, MD, ME are the audit's mutations (2026-10-25, section E). Every file is
restored afterwards. Run from the repository root."""
import subprocess, pathlib, os
MUTANTS = [
  # The audit's three
  ("MB the finder ignores the tab on screen (several matches)", "perception/tabResolver.ts",
   "if (matches.length === 1) return { kind: 'one', tab: matches[0]! };", "if (matches.length >= 1) return { kind: 'one', tab: matches[0]! };"),
  ("MD the close check always says verified", "core/verifiers.ts",
   "return page ? failed('the tab is still open') : verified('the tab is gone');", "return verified('the tab is gone');"),
  ("ME browser_tab close does nothing", "control/browserAgent.ts",
   "      await closeTabKeepingChrome(target.id, port);\n      forgetTab(target.id);", "      forgetTab(target.id);"),
  # This plan
  ("M4 no name: the first listed tab, not the one on screen", "perception/tabResolver.ts",
   "    const onScreen = await visibleAmong(pages, port);\n    if (onScreen.length === 1) return { kind: 'one', tab: onScreen[0]! };", "    return { kind: 'one', tab: pages[0]! };"),
  ("M5 several matches, none on screen: the first, no question", "perception/tabResolver.ts",
   "return { kind: 'ask', tabs: matches,", "return { kind: 'one', tab: matches[0]!, tabs: matches,"),
  ("M6 the close check does not wait (N-PC4)", "core/verifiers.ts",
   "while (page && Date.now() < deadline) {", "while (false && page && Date.now() < deadline) {"),
  ("M7 the last tab closes Chrome (N-PC8)", "control/jarvisChrome.ts",
   "if (pages.length === 1 && pages[0]!.id === id) await openTab('about:blank', port);", ""),
  ("M8 any port: profile file or 9222, unchecked", "control/jarvisChrome.ts",
   "  const running = await chrome.running();\n  if (running) return running.port;", "  const { cdpPort } = await import('../perception/cdpClient.js');\n  return cdpPort();"),
  ("M9 an empty target is level 1 again", "security/riskEngine.ts",
   "/^about:blank$|youtube/i.test(text(args, 'target'))", "/^(about:blank)?$|youtube/i.test(text(args, 'target'))"),
  ("M10 browser_tab keeps its own rule (N-PC6)", "security/riskEngine.ts",
   "if (action === 'close' && /^about:blank$|youtube/i.test(text(args, 'tab'))) {", "if (false) {"),
  ("M11 'open youtube' always adds a tab (N-PC5)", "control/jarvisChrome.ts",
   "const open = site ? before.find((p) => siteOf(p.url) === site) : undefined;", "const open = undefined as any;"),
  ("M12 no route for 'close this tab'", "core/deterministicRoutes.ts",
   "'close tab', 'close this tab', 'close the tab', ", ""),
  ("M13 a tab question is retried", "control/actionQueue.ts",
   "|^Which tab, sir\\?", ""),
  ("M14 control_browser keeps the old 'blank' rule for an empty name", "control/browserController.ts",
   "const requiredLevel = youTubeOrBlank ? 1 : 2;", "const requiredLevel = (youTubeOrBlank || query === '') ? 1 : 2;"),
  # Review round 1
  ("M15 browser_tab close skips the tab's own rule (R1)", "control/browserAgent.ts",
   "      await checkTabClose(target);\n", ""),
  ("M16 level 1 for any address that mentions YouTube (R2)", "control/tabClose.ts",
   "(host === 'youtube.com' || host.endsWith('.youtube.com'))", "tab.url.toLowerCase().includes('youtube')"),
  ("M17 page tools on any port again (R3)", "control/browserAgent.ts",
   "port ?? await checkedChromePort()", "port ?? cdpPort()"),
  ("M18 the tab id read from anywhere in the result (R4)", "core/verifiers.ts",
   "(tab ([A-Za-z0-9]+)\\)\\.?\\s*$/.exec(message)", "(tab ([A-Za-z0-9]+)\\)/.exec(message)"),
  ("M19 two tabs on screen: the first, no question (R5)", "perception/tabResolver.ts",
   "  if (onScreen.length === 1) return { kind: 'one', tab: onScreen[0]! };\n  return { kind: 'ask', tabs: matches,", "  if (onScreen.length >= 1) return { kind: 'one', tab: onScreen[0]! };\n  return { kind: 'ask', tabs: matches,"),
  ("M20 browser_state's tab on screen falls back to the first listed (R6)", "perception/browserState.ts",
   "visibleTab: tabs.find((t) => t.visible),", "visibleTab: tabs.find((t) => t.visible) ?? tabs[0],"),
  ("M21 a site is its host name only (R7)", "control/jarvisChrome.ts",
   "`${u.protocol}//${u.host.toLowerCase().replace(/^www\\./, '')}`", "u.hostname.toLowerCase().replace(/^www\\./, '')"),
  ("M22 closes not one at a time (R8)", "control/jarvisChrome.ts",
   "const run = closing.then(async () => {", "const run = Promise.resolve().then(async () => {"),
  ("M23 titles in the question not redacted (R10)", "perception/tabResolver.ts",
   "const t = redact(text).replace", "const t = text.replace"),
  # Review round 2
  ("M24 pause goes to the oldest video tab (R12)", "control/youtubeControl.ts",
   "      ?? pages.find((p) => isWatchPage(p.url));", "      ?? [...pages].reverse().find((p) => isWatchPage(p.url));"),
  # Spoken route replies (owner's approval of the orchestrator change)
  ("M25 the named-tab route says the old fallback first", "core/orchestrator.ts",
   ": (await import('../control/tabClose.js')).tabRouteReply(result) ?? failureReply(result, `I tried to close the tab \"${route.target}\"", ": failureReply(result, `I tried to close the tab \"${route.target}\""),
  ("M26 the current-tab route says the old fallback first", "core/orchestrator.ts",
   ": (await import('../control/tabClose.js')).tabRouteReply(result) ?? failureReply(result, `I tried to close the current tab", ": failureReply(result, `I tried to close the current tab"),
  ("M27 'Chrome is not running' not said", "control/tabClose.ts",
   "    return 'My Chrome is not running, sir, so I did not change any tab.';", "    return undefined;"),
  # Review round 3
  ("M28 the Chrome phrase matched anywhere (R18)", "control/tabClose.ts",
   "if (/^JARVIS's own Chrome is not running, so no tab was changed/.test(reason)) {", "if (/JARVIS's own Chrome is not running, so no tab was changed/.test(`${reason} ${result?.output ?? ''}`)) {"),
]
only = os.environ.get("MUT_ONLY")
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
caught = 0
for name, file, old, new in MUTANTS:
    p = pathlib.Path(file); original = p.read_text()
    if original.count(old) != 1:
        print(f"{name}: NOT APPLIED ({original.count(old)})"); continue
    try:
        p.write_text(original.replace(old, new))
        r = subprocess.run(["pnpm", "test", "--", "--only=tabTargetingA4Test,tabRouteReplyA4Test"], capture_output=True, text=True, timeout=900)
        out = r.stdout + r.stderr
        passed = "2 passed · 0 failed" in out
        first = next((l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")), "")
    finally:
        p.write_text(original)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {first[:170]}", flush=True)
print(f"\n{caught}/{len(MUTANTS)} caught")
