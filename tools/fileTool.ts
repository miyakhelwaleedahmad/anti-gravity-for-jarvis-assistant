/**
 * core/tools/fileTool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * File operation AgentTools — read and write file contents.
 * Wraps existing fileTools.ts with schema validation and path safety checks.
 */

import type { AgentTool } from '../core/toolRegistryV2.js';
import { fileTools } from '../core/fileTools.js';
import path from 'path';
import { approvalGate } from '../security/approvalGate.js';
import { securityAuditLogger } from '../security/securityAuditLogger.js';
import { isEnvFile, resolveWorkspacePath } from '../security/workspacePathPolicy.js';

// ─── Path Safety ─────────────────────────────────────────────────────────────

const PROTECTED_PATHS = [
  '.gitconfig', '.bashrc', '.zshrc', '.bash_profile', '.zprofile',
  'credentials.json', 'id_rsa', 'id_ed25519',
];

function isProtectedPath(filePath: string): boolean {
  const basename = path.basename(filePath);
  return PROTECTED_PATHS.some(p => basename.includes(p));
}

// ─── Read File ────────────────────────────────────────────────────────────────

export const fileReadTool: AgentTool = {
  name: 'read_file',
  description:
    'Use to read full text content from a file on the local filesystem. DO NOT use for writing files, web searching, or executing shell commands. Required parameter: filePath (string path to file). Returns text content of the file.',
  riskLevel: 'low',
  inputSchema: {
    filePath: {
      type: 'string',
      description: 'Absolute or relative path to the file to read.',
      required: true,
    },
  },
  fallbacks: [],

  async execute(args, signal) {
    const filePath = String(args['filePath'] ?? '');

    if (!filePath.trim()) {
      return 'Error: read_file requires a filePath argument.';
    }

    const pathCheck = resolveWorkspacePath(filePath, 'read', 'read_file');
    if (!pathCheck.allowed || !pathCheck.resolvedPath) {
      return `Error: read_file denied - ${pathCheck.reason}`;
    }

    if (signal?.aborted) throw new Error('ABORTED');

    try {
      securityAuditLogger.allowed(pathCheck.resolvedPath, 'LOW_RISK', 'read_file');
      const content = await fileTools.read(pathCheck.resolvedPath);
      return content;
    } catch (err) {
      throw new Error(`read_file failed for "${filePath}": ${String(err)}`);
    }
  },
};

// ─── Write File ───────────────────────────────────────────────────────────────

export const fileWriteTool: AgentTool = {
  name: 'write_file',
  description:
    'Use to write text content to a local file, creating parent directories if missing. DO NOT use for web searching, launching applications, or reading files. Required parameters: filePath (string target path) and content (string text to write). Returns status confirmation string.',
  riskLevel: 'medium',
  inputSchema: {
    filePath: {
      type: 'string',
      description: 'Absolute or relative path to the file to create or overwrite.',
      required: true,
    },
    content: {
      type: 'string',
      description: 'The full text content to write to the file.',
      required: true,
    },
  },
  fallbacks: [],

  async execute(args, signal) {
    const filePath = String(args['filePath'] ?? '');
    const content = String(args['content'] ?? '');

    if (!filePath.trim()) {
      return 'Error: write_file requires a filePath argument.';
    }

    // Protected path guard
    if (isProtectedPath(filePath)) {
      return `Error: write_file denied — "${path.basename(filePath)}" is a protected file.`;
    }

    const pathCheck = resolveWorkspacePath(filePath, 'write', 'write_file');
    if (!pathCheck.allowed || !pathCheck.resolvedPath) {
      return `Error: write_file denied - ${pathCheck.reason}`;
    }

    if (isEnvFile(pathCheck.resolvedPath)) {
      const approved = await approvalGate.requestApproval(
        'Write Environment File',
        pathCheck.resolvedPath,
        'HIGH_RISK',
        'Writing .env files can expose or overwrite secrets.',
      );
      if (!approved) {
        securityAuditLogger.denied(pathCheck.resolvedPath, 'HIGH_RISK', 'Environment file write was not approved.', 'write_file');
        return 'Error: write_file denied - .env writes require explicit approval.';
      }
    }

    if (signal?.aborted) throw new Error('ABORTED');

    try {
      securityAuditLogger.allowed(pathCheck.resolvedPath, 'MEDIUM_RISK', 'write_file');
      const result = await fileTools.write(pathCheck.resolvedPath, content);
      return result;
    } catch (err) {
      throw new Error(`write_file failed for "${filePath}": ${String(err)}`);
    }
  },
};
