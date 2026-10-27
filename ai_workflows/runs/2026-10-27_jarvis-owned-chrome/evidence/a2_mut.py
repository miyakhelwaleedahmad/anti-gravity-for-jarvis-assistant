"""Mutation check for phase A2: each fault below is applied alone, the new test
is run through the runner, and the fault must make it fail. Every file is
restored afterwards (also on error). Run from the repository root:
    python3 ai_workflows/runs/2026-10-27_jarvis-owned-chrome/evidence/a2_mut.py
"""
import subprocess, sys, pathlib

MUTANTS = [
    ("M1 ownership: any Chrome on the file's port counts", "control/jarvisChrome.ts",
     "return (await browserPathAt(active.port)) === active.browserPath ? { port: active.port, browserPath: active.browserPath } : undefined;",
     "return (await browserPathAt(active.port)) !== undefined ? { port: active.port, browserPath: active.browserPath } : undefined;"),
    ("M2 close without asking", "control/browserController.ts",
     "const approved = await withoutApproval(() => this.deps.approve(",
     "const approved = true || await withoutApproval(() => this.deps.approve("),
    ("M3 question inside the earlier approval", "control/browserController.ts",
     "const approved = await withoutApproval(() => this.deps.approve(",
     "const approved = await ((f: () => Promise<boolean>) => f())(() => this.deps.approve("),
    ("M4 openUrl falls back to the default browser", "control/browserController.ts",
     "    const port = await this.deps.chrome.ensure();\n    const newTab = await openTab(finalUrl, port);",
     "    let port: number;\n    try { port = await this.deps.chrome.ensure(); } catch { const { appController } = await import('./appController.js'); return appController.openApp(finalUrl); }\n    const newTab = await openTab(finalUrl, port);"),
    # M4 is equivalent since review fix R1: appController.openApp itself sends pages to JARVIS's Chrome.
    ("M4b openUrl falls back to the platform opener directly", "control/browserController.ts",
     "    const port = await this.deps.chrome.ensure();\n    const newTab = await openTab(finalUrl, port);",
     "    let port: number;\n    try { port = await this.deps.chrome.ensure(); } catch { const cp = await import('child_process'); cp.spawn(process.platform === 'win32' ? 'cmd.exe' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', finalUrl] : [finalUrl], { stdio: 'ignore', detached: true }).unref(); return `Opened URL: ${finalUrl}`; }\n    const newTab = await openTab(finalUrl, port);"),
    ("M5 open_app web targets use the platform opener", "skills/automation/skill.ts",
     "if (/^https?:\\/\\//i.test(resolved.resolvedTarget) || resolved.resolvedTarget === 'chrome.exe') {",
     "if (false) {"),
    ("M6 fixed port instead of port 0", "control/jarvisChrome.ts",
     "const args = ['--remote-debugging-port=0',",
     "const args = ['--remote-debugging-port=9222',"),
    ("M7 JARVIS_CHROME_AUTOSTART ignored", "control/jarvisChrome.ts",
     "if (/^(off|0|false|no)$/i.test(this.env['JARVIS_CHROME_AUTOSTART']?.trim() ?? '')) {",
     "if (false) {"),
    ("M8 'still open' retried by the queue", "control/actionQueue.ts",
     "JARVIS's Chrome is (?:not|still) open|",
     "JARVIS's Chrome is not open|"),
    ("M9 close_browser check always verified", "core/verifiers.ts",
     "return (await cdpVersion(port).then(() => true, () => false))",
     "return (await cdpVersion(port).then(() => false, () => false))"),
    ("M10 'close chrome' not routed", "core/deterministicRoutes.ts",
     "'close the browser', 'close browser', 'close chrome', ",
     "'close the browser', 'close browser', "),
    ("M11 planner offers app/window tools for 'close the browser'", "core/planningToolSelection.ts",
     "if (isTabRequest || isBrowserClose) {",
     "if (isTabRequest) {"),
    ("M12 two requests start two Chromes", "control/jarvisChrome.ts",
     "this.pending ??= this.findOrStart().finally(() => { this.pending = undefined; });\n    return this.pending;",
     "return this.findOrStart();"),
    ("M13 no full-control check on close_browser", "control/browserController.ts",
     "if (!permissionSession.checkPermission(2, 'Close JARVIS\\'s Chrome')) {",
     "if (false) {"),
    ("M14 cdpPort ignores the profile file", "perception/cdpClient.ts",
     "return readActivePort(chromeProfileDir(env))?.port ?? 9222;",
     "return 9222;"),
    # Added after review round 1:
    ("M15 (R1) control_app open sends pages to the platform opener", "control/appController.ts",
     "if (isUrl || program === 'chrome.exe' || program === 'chrome') {",
     "if (false) {"),
    ("M16 (R3) a late yes still closes", "control/browserController.ts",
     "if (signal?.aborted) throw new Error('JARVIS\\'s Chrome was not closed: the request had already ended when the answer came.');",
     ""),
    ("M17 (R7) close check reads the first port in the reply", "core/verifiers.ts",
     "/\\(port (\\d+) no longer answers\\)\\.?\\s*$/",
     "/\\(port (\\d+) no longer answers\\)/"),
    ("M18 (R8) close does not check which browser answers", "control/jarvisChrome.ts",
     "if (now !== chrome.browserPath) throw",
     "if (false) throw"),
    # Added after review round 2:
    ("M19 (R2-1) the kernel passes the queue's 10 s timeout signal", "control/pcControlKernel.ts",
     "return this.executeAction('closeBrowser', 'JARVIS Chrome', false, () => browserController.closeBrowser(signal));",
     "return this.executeAction('closeBrowser', 'JARVIS Chrome', false, (qs) => browserController.closeBrowser(either(signal, qs)));"),
    ("M20 (R2-4) chrome.exe by its full path goes to the opener", "control/appController.ts",
     "if (isUrl || program === 'chrome.exe' || program === 'chrome') {",
     "if (isUrl || finalTarget.toLowerCase() === 'chrome.exe') {"),
    # Owner requirement after review: a browser named explicitly opens that browser.
    ("M21 open_app sends Edge and Firefox to JARVIS's Chrome", "skills/automation/skill.ts",
     "if (/^https?:\\/\\//i.test(resolved.resolvedTarget) || resolved.resolvedTarget === 'chrome.exe') {",
     "if (/^https?:\\/\\//i.test(resolved.resolvedTarget) || /^(chrome|msedge|firefox)\\.exe$/.test(resolved.resolvedTarget)) {"),
    ("M22 control_app open sends Firefox to JARVIS's Chrome", "control/appController.ts",
     "if (isUrl || program === 'chrome.exe' || program === 'chrome') {",
     "if (isUrl || program === 'chrome.exe' || program === 'chrome' || program === 'firefox' || program === 'firefox.exe') {"),
    # Owner request: "Open Microsoft Edge" / "Open Mozilla Firefox".
    ("M23 no route for 'microsoft edge'", "core/deterministicRoutes.ts",
     "    'microsoft edge':   'edge',", ""),
    ("M24 no route for 'mozilla firefox'", "core/deterministicRoutes.ts",
     "    'mozilla firefox':  'firefox',", ""),
    ("M25 'mozilla firefox' not on the open_app allow-list", "security/openAppPolicy.ts",
     "  'mozilla firefox': 'firefox.exe',", ""),
    ("M26 control_app opens 'microsoft edge' by that name", "control/appController.ts",
     "  'microsoft edge': 'msedge.exe',", ""),
    ("M27 control_app opens 'firefox' by that name", "control/appController.ts",
     "  'firefox': 'firefox.exe',\n  'mozilla firefox'", "  'mozilla firefox'"),
    ("M28 'microsoft edge' routed to JARVIS's Chrome", "core/deterministicRoutes.ts",
     "    'microsoft edge':   'edge',", "    'microsoft edge':   'chrome',"),
]

def run_test() -> tuple[bool, str]:
    r = subprocess.run(["pnpm", "test", "--", "--only=jarvisChromeTest"], capture_output=True, text=True, timeout=600)
    out = r.stdout + r.stderr
    fails = [l.strip() for l in out.splitlines() if l.strip().startswith("FAIL:")]
    return ("1 passed · 0 failed" in out), (fails[0] if fails else out.strip().splitlines()[-1] if out.strip() else "")

import os
only = os.environ.get("MUT_ONLY")
caught = 0
if only: MUTANTS = [m for m in MUTANTS if m[0].split()[0] in only.split(",")]
for name, file, old, new in MUTANTS:
    p = pathlib.Path(file)
    original = p.read_text()
    if original.count(old) != 1:
        print(f"{name}: NOT APPLIED (pattern found {original.count(old)} times)")
        continue
    try:
        p.write_text(original.replace(old, new))
        passed, first = run_test()
    finally:
        p.write_text(original)
    caught += not passed
    print(f"{name}: {'CAUGHT' if not passed else 'MISSED'} | {first[:200]}")
print(f"\n{caught}/{len(MUTANTS)} caught")
sys.exit(0 if caught == len(MUTANTS) else 1)
