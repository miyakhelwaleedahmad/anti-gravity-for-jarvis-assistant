/**
 * tests/vectorReadinessTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vector memory: loading is not failure, a failed model load is not loading,
 * and recovery clears the failure (docs/PROVIDER_HEALTH_AUDIT.md §4, items 9–13).
 *
 * A real HTTP server on 127.0.0.1:8000 (the supervisor's address) answers the
 * way vectorMemory.py does in each phase. The supervisor, the health checker,
 * the pipeline registry and the dashboard read it over real sockets.
 *
 * Measured against the real service in this sandbox (model download blocked,
 * 403): /stats answered 200 in 1–9 ms throughout loading, /health 503, and the
 * service stayed "loading" after the load had failed; both are covered here.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vector-'));
process.env['JARVIS_DATA_ROOT'] = tmp;
process.env['JARVIS_WORKSPACE_ROOT'] = tmp;
process.env['GEMINI_API_KEY'] = '';
process.env['GROQ_API_KEY'] = '';

type Phase = 'loading' | 'failed' | 'ready';
let phase: Phase = 'loading';
const hits: string[] = [];
const server = http.createServer((req, res) => {
  hits.push(req.url ?? '');
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const state = phase;
  if (req.url === '/health') {
    if (state === 'ready') return send(200, { status: 'ready', model_ready: true, count: 3 });
    return send(503, { detail: state === 'failed' ? { state: 'failed', error: 'OSError: 403 Forbidden' } : { state: 'loading' } });
  }
  if (req.url === '/liveness') return send(200, { status: 'alive', model_ready: state === 'ready', model_state: state });
  if (req.url === '/stats') return send(200, { count: state === 'ready' ? 3 : 0, embedding_dim: 384 });
  send(404, {});
});
const bound = await new Promise<boolean>((resolve) => {
  server.once('error', () => resolve(false));
  server.listen(8000, '127.0.0.1', () => resolve(true));
});
if (!bound) {
  console.log('SKIPPED: port 8000 is in use on this machine (a vector service is running); this test needs it free.');
  process.exit(0);
}

const { vectorMemorySupervisor } = await import('../memory/vectorMemorySupervisor.js');
const { pipelineRegistry, VECTOR_PIPELINE } = await import('../self_healing/pipelineRegistry.js');
const { healthChecker } = await import('../self_healing/healthChecker.js');
const { healthManager } = await import('../monitoring/healthManager.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

// The supervisor as if it had launched the service (no Python process here).
const sup = vectorMemorySupervisor as any;
sup.running = true;
sup.startedAt = Date.now();
const check = (): Promise<boolean> => sup.checkHealth();
const logs: string[] = [];
const realLog = console.log;
const realError = console.error;
console.log = (...a: unknown[]) => { logs.push(a.join(' ')); realLog(...a); };
console.error = (...a: unknown[]) => { logs.push(a.join(' ')); realError(...a); };
const vectorRow = async () => (await healthManager.probe()).services['vector_memory']!;
const vectorProbe = async () => (await healthChecker.runNow()).find((r) => r.subsystem === 'Vector Memory')!;
const settle = () => new Promise((r) => setTimeout(r, 30));

console.log('\n=== Vector memory readiness ===\n');

console.log('--- Loading ---');
{
  for (let i = 0; i < 20; i++) await check();
  await settle();
  ok('20 polls during loading: state loading', vectorMemorySupervisor.state() === 'loading');
  const lines = logs.filter((l) => /Embedding model loading/.test(l)).length;
  ok('"model loading" is logged once, not on every poll', lines === 1, `${lines} line(s)`);
  ok('no failure is recorded while loading', pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.failureCount === 0 && pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.status === 'loading');
  const row = await vectorRow();
  ok('the dashboard shows loading, not online with "0 vectors" and not a timeout', row.status === 'loading' && /loading/.test(row.detail ?? ''), `${row.status}: ${row.detail}`);
  ok('… and does not call /stats while loading', !hits.includes('/stats'));
  const probe = await vectorProbe();
  ok('the health checker reports loading, not a failure', probe.loading === true && pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.failureCount === 0, JSON.stringify(probe));
}

console.log('\n--- The model fails to load ---');
{
  phase = 'failed';
  logs.length = 0;
  await check();
  await check();
  await settle();
  ok('state failed (it stayed "loading" forever before)', vectorMemorySupervisor.state() === 'failed');
  ok('the reason is kept', vectorMemorySupervisor.getModelError() === 'OSError: 403 Forbidden');
  ok('the failure is logged once with what to do', logs.filter((l) => /\[VectorSupervisor\] Embedding model failed to load: OSError: 403 Forbidden\. Lexical search/.test(l)).length === 1);
  ok('one pipeline failure is recorded', pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.failureCount === 1, String(pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.failureCount));
  const row = await vectorRow();
  ok('the dashboard says the model failed and lexical search is used', row.status === 'degraded' && /failed to load \(OSError: 403 Forbidden\)/.test(row.detail ?? ''), row.detail);
  const probe = await vectorProbe();
  ok('the health checker reports a failure with the reason', probe.ok === false && !probe.loading && /403 Forbidden/.test(probe.error ?? ''), probe.error);
}

console.log('\n--- Recovery ---');
{
  phase = 'ready';
  hits.length = 0;
  await check();
  await settle();
  ok('state ready, the error cleared', vectorMemorySupervisor.state() === 'ready' && vectorMemorySupervisor.getModelError() === null);
  ok('the pipeline is healthy again', pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.status === 'healthy' && pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.failureCount === 0);
  const row = await vectorRow();
  ok('the dashboard is online with the real count from /stats', row.status === 'online' && /3 vectors/.test(row.detail ?? '') && hits.includes('/stats'), row.detail);
  const probe = await vectorProbe();
  ok('the health checker reports OK', probe.ok === true && !probe.loading);
}

console.log('\n--- The service goes away ---');
{
  await new Promise<void>((r) => server.close(() => r()));
  server.closeAllConnections?.();
  sup.startedAt = Date.now() - 120_000; // past the startup window
  await check();
  await settle();
  ok('state down (not loading) when nothing answers after startup', vectorMemorySupervisor.state() === 'down');
  ok('a failure is recorded', pipelineRegistry.getHealth()[VECTOR_PIPELINE]!.failureCount >= 1);
  sup.running = false;
  ok('not started at all → stopped', vectorMemorySupervisor.state() === 'stopped');
  const probe = await vectorProbe();
  ok('stopped is not reported as healthy (and not as a fault to heal)', probe.inactive === true);
}

console.log = realLog;
console.error = realError;
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
