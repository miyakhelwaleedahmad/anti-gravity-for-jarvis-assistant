/**
 * tests/finalIntegrationSuiteTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Live end-to-end check: twelve owner commands through the whole pipeline
 * (router or LLM planner → tool registry → risk engine → tool), against the
 * real configured LLM provider.
 *
 * A LIVE test: it needs a key and the network, and it acts on this PC (opens
 * WhatsApp, Chrome, Calculator, VS Code, YouTube, Downloads, Settings; takes
 * a screenshot). The runner runs it only when asked:
 *
 *   pnpm test:live
 *
 * Before, it counted a command as passed whenever orchestrator.process()
 * returned, which it always does (it speaks its errors): "Planning failed …
 * Goal marked FAILED" was a pass, and the expected tool was never compared
 * with anything. It also ran in an ordinary `pnpm test`, and timed out there
 * at 120 s on the owner's PC.
 *
 * Now:
 *   - no key, or the provider does not answer: BLOCKED (exit 3) within seconds,
 *     with the reason; never a pass;
 *   - each command must reach its expected tool (the registry's call record,
 *     and the task graph's for planned steps refused before they run, such
 *     as "close Chrome" without full control);
 *   - any approval asked is answered "deny" at once and recorded, so nothing
 *     needing approval runs (Chrome is not closed) and nothing waits 20 s.
 * The key is never printed.
 */

import { performance } from 'perf_hooks';
import { orchestrator } from '../core/orchestrator.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { taskGraphEngine } from '../core/taskGraphEngine.js';
import { goalManager } from '../core/goalManager.js';
import { approvalGate } from '../security/approvalGate.js';
import { requireLiveProvider } from './livePreflight.js';

// ── Preflight: a key, and a provider that answers ────────────────────────────
await requireLiveProvider();

// ── Record tool calls and answer every approval with "deny" ──────────────────
let calls: { tool: string; success: boolean; error?: string }[] = [];
toolRegistryV2.onCall((c) => calls.push({ tool: c.tool, success: c.success, ...(c.error ? { error: c.error } : {}) }));
// Planned steps the registry refuses before they run (e.g. "needs full control
// mode") are not in its call record; the task graph reports them.
taskGraphEngine.on('node_failed', (e: { tool?: string; error?: string }) => {
  if (e.tool && !calls.some((c) => c.tool === e.tool)) calls.push({ tool: e.tool, success: false, error: String(e.error ?? '') });
});
let asked: string[] = [];
approvalGate.attachConsole();
const denier = setInterval(() => {
  const p = (approvalGate as unknown as { pending: { request: { tool: string }; settle(v: string): void } | null }).pending;
  if (p) { asked.push(p.request.tool); p.settle('deny'); }
}, 50);

const TESTS: { command: string; expect: string[] }[] = [
  { command: 'Open WhatsApp', expect: ['open_app'] },
  { command: 'Open Chrome', expect: ['open_app'] },
  { command: 'Open Calculator', expect: ['open_app'] },
  { command: 'Open VS Code', expect: ['open_app'] },
  { command: 'Open YouTube', expect: ['open_app'] },
  // Routed to the on-screen site search (core/desktopRouting.ts), not web_search.
  { command: 'Search Google for quantum computing', expect: ['site_search', 'web_search'] },
  { command: 'Take Screenshot', expect: ['screenshot', 'control_system', 'browser_screenshot'] },
  { command: 'Open Downloads', expect: ['open_app'] },
  { command: 'Open Settings', expect: ['open_app'] },
  { command: 'Remember this: User prefers dark theme', expect: ['save_relation'] },
  { command: 'Recall memory: dark theme preference', expect: ['search_memory'] },
  { command: 'Close Chrome', expect: ['control_app', 'control_process'] },
];

await goalManager.init();
let failed = 0;
for (const [i, t] of TESTS.entries()) {
  calls = [];
  asked = [];
  const t0 = performance.now();
  await orchestrator.process(t.command, 'voice');
  const ms = Math.round(performance.now() - t0);
  const route = orchestrator.matchDeterministicCommand(t.command)?.type ?? 'planner';
  const hit = calls.find((c) => t.expect.includes(c.tool));
  const seen = calls.map((c) => `${c.tool}${c.success ? '' : ' (failed)'}`).join(', ') || 'no tool called';
  const approval = asked.length ? `; approval asked for ${asked.join(', ')} and denied` : '';
  if (hit) {
    console.log(`  PASS: [${i + 1}/${TESTS.length}] "${t.command}" → ${hit.tool}${hit.success ? '' : ` (did not succeed: ${(hit.error ?? '').slice(0, 80)})`} via ${route}, ${ms}ms${approval}`);
  } else {
    console.error(`  FAIL: [${i + 1}/${TESTS.length}] "${t.command}": expected ${t.expect.join(' or ')}, got ${seen} via ${route}, ${ms}ms${approval}`);
    failed++;
  }
}
clearInterval(denier);

console.log(`\n=== Results: ${TESTS.length - failed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
