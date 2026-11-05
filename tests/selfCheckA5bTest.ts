/**
 * tests/selfCheckA5bTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase A5b (audit TRA-08, B3; owner's choices of 2026-11-05: Q1 Redis on its
 * fallback is "not verified" with the reason; Q2 JARVIS's Chrome not running is
 * "not verified, starts when needed"; Q3 the Chrome and PowerShell checks are in
 * the full self-check only). self_check said "tools: working" when any tool had
 * run, "redis VERIFIED" on the in-memory fallback, and nothing about Chrome,
 * PowerShell or the permission level.
 *
 *   1. the "tools" item is said as the last tool call, not as a check of the tools
 *   2. Redis on its fallback is not verified; a probe that throws is not "online"
 *   3. JARVIS's Chrome: running, installed but not running, missing (full only)
 *   4. PowerShell: answers, fails, not Windows (full only)
 *   5. the permission level, as a line in every self-check
 *
 * Chrome, PowerShell, the platform, Redis and the permission level are stood in
 * for, so the test is the same on Windows and Linux.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-selfcheck-a5b-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['JARVIS_CHROME_PROFILE'] = path.join(root, 'no-chrome-profile');
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';
delete process.env['JARVIS_CDP_PORT'];

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const { healthLedger, LEDGER_PIPELINES } = await import('../monitoring/healthLedger.js');
const { healthCheck, overclaims } = await import('../core/selfCheck.js');
const hmModule = await import('../monitoring/healthManager.js') as any;

type Item = { name: string; state: string; detail: string };
const find = (items: Item[], re: RegExp) => items.find((i) => re.test(i.name));
const show = (i?: Item) => (i ? `[${i.state}] ${i.name}: ${i.detail}` : 'no such item');

let psCalls = 0;
const base = (over: Record<string, unknown> = {}) => ({
  connectedRoles: () => ['tts', 'stt', 'wakeword'],
  services: async () => [],
  chrome: async () => ({ installedPath: '/opt/chrome/chrome' }),
  powershell: async () => { psCalls++; return { ok: true, version: '5.1.19041.5007' }; },
  platform: () => 'win32' as NodeJS.Platform,
  permission: () => ({ level: 1, remainingSeconds: null }),
  ...over,
}) as never;

console.log('\n=== Honest self-check (phase A5b) ===\n');

console.log('--- 1. the "tools" item ---');
{
  healthLedger.clear();
  healthLedger.record(LEDGER_PIPELINES.tools, true, 'list_capabilities ran');
  const r = await healthCheck(false, base());
  const tools = find(r.items as Item[], /tool/);
  ok('no item says "tools: working" because one tool ran', !(r.items as Item[]).some((i) => i.name === 'tools' && /working/.test(i.detail)), show(tools));
  ok('it is said as the last tool call, with the tool', !!tools && /last tool call/i.test(tools.name) && /list_capabilities/.test(tools.detail), show(tools));
  ok('…and says it is not a check of what the tools can do', !!tools && /not a check of what the tools can do/i.test(tools.detail), show(tools));
  ok('…without "working": what ran, and when (review B2)', !!tools && !/working/i.test(tools.detail) && /list_capabilities ran \d+ s ago/.test(tools.detail), show(tools));
  // "Why stuck": the same name in the item and in what is said (review B6).
  healthLedger.clear();
  healthLedger.record(LEDGER_PIPELINES.tools, false, 'open_app crashed (test)');
  healthLedger.record(LEDGER_PIPELINES.tools, false, 'open_app crashed (test)');
  const { investigateStuck } = await import('../core/selfCheck.js');
  const stuck = await investigateStuck({ snapshot: undefined, goals: () => [], agents: () => ({ running: 0, waiting: 0, agents: [] }) } as never);
  const failingTools = find(stuck.items as Item[], /tool/);
  ok('why stuck: a failing last tool call is named as such when spoken', /Failing: last tool call/.test(stuck.spoken) && !/Failing: tools\b/.test(stuck.spoken), stuck.spoken);
  ok('…and a failing item does not carry the "not a check" note', !!failingTools && failingTools.state === 'FAILING' && !/not a check/.test(failingTools.detail), show(failingTools));
  healthLedger.clear();
}

console.log('--- 2. Redis (Q1) ---');
{
  let r = await healthCheck(true, base({ services: async () => [{ name: 'redis', status: 'online', detail: 'in-memory cache fallback', fallback: true }] }));
  let redis = find(r.items as Item[], /redis/);
  ok('Redis on its in-memory fallback: not verified', redis?.state === 'NOT_VERIFIED', show(redis));
  ok('…with the reason: not connected, the in-memory cache is used', !!redis && /not connected/i.test(redis.detail) && /in-memory cache/i.test(redis.detail), show(redis));
  r = await healthCheck(true, base({ services: async () => [{ name: 'redis', status: 'online', detail: 'round-trip OK' }] }));
  redis = find(r.items as Item[], /redis/);
  ok('Redis connected: verified, as before', redis?.state === 'VERIFIED', show(redis));

  const deps = hmModule.redisProbeDeps as { load: () => Promise<unknown> } | undefined;
  ok('Redis\'s own probe can be stood in for (redisProbeDeps)', !!deps);
  if (deps) {
    const realLoad = deps.load;
    const hm = hmModule.healthManager as any;
    deps.load = async () => ({ initRedis: () => undefined, probeRedis: async () => ({ state: 'fallback', latencyMs: 0, detail: 'in-memory cache fallback' }) });
    let h = await hm.probeRedis();
    ok('the probe marks the fallback; the dashboard still reads "online, fallback"', h.fallback === true && h.status === 'online' && /fallback/.test(String(h.detail)), JSON.stringify(h));
    deps.load = async () => { throw new Error('the cache module failed to load (test)'); };
    h = await hm.probeRedis();
    ok('a probe that throws: degraded with the reason, not "online"', h.status === 'degraded' && /failed to load \(test\)/.test(String(h.detail)), JSON.stringify(h));
    deps.load = realLoad;

    // The default service list carries the flag through to the self-check.
    const realProbe = hm.probe;
    hm.probe = async () => ({ services: { redis: { name: 'redis', status: 'online', detail: 'in-memory cache fallback', fallback: true, checkedAt: Date.now() } } });
    try {
      const { services: _drop, ...noServices } = base() as Record<string, unknown>;
      r = await healthCheck(true, noServices as never);
      redis = find(r.items as Item[], /redis/);
      ok('through the real service list: Redis on its fallback is not verified', redis?.state === 'NOT_VERIFIED', show(redis));
    } finally { hm.probe = realProbe; }
  }
}

console.log('--- 3. JARVIS\'s Chrome (Q2, Q3) ---');
{
  const chromeOf = async (chrome: () => Promise<unknown>) => find((await healthCheck(true, base({ chrome }))).items as Item[], /chrome/i);
  let c = await chromeOf(async () => ({ running: { port: 9333 }, installedPath: '/opt/chrome/chrome' }));
  ok('running and answering: verified, with its port', c?.state === 'VERIFIED' && /9333/.test(c.detail), show(c));
  c = await chromeOf(async () => ({ installedPath: '/opt/chrome/chrome' }));
  ok('installed but not running: not verified, starts when JARVIS opens a page', c?.state === 'NOT_VERIFIED' && /starts when JARVIS opens a page/i.test(c.detail), show(c));
  c = await chromeOf(async () => ({ installedPath: '/opt/chrome/chrome', autostartOff: true }));
  ok('installed, not running, JARVIS_CHROME_AUTOSTART off: blocked, JARVIS will not start it (review B1)', c?.state === 'BLOCKED' && /AUTOSTART is off/.test(c.detail) && !/starts when/.test(c.detail), show(c));
  c = await chromeOf(async () => ({}));
  ok('not installed: failing, web pages cannot open', c?.state === 'FAILING' && /not (installed|found)/i.test(c.detail), show(c));
  c = await chromeOf(async () => ({ fixedPort: 9555, installedPath: '/opt/chrome/chrome' }));
  ok('JARVIS_CDP_PORT set and nothing answers there: failing, with the port', c?.state === 'FAILING' && /9555/.test(c.detail), show(c));
  c = await chromeOf(async () => { throw new Error('profile unreadable (test)'); });
  ok('the check itself fails: failing, with the reason', c?.state === 'FAILING' && /profile unreadable \(test\)/.test(c.detail), show(c));
  const quick = await healthCheck(false, base());
  ok('not in the quick self-check (Q3)', !find(quick.items as Item[], /chrome/i), show(find(quick.items as Item[], /chrome/i)));

  // The real check reads; it starts nothing. With JARVIS_CHROME_PATH it is the same on every OS.
  const { chrome: _c, ...noChrome } = base() as Record<string, unknown>;
  process.env['JARVIS_CHROME_PATH'] = path.join(root, 'no-such-chrome');
  c = find((await healthCheck(true, noChrome as never)).items as Item[], /chrome/i);
  ok('the real check: a Chrome path that does not exist is failing', c?.state === 'FAILING', show(c));
  process.env['JARVIS_CHROME_PATH'] = process.execPath;
  c = find((await healthCheck(true, noChrome as never)).items as Item[], /chrome/i);
  ok('the real check, autostart off (as here): blocked, nothing started', c?.state === 'BLOCKED' && /AUTOSTART is off/.test(c.detail), show(c));
  delete process.env['JARVIS_CHROME_AUTOSTART'];
  c = find((await healthCheck(true, noChrome as never)).items as Item[], /chrome/i);
  ok('the real check, autostart on: installed, not running, nothing started: not verified, starts when needed', c?.state === 'NOT_VERIFIED' && /starts when JARVIS opens a page/.test(c.detail), show(c));
  process.env['JARVIS_CHROME_AUTOSTART'] = 'off';
  delete process.env['JARVIS_CHROME_PATH'];
}

console.log('--- 4. PowerShell (Q3) ---');
{
  const psOf = async (over: Record<string, unknown>) => find((await healthCheck(true, base(over))).items as Item[], /powershell/i);
  let p = await psOf({});
  ok('on Windows, PowerShell answers: verified, with its version', p?.state === 'VERIFIED' && /5\.1/.test(p.detail), show(p));
  p = await psOf({ powershell: async () => ({ ok: false, reason: 'spawn powershell.exe ENOENT (test)' }) });
  ok('on Windows, PowerShell cannot start: failing, with the reason', p?.state === 'FAILING' && /ENOENT \(test\)/.test(p.detail), show(p));
  p = await psOf({ powershell: async () => ({ ok: false, reason: 'no answer within 5 s', slow: true }) });
  ok('on Windows, PowerShell slower than 5 s: not verified, not "cannot work" (review B3)', p?.state === 'NOT_VERIFIED' && /within 5 s/.test(p.detail) && !/cannot work/.test(p.detail), show(p));
  if (process.platform === 'win32') {
    // The real query, on Windows only (Windows CI and the owner's PC; review B4).
    p = await psOf({ powershell: undefined });
    ok('Windows: the real PowerShell answers with its version (or is only slow)', (p?.state === 'VERIFIED' && /PowerShell \d+\.\d+/.test(p.detail)) || (p?.state === 'NOT_VERIFIED' && /within 5 s/.test(p.detail)), show(p));
  }
  psCalls = 0;
  p = await psOf({ platform: () => 'linux' });
  ok('not Windows: blocked, desktop control needs Windows', p?.state === 'BLOCKED' && /needs Windows/i.test(p.detail), show(p));
  ok('…and PowerShell is not asked', psCalls === 0, `calls=${psCalls}`);
  psCalls = 0;
  const quick = await healthCheck(false, base());
  ok('not in the quick self-check (Q3)', !find(quick.items as Item[], /powershell/i) && psCalls === 0, `calls=${psCalls}`);
}

console.log('--- 5. the permission level ---');
{
  let r = await healthCheck(false, base());
  ok('quick: the level is said', /Permission: level 1, safe control/.test(r.spoken) && r.details.some((l) => /Permission: level 1, safe control/.test(l)), r.spoken);
  ok('…as a line, not a check', !(r.items as Item[]).some((i) => /permission/i.test(i.name)), (r.items as Item[]).map((i) => i.name).join(', '));
  r = await healthCheck(true, base({ permission: () => ({ level: 2, remainingSeconds: 720 }) }));
  ok('full control: with the time left', /Permission: full control, 12 min left/.test(r.spoken), r.spoken);
  r = await healthCheck(true, base({ permission: () => ({ level: 2, remainingSeconds: 30 }) }));
  ok('full control under a minute: "less than 1 min left" (review B8)', /Permission: full control, less than 1 min left/.test(r.spoken), r.spoken);
  r = await healthCheck(true, base({ permission: () => ({ level: 0, remainingSeconds: null }) }));
  ok('level 0: read only', /Permission: level 0, read only/.test(r.spoken), r.spoken);
  r = await healthCheck(true, base({ permission: () => { throw new Error('session file unreadable (test)'); } }));
  ok('the level cannot be read: said so, with the reason', /Permission: (unknown|not read)/i.test(r.spoken) && /session file unreadable \(test\)/.test(r.details.join('\n')), r.spoken);
}

console.log('--- 6. the whole report ---');
{
  healthLedger.clear();
  const r = await healthCheck(true, base({ services: async () => [{ name: 'redis', status: 'online', detail: 'in-memory cache fallback', fallback: true }] }));
  ok('no overclaim in the spoken report', !overclaims(r.spoken), r.spoken);
  const blocked = await healthCheck(true, base({ platform: () => 'linux', chrome: async () => ({ installedPath: '/x', autostartOff: true }) }));
  ok('no nested brackets in what is said (review B8)', !/\([^)]*\(/.test(blocked.spoken), blocked.spoken);
  ok('the details say what the Chrome and PowerShell checks look at', r.details.some((l) => /Chrome and PowerShell/.test(l)), r.details.slice(-3).join(' | '));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
