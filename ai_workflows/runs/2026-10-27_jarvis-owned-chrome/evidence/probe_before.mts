/**
 * Read-only probe for the A2 run (before any change). Prints what the current
 * code does when no debugging Chrome is reachable, and checks the two Chrome
 * facts the plan depends on with a real headless Chromium:
 *   1. Chrome writes <profile>/DevToolsActivePort (port + browser socket path)
 *   2. CDP Browser.close closes that Chrome (the port stops answering)
 * Starts nothing but a throwaway headless Chromium; opens no page in any browser.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

process.env['JARVIS_CDP_PORT'] = '9';   // nothing listens there

const { CdpUnavailableError, CdpSession, cdpVersion } = await import('../../../../perception/cdpClient.js');
console.log('1. CdpUnavailableError on', process.platform, '→', new CdpUnavailableError(9).message);

const { execute: controlBrowser } = await import('../../../../skills/control_browser/skill.js');
try { await controlBrowser({ action: 'close_browser' }); console.log('2. control_browser close_browser → ran'); }
catch (e) { console.log('2. control_browser close_browser →', (e as Error).message); }

const { resolveTargetUrl } = await import('../../../../security/openAppPolicy.js');
console.log('3. open_app "youtube" resolves to', resolveTargetUrl('youtube').resolvedTarget, '(skills/automation/skill.ts opens it with cmd /c start | open | xdg-open: the default browser)');

const { matchDeterministicCommand } = await import('../../../../core/deterministicRoutes.js');
for (const p of ['close the browser', 'close browser', 'close chrome', 'close google chrome', 'open browser']) {
  const r = matchDeterministicCommand(p);
  console.log(`4. route "${p}" →`, r ? `${r.type}${'target' in r && r.target ? ` ${r.target}` : ''}` : 'none (planner)');
}

const binary = ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
if (!binary) { console.log('5. no Chromium here: Chrome facts not checked'); process.exit(0); }
console.log('   Chromium:', binary);
async function chromeRun(port: number) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-probe-'));
  const proc = spawn(binary!, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let lines: string[] = [];
  for (let i = 0; i < 100 && !lines.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* not yet */ }
    if (port && i > 30) break;
  }
  return { profile, proc, lines };
}
const fixed = await chromeRun(9333);
console.log('5. --remote-debugging-port=9333: DevToolsActivePort', fixed.lines.length ? JSON.stringify(fixed.lines) : 'not written');
fixed.proc.kill(); await new Promise((r) => fixed.proc.once('exit', r));
fs.rmSync(fixed.profile, { recursive: true, force: true });
const eph = await chromeRun(0);
const port = Number(eph.lines[0]);
const v = await cdpVersion(port);
console.log('6. --remote-debugging-port=0: DevToolsActivePort', JSON.stringify(eph.lines), '| /json/version socket', v && (v as any).webSocketDebuggerUrl);
console.log('   the file names this browser:', String((v as any).webSocketDebuggerUrl ?? '').endsWith(eph.lines[1] ?? '\u0000'));
const s = await CdpSession.connectBrowser(port);
await s.send('Browser.close').catch(() => undefined);
let gone = false;
for (let i = 0; i < 50 && !gone; i++) { await new Promise((r) => setTimeout(r, 100)); gone = !(await cdpVersion(port).then(() => true).catch(() => false)); }
await new Promise((r) => eph.proc.exitCode !== null ? r(null) : eph.proc.once('exit', r));
console.log('7. after CDP Browser.close: port answers', !gone, '| process exit code', eph.proc.exitCode);
fs.rmSync(eph.profile, { recursive: true, force: true });
process.exit(0);
