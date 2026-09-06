/**
 * core/tools/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers all built-in AgentTools into toolRegistryV2.
 * Import this once at startup (called by orchestrator.ts).
 */

import { toolRegistryV2 } from '../toolRegistryV2.js';
import { webSearchTool } from '../../tools/webSearchTool.js';
import { fileReadTool, fileWriteTool } from '../../tools/fileTool.js';
import { runCommandTool, getSystemInfoTool } from '../../tools/terminalTool.js';
import { saveRelationTool, searchMemoryTool } from './memoryTool.js';

export function registerAllTools(): void {
  toolRegistryV2.registerMany([
    webSearchTool,
    fileReadTool,
    fileWriteTool,
    runCommandTool,
    getSystemInfoTool,
    saveRelationTool,
    searchMemoryTool,
  ]);

  console.log(`[ToolRegistry] All built-in tools registered. Total: ${toolRegistryV2.names().length}`);
  console.log(`[ToolRegistry] Tools: ${toolRegistryV2.names().join(', ')}`);
}
