/**
 * tests/browserControlAgentTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 9 — browser control, through the tool registry (risk engine, approval,
 * verify step) against a real headless Chromium and a local test site:
 *
 *  1. Nine tools registered, with metadata and their own check.
 *  2. Risk from the element JARVIS saw: plain button 1, submit 2, "Delete
 *     account" 3, "Pay now" 4; search box 1, form field 2; password, card and
 *     one-time-code fields refused; javascript:, file: and data: addresses
 *     refused; an element JARVIS has not seen refused; uploads only from
 *     approved folders, never keys.
 *  3. Each level-1 action changes the real page and its check confirms it:
 *     click, type, choose, scroll, open, back, forward, reload, new tab,
 *     switch, screenshot.
 *  4. Looking before acting: a changed, removed, hidden, disabled or covered
 *     element is not clicked; a click that changes nothing is reported as not
 *     confirmed; a page dialog is reported, not answered.
 *  5. Approval: a form submit asks (policy "ask"); denied, nothing reaches the
 *     server; approved, it does and the check sees the new page. "Pay now"
 *     asks for a typed code. Download lands on disk; upload is approved each
 *     time and the field holds the file.
 *  6. control_browser repairs: open_url opens a tab in Chrome (PUT), focus is
 *     checked on screen, close_current closes the tab on screen, refresh
 *     reloads the page — each checked in the browser.
 *  7. The planner offers the actions; only fixed functions run in pages.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { findChromium, startChromium } from './chromeHelper.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!findChromium()) {
  console.error('No Chromium or Chrome found (set JARVIS_TEST_CHROME): this test needs a real browser.');
  process.exit(1);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-browser-act-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
const downloads = path.join(workspace, 'downloads');
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_DOWNLOAD_DIR'] = downloads;
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
process.chdir(workspace);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { appController } = await import('../control/appController.js');
const { assessRisk } = await import('../security/riskEngine.js');
const { CdpSession, listPages } = await import('../perception/cdpClient.js');
const refs: any = await import('../perception/browserRefs.js' as string).catch(() => ({}));

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();

// Approvals are answered by the test; the old fallback that starts the
// system browser is recorded instead of run.
const approvals: any[] = [];
let answer = true;
(approvalGate as any).requestApproval = async (request: any) => { approvals.push(request); return answer; };
const fallbacks: string[] = [];
(appController as any).openApp = async (target: string) => { fallbacks.push(target); return `Opened ${target}`; };

async function run(tool: string, args: Record<string, unknown> = {}) {
  return toolRegistryV2.execute(tool, args);
}
function parse(output: string): any {
  try { return JSON.parse(output); } catch { return null; }
}
function unwrap(output: string): any {
  const m = /^<untrusted_context source="web-page">\n([\s\S]*)\n<\/untrusted_context>$/.exec(output);
  return m ? parse(m[1]!) : null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── The test site ────────────────────────────────────────────────────────────

const hits: string[] = [];
const PAGES: Record<string, string> = {
  '/app': `<!doctype html><html><head><title>Shop</title></head><body>
    <h1>Shop</h1>
    <input type="search" id="q" name="q" aria-label="Search the shop">
    <button id="plain" onclick="document.getElementById('out').textContent = 'details shown'">Show details</button>
    <button id="noop">Does nothing</button>
    <p id="out">-</p>
    <button id="hidden" style="display:none">Hidden button</button>
    <button id="off" disabled>Disabled button</button>
    <div style="position:relative;display:inline-block"><button id="covered">Covered button</button>
      <div style="position:absolute;left:0;top:0;right:0;bottom:0;background:white"></div></div>
    <button id="asks" onclick="alert('Are you sure?')">Ask me</button>
    <button id="rename" onclick="document.getElementById('out').textContent = 'renamed'">Rename me</button>
    <button id="gone">Going away</button>
    <label><input type="checkbox" id="news" name="news"> Newsletter</label>
    <select id="sort" aria-label="Sort by"><option>Newest</option><option>Cheapest</option></select>
    <form id="login" action="/submit" method="get">
      <label for="user">User name</label><input id="user" name="user">
      <label for="pw">Password</label><input id="pw" name="pw" type="password">
      <label for="card">Card</label><input id="card" name="cardnum" autocomplete="cc-number">
      <label for="code">Code</label><input id="code" name="otp">
      <label for="size">Size</label><select id="size" name="size"><option>S</option><option>L</option></select>
      <label for="doc">Document</label><input id="doc" name="doc" type="file">
      <button type="submit">Sign in</button>
    </form>
    <button id="pay" onclick="document.getElementById('out').textContent = 'PAID'">Pay now</button>
    <button id="del" onclick="document.getElementById('out').textContent = 'DELETED'">Delete account</button>
    <a id="dl" href="/report.txt" download>Report file</a>
    <a id="dl2" href="/report.txt">Get the report</a>
    <a id="next" href="/next">Next page</a>
    <a id="newtab" href="/next?tab=1" target="_blank">Open in a new tab</a>
    <div style="height:2500px"></div>
    <h2 id="bottom">Bottom of the shop</h2>
  </body></html>`,
  '/next': '<!doctype html><html><head><title>Next</title></head><body><p>next page</p></body></html>',
  '/submit': '<!doctype html><html><head><title>Submitted</title></head><body><p>thanks</p></body></html>',
};

const site = http.createServer((req, res) => {
  const pathname = (req.url ?? '').split('?')[0]!;
  hits.push(req.url ?? '');
  if (pathname === '/report.txt') {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="report.txt"');
    res.end('quarterly numbers');
    return;
  }
  const page = PAGES[pathname];
  if (!page) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page);
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;

const chrome = await startChromium(`${base}/app`);
process.env['JARVIS_CDP_PORT'] = String(chrome.port);

/** A raw DevTools evaluation in the page — the test's own eyes, not JARVIS's. */
async function inPage(urlPart: string, expression: string): Promise<any> {
  const page = (await listPages(chrome.port)).find((p) => p.url.includes(urlPart));
  if (!page) return undefined;
  const s = await CdpSession.connect(page, chrome.port);
  try {
    return (await s.send('Runtime.evaluate', { expression, returnByValue: true }, 3_000))?.result?.value;
  } finally {
    s.close();
  }
}

let page: any;
async function look(tab = 'Shop') {
  page = unwrap((await run('browser_page_structure', { tab })).output);
  return page;
}
const button = (text: string) => page?.buttons?.find((b: any) => b.text === text)?.ref;
const fieldNamed = (name: string) => [...(page?.fields ?? []), ...(page?.forms ?? []).flatMap((f: any) => f.fields)].find((f: any) => f.name === name)?.ref;
const fieldLabelled = (label: string) => [...(page?.fields ?? []), ...(page?.forms ?? []).flatMap((f: any) => f.fields)].find((f: any) => f.label === label)?.ref;
const link = (text: string) => page?.links?.find((l: any) => l.text === text)?.ref;
const heading = (text: string) => page?.headings?.find((h: any) => h.text === text)?.ref;
const risk = (tool: string, args: Record<string, unknown>) => assessRisk({ tool, args, baseRisk: toolRegistryV2.riskOf(tool, args) });

async function backToShop() {
  await run('browser_navigate', { action: 'go', url: `${base}/app`, tab: '127.0.0.1' });
  await look();
}

console.log('\n=== Browser Control Agent Test ===\n');

try {
  await sleep(500);

  console.log('--- 1. Registered, with metadata and a check ---');
  const TOOLS = ['browser_navigate', 'browser_tab', 'browser_click', 'browser_type', 'browser_select', 'browser_scroll',
    'browser_screenshot', 'browser_download', 'browser_upload'];
  ok('nine browser action tools are registered', TOOLS.every((t) => toolRegistryV2.has(t)), TOOLS.filter((t) => !toolRegistryV2.has(t)).join(', '));
  ok('…in the BROWSER category, each with its own after-action check',
    TOOLS.every((t) => toolRegistryV2.getMeta(t)?.category === 'BROWSER' && typeof (toolRegistryV2.get(t) as any)?.verify === 'function'));
  ok('base risks: download 2, upload 3, closing a tab 2, the rest 1',
    toolRegistryV2.riskOf('browser_download', {}) === 2 && toolRegistryV2.riskOf('browser_upload', {}) === 3
    && toolRegistryV2.riskOf('browser_tab', { action: 'close' }) === 2 && toolRegistryV2.riskOf('browser_click', {}) === 1,
    TOOLS.map((t) => `${t}:${toolRegistryV2.riskOf(t, {})}`).join(' '));

  console.log('\n--- 2. Risk from what JARVIS saw ---');
  await look();
  ok('the page structure gives references', !!button('Show details') && !!fieldNamed('q') && !!link('Next page'), JSON.stringify(page?.buttons?.slice(0, 2)));
  const level = (tool: string, args: Record<string, unknown>) => { const a = risk(tool, args); return a.refused ? `refused: ${a.refused}` : a.level; };
  ok('a plain button: 1', level('browser_click', { ref: button('Show details') }) === 1, String(level('browser_click', { ref: button('Show details') })));
  ok('the form\'s submit button: 2', level('browser_click', { ref: button('Sign in') }) === 2, String(level('browser_click', { ref: button('Sign in') })));
  ok('"Delete account": 3', level('browser_click', { ref: button('Delete account') }) === 3);
  ok('"Pay now": 4', level('browser_click', { ref: button('Pay now') }) === 4);
  ok('a link that downloads is refused for a click (browser_download instead)', /use browser_download/.test(String(level('browser_click', { ref: link('Report file') }))));
  ok('the search box: 1; a form field: 2', level('browser_type', { ref: fieldNamed('q'), text: 'x' }) === 1
    && level('browser_type', { ref: fieldNamed('user'), text: 'x' }) === 2);
  for (const name of ['pw', 'cardnum', 'otp']) {
    ok(`typing into the ${name} field is refused`, /does not type passwords, card numbers or one-time codes/.test(String(level('browser_type', { ref: fieldNamed(name), text: '1234' }))),
      String(level('browser_type', { ref: fieldNamed(name), text: '1234' })));
  }
  ok('a list outside a form: 1; in a form: 2', level('browser_select', { ref: fieldLabelled('Sort by'), option: 'Cheapest' }) === 1
    && level('browser_select', { ref: fieldNamed('size'), option: 'L' }) === 2);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'https://user:pass@example.com/']) {
    ok(`opening ${url.slice(0, 22)} is refused`, typeof level('browser_navigate', { action: 'go', url }) === 'string'
      && typeof level('browser_tab', { action: 'new', url }) === 'string');
  }
  ok('opening an http address: 1', level('browser_navigate', { action: 'go', url: `${base}/next` }) === 1);
  ok('an element JARVIS has not seen is refused', /acts only on page elements it has looked at/.test(String(level('browser_click', { ref: 'e999999' })))
    && /looked at/.test(String(level('browser_type', { ref: '#user', text: 'x' }))) && /looked at/.test(String(level('browser_scroll', { ref: 'nope' }))));
  const upload = path.join(workspace, 'cv.txt');
  fs.writeFileSync(upload, 'my cv');
  fs.writeFileSync(path.join(workspace, '.env'), 'KEY=1');
  ok('upload from an approved folder: 3', level('browser_upload', { ref: fieldNamed('doc'), path: upload }) === 3);
  ok('upload from outside the approved folders is refused', /approved folders/.test(String(level('browser_upload', { ref: fieldNamed('doc'), path: '/etc/hostname' }))));
  ok('uploading a .env file is refused', /keys, passwords or credential files/.test(String(level('browser_upload', { ref: fieldNamed('doc'), path: path.join(workspace, '.env') }))));
  ok('the approval request names the element and the site', risk('browser_click', { ref: button('Sign in') }).target === `button "Sign in" on ${new URL(base).host}`,
    String(risk('browser_click', { ref: button('Sign in') }).target));

  console.log('\n--- 3. Level-1 actions, checked on the real page ---');
  approvals.length = 0;
  let r = await run('browser_click', { ref: button('Show details') });
  ok('click: the page changed, and the check says so', r.success && r.verification?.status === 'verified'
    && await inPage('/app', `document.getElementById('out').textContent`) === 'details shown', `${r.verification?.evidence}`);
  r = await run('browser_type', { ref: fieldNamed('q'), text: 'blue shoes' });
  ok('type: the search box holds the text', r.success && r.verification?.status === 'verified'
    && await inPage('/app', `document.getElementById('q').value`) === 'blue shoes', r.verification?.evidence ?? r.output.slice(0, 160));
  r = await run('browser_type', { ref: fieldNamed('q'), text: ' today', clear: false });
  ok('type without clearing adds to the text', r.success && await inPage('/app', `document.getElementById('q').value`) === 'blue shoes today');
  r = await run('browser_select', { ref: fieldLabelled('Sort by'), option: 'Cheapest' });
  ok('choose: the list shows the option', r.success && r.verification?.status === 'verified'
    && await inPage('/app', `document.getElementById('sort').value`) === 'Cheapest', r.verification?.evidence ?? r.output.slice(0, 160));
  r = await run('browser_select', { ref: fieldLabelled('Sort by'), option: 'Most expensive' });
  ok('choose an option that is not there: not done, the options are listed', !r.success && /Newest, Cheapest/.test(r.output), r.output.slice(0, 200));
  r = await run('browser_click', { ref: fieldNamed('news') });
  ok('click a checkbox: it is now checked', r.success && /checked/.test(r.verification?.evidence ?? '')
    && await inPage('/app', `document.getElementById('news').checked`) === true, r.verification?.evidence);
  r = await run('browser_scroll', { ref: heading('Bottom of the shop') });
  ok('scroll to an element: it is in view', r.success && r.verification?.status === 'verified'
    && await inPage('/app', `(() => { const b = document.getElementById('bottom').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; })()`) === true,
    r.verification?.evidence);
  r = await run('browser_scroll', { direction: 'top', tab: 'Shop' });
  ok('scroll to the top: the page moved', r.success && r.verification?.status === 'verified' && await inPage('/app', 'scrollY') === 0, r.verification?.evidence);
  r = await run('browser_screenshot', { tab: 'Shop' });
  const shot = parse(r.output)?.file;
  ok('screenshot: a PNG saved in the data folder, not sent anywhere', r.success && r.verification?.status === 'verified'
    && !!shot && fs.existsSync(shot) && shot.startsWith(path.join(workspace, 'data', 'screenshots'))
    && fs.readFileSync(shot).subarray(1, 4).toString() === 'PNG', shot);
  ok('no approval was asked for any of these', approvals.length === 0, String(approvals.length));

  r = await run('browser_click', { ref: link('Next page') });
  ok('click a link: the check sees the new page', r.success && /went to .*\/next/.test(r.verification?.evidence ?? '')
    && (await listPages(chrome.port)).some((p) => p.url === `${base}/next`), r.verification?.evidence);
  r = await run('browser_navigate', { action: 'back', tab: 'Next' });
  ok('back: the tab shows the shop again', r.success && r.verification?.status === 'verified' && /\/app$/.test(parse(r.output)?.page?.url ?? ''), r.verification?.evidence);
  r = await run('browser_navigate', { action: 'forward', tab: 'Shop' });
  ok('forward: the tab shows the next page', r.success && /\/next$/.test(parse(r.output)?.page?.url ?? ''), r.verification?.evidence);
  const before = await inPage('/next', 'performance.timeOrigin');
  r = await run('browser_navigate', { action: 'reload', tab: 'Next' });
  ok('reload: a new document loaded', r.success && r.verification?.evidence === 'the page loaded again'
    && (await inPage('/next', 'performance.timeOrigin')) > before, r.verification?.evidence);
  r = await run('browser_navigate', { action: 'go', url: `${base}/app`, tab: 'Next' });
  ok('open an address: the tab shows it', r.success && r.verification?.status === 'verified' && /\/app$/.test(parse(r.output)?.page?.url ?? ''), r.verification?.evidence);
  const hitsBefore = hits.length;
  r = await run('browser_navigate', { action: 'go', url: 'javascript:alert(document.cookie)', tab: 'Shop' });
  ok('javascript: refused before anything runs', !r.success && r.error === 'RISK_REFUSED' && hits.length === hitsBefore, r.output.slice(0, 120));
  r = await run('browser_tab', { action: 'new', url: `${base}/next` });
  ok('new tab: it shows the address', r.success && r.verification?.status === 'verified'
    && (await listPages(chrome.port)).filter((p) => p.url === `${base}/next`).length === 1, r.verification?.evidence);
  r = await run('browser_tab', { action: 'switch', tab: 'Shop' });
  ok('switch: the shop tab is on screen', r.success && r.verification?.evidence === 'the tab is on screen'
    && await inPage('/app', 'document.visibilityState') === 'visible', r.verification?.evidence);

  console.log('\n--- 4. Looking before acting ---');
  await look();
  await inPage('/app', `document.getElementById('rename').textContent = 'Renamed'`);
  r = await run('browser_click', { ref: button('Rename me') });
  ok('a button that changed since JARVIS looked is not clicked', !r.success && /changed since JARVIS looked/.test(r.output)
    && await inPage('/app', `document.getElementById('out').textContent`) !== 'renamed', r.output.slice(0, 160));
  await inPage('/app', `document.getElementById('gone').remove()`);
  r = await run('browser_click', { ref: button('Going away') });
  ok('a removed button: not clicked, "no longer on the page"', !r.success && /no longer on the page/.test(r.output), r.output.slice(0, 160));
  r = await run('browser_click', { ref: button('Hidden button') });
  ok('a hidden button is not clicked', !r.success && /cannot be seen/.test(r.output), r.output.slice(0, 160));
  r = await run('browser_click', { ref: button('Disabled button') });
  ok('a disabled button is not clicked', !r.success && /is disabled/.test(r.output), r.output.slice(0, 160));
  r = await run('browser_click', { ref: button('Covered button') });
  ok('a covered button is not clicked', !r.success && /covers/.test(r.output), r.output.slice(0, 160));
  r = await run('browser_click', { ref: button('Does nothing') });
  ok('a click that changes nothing is not reported as done', !r.success && r.error === 'VERIFICATION_FAILED'
    && /nothing on the page changed/.test(r.output), r.output.slice(0, 200));
  r = await run('browser_click', { ref: button('Ask me') });
  ok('a page dialog is reported, not answered', r.success && /dialog saying "Are you sure\?"/.test(r.verification?.evidence ?? ''), r.verification?.evidence);
  {
    // Nobody answers the dialog in a headless browser: the test closes that
    // tab and opens the shop again.
    const blocked = (await listPages(chrome.port)).find((p) => p.url.endsWith('/app'))!;
    await fetch(`http://127.0.0.1:${chrome.port}/json/close/${blocked.id}`);
    await fetch(`http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent(`${base}/app`)}`, { method: 'PUT' });
    await sleep(800);
    await look();
  }
  r = await run('browser_type', { ref: fieldNamed('pw'), text: 'hunter2' });
  ok('typing a password: refused, the field stays empty', !r.success && r.error === 'RISK_REFUSED'
    && await inPage('/app', `document.getElementById('pw').value`) === '', r.output.slice(0, 160));

  console.log('\n--- 5. Approval, download, upload ---');
  await look();
  approvals.length = 0;
  answer = false;
  const submitsBefore = hits.filter((h) => h.startsWith('/submit')).length;
  r = await run('browser_type', { ref: fieldNamed('user'), text: 'ada' });
  ok('typing into a form field asks for approval (policy "ask")', approvals.length === 1 && !r.success && /not approved/.test(r.output),
    approvals.map((a) => a.action).join(', '));
  answer = true;
  r = await run('browser_type', { ref: fieldNamed('user'), text: 'ada' });
  ok('…approved, the field holds it', r.success && await inPage('/app', `document.getElementById('user').value`) === 'ada');
  approvals.length = 0;
  answer = false;
  r = await run('browser_click', { ref: button('Sign in') });
  const request = approvals[0];
  ok('submitting the form asks first: action, target, risk 2', request?.action === 'Click on a web page' && request?.risk === 2
    && /button "Sign in" on 127\.0\.0\.1/.test(request?.target ?? '') && /submits a form|sign-in form/.test(request?.riskDetail ?? ''),
    JSON.stringify({ action: request?.action, target: request?.target, risk: request?.risk, detail: request?.riskDetail }));
  ok('denied: nothing reached the server, the page did not change', !r.success && hits.filter((h) => h.startsWith('/submit')).length === submitsBefore
    && (await listPages(chrome.port)).some((p) => p.url.endsWith('/app')), r.output.slice(0, 120));
  answer = true;
  r = await run('browser_click', { ref: button('Sign in') });
  ok('approved: the form was submitted and the check sees the new page', r.success && /went to .*\/submit\?user=ada/.test(r.verification?.evidence ?? '')
    && hits.some((h) => h.startsWith('/submit?user=ada')), r.verification?.evidence);
  await backToShop();
  approvals.length = 0;
  answer = false;
  r = await run('browser_click', { ref: button('Pay now') });
  // By now browser_click has run more than ten times this minute at level 1;
  // the level-4 limit (10) counts only level-4 clicks.
  ok('"Pay now" asks for a typed code (risk 4), even after a dozen plain clicks this minute; denied, nothing paid',
    approvals[0]?.risk === 4 && approvals[0]?.strong === true
    && typeof approvals[0]?.code === 'string' && !r.success && await inPage('/app', `document.getElementById('out').textContent`) !== 'PAID',
    JSON.stringify({ risk: approvals[0]?.risk, strong: approvals[0]?.strong, out: r.output.slice(0, 300) }));
  answer = true;
  approvals.length = 0;
  r = await run('browser_download', { ref: link('Get the report') });
  const saved = parse(r.output)?.file;
  ok('download: approved once, the file is on disk in the JARVIS download folder', approvals.length === 1 && r.success
    && r.verification?.status === 'verified' && saved === path.join(downloads, 'report.txt')
    && fs.readFileSync(saved, 'utf8') === 'quarterly numbers', `${r.verification?.evidence} ${saved}`);
  approvals.length = 0;
  r = await run('browser_upload', { ref: fieldNamed('doc'), path: upload });
  ok('upload: approved (risk 3), the field holds the file', approvals[0]?.risk === 3 && r.success && r.verification?.status === 'verified'
    && await inPage('/app', `document.getElementById('doc').files[0]?.name`) === 'cv.txt', r.verification?.evidence ?? r.output.slice(0, 160));
  approvals.length = 0;
  r = await run('browser_upload', { ref: fieldNamed('doc'), path: '/etc/hostname' });
  ok('upload from outside the approved folders: refused, nobody is asked', !r.success && r.error === 'RISK_REFUSED' && approvals.length === 0, r.output.slice(0, 160));
  r = await run('browser_click', { ref: link('Open in a new tab') });
  ok('a link that opens a new tab: the check sees it', r.success && /new tab opened/.test(r.verification?.evidence ?? ''), r.verification?.evidence);

  console.log('\n--- 6. control_browser repairs ---');
  fallbacks.length = 0;
  approvals.length = 0;
  r = await run('control_browser', { action: 'open_url', target: `${base}/next?opened=1` });
  await sleep(500);
  ok('open_url opens the tab in Chrome (not the system browser), checked', r.success && fallbacks.length === 0
    && (await listPages(chrome.port)).some((p) => p.url === `${base}/next?opened=1`) && r.verification?.status === 'verified',
    `fallbacks=${fallbacks.length} ${r.verification?.status}: ${r.verification?.evidence}`);
  r = await run('control_browser', { action: 'focus', target: 'Shop' });
  ok('focus: checked on screen', r.success && r.verification?.evidence === 'the tab is on screen', `${r.verification?.status}: ${r.verification?.evidence}`);
  const shopOrigin = await inPage('/app', 'performance.timeOrigin');
  r = await run('control_browser', { action: 'refresh', target: 'Shop' });
  ok('refresh: the page loaded again (not a key press), checked', r.success && (await inPage('/app', 'performance.timeOrigin')) > shopOrigin
    && r.verification?.status === 'verified', `${r.output.slice(0, 160)} / ${r.verification?.evidence}`);
  const visibleBefore = (await listPages(chrome.port)).find((p) => p.url.endsWith('/app'))?.id;
  answer = true;
  r = await run('control_browser', { action: 'close_current' });
  await sleep(300);
  const after = await listPages(chrome.port);
  ok('close_current closes the tab on screen, checked', r.success && !after.some((p) => p.id === visibleBefore)
    && r.verification?.evidence === 'the tab is gone', `${r.output.slice(0, 120)} / ${r.verification?.evidence}`);
  r = await run('control_browser', { action: 'close', target: 'no-such-tab-xyz' });
  ok('closing a tab that is not open is not reported as done', !r.success, `${r.success} ${r.output.slice(0, 160)}`);

  console.log('\n--- 7. Planner and fixed functions ---');
  {
    const { orchestrator } = await import('../core/orchestrator.js');
    const offered = (q: string): string[] => (orchestrator as any).selectPlanningToolNames(q);
    const click = offered('click the sign in button on this page');
    ok('"click the sign in button on this page" offers browser_click and the page structure',
      click.includes('browser_click') && click.includes('browser_page_structure'), click.join(', '));
    const typeIt = offered('type hello into the search box on this website');
    ok('"type hello into the search box on this website" offers browser_type', typeIt.includes('browser_type'), typeIt.join(', '));
    const launch = offered('open chrome');
    ok('"open chrome" still offers open_app first', launch[0] === 'open_app', launch.join(', '));
  }
  const scripts: Record<string, unknown> = await import('../perception/cdpScripts.js');
  const fixed = Object.keys(scripts).filter((k) => k.endsWith('_FN'));
  const calls = ['control/browserAgent.ts', 'perception/browserState.ts', 'core/verifiers.ts', 'control/browserController.ts']
    .filter((f) => fs.existsSync(path.join(repo, f)))
    .flatMap((f) => [...fs.readFileSync(path.join(repo, f), 'utf8').matchAll(/callFixed(?:<[^>]*>)?\(\s*\w+\s*,\s*\w+\s*,\s*([^,)]+)/g)].map((m) => m[1]!.trim()));
  ok('every callFixed passes one of the fixed _FN functions', calls.length > 0 && calls.every((c) => fixed.includes(c)), calls.join(', '));
  ok('references expire and a new look replaces them', typeof refs.REF_MAX_AGE_MS === 'number' && refs.REF_MAX_AGE_MS <= 10 * 60_000);
} finally {
  await chrome.stop();
  site.close();
}

try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
