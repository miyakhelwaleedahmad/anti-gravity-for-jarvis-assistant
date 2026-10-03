/**
 * tests/redisReadyRaceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Seen on Windows at startup:
 *   [Redis] cacheSet("__health_probe__") failed: Stream isn't writeable and
 *   enableOfflineQueue options is false
 *
 * redisCache marked Redis available on ioredis's "connect" event, which fires
 * when the socket opens; ioredis accepts commands only once it is "ready"
 * (after its INFO ready check). With the offline queue disabled, a command in
 * that gap is rejected. Availability now follows "ready".
 *
 * A minimal fake Redis server delays its INFO reply by 300 ms to hold the gap
 * open, so the race is hit every run; no real Redis is needed.
 */

import * as net from 'net';

const INFO_DELAY_MS = 300;
const store = new Map<string, string>();

function parseCommands(buf: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let text = buf.toString('latin1');
  let consumed = 0;
  while (text.length > 0 && text[0] === '*') {
    const lines: string[] = [];
    let pos = 0;
    const header = text.indexOf('\r\n');
    if (header < 0) break;
    const n = Number(text.slice(1, header));
    pos = header + 2;
    let complete = true;
    for (let i = 0; i < n; i++) {
      const lenEnd = text.indexOf('\r\n', pos);
      if (lenEnd < 0) { complete = false; break; }
      const len = Number(text.slice(pos + 1, lenEnd));
      const start = lenEnd + 2;
      if (text.length < start + len + 2) { complete = false; break; }
      lines.push(text.slice(start, start + len));
      pos = start + len + 2;
    }
    if (!complete) break;
    commands.push(lines);
    consumed += pos;
    text = text.slice(pos);
  }
  return { commands, rest: buf.subarray(Buffer.byteLength(buf.toString('latin1').slice(0, consumed), 'latin1')) };
}

const bulk = (s: string) => `$${Buffer.byteLength(s)}\r\n${s}\r\n`;

const server = net.createServer((socket) => {
  let pending: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const { commands, rest } = parseCommands(pending);
    pending = rest;
    for (const [name = '', ...args] of commands) {
      switch (name.toUpperCase()) {
        case 'INFO':
          setTimeout(() => socket.write(bulk('# Server\r\nredis_version:7.0.0\r\nloading:0\r\n')), INFO_DELAY_MS);
          break;
        case 'SET': store.set(args[0]!, args[1]!); socket.write('+OK\r\n'); break;
        case 'GET': socket.write(store.has(args[0]!) ? bulk(store.get(args[0]!)!) : '$-1\r\n'); break;
        case 'QUIT': socket.end('+OK\r\n'); break;
        default: socket.write('+OK\r\n');
      }
    }
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as net.AddressInfo).port;

process.env['REDIS_HOST'] = '127.0.0.1';
process.env['REDIS_PORT'] = String(port);
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };

const redis = await import('../memory/redisCache.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  const line = `  ${condition ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`;
  if (condition) { console.log(line); passed++; } else { console.error(line); failed++; }
}

console.log('\n=== Redis Ready Race Test ===\n');

const t0 = Date.now();
redis.initRedis();
let availableAt = -1;
let value: { ts: number } | null = null;
while (Date.now() - t0 < 3_000) {
  if (redis.isRedisAvailable()) {
    availableAt = Date.now() - t0;
    // What monitoring/healthManager.ts does the moment Redis looks available:
    await redis.cacheSet('__health_probe__', { ts: 1 }, 10);
    value = await redis.cacheGet<{ ts: number }>('__health_probe__');
    break;
  }
  await new Promise((r) => setTimeout(r, 5));
}

console.warn = realWarn;
ok('Redis became available', availableAt >= 0, `${availableAt}ms`);
ok('only after the ready check finished', availableAt >= INFO_DELAY_MS - 20, `${availableAt}ms ≥ ~${INFO_DELAY_MS}ms`);
ok('no "Stream isn\'t writeable" errors', !warnings.some((w) => w.includes("Stream isn't writeable")), warnings.join(' | ').slice(0, 160));
ok('the health probe round-trips', value?.ts === 1, JSON.stringify(value));

await redis.disconnectRedis();
server.close();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
