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
import { listCapabilitiesTool } from './capabilityTool.js';
import { actionHistoryTool } from './historyTool.js';
import { devStatusTool, gitOverviewTool, systemOverviewTool } from './observationTools.js';
import { browserPageStructureTool, browserReadPageTool, browserStateTool } from './browserTools.js';
import { browserActionTools } from './browserActionTools.js';
import { filesTool } from '../../tools/fsTools.js';
import { gitPushTool, gitTool } from '../../tools/gitTools.js';
import { devTool } from '../../tools/devTools.js';
import { diagnoseAppTool } from './diagnosisTools.js';
import { windowsTools } from './windowsTools.js';

export function registerAllTools(): void {
  toolRegistryV2.registerMany([
    webSearchTool,
    fileReadTool,
    fileWriteTool,
    runCommandTool,
    getSystemInfoTool,
    saveRelationTool,
    searchMemoryTool,
    listCapabilitiesTool,
    actionHistoryTool,
    systemOverviewTool,
    devStatusTool,
    gitOverviewTool,
    browserStateTool,
    browserReadPageTool,
    browserPageStructureTool,
    ...browserActionTools,
    filesTool,
    gitTool,
    gitPushTool,
    devTool,
    diagnoseAppTool,
    ...windowsTools,
  ]);

  console.log(`[ToolRegistry] All built-in tools registered. Total: ${toolRegistryV2.names().length}`);
  console.log(`[ToolRegistry] Tools: ${toolRegistryV2.names().join(', ')}`);
}
