/**
 * core/tools/capabilityTool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * list_capabilities: what JARVIS can do, read from the tool registry's
 * metadata, so the model can ask instead of guessing.
 */

import { toolRegistryV2, TOOL_CATEGORIES, type AgentTool } from '../toolRegistryV2.js';

export const listCapabilitiesTool: AgentTool = {
  name: 'list_capabilities',
  description:
    'Use to answer what JARVIS can do or which tools it has. Optional parameter: category. ' +
    'Returns the tools grouped by category, each with its risk level (0 observe … 4 critical), ' +
    'whether approval is needed, whether the effect can be undone, and whether it reaches outside the PC.',
  riskLevel: 'low',
  inputSchema: {
    category: {
      type: 'string',
      description: 'Only tools of this category',
      required: false,
      enum: [...TOOL_CATEGORIES],
    },
  },
  fallbacks: [],

  async execute(args) {
    const category = typeof args['category'] === 'string' ? args['category'] : undefined;
    return JSON.stringify(toolRegistryV2.describeCapabilities(category ? { category } : {}), null, 2);
  },
};
