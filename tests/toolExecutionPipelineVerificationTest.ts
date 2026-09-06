/**
 * tests/toolExecutionPipelineVerificationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * End-to-end verification of the 5-stage desktop application launch pipeline:
 *   Stage 1: Planner Output & Tool JSON Parsing (never stop/speak raw JSON)
 *   Stage 2: Function Dispatch (TaskGraph building & dependency resolution)
 *   Stage 3: Tool Invocation (ToolRegistryV2 argument validation & dispatch)
 *   Stage 4: Desktop Automation (target path & URL resolution)
 *   Stage 5: Windows Execution (cmd.exe process launcher verification)
 */

import { orchestrator } from '../core/orchestrator.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { registerAllTools } from '../core/tools/index.js';
import { SkillLoader } from '../core/skillLoader.js';
import { TaskGraphBuilder } from '../core/taskGraphEngine.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

async function runVerification() {
  console.log('\n=== 5-Stage Desktop Execution Pipeline Verification ===\n');

  // Initialize Tool Registry & Skills
  registerAllTools();
  const skillsDir = path.join(__dirname, '..', 'skills');
  const loader = new SkillLoader(skillsDir);
  await loader.loadSkills();

  // ── Stage 1: Tool JSON Extraction & Parsing ─────────────────────────────────
  console.log('--- Stage 1: Tool JSON Parsing & Extraction ---');
  
  const sampleJsonText = `\`\`\`json
{
  "tool": "open_app",
  "args": {
    "target": "whatsapp"
  }
}
\`\`\``;

  const extracted = (orchestrator as any).extractToolCallsFromContent(sampleJsonText);
  assert(extracted.length === 1, 'Extracted 1 tool call from markdown codeblock');
  assert(extracted[0].function.name === 'open_app', 'Extracted tool name is "open_app"');
  
  const parsedArgs = JSON.parse(extracted[0].function.arguments);
  assert(parsedArgs.target === 'whatsapp', 'Parsed arguments target is "whatsapp"');

  const rawJsonString = `{"name": "open_app", "arguments": {"target": "vscode"}}`;
  const extractedRaw = (orchestrator as any).extractToolCallsFromContent(rawJsonString);
  assert(extractedRaw.length === 1, 'Extracted 1 tool call from raw JSON string');
  assert(extractedRaw[0].function.name === 'open_app', 'Extracted tool name is "open_app"');

  // ── Stage 2: Function Dispatch & Task Graph Building ─────────────────────────
  console.log('\n--- Stage 2: Function Dispatch (TaskGraph Building) ---');

  const toolCalls = [
    {
      id: 'call_whatsapp',
      function: {
        name: 'open_app',
        arguments: JSON.stringify({ target: 'whatsapp' }),
      },
    },
    {
      id: 'call_calc',
      function: {
        name: 'open_app',
        arguments: JSON.stringify({ target: 'calculator' }),
      },
    },
  ];

  const graph = TaskGraphBuilder.fromToolCalls('Open WhatsApp and Calculator', toolCalls);
  assert(graph.nodes.size === 2, 'TaskGraph built 2 execution nodes');
  
  const nodes = [...graph.nodes.values()];
  assert(nodes[0]?.tool === 'open_app', 'Node 1 tool is "open_app"');
  assert((nodes[0]?.args as any).target === 'whatsapp', 'Node 1 target is "whatsapp"');
  assert(nodes[1]?.tool === 'open_app', 'Node 2 tool is "open_app"');
  assert((nodes[1]?.args as any).target === 'calculator', 'Node 2 target is "calculator"');

  // ── Stage 3: Tool Invocation & Argument Schema Validation ────────────────────
  console.log('\n--- Stage 3: Tool Invocation & Registry Dispatch ---');

  const openAppTool = toolRegistryV2.get('open_app');
  assert(openAppTool !== undefined, 'open_app tool registered in ToolRegistryV2');

  const dryRunExecution = await toolRegistryV2.execute('open_app', { target: 'chrome', dryRun: true });
  assert(dryRunExecution.success === true, 'Tool invocation executed successfully');
  assert(dryRunExecution.output.includes('chrome.exe'), 'Output contains resolved application executable');

  // ── Stage 4: Desktop Automation Target Resolution ─────────────────────────────
  console.log('\n--- Stage 4: Desktop Automation Target Resolution ---');

  const TARGETS_TO_TEST = [
    { target: 'whatsapp',   expected: 'https://web.whatsapp.com' },
    { target: 'youtube',    expected: 'https://www.youtube.com' },
    { target: 'chrome',     expected: 'chrome.exe' },
    { target: 'calculator', expected: 'calc.exe' },
    { target: 'vscode',     expected: 'code' },
  ];

  for (const { target, expected } of TARGETS_TO_TEST) {
    const res = await toolRegistryV2.execute('open_app', { target, dryRun: true });
    const parsed = JSON.parse(res.output);
    assert(parsed.resolvedTarget === expected, `Desktop automation target "${target}" resolved to "${expected}"`);
  }

  // ── Stage 5: Windows Execution Engine Verification ────────────────────────────
  console.log('\n--- Stage 5: Windows Process Launcher Execution ---');

  // Dry-run desktop automation process spawn test
  const calcTest = await toolRegistryV2.execute('open_app', { target: 'calculator', dryRun: true });
  assert(calcTest.success === true, 'Windows launcher validated target calc.exe');
  
  const vscodeTest = await toolRegistryV2.execute('open_app', { target: 'vscode', dryRun: true });
  assert(vscodeTest.success === true, 'Windows launcher validated target code');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('❌ Pipeline verification FAILED.');
    process.exit(1);
  } else {
    console.log('✅ 5-Stage Desktop Application Launch Pipeline Fully Verified!');
    process.exit(0);
  }
}

runVerification().catch((err) => {
  console.error('[PipelineTest] Unexpected error:', err);
  process.exit(1);
});
