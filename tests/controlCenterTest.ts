/**
 * tests/controlCenterTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OPS-01: the local Control Center (system/controlCenter.ts).
 *
 *   1. it refuses to listen anywhere but loopback
 *   2. without logging in, no status and no action
 *   3. a wrong token is refused, and logins stop after five wrong tokens
 *   4. login gives an HttpOnly, SameSite=Strict cookie and a CSRF token
 *   5. a POST without the CSRF token, from another site, with a foreign Host
 *      header (DNS rebinding) or not as JSON is refused before anything runs
 *   6. only the listed actions run; a tool name such as run_command does not
 *   7. through the real registry: turning on full control still asks for
 *      approval, and a denied approval leaves it off
 *   8. no secret reaches the page; the page itself carries no token
 *   9. logging out ends the session
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-control-center-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
process.env['JARVIS_DATA_ROOT'] = root;
process.env['JARVIS_WORKSPACE_ROOT'] = root;
const PLANTED = 'gsk_' + 'Q'.repeat(40);
process.env['GROQ_API_KEY'] = PLANTED;

const { startControlCenter, getControlCenterToken, controlCenterTokenFile } = await import('../system/controlCenter.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const ran: Array<{ tool: string; args: Record<string, unknown> }> = [];
const fakeTools = {
  async execute(tool: string, args: Record<string, unknown>) {
    ran.push({ tool, args });
    if (tool === 'get_permission_status') return { success: true, output: `Level 1. Key in use: ${PLANTED}` };
    return { success: true, output: `${tool} done` };
  },
};

console.log('\n=== Control Center (OPS-01) ===\n');

console.log('--- 1. Loopback only ---');
for (const host of ['0.0.0.0', '::', '192.168.1.10']) {
  let refused = false;
  try { const cc = await startControlCenter({ host, port: 0, token: 't'.repeat(20), tools: fakeTools, log: () => {} }); await cc.close(); }
  catch (err) { refused = /only on 127\.0\.0\.1/.test(String(err)); }
  ok(`refuses to listen on ${host}`, refused);
}
const token = getControlCenterToken({});
ok('the token is kept in an owner-only file', fs.existsSync(controlCenterTokenFile()) && token.length >= 24);
if (process.platform !== 'win32') ok('…readable by the owner only', (fs.statSync(controlCenterTokenFile()).mode & 0o077) === 0);
const logs: string[] = [];
const cc = await startControlCenter({ port: 0, token, tools: fakeTools, extraStatus: () => ({ primary: 'groq', key: PLANTED }), log: (m) => logs.push(m) });
const addr = cc.server.address();
ok('it listens on 127.0.0.1', typeof addr === 'object' && addr?.address === '127.0.0.1', JSON.stringify(addr));
const base = `http://127.0.0.1:${cc.port}`;

const call = async (p: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) => {
  const res = await fetch(base + p, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html or js */ }
  return { status: res.status, headers: res.headers, text, json };
};

console.log('\n--- 2. Not logged in ---');
ran.length = 0;
ok('status needs a login', (await call('/api/status')).status === 401);
ok('an action needs a login', (await call('/api/action', { method: 'POST', body: { action: 'stop_agents' } })).status === 401);
ok('…and nothing ran', ran.length === 0, ran.map((r) => r.tool).join(','));

console.log('\n--- 3. Wrong tokens ---');
ok('a wrong token is refused', (await call('/api/login', { method: 'POST', body: { token: 'nope' } })).status === 401);
for (let i = 0; i < 4; i++) await call('/api/login', { method: 'POST', body: { token: `wrong-${i}` } });
const limited = await call('/api/login', { method: 'POST', body: { token } });
ok('after five wrong tokens, even the right one waits a minute', limited.status === 429, String(limited.status));
await cc.close();

const cc2 = await startControlCenter({ port: 0, token, tools: fakeTools, extraStatus: () => ({ primary: 'groq', key: PLANTED }), log: (m) => logs.push(m) });
const base2 = `http://127.0.0.1:${cc2.port}`;
const call2 = async (p: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) => {
  const res = await fetch(base2 + p, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html or js */ }
  return { status: res.status, headers: res.headers, text, json };
};

console.log('\n--- 4. Login ---');
const login = await call2('/api/login', { method: 'POST', body: { token } });
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = /jcc_session=[^;]+/.exec(setCookie)?.[0] ?? '';
const csrf = String(login.json?.csrf ?? '');
ok('the right token logs in', login.status === 200 && !!cookie && csrf.length > 20);
ok('the cookie is HttpOnly and SameSite=Strict', /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie.replace(/=[^;]+/, '=…'));
const authed = { Cookie: cookie };
const status = await call2('/api/status', { headers: authed });
ok('status is shown after login', status.status === 200 && typeof status.json?.permissions === 'string');

console.log('\n--- 5. Requests that are refused before anything runs ---');
ran.length = 0;
const act = (headers: Record<string, string>, body: unknown = { action: 'stop_agents' }) => call2('/api/action', { method: 'POST', body, headers: { ...authed, ...headers } });
ok('no CSRF token: 403', (await act({})).status === 403);
ok('a wrong CSRF token: 403', (await act({ 'X-CSRF-Token': 'x'.repeat(32) })).status === 403);
ok('from another site (Origin): 403', (await act({ 'X-CSRF-Token': csrf, Origin: 'https://evil.example' })).status === 403);
// fetch() will not send a chosen Host header; http.request does.
const rebind = await new Promise<number>((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: cc2.port, path: '/api/status', headers: { ...authed, Host: `evil.example:${cc2.port}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  r.on('error', () => resolve(0));
  r.end();
});
ok('a foreign Host header (DNS rebinding): refused', rebind === 421, String(rebind));
const form = await call2('/api/action', { method: 'POST', raw: 'action=stop_agents', headers: { ...authed, 'X-CSRF-Token': csrf, 'Content-Type': 'text/plain' } });
ok('a form-style body (text/plain): 415', form.status === 415, String(form.status));
ok('…none of these ran anything', ran.length === 0, ran.map((r) => r.tool).join(','));

console.log('\n--- 6. Only the listed actions ---');
const bad = await act({ 'X-CSRF-Token': csrf }, { action: 'run_command', command: 'del /s C:\\' });
ok('a tool name that is not an action (run_command) is refused', bad.status === 403 && !ran.some((r) => r.tool === 'run_command'));
const proto = await act({ 'X-CSRF-Token': csrf }, { action: '__proto__' });
ok('…as is an inherited name (__proto__)', proto.status === 403);
const good = await act({ 'X-CSRF-Token': csrf }, { action: 'pause_goal', goal: 'news' });
ok('a listed action runs its registry tool', good.status === 200 && ran.at(-1)?.tool === 'goal_control' && ran.at(-1)?.args['action'] === 'pause', JSON.stringify(ran.at(-1)));

console.log('\n--- 8. Secrets and the page ---');
ok('no secret in the status (a key in a tool reply or model status is redacted)', !status.text.includes(PLANTED), status.text.slice(0, 160));
const page = await call2('/');
ok('the page is served with a strict CSP and no framing', page.status === 200 && /default-src 'none'/.test(page.headers.get('content-security-policy') ?? '') && page.headers.get('x-frame-options') === 'DENY');
ok('the page and its script carry no token', !page.text.includes(token) && !(await call2('/app.js')).text.includes(token));
ok('the script sends the CSRF token with every POST', /X-CSRF-Token/.test((await call2('/app.js')).text));
ok('the log never shows the token', !logs.join('\n').includes(token));

console.log('\n--- 9. Logout ---');
ok('logout needs the CSRF token too', (await call2('/api/logout', { method: 'POST', body: {}, headers: authed })).status === 403);
ok('logout works', (await call2('/api/logout', { method: 'POST', body: {}, headers: { ...authed, 'X-CSRF-Token': csrf } })).status === 200);
ok('…and the old cookie no longer works', (await call2('/api/status', { headers: authed })).status === 401);
await cc2.close();

console.log('\n--- 7. Through the real registry ---');
const { approvalGate } = await import('../security/approvalGate.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await new SkillLoader(path.join(repo, 'skills')).loadSkills();
let asked = 0;
(approvalGate as any).requestApproval = async () => { asked++; return false; };
const cc3 = await startControlCenter({ port: 0, token, log: () => {} });
const base3 = `http://127.0.0.1:${cc3.port}`;
const l3 = await fetch(`${base3}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
const c3 = /jcc_session=[^;]+/.exec(l3.headers.get('set-cookie') ?? '')?.[0] ?? '';
const k3 = (await l3.json()).csrf;
const enable = await fetch(`${base3}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c3, 'X-CSRF-Token': k3 }, body: JSON.stringify({ action: 'enable_full_control' }) });
const enableBody = await enable.json();
ok('the registry knows the tool', toolRegistryV2.names().includes('enable_full_control_session'));
ok('turning on full control asked for approval', asked >= 1, `asked ${asked}`);
ok('…denied, so full control stays off', permissionSession.getCurrentLevel() < 2, `${enable.status} ${String(enableBody.output ?? enableBody.error).slice(0, 80)}`);
await cc3.close();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
