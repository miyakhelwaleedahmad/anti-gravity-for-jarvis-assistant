/**
 * config/configValidator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 9 — Configuration Validation
 *
 * Validates all required environment variables and configuration values at
 * startup BEFORE any subsystem is initialized. Fails fast with a clear,
 * actionable error report rather than crashing deep in the pipeline.
 *
 * Validation categories:
 *   CRITICAL  — missing = JARVIS cannot start (LLM API key, bridge port)
 *   WARNING   — missing = degraded functionality (Redis, Vector memory)
 *   INFO      — missing = optional feature disabled (custom voice, model override)
 *
 * Usage:
 *   import { configValidator } from './config/configValidator.js';
 *   const report = configValidator.validate();
 *   if (!report.canStart) process.exit(1);
 */

import * as fs from 'fs';
import * as path from 'path';
import { isPlaceholderKey, resolveProviderSettings } from './llmconfig.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ValidationLevel = 'CRITICAL' | 'WARNING' | 'INFO';

export interface ValidationIssue {
  level: ValidationLevel;
  field: string;
  message: string;
  fix: string;
}

export interface ValidationReport {
  canStart: boolean;           // false if any CRITICAL issues found
  issues: ValidationIssue[];
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  summary: string;
}

// ─── Validator ────────────────────────────────────────────────────────────────

export class ConfigValidator {

  validate(): ValidationReport {
    const issues: ValidationIssue[] = [];

    // ── CRITICAL: LLM API key ────────────────────────────────────────────────
    // Checked for the provider JARVIS will actually use. XAI_API_KEY used to
    // satisfy this check although nothing in JARVIS calls xAI, so a .env with
    // only the xAI placeholder passed validation and then could not reason.
    const llm = resolveProviderSettings(process.env);
    const isGemini = llm.provider === 'gemini';
    const keyVar = isGemini ? 'GEMINI_API_KEY' : 'GROQ_API_KEY';
    if (!llm.apiKey) {
      const xaiNote = isPlaceholderKey(process.env.XAI_API_KEY) ? '' : ' XAI_API_KEY is set, but JARVIS does not use xAI.';
      issues.push({
        level: 'CRITICAL',
        field: keyVar,
        message: `No ${isGemini ? 'Gemini' : 'Groq'} API key found. JARVIS cannot reason without an LLM provider.${xaiNote}`,
        fix: isGemini
          ? 'Add GEMINI_API_KEY=<your key from Google AI Studio> to your .env file.'
          : 'Add GEMINI_API_KEY=<key from Google AI Studio> or GROQ_API_KEY=gsk_... (https://console.groq.com) to your .env file.',
      });
    } else if (llm.apiKey.length < 20) {
      issues.push({
        level: 'CRITICAL',
        field: keyVar,
        message: `${keyVar} looks malformed (length: ${llm.apiKey.length}).`,
        fix: isGemini ? 'Copy the whole key from Google AI Studio.' : 'Verify the key starts with "gsk_" and is at least 50 characters.',
      });
    }

    for (const note of llm.notes) {
      issues.push({ level: 'INFO', field: 'JARVIS_LLM_PROVIDER', message: note, fix: 'No action needed unless this is not what you intended.' });
    }

    // A model left over from the other provider fails on the first request.
    for (const [field, value] of [['JARVIS_BRAIN_MODEL', llm.model], ['JARVIS_FAST_MODEL', llm.fastModel]] as const) {
      const looksGemini = /^(models\/)?gemini/i.test(value);
      if (isGemini !== looksGemini) {
        issues.push({
          level: 'WARNING',
          field,
          message: `${field}="${value}" does not look like a ${isGemini ? 'Gemini' : 'Groq'} model, but the active provider is ${llm.provider}.`,
          fix: isGemini ? `Set ${field}=gemini-3.5-flash (or another model your key lists).` : `Set ${field} to a Groq model, or set JARVIS_LLM_PROVIDER=gemini.`,
        });
      }
    }

    // ── CRITICAL: Bridge port ────────────────────────────────────────────────
    const bridgePort = parseInt(process.env.BRIDGE_PORT ?? '9000', 10);
    if (isNaN(bridgePort) || bridgePort < 1024 || bridgePort > 65535) {
      issues.push({
        level: 'CRITICAL',
        field: 'BRIDGE_PORT',
        message: `BRIDGE_PORT=${process.env.BRIDGE_PORT} is not a valid port number.`,
        fix: 'Set BRIDGE_PORT to a value between 1024–65535 (default: 9000).',
      });
    }

    // ── CRITICAL: Memory DB path writable ───────────────────────────────────
    // (This used require(), which does not exist in an ES module: the check
    // threw, the catch swallowed it, and it never ran.)
    try {
      const dbDir = path.dirname('./memory/jarvis_memory.json');
      // Just check the directory exists or is creatable — non-blocking check
      if (!fs.existsSync(dbDir)) {
        issues.push({
          level: 'WARNING',
          field: 'MEMORY_DB_PATH',
          message: `Memory directory '${dbDir}' does not exist yet.`,
          fix: 'It will be created automatically on first write. No action required.',
        });
      }
    } catch { /* non-fatal */ }

    // ── WARNING: Redis ───────────────────────────────────────────────────────
    const redisHost = process.env.REDIS_HOST;
    if (!redisHost) {
      issues.push({
        level: 'WARNING',
        field: 'REDIS_HOST',
        message: 'REDIS_HOST not set. JARVIS will use in-process LRU cache only.',
        fix: 'Set REDIS_HOST=127.0.0.1 and REDIS_PORT=6379 in .env to enable Redis cache. Performance will be reduced without it.',
      });
    }

    // ── INFO: LLM model defaults ─────────────────────────────────────────────
    if (!process.env.JARVIS_BRAIN_MODEL?.trim()) {
      issues.push({
        level: 'INFO',
        field: 'JARVIS_BRAIN_MODEL',
        message: `JARVIS_BRAIN_MODEL not set. Using the ${llm.provider} default: ${llm.model}.`,
        fix: 'Set JARVIS_BRAIN_MODEL in .env to choose a different model.',
      });
    }
    if (!process.env.JARVIS_FAST_MODEL?.trim()) {
      issues.push({
        level: 'INFO',
        field: 'JARVIS_FAST_MODEL',
        message: `JARVIS_FAST_MODEL not set. Short replies and the rate-limit fallback will use ${llm.fastModel}.`,
        fix: 'Set JARVIS_FAST_MODEL in .env to choose a different fast model.',
      });
    }

    // ── WARNING: TTS voice ───────────────────────────────────────────────────
    const ttsVoice = process.env.TTS_VOICE;
    if (!ttsVoice) {
      issues.push({
        level: 'INFO',
        field: 'TTS_VOICE',
        message: 'TTS_VOICE not set. Using default: en-US-GuyNeural.',
        fix: 'Set TTS_VOICE in .env to customise the voice (e.g., en-GB-RyanNeural).',
      });
    }

    // ── WARNING: LLM timeout ─────────────────────────────────────────────────
    const llmTimeout = process.env.JARVIS_LLM_TIMEOUT_MS;
    if (llmTimeout) {
      const t = parseInt(llmTimeout, 10);
      if (isNaN(t) || t < 1000) {
        issues.push({
          level: 'WARNING',
          field: 'JARVIS_LLM_TIMEOUT_MS',
          message: `JARVIS_LLM_TIMEOUT_MS=${llmTimeout} is dangerously low (< 1000ms).`,
          fix: 'Set JARVIS_LLM_TIMEOUT_MS to at least 5000 (recommended: 10000).',
        });
      }
    }

    // ── CRITICAL: Node version ───────────────────────────────────────────────
    const nodeVersion = process.versions.node;
    const [major] = nodeVersion.split('.').map(Number);
    if (major < 18) {
      issues.push({
        level: 'CRITICAL',
        field: 'NODE_VERSION',
        message: `Node.js ${nodeVersion} detected. JARVIS requires Node.js 18+.`,
        fix: 'Install Node.js 18 or later from https://nodejs.org',
      });
    }

    // ── Build report ─────────────────────────────────────────────────────────
    const criticalCount = issues.filter(i => i.level === 'CRITICAL').length;
    const warningCount  = issues.filter(i => i.level === 'WARNING').length;
    const infoCount     = issues.filter(i => i.level === 'INFO').length;

    const canStart = criticalCount === 0;

    const summary = canStart
      ? `✅ Configuration valid. ${warningCount} warning(s), ${infoCount} info note(s).`
      : `❌ Configuration INVALID. ${criticalCount} critical issue(s) must be resolved before starting.`;

    return { canStart, issues, criticalCount, warningCount, infoCount, summary };
  }

  /**
   * Print a human-readable validation report to the console.
   * Returns false if JARVIS should not start.
   */
  printReport(report: ValidationReport): boolean {
    const RESET  = '\x1b[0m';
    const RED    = '\x1b[31m';
    const YELLOW = '\x1b[33m';
    const CYAN   = '\x1b[36m';
    const GREEN  = '\x1b[32m';
    const BOLD   = '\x1b[1m';

    console.log(`\n${BOLD}${CYAN}┌─────────────────────────────────────────┐${RESET}`);
    console.log(`${BOLD}${CYAN}│   JARVIS Configuration Validator        │${RESET}`);
    console.log(`${BOLD}${CYAN}└─────────────────────────────────────────┘${RESET}`);

    if (report.issues.length === 0) {
      console.log(`${GREEN}  ✓ All configuration checks passed.${RESET}\n`);
      return true;
    }

    for (const issue of report.issues) {
      const color = issue.level === 'CRITICAL' ? RED : issue.level === 'WARNING' ? YELLOW : CYAN;
      const icon  = issue.level === 'CRITICAL' ? '✗' : issue.level === 'WARNING' ? '⚠' : 'ℹ';
      console.log(`\n${color}${BOLD}  ${icon} [${issue.level}] ${issue.field}${RESET}`);
      console.log(`${color}    ${issue.message}${RESET}`);
      console.log(`    💡 ${issue.fix}`);
    }

    const color = report.canStart ? GREEN : RED;
    console.log(`\n${color}${BOLD}  ${report.summary}${RESET}\n`);

    return report.canStart;
  }

  /**
   * Validate and print. Exits process if critical issues found and exitOnFail=true.
   */
  validateAndPrint(exitOnFail = true): ValidationReport {
    const report = this.validate();
    const ok = this.printReport(report);
    if (!ok && exitOnFail) {
      console.error('[ConfigValidator] JARVIS cannot start due to critical configuration errors.');
      process.exit(1);
    }
    return report;
  }
}

export const configValidator = new ConfigValidator();
