/**
 * index.ts — JARVIS Secondary Entry Point
 * ─────────────────────────────────────────────────────────────────────────────
 * This is kept for backward compatibility and lightweight standalone testing.
 * The PRIMARY entry point is jarvis.ts (full voice pipeline + self-healing).
 *
 * This entry point boots:
 *   - Orchestrator (PLAN→EXECUTE→OBSERVE→REFLECT→REPAIR loop)
 *   - SkillLoader (auto-registers all skills as AgentTools)
 *   - EventLogger + HealthCheck (monitoring)
 *   - A simple readline CLI
 */

import 'dotenv/config';
import * as readline from 'readline';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { orchestrator } from './core/orchestrator.js';
import { brainLoop } from './core/brainLoop.js';
import { memoryManager } from './memory/memoryManager.js';
import { agentStateMachine } from './core/agentStateMachine.js';
import { eventLogger } from './monitoring/eventLogger.js';
import { healthCheck } from './monitoring/healthCheck.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Global Error Handlers ─────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  eventLogger.error('System', `Uncaught Exception: ${err.message}`);
});

process.on('unhandledRejection', (err) => {
  eventLogger.error('System', `Unhandled Rejection: ${String(err)}`);
});

// ─── Bootstrap ─────────────────────────────────────────────────────────────

async function bootstrap() {
  eventLogger.info('System', '=============================');
  eventLogger.info('System', '🚀 JARVIS Boot Sequence (index mode)');
  eventLogger.info('System', '=============================');

  try {
    // 1. Initialize memory
    eventLogger.info('System', 'Initializing memory...');
    await memoryManager.init();

    // 2. Register health modules
    healthCheck.registerModule('Core');
    healthCheck.registerModule('Brain');
    healthCheck.registerModule('Orchestrator');

    // 3. Start brain loop (orchestrator lifecycle)
    brainLoop.start();

    eventLogger.info('System', '✅ JARVIS Orchestrator is online.');
    eventLogger.info('System', `   State: ${agentStateMachine.currentState}`);
    eventLogger.info('System', '   Type your message below. Type "exit" to quit, "status" for info.');
    eventLogger.info('System', '=============================');

    // 4. Start CLI
    startCLI();

  } catch (error: any) {
    eventLogger.error('System', `Boot sequence failed: ${error.message}`);
    process.exit(1);
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function startCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      await shutdown();
      return;
    }

    if (input.toLowerCase() === 'status') {
      console.log(`[JARVIS] State: ${agentStateMachine.currentState}`);
      console.log('[JARVIS] History:', agentStateMachine.getStats());
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === 'memory') {
      const { agentMemory } = await import('./memory/agentMemory.js');
      console.log('[JARVIS] Memory stats:', JSON.stringify(agentMemory.getStats(), null, 2));
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === 'tools') {
      const { toolRegistryV2 } = await import('./core/toolRegistryV2.js');
      console.log('[JARVIS] Registered tools:', toolRegistryV2.names().join(', '));
      rl.prompt();
      return;
    }

    try {
      await orchestrator.process(input, 'cli');
    } catch (err) {
      console.error('[CLI] Orchestrator error:', err);
    }

    rl.prompt();

  }).on('close', async () => {
    await shutdown();
  });
}

async function shutdown() {
  eventLogger.info('System', 'JARVIS Shutdown Sequence...');
  await memoryManager.flush();
  brainLoop.stop();
  process.exit(0);
}

bootstrap();
