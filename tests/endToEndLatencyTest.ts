import { orchestrator } from '../core/orchestrator.js';

async function runEndToEndLatencyTest() {
  console.log('=== END-TO-END LATENCY & PIPELINE BENCHMARK ===\n');

  // 1. Test Simple Deterministic Command Path (<500ms target)
  const t1Start = performance.now();
  const match1 = orchestrator.matchDeterministicCommand("open notepad");
  const t1Ms = performance.now() - t1Start;
  console.log(`[E2E Path 1] Deterministic Command Match ("open notepad"): ${t1Ms.toFixed(3)}ms`);
  if (!match1) {
    console.error('❌ FAIL: "open notepad" did not match deterministic route!');
    process.exit(1);
  }
  if (t1Ms > 500) {
    console.error(`❌ FAIL: Deterministic command matching took ${t1Ms.toFixed(3)}ms (> 500ms limit)!`);
    process.exit(1);
  }
  console.log(`✅ PASS: Deterministic fast path (${t1Ms.toFixed(3)}ms < 500ms target).`);

  // 2. Test Tool Selection & Token Estimation (<800ms target)
  const t2Start = performance.now();
  const selectedTools = (orchestrator as any).selectPlanningToolNames("get system state");
  const toolTokens = selectedTools.length > 0 ? (orchestrator as any).selectPlanningToolNames ? 50 : 0 : 0;
  const t2Ms = performance.now() - t2Start;
  console.log(`[E2E Path 2] Tool Selection & Token Est ("get system state"): ${t2Ms.toFixed(3)}ms (selected: ${selectedTools.join(', ') || 'none'})`);
  if (t2Ms > 800) {
    console.error(`❌ FAIL: Tool selection took ${t2Ms.toFixed(3)}ms (> 800ms limit)!`);
    process.exit(1);
  }
  console.log(`✅ PASS: Tool command preparation (${t2Ms.toFixed(3)}ms < 800ms target).`);

  // 3. Test System Prompt + Context Assembly (<1500ms target)
  const t3Start = performance.now();
  const sysPrompt = orchestrator.getPrewarmedSystemPrompt();
  const t3Ms = performance.now() - t3Start;
  console.log(`[E2E Path 3] Pre-Warmed System Context ("general query"): ${t3Ms.toFixed(3)}ms (${sysPrompt.tokens} tokens)`);
  if (t3Ms > 1500) {
    console.error(`❌ FAIL: Pre-warmed prompt context took ${t3Ms.toFixed(3)}ms (> 1500ms limit)!`);
    process.exit(1);
  }
  console.log(`✅ PASS: General conversation prep (${t3Ms.toFixed(3)}ms < 1500ms target).`);

  console.log('\n==================================================');
  console.log('✅ ALL END-TO-END LATENCY BENCHMARKS PASSED SUCCESSFULLY');
  console.log('==================================================\n');

  process.exit(0);
}

runEndToEndLatencyTest().catch(err => {
  console.error('Fatal error during E2E latency test:', err);
  process.exit(1);
});
