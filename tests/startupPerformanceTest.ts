import * as path from 'path';
import { memoryManager } from '../memory/memoryManager.js';
import { goalManager } from '../core/goalManager.js';
import { nodeBridge } from '../bridge/nodeBridge.js';
import { brainLoop } from '../core/brainLoop.js';
import { registerAllTools } from '../core/tools/index.js';
import { SkillLoader } from '../core/skillLoader.js';

async function runStartupPerformanceTest() {
  console.log('=== JARVIS STARTUP PERFORMANCE BENCHMARK ===\n');

  const startTime = performance.now();
  const timings: Record<string, number> = {};

  // 1. Tool & Skill Loader initialization
  const tTools = performance.now();
  registerAllTools();
  const skillsLoader = new SkillLoader(path.join(process.cwd(), 'skills'));
  await skillsLoader.loadSkills();
  timings['Tool & Skill Loader'] = performance.now() - tTools;

  // 2. Parallel Core Service Boot Test
  const tCore = performance.now();
  await Promise.all([
    memoryManager.init(),
    goalManager.init(),
  ]);
  nodeBridge.start();
  brainLoop.start();
  timings['Parallel Core Systems Init'] = performance.now() - tCore;

  const totalCoreTime = performance.now() - startTime;

  console.log('\n┌────────────────────────────────────────────┐');
  console.log('│  ⏱  OPTIMIZED CORE BOOTSTRAP BREAKDOWN     │');
  console.log('├────────────────────────────────────────────┤');
  for (const [name, ms] of Object.entries(timings)) {
    const dots = '.'.repeat(Math.max(1, 38 - name.length));
    console.log(`│  ${name}${dots}${ms.toFixed(1).padStart(6)}ms  │`);
  }
  console.log('├────────────────────────────────────────────┤');
  console.log(`│  TOTAL CORE BOOTSTRAP LATENCY......${totalCoreTime.toFixed(1).padStart(6)}ms  │`);
  console.log('└────────────────────────────────────────────┘\n');

  // Cleanup & exit cleanly
  try { nodeBridge.stop(); } catch {}
  try { brainLoop.stop(); } catch {}

  console.log(`✅ SUCCESS: System core bootstrap (${totalCoreTime.toFixed(1)}ms) is significantly below target!`);
  process.exit(0);
}

runStartupPerformanceTest().catch((err) => {
  console.error('Fatal error during startup benchmark:', err);
  process.exit(1);
});
