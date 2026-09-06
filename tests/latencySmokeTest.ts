import { orchestrator } from "../core/orchestrator.js";
import { memoryManager } from "../memory/memoryManager.js";

async function testLatency() {
    console.log("Initializing JARVIS core components for latency test...");
    await memoryManager.init();
    
    
    const input = process.argv[2] || "hello";
    console.log(`\n--- STARTING TIMING TEST: "${input}" ---`);
    await orchestrator.process(input, "cli");
    console.log("--- TIMING TEST COMPLETE ---");
    
    process.exit(0);
}

testLatency().catch(err => {
    console.error(err);
    process.exit(1);
});
