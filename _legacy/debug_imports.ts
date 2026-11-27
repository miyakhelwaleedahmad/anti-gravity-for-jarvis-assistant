import 'dotenv/config';

async function testImports() {
    console.log("Starting dynamic imports...");
    
    console.log("Importing memoryManager...");
    await import('./memory/memoryManager.js');
    
    console.log("Importing unifiedContextBuilder...");
    await import('./memory/unifiedContextBuilder.js');
    
    console.log("Importing toolRegistryV2...");
    await import('./core/toolRegistryV2.js');
    
    console.log("Importing registerAllTools...");
    await import('./core/tools/index.js');
    
    console.log("Importing selfHealingManager...");
    await import('./self_healing/selfHealingManager.js');
    
    console.log("Importing pipelineRegistry...");
    await import('./self_healing/pipelineRegistry.js');

    console.log("All imports finished!");
    process.exit(0);
}

testImports();
