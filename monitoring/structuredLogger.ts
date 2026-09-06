/**
 * monitoring/structuredLogger.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 9 — Structured Logger
 *
 * Replaces ad-hoc console.log calls with structured JSON logging:
 *
 *   Features:
 *   - Log levels: DEBUG < INFO < WARN < ERROR < CRITICAL
 *   - Correlation IDs: attach a request/session ID to trace log groups
 *   - Async JSONL file output with log rotation (max file size / max files)
 *   - Console mirror: structured logs still print to stdout in dev mode
 *   - Module namespacing: each subsystem uses a named child logger
 *   - Error serialization: Error objects are properly serialized
 *
 * Usage:
 *   import { logger } from './monitoring/structuredLogger.js';
 *   const log = logger.child('Orchestrator');
 *   log.info('Planning started', { goalId: 'g1', query: 'open spotify' });
 *   log.error('Tool failed', { tool: 'open_app', error });
 */

import * as fs   from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants ────────────────────────────────────────────────────────────────

const LOG_DIR          = path.join(__dirname, '..', 'data', 'logs');
const LOG_FILE_BASE    = 'jarvis';
const MAX_FILE_SIZE_MB = 10;
const MAX_FILES        = 5;
const DEV_MODE         = process.env.NODE_ENV !== 'production';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  correlationId?: string;
  data?: Record<string, unknown>;
  error?: { name: string; message: string; stack?: string };
  pid: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, CRITICAL: 4,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  DEBUG:    '\x1b[2m',        // dim
  INFO:     '\x1b[36m',       // cyan
  WARN:     '\x1b[33m',       // yellow
  ERROR:    '\x1b[31m',       // red
  CRITICAL: '\x1b[35m\x1b[1m', // magenta bold
};
const RESET = '\x1b[0m';

// ─── StructuredLogger ─────────────────────────────────────────────────────────

export class StructuredLogger {
  private static instance: StructuredLogger;
  private minLevel: LogLevel = 'INFO';
  private correlationId: string | undefined;
  private module: string;
  private writeStream: fs.WriteStream | null = null;
  private currentFilePath = '';
  private currentFileSize = 0;
  private fileIndex = 0;

  private constructor(module = 'JARVIS', minLevel: LogLevel = 'INFO') {
    this.module   = module;
    this.minLevel = minLevel;
    if (module === 'JARVIS') {
      // Root logger: own the file stream
      this._ensureLogDir();
      this._openNewLogFile();
    }
  }

  static getInstance(): StructuredLogger {
    if (!StructuredLogger.instance) {
      StructuredLogger.instance = new StructuredLogger('JARVIS', (process.env.LOG_LEVEL as LogLevel) ?? 'INFO');
    }
    return StructuredLogger.instance;
  }

  // ── Child logger ──────────────────────────────────────────────────────────

  child(module: string, correlationId?: string): ChildLogger {
    return new ChildLogger(module, correlationId, this);
  }

  // ── Log methods ───────────────────────────────────────────────────────────

  debug(message: string, data?: Record<string, unknown>, correlationId?: string): void {
    this._log('DEBUG', this.module, message, data, correlationId ?? this.correlationId);
  }
  info(message: string, data?: Record<string, unknown>, correlationId?: string): void {
    this._log('INFO', this.module, message, data, correlationId ?? this.correlationId);
  }
  warn(message: string, data?: Record<string, unknown>, correlationId?: string): void {
    this._log('WARN', this.module, message, data, correlationId ?? this.correlationId);
  }
  error(message: string, errOrData?: Error | Record<string, unknown>, correlationId?: string): void {
    const { data, error } = this._extractError(errOrData);
    this._log('ERROR', this.module, message, data, correlationId ?? this.correlationId, error);
  }
  critical(message: string, errOrData?: Error | Record<string, unknown>, correlationId?: string): void {
    const { data, error } = this._extractError(errOrData);
    this._log('CRITICAL', this.module, message, data, correlationId ?? this.correlationId, error);
  }

  // ── Core write ────────────────────────────────────────────────────────────

  _log(
    level: LogLevel,
    module: string,
    message: string,
    data?: Record<string, unknown>,
    correlationId?: string,
    error?: LogEntry['error']
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      pid: process.pid,
      ...(correlationId ? { correlationId } : {}),
      ...(data          ? { data }          : {}),
      ...(error         ? { error }         : {}),
    };

    // Console mirror
    if (DEV_MODE || level === 'ERROR' || level === 'CRITICAL') {
      const color = LEVEL_COLOR[level];
      const ts    = entry.timestamp.slice(11, 23);
      const cid   = correlationId ? ` [${correlationId.slice(0, 8)}]` : '';
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      const errStr  = error ? ` ← ${error.name}: ${error.message}` : '';
      console.log(`${color}[${level}]${RESET} ${ts} [${module}]${cid} ${message}${dataStr}${errStr}`);
    }

    // File write (non-blocking)
    this._writeToFile(entry);
  }

  setLevel(level: LogLevel): void { this.minLevel = level; }
  setCorrelationId(id: string | undefined): void { this.correlationId = id; }

  // ── File management ───────────────────────────────────────────────────────

  private _ensureLogDir(): void {
    try {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch { /* non-fatal */ }
  }

  private _openNewLogFile(): void {
    const fileName = `${LOG_FILE_BASE}.${Date.now()}.${this.fileIndex}.jsonl`;
    this.currentFilePath = path.join(LOG_DIR, fileName);
    this.currentFileSize = 0;
    try {
      this.writeStream?.end();
      this.writeStream = fs.createWriteStream(this.currentFilePath, { flags: 'a', encoding: 'utf8' });
      this.writeStream.on('error', () => { this.writeStream = null; });
      this._rotateOldFiles();
    } catch { this.writeStream = null; }
  }

  private _rotateOldFiles(): void {
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith(LOG_FILE_BASE) && f.endsWith('.jsonl'))
        .map(f => ({ name: f, time: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
        .sort((a, b) => a.time - b.time);

      while (files.length > MAX_FILES) {
        const oldest = files.shift()!;
        fs.unlinkSync(path.join(LOG_DIR, oldest.name));
      }
    } catch { /* non-fatal */ }
  }

  private _writeToFile(entry: LogEntry): void {
    if (!this.writeStream) return;
    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');

    // Rotate if over size limit
    if (this.currentFileSize + bytes > MAX_FILE_SIZE_MB * 1024 * 1024) {
      this.fileIndex++;
      this._openNewLogFile();
    }

    this.currentFileSize += bytes;
    this.writeStream.write(line, () => { /* non-fatal on error */ });
  }

  private _extractError(errOrData?: Error | Record<string, unknown>): {
    data?: Record<string, unknown>;
    error?: LogEntry['error'];
  } {
    if (!errOrData) return {};
    if (errOrData instanceof Error) {
      return { error: { name: errOrData.name, message: errOrData.message, stack: errOrData.stack } };
    }
    return { data: errOrData as Record<string, unknown> };
  }
}

// ─── Child logger ─────────────────────────────────────────────────────────────

export class ChildLogger {
  constructor(
    private readonly module: string,
    private correlationId: string | undefined,
    private readonly root: StructuredLogger
  ) {}

  withCorrelation(id: string): ChildLogger {
    return new ChildLogger(this.module, id, this.root);
  }

  debug(msg: string, data?: Record<string, unknown>): void    { this.root._log('DEBUG',    this.module, msg, data, this.correlationId); }
  info(msg: string, data?: Record<string, unknown>): void     { this.root._log('INFO',     this.module, msg, data, this.correlationId); }
  warn(msg: string, data?: Record<string, unknown>): void     { this.root._log('WARN',     this.module, msg, data, this.correlationId); }
  error(msg: string, err?: Error | Record<string, unknown>): void {
    const { data, error } = this._ex(err);
    this.root._log('ERROR',    this.module, msg, data, this.correlationId, error);
  }
  critical(msg: string, err?: Error | Record<string, unknown>): void {
    const { data, error } = this._ex(err);
    this.root._log('CRITICAL', this.module, msg, data, this.correlationId, error);
  }

  private _ex(e?: Error | Record<string, unknown>) {
    if (!e) return {};
    if (e instanceof Error) return { error: { name: e.name, message: e.message, stack: e.stack } };
    return { data: e as Record<string, unknown> };
  }
}

export const logger = StructuredLogger.getInstance();
