/**
 * tests/toolAuditHelper.ts
 * Dumps all registered tools, their parameters, descriptions, and discoverability metrics.
 */

import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { registerAllTools } from '../core/tools/index.js';
import { SkillLoader } from '../core/skillLoader.js';
import * as path from 'path';

async function main() {
  registerAllTools();
  const loader = new SkillLoader(path.resolve('./skills'));
  await loader.loadSkills();

  const tools = toolRegistryV2.getAll();
  console.log(`TOTAL_REGISTERED_TOOLS: ${tools.length}\n`);

  for (const t of tools) {
    console.log(`=== TOOL: ${t.name} ===`);
    console.log(`Description: ${t.description}`);
    console.log(`RiskLevel: ${t.riskLevel}`);
    console.log(`Fallbacks: ${JSON.stringify(t.fallbacks)}`);
    console.log(`InputSchema: ${JSON.stringify(t.inputSchema, null, 2)}`);
    console.log('');
  }
}

main().catch(console.error);
