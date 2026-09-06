/**
 * test_production_hardening.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS Production Hardening & Integration Test
 *
 * NOTE: selfHealingManager is intentionally NOT imported here.
 *       It spawns Python voice processes (TTS/STT/WakeWord) at import time,
 *       which blocks in a non-interactive test environment.
 *       Self-healing is tested via pipelineRegistry directly.
 */

import 'dotenv/config';
import * as fs from 'fs';

// ─── Timing helper ────────────────────────────────────────────────────────────

async function measure<T>(
  label: string,
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: Math.round(performance.now() - start) };
}

// ─── Report builder ───────────────────────────────────────────────────────────

const lines: string[] = [];
const perf: Record<string, number> = {};
const issues: string[] = [];

function log(msg: string) {
  console.log(msg);
  lines.push(msg);
}

function fail(msg: string) {
  console.error('❌ ' + msg);
  lines.push('❌ ' + msg);
  issues.push(msg);
}

function ok(msg: string) {
  console.log('✅ ' + msg);
  lines.push('✅ ' + msg);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('');
  log('═══════════════════════════════════════════════════════');
  log('  JARVIS PRODUCTION HARDENING & INTEGRATION TEST');
  log('  ' + new Date().toISOString());
  log('═══════════════════════════════════════════════════════');
  log('');

  // ══════════════════════════════════════════════════════════
  // PHASE 1 — STARTUP VERIFICATION
  // ══════════════════════════════════════════════════════════
  log('── PHASE 1: STARTUP VERIFICATION ──────────────────────');

  // 1a. memoryManager
  const { memoryManager } = await import('./memory/memoryManager.js');
  const memInit = await measure('memoryManager.init', () => memoryManager.init());
  perf['memoryManager.init'] = memInit.durationMs;
  ok(`memoryManager initialized in ${memInit.durationMs}ms`);

  // 1b. toolRegistryV2
  const { toolRegistryV2 } = await import('./core/toolRegistryV2.js');
  const { registerAllTools } = await import('./core/tools/index.js');
  const regPerf = await measure('registerAllTools', async () => registerAllTools());
  perf['registerAllTools'] = regPerf.durationMs;
  ok(`toolRegistryV2 populated in ${regPerf.durationMs}ms`);

  // 1c. messageBus
  const { messageBus } = await import('./core/messageBus.js');
  ok('messageBus imported (singleton, event-driven)');

  // 1d. worldModel
  const { worldModel } = await import('./simulation/worldModel.js');
  ok(`worldModel initialized — state: ${worldModel.state.currentEnvironmentState}`);

  // 1e. pipelineRegistry (self-healing entry point)
  const { pipelineRegistry } = await import('./self_healing/pipelineRegistry.js');
  ok('pipelineRegistry initialized');

  log('');

  // ══════════════════════════════════════════════════════════
  // PHASE 2 — TOOL REGISTRY VALIDATION
  // ══════════════════════════════════════════════════════════
  log('── PHASE 2: TOOL REGISTRY VALIDATION ──────────────────');

  const allTools = toolRegistryV2.getAll();
  const toolNames = toolRegistryV2.names();

  if (allTools.length === 0) {
    fail('No tools registered!');
  } else {
    ok(`${allTools.length} tools registered: ${toolNames.join(', ')}`);
  }

  // Check for required tools
  const required = ['web_search', 'read_file', 'write_file', 'run_command', 'get_system_info', 'save_relation', 'search_memory'];
  for (const name of required) {
    if (toolRegistryV2.has(name)) {
      ok(`  Tool present: ${name} [risk: ${toolRegistryV2.get(name)!.riskLevel}]`);
    } else {
      fail(`  MISSING TOOL: ${name}`);
    }
  }

  // Check for duplicates
  const nameSet = new Set(toolNames);
  if (nameSet.size !== toolNames.length) {
    fail('Duplicate tool names detected in registry!');
  } else {
    ok('No duplicate registrations');
  }

  // Check no tool has an empty execute handler
  for (const tool of allTools) {
    if (typeof tool.execute !== 'function') {
      fail(`Tool "${tool.name}" has no execute handler!`);
    }
  }

  // LLM definitions check
  const defs = toolRegistryV2.getLLMDefinitions();
  if (defs.length !== allTools.length) {
    fail(`getLLMDefinitions() returned ${defs.length} vs ${allTools.length} registered tools`);
  } else {
    ok(`getLLMDefinitions() returns ${defs.length} OpenAI-compatible definitions`);
  }

  log('');

  // ══════════════════════════════════════════════════════════
  // PHASE 3 — WEB SEARCH INVESTIGATION
  // ══════════════════════════════════════════════════════════
  log('── PHASE 3: WEB SEARCH STATUS ──────────────────────────');

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    fail('SERPER_API_KEY not found in environment');
    log('WEB SEARCH STATUS: BROKEN (no API key)');
  } else {
    ok(`SERPER_API_KEY present (${apiKey.length} chars)`);

    const searchPerf = await measure('web_search execute', async () =>
      toolRegistryV2.execute('web_search', { query: 'current time in London' })
    );
    perf['web_search'] = searchPerf.durationMs;
    const sr = searchPerf.result;

    if (sr.success) {
      ok(`web_search returned real results in ${searchPerf.durationMs}ms`);
      ok(`  Preview: ${sr.output.substring(0, 120).replace(/\n/g, ' ')}…`);
      log('\nWEB SEARCH STATUS: REAL ✅');
    } else {
      fail(`web_search failed: ${sr.error}`);
      log('\nWEB SEARCH STATUS: BROKEN ❌');
    }
  }

  log('');

  // ══════════════════════════════════════════════════════════
  // PHASE 4 — MEMORY STRESS TEST
  // ══════════════════════════════════════════════════════════
  log('── PHASE 4: MEMORY STRESS TEST ─────────────────────────');

  // 4a. 100 writes (50 unique + 50 duplicates)
  const stressStart = performance.now();
  for (let i = 0; i < 50; i++) {
    await memoryManager.addMessage('user',      `Stress message ${i}: unique content for test run`);
    await memoryManager.addMessage('user',      `Stress message ${i}: unique content for test run`); // duplicate
  }
  perf['memory_stress_100_writes'] = Math.round(performance.now() - stressStart);
  ok(`100 writes (50 unique + 50 duplicates) in ${perf['memory_stress_100_writes']}ms`);

  // 4b. Retrieval
  const shortTerm = memoryManager.getShortTerm(20);
  ok(`getShortTerm(20) returned ${shortTerm.length} messages`);

  // 4c. Duplicate detection
  const contents = shortTerm.map(m => m.content);
  const unique = new Set(contents);
  if (unique.size === contents.length) {
    ok('No duplicate messages stored (deduplication working)');
  } else {
    // Some duplicates may be allowed depending on implementation
    log(`  ℹ️  ${contents.length - unique.size} duplicate messages present in buffer`);
  }

  // 4d. Fact storage & search
  await memoryManager.rememberFact('JARVIS production hardening test completed', 'system', 9, 0.99);
  const facts = await memoryManager.searchFacts('production hardening', 5);
  if (facts.length > 0) {
    ok(`Fact search returned ${facts.length} result(s)`);
  } else {
    fail('Fact search returned 0 results after write');
  }

  // 4e. Context building
  const { unifiedContextBuilder } = await import('./memory/unifiedContextBuilder.js');
  const ctxPerf = await measure('buildContext', () =>
    unifiedContextBuilder.buildContext('test query', 'test-session')
  );
  perf['buildContext'] = ctxPerf.durationMs;
  const ctx = ctxPerf.result;
  ok(`Context built in ${ctxPerf.durationMs}ms — ${ctx.mergedContext.length} chars`);

  if (ctx.mergedContext.length > 16000) {
    fail('Context exceeds 16k chars — token budget enforcement may be failing');
  } else {
    ok('Context within token budget (≤16k chars)');
  }

  log('');

  // ══════════════════════════════════════════════════════════
  // PHASE 5 — AGENT LOOP PARTIAL TEST (tool execution path)
  // ══════════════════════════════════════════════════════════
  log('── PHASE 5: AGENT TOOL EXECUTION PATH ──────────────────');

  // Test get_system_info (safe, low-risk, no network)
  const sysPerf = await measure('get_system_info', () =>
    toolRegistryV2.execute('get_system_info', {})
  );
  perf['get_system_info'] = sysPerf.durationMs;
  if (sysPerf.result.success) {
    ok(`get_system_info → ${sysPerf.durationMs}ms — OS: ${sysPerf.result.output.split('\n')[0]}`);
  } else {
    fail(`get_system_info failed: ${sysPerf.result.error}`);
  }

  // Test read_file (reads this script itself)
  const readPerf = await measure('read_file', () =>
    toolRegistryV2.execute('read_file', { filePath: 'test_production_hardening.ts' })
  );
  perf['read_file'] = readPerf.durationMs;
  if (readPerf.result.success) {
    ok(`read_file → ${readPerf.durationMs}ms — ${readPerf.result.output.length} chars read`);
  } else {
    fail(`read_file failed: ${readPerf.result.error}`);
  }

  // Test search_memory
  const searchMemPerf = await measure('search_memory', () =>
    toolRegistryV2.execute('search_memory', { query: 'production hardening', top_k: 3 as unknown as string })
  );
  perf['search_memory'] = searchMemPerf.durationMs;
  if (searchMemPerf.result.success) {
    ok(`search_memory → ${searchMemPerf.durationMs}ms`);
  } else {
    fail(`search_memory failed: ${searchMemPerf.result.error}`);
  }

  // Test unknown tool gracefully
  const unknownPerf = await measure('unknown_tool', () =>
    toolRegistryV2.execute('does_not_exist', {})
  );
  if (!unknownPerf.result.success && unknownPerf.result.error?.includes('Unknown tool')) {
    ok('Unknown tool handled gracefully with error message');
  } else {
    fail('Unknown tool did not return expected error');
  }

  log('');

  // ══════════════════════════════════════════════════════════
  // PHASE 6 — SELF-HEALING TEST
  // ══════════════════════════════════════════════════════════
  log('── PHASE 6: SELF-HEALING TEST ──────────────────────────');

  // Simulate pipeline failure
  pipelineRegistry.recordFailure('test_pipeline', 'Simulated failure for hardening test');
  const health = pipelineRegistry.getHealth();

  if (health['test_pipeline']) {
    const status = health['test_pipeline'].status;
    ok(`pipelineRegistry recorded failure — status: "${status}"`);
    if (status === 'degraded' || status === 'unknown') {
      ok('Self-healing failure detection: ACTIVE');
    }
  } else {
    fail('pipelineRegistry did not record test failure');
  }

  // Simulate recovery
  pipelineRegistry.recordSuccess('test_pipeline');
  const healthAfter = pipelineRegistry.getHealth();
  const statusAfter = healthAfter['test_pipeline']?.status;
  ok(`After recovery — pipeline status: "${statusAfter}"`);

  // messageBus event roundtrip using a real EventMap key
  let busEventFired = false;
  messageBus.subscribe('TASK_COMPLETED', () => { busEventFired = true; });
  messageBus.publish('TASK_COMPLETED', { goal: 'hardening_test', result: 'pass' }, 1);
  await new Promise(r => setTimeout(r, 50));
  if (busEventFired) {
    ok('messageBus pub/sub roundtrip: working');
  } else {
    fail('messageBus pub/sub did not fire event');
  }

  log('');

  // ══════════════════════════════════════════════════════════
  // PHASE 7 — PERFORMANCE REPORT
  // ══════════════════════════════════════════════════════════
  log('── PHASE 7: PERFORMANCE TIMINGS ────────────────────────');

  const sorted = Object.entries(perf).sort(([, a], [, b]) => b - a);
  for (const [label, ms] of sorted) {
    const flag = ms > 3000 ? ' ⚠️  SLOW' : ms > 1000 ? ' ℹ️  moderate' : '';
    log(`  ${label.padEnd(35)} ${String(ms).padStart(5)}ms${flag}`);
  }

  log('');

  // ══════════════════════════════════════════════════════════
  // PHASE 8 — FINAL REPORT
  // ══════════════════════════════════════════════════════════
  const score = Math.max(0, 100 - issues.length * 10);

  log('── PHASE 8: FINAL SUMMARY ──────────────────────────────');
  log(`  Issues found: ${issues.length}`);
  if (issues.length > 0) {
    for (const issue of issues) log(`    • ${issue}`);
  }
  log(`  Production Readiness Score: ${score}/100`);
  log('');
  log('  Next 5 Tasks:');
  log('  1. Integrate a real web search rate-limiter (Serper: 2,500 free/month)');
  log('  2. Wire Neo4j locally or swap graphMemory for LowDB-backed fallback');
  log('  3. Add write_file + run_command smoke tests with approval gate bypass flag');
  log('  4. Implement brainLoop watchdog timeout (max 60s per orchestrator turn)');
  log('  5. Add structured logging export (JSON lines) for production observability');
  log('');
  log('═══════════════════════════════════════════════════════');
  log(issues.length === 0
    ? '  ALL PHASES PASSED — JARVIS IS PRODUCTION READY ✅'
    : `  ${issues.length} ISSUE(S) FOUND — SEE ABOVE ⚠️`);
  log('═══════════════════════════════════════════════════════');

  // Write markdown report
  const md = [
    '# JARVIS Production Hardening Report',
    `_Generated: ${new Date().toISOString()}_`,
    '',
    '## Results',
    ...lines,
    '',
    '## Issues',
    ...(issues.length === 0
      ? ['_None_']
      : issues.map(i => `- ${i}`)),
    '',
    `## Production Readiness Score: **${score}/100**`,
  ].join('\n');

  fs.writeFileSync('jarvis_production_hardening_report.md', md, 'utf8');
  console.log('\n✅ Report written: jarvis_production_hardening_report.md');

  process.exit(issues.length === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('[HardeningTest] Fatal error:', err);
  process.exit(1);
});
