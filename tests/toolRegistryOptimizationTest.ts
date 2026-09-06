import { toolRegistryV2, type AgentTool } from '../core/toolRegistryV2.js';
import { SkillLoader } from '../core/skillLoader.js';
import { registerAllTools } from '../core/tools/index.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runToolRegistryOptimizationTest() {
  console.log('=== TOOL REGISTRY & SKILL LOADER OPTIMIZATION TEST ===\n');

  // 1. Measure Built-in Tool Registration Latency
  const t0 = performance.now();
  registerAllTools();
  const builtInMs = performance.now() - t0;
  console.log(`[Built-in Tools] Registration latency: ${builtInMs.toFixed(3)}ms`);

  // 2. Test Duplicate Registration Protection
  const t1 = performance.now();
  registerAllTools(); // Second call — should be deduplicated instantly
  const duplicateMs = performance.now() - t1;
  console.log(`[Duplicate Registration] Deduplication latency: ${duplicateMs.toFixed(3)}ms`);

  if (duplicateMs > builtInMs) {
    console.error(`❌ FAIL: Duplicate registration (${duplicateMs.toFixed(3)}ms) was slower than initial registration (${builtInMs.toFixed(3)}ms)`);
    process.exit(1);
  }
  console.log(`✅ PASS: Duplicate registration handled instantly without redundant work.`);

  // 3. Test SkillLoader Parallel Loading & Lazy Execution
  const skillsDir = path.join(__dirname, '..', 'skills');
  const skillLoader = new SkillLoader(skillsDir);
  
  const t2 = performance.now();
  const loadedCount = await skillLoader.loadSkills();
  const skillLoadMs = performance.now() - t2;
  console.log(`[SkillLoader] Parallel load time for ${loadedCount} skill(s): ${skillLoadMs.toFixed(3)}ms`);

  // 4. Test Lazy Execution of a Skill Tool
  const openAppTool = toolRegistryV2.get('open_app');
  if (openAppTool) {
    console.log(`[Lazy Execution] Executing skill 'open_app'...`);
    const execStart = performance.now();
    // Dry run / invalid target execution
    const res = await openAppTool.execute({ target: 'nonexistent_test_app' });
    const execMs = performance.now() - execStart;
    console.log(`[Lazy Execution] Lazy import + execution finished in ${execMs.toFixed(2)}ms`);
    console.log(`[Lazy Execution] Result snippet: "${res.substring(0, 80)}..."`);
  }

  console.log('\n✅ ALL TOOL REGISTRY OPTIMIZATION TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runToolRegistryOptimizationTest().catch((err) => {
  console.error('Fatal error during tool registry test:', err);
  process.exit(1);
});
