/**
 * tests/redisHealthAgreementTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-02: the two health systems give the same answer for Redis.
 *
 * self_healing/healthChecker.ts (feeds self-healing) and
 * monitoring/healthManager.ts (feeds the dashboard) each probed Redis their
 * own way. The healer's probe called `pingRedis`, which redisCache never
 * exported; an `as any` cast hid that from the compiler, so the probe never
 * reached Redis and said "ok" whatever Redis did. The dashboard's probe had
 * no time limit, so a Redis that stopped answering held it forever.
 *
 * A fake Redis server is switched between four behaviours, and both probes
 * are asked each time:
 *   healthy  — commands answered
 *   refusing — connected, but writes refused (as with a full disk or memory)
 *   silent   — connected, but nothing answered
 *   gone     — server closed: the in-memory fallback, by design not a fault
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-redis-health-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;

type Mode = 'healthy' | 'refusing' | 'silent';
let mode: Mode = 'healthy';
const store = new Map<string, string>();
const sockets = new Set<net.Socket>();

function parseCommands(buf: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  const text = buf.toString('latin1');
  let pos = 0;
  while (pos < text.length && text[pos] === '*') {
    const header = text.indexOf('\r\n', pos);
    if (header < 0) break;
    const n = Number(text.slice(pos + 1, header));
    let p = header + 2;
    const parts: string[] = [];
    let complete = true;
    for (let i = 0; i < n; i++) {
      const lenEnd = text.indexOf('\r\n', p);
      if (lenEnd < 0) { complete = false; break; }
      const len = Number(text.slice(p + 1, lenEnd));
      const start = lenEnd + 2;
      if (text.length < start + len + 2) { complete = false; break; }
      parts.push(text.slice(start, start + len));
      p = start + len + 2;
    }
    if (!complete) break;
    commands.push(parts);
    pos = p;
  }
  return { commands, rest: buf.subarray(pos) };
}

const bulk = (s: string) => `$${Buffer.byteLength(s)}\r\n${s}\r\n`;

const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => { /* the client goes away at the end */ });
  let pending: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const { commands, rest } = parseCommands(pending);
    pending = rest;
    for (const [name = '', ...args] of commands) {
      const cmd = name.toUpperCase();
      if (cmd === 'INFO') { socket.write(bulk('# Server\r\nredis_version:7.0.0\r\nloading:0\r\n')); continue; }
      if (cmd === 'QUIT') { socket.end('+OK\r\n'); continue; }
      if (mode === 'silent') continue;
      if (mode === 'refusing') {
        if (cmd === 'PING') socket.write('+PONG\r\n');
        else if (cmd === 'SET') socket.write("-OOM command not allowed when used memory > 'maxmemory'.\r\n");
        else socket.write(store.has(args[0]!) ? bulk(store.get(args[0]!)!) : '$-1\r\n');
        continue;
      }
      if (cmd === 'SET') { store.set(args[0]!, args[1]!); socket.write('+OK\r\n'); }
      else if (cmd === 'GET') socket.write(store.has(args[0]!) ? bulk(store.get(args[0]!)!) : '$-1\r\n');
      else if (cmd === 'PING') socket.write('+PONG\r\n');
      else socket.write('+OK\r\n');
    }
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
process.env['REDIS_HOST'] = '127.0.0.1';
process.env['REDIS_PORT'] = String((server.address() as net.AddressInfo).port);

const realWarn = console.warn;
console.warn = () => { /* the cache's own warnings are expected here */ };
const redis = await import('../memory/redisCache.js');
const { healthChecker } = await import('../self_healing/healthChecker.js');
const { healthManager } = await import('../monitoring/healthManager.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  const line = `  ${condition ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`;
  if (condition) { console.log(line); passed++; } else { console.error(line); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Both probes, each given 8 s (a probe that never returns counts as "hung"). */
async function both(): Promise<{ healer: any; dashboard: any; ms: number }> {
  const t0 = Date.now();
  const limit = <T>(p: Promise<T>) => Promise.race([p, sleep(8_000).then(() => 'hung' as const)]);
  const [healer, dashboard] = await Promise.all([
    limit((healthChecker as any)._probeRedis()),
    limit((healthManager as any).probeRedis()),
  ]);
  return { healer, dashboard, ms: Date.now() - t0 };
}
const say = (r: any) => (r === 'hung' ? 'hung' : JSON.stringify({ ok: r.ok, status: r.status, error: r.error, detail: r.detail }));

console.log('\n=== Both health systems agree on Redis (ARCH-02) ===\n');

redis.initRedis();
for (let i = 0; i < 150 && !redis.isRedisAvailable(); i++) await sleep(20);
ok('(setup) connected to the fake Redis', redis.isRedisAvailable());

mode = 'healthy';
let r = await both();
ok('healthy: the healer says ok', r.healer !== 'hung' && r.healer.ok === true, say(r.healer));
ok('healthy: the dashboard says online', r.dashboard !== 'hung' && r.dashboard.status === 'online', say(r.dashboard));

mode = 'refusing';
r = await both();
ok('refusing writes: the healer reports a failure', r.healer !== 'hung' && r.healer.ok === false, say(r.healer));
ok('refusing writes: the dashboard says degraded', r.dashboard !== 'hung' && r.dashboard.status === 'degraded', say(r.dashboard));
ok('…and both give the same reason', r.healer !== 'hung' && r.dashboard !== 'hung' && /OOM/.test(String(r.healer.error)) && /OOM/.test(String(r.dashboard.detail)),
  `${say(r.healer)} / ${say(r.dashboard)}`);

mode = 'silent';
r = await both();
ok('not answering: the healer reports a failure', r.healer !== 'hung' && r.healer.ok === false, say(r.healer));
ok('not answering: the dashboard says degraded, and does not hang', r.dashboard !== 'hung' && r.dashboard.status === 'degraded', say(r.dashboard));
ok('…within the probe time limit', r.ms < 6_000, `${r.ms}ms`);

mode = 'healthy';
for (const s of sockets) s.destroy();
server.close();
for (let i = 0; i < 150 && redis.isRedisAvailable(); i++) await sleep(20);
r = await both();
ok('gone (in-memory fallback): the healer says ok', r.healer !== 'hung' && r.healer.ok === true, say(r.healer));
ok('gone (in-memory fallback): the dashboard says online, fallback', r.dashboard !== 'hung' && r.dashboard.status === 'online' && /fallback/.test(String(r.dashboard.detail)), say(r.dashboard));

console.warn = realWarn;
await redis.disconnectRedis().catch(() => {});
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
