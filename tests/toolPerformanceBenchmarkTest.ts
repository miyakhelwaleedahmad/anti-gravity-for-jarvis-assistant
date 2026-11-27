/**
 * tests/toolPerformanceBenchmarkTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Task 8: Tool System Performance Benchmark Suite
 *
 * Measures sub-millisecond precision latencies for the 7 stages of Tool Execution:
 *   1. Tool Lookup Latency
 *   2. Planner Selection / Router Matching Latency
 *   3. Dispatcher Schema & Validation Latency
 *   4. Native Execution Latency
 *   5. Return Value Serialization & Parsing Latency
 *   6. Memory Update & Context Sync Latency
 *   7. GoalManager State Update Latency
 *
 * Runs 100 iterations across benchmark targets to compute exact min/avg/p95/max latencies.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { registerAllTools } from '../core/tools/index.js';
import { SkillLoader } from '../core/skillLoader.js';
import { orchestrator } from '../core/orchestrator.js';
import { goalManager } from '../core/goalManager.js';
import { agentMemory } from '../memory/agentMemory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface StageMetrics {
  stage: string;
  count: number;
  totalMs: number;
  minMs: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}

function calculateMetrics(stage: string, samples: number[]): StageMetrics {
  const sorted = [...samples].sort((a, b) => a - b);
  const totalMs = sorted.reduce((sum, v) => sum + v, 0);
  const count = sorted.length;
  const minMs = Math.round((sorted[0] ?? 0) * 1000) / 1000;
  const maxMs = Math.round((sorted[count - 1] ?? 0) * 1000) / 1000;
  const avgMs = Math.round((totalMs / count) * 1000) / 1000;
  const p95Idx = Math.floor(count * 0.95);
  const p95Ms = Math.round((sorted[p95Idx] ?? 0) * 1000) / 1000;

  return { stage, count, totalMs, minMs, avgMs, p95Ms, maxMs };
}

async function runPerformanceBenchmark() {
  console.log('\n=============================================================');
  console.log('⚡ TASK 8: TOOL SYSTEM PERFORMANCE BENCHMARK SUITE');
  console.log('=============================================================\n');

  registerAllTools();
  const skillsDir = path.join(__dirname, '..', 'skills');
  const loader = new SkillLoader(skillsDir);
  await loader.loadSkills();
  await goalManager.init();

  const ITERATIONS = 100;

  const lookupSamples: number[] = [];
  const selectionSamples: number[] = [];
  const dispatcherSamples: number[] = [];
  const executionSamples: number[] = [];
  const returnValueSamples: number[] = [];
  const memoryUpdateSamples: number[] = [];
  const goalUpdateSamples: number[] = [];

  console.log(`⏱️ Running ${ITERATIONS} iterations for 7 tool pipeline stages...\n`);

  for (let i = 0; i < ITERATIONS; i++) {
    // 1. Tool Lookup
    const t0 = performance.now();
    const tool = toolRegistryV2.get('open_app');
    lookupSamples.push(performance.now() - t0);

    // 2. Planner Selection (Router matching)
    const t1 = performance.now();
    const isMatched = orchestrator.matchDeterministicCommand('Open Calculator');
    selectionSamples.push(performance.now() - t1);

    // 3. Dispatcher (Validation & routing without execution)
    const t2 = performance.now();
    // Validate schema
    const validationRes = (toolRegistryV2 as any).validateArgs(tool, { target: 'calc', dryRun: true });
    dispatcherSamples.push(performance.now() - t2);

    // 4. Execution
    const t3 = performance.now();
    const execRes = await toolRegistryV2.execute('open_app', { target: 'calc', dryRun: true });
    executionSamples.push(performance.now() - t3);

    // 5. Return Value Serialization & Parsing
    const t4 = performance.now();
    const parsed = JSON.parse(execRes.output);
    returnValueSamples.push(performance.now() - t4);

    // 6. Memory Update
    const t5 = performance.now();
    agentMemory.addObservation(`Benchmark run ${i}`);
    memoryUpdateSamples.push(performance.now() - t5);

    // 7. Goal Update
    const t6 = performance.now();
    const goal = await goalManager.createGoal(`Benchmark ${i}`, 'cli');
    await goalManager.updateGoalStatus(goal.id, 'completed');
    goalUpdateSamples.push(performance.now() - t6);
  }

  const results: StageMetrics[] = [
    calculateMetrics('1. Tool Lookup', lookupSamples),
    calculateMetrics('2. Planner Selection', selectionSamples),
    calculateMetrics('3. Dispatcher Validation', dispatcherSamples),
    calculateMetrics('4. Tool Execution (dryRun)', executionSamples),
    calculateMetrics('5. Return Value Parsing', returnValueSamples),
    calculateMetrics('6. Memory Update', memoryUpdateSamples),
    calculateMetrics('7. Goal Update', goalUpdateSamples),
  ];

  console.table(results);

  console.log('\n=============================================================');
  console.log('📊 BENCHMARK SUMMARY & BOTTLENECK ANALYSIS');
  console.log('=============================================================');
  for (const r of results) {
    console.log(`  • ${r.stage.padEnd(28, ' ')}: Avg = ${r.avgMs} ms | p95 = ${r.p95Ms} ms | Min = ${r.minMs} ms | Max = ${r.maxMs} ms`);
  }
  console.log('=============================================================\n');
}

// Exit explicitly when done: an open connection or child process (Redis, the
// Windows PowerShell session) must not keep a finished benchmark running.
runPerformanceBenchmark().then(() => process.exit(0), (err) => {
  console.error('[Benchmark] Error:', err);
  process.exit(1);
});
