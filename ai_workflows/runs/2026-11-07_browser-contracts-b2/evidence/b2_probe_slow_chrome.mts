// B2 diagnosis probe (read-only): a Chrome that is slow to open a tab (3.5 s), through the real openTab and actionQueue.
import http from 'node:http';
let puts = 0; const opened: string[] = [];
const server = http.createServer((req, res) => {
  if (req.method === 'PUT' && req.url?.startsWith('/json/new')) {
    puts++;
    const id = `tab${puts}`; opened.push(id);            // Chrome opens the tab at once...
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id, type: 'page', url: 'https://example.com/' })); }, 3_500); // ...and answers late
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;
const { openTab } = await import('./perception/cdpClient.ts');
const { actionQueue } = await import('./control/actionQueue.ts');
const t0 = Date.now();
let msg = '';
try { await actionQueue.enqueue('openUrl', () => openTab('https://example.com/', port), 20_000); msg = 'resolved'; } catch (e: any) { msg = String(e?.message ?? e); }
console.log(`requests to open a tab: ${puts}; tabs Chrome opened: ${opened.length} (${opened.join(', ')})`);
console.log(`after ${((Date.now() - t0) / 1000).toFixed(1)} s, JARVIS's error: ${msg.slice(0, 160)}`);
server.closeAllConnections?.(); server.close(); process.exit(0);
