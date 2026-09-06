/**
 * skills/coding/skill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Coding skill: reads a source code file and returns its content
 * with metadata (line count, detected language, size) for LLM analysis.
 * The orchestrator's synthesis LLM will then explain it in natural language.
 */

import * as fs from 'fs';
import * as path from 'path';

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript/React',
  '.js': 'JavaScript', '.jsx': 'JavaScript/React',
  '.py': 'Python', '.rb': 'Ruby', '.rs': 'Rust',
  '.go': 'Go', '.java': 'Java', '.cpp': 'C++', '.c': 'C',
  '.cs': 'C#', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin',
  '.sh': 'Bash', '.ps1': 'PowerShell', '.json': 'JSON',
  '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
  '.html': 'HTML', '.css': 'CSS', '.sql': 'SQL', '.md': 'Markdown',
};

const MAX_CHARS = 6000; // guard against huge files flooding context

export async function execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const filePath = String(args['file_path'] ?? '').trim();
  const focus = args['focus'] ? String(args['focus']).trim() : '';

  if (!filePath) return 'Error: file_path is required.';
  if (signal?.aborted) throw new Error('ABORTED');

  // Resolve path
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolved)) {
    return `Error: File not found at "${resolved}".`;
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return `Error: "${resolved}" is not a file.`;
  }

  const ext = path.extname(resolved).toLowerCase();
  const lang = LANGUAGE_MAP[ext] ?? 'Unknown';
  const sizeKb = (stat.size / 1024).toFixed(1);

  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    return `Error: Could not read file — ${String(err)}`;
  }

  const lines = content.split('\n').length;
  const truncated = content.length > MAX_CHARS;
  const displayContent = truncated
    ? content.substring(0, MAX_CHARS) + `\n\n... [truncated — file is ${sizeKb}KB, showing first ${MAX_CHARS} chars] ...`
    : content;

  const header = [
    `📄 File: ${path.basename(resolved)}`,
    `   Language: ${lang}  |  Lines: ${lines}  |  Size: ${sizeKb}KB`,
    focus ? `   Focus: ${focus}` : '',
    '---',
  ].filter(Boolean).join('\n');

  return `${header}\n\`\`\`${ext.slice(1)}\n${displayContent}\n\`\`\``;
}

export default { execute };
