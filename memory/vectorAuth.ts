/**
 * memory/vectorAuth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The shared token for the local vector memory service (SEC-18).
 *
 * memory/vectorMemory.py listens on 127.0.0.1:8000. Before this, any program on
 * the PC, and any web page the browser opened (a "simple" cross-site POST needs
 * no preflight), could read, add to or clear JARVIS's semantic memory.
 *
 * The service now refuses every request except /liveness without this token
 * in the `X-JARVIS-Token` header. The token is:
 *   - JARVIS_VECTOR_TOKEN when set, otherwise
 *   - a random token kept in data/security/vector_token (owner-only file,
 *     git-ignored). It is kept, not made per run, because JARVIS adopts a
 *     service already running from an earlier start.
 * The Python side reads the same variable and file.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dataRoot } from '../core/workspaceRoot.js';

export const VECTOR_TOKEN_HEADER = 'X-JARVIS-Token';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where the kept token lives. Read on every call, so tests can move it. */
export function vectorTokenFile(): string {
  return path.join(dataRoot(path.resolve(__dirname, '..')), 'data', 'security', 'vector_token');
}

let cached: { file: string; token: string } | null = null;

/** The token, creating and keeping one the first time. Never logged. */
export function getVectorToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['JARVIS_VECTOR_TOKEN']?.trim();
  if (fromEnv) return fromEnv;
  const file = vectorTokenFile();
  if (cached?.file === file) return cached.token;
  let token = '';
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch { /* not made yet */ }
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      // 'wx': if another JARVIS process made it a moment ago, use theirs.
      fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      token = fs.readFileSync(file, 'utf8').trim();
    }
  }
  cached = { file, token };
  return token;
}

/** Headers for a request to the vector service. */
export function vectorHeaders(json = false): Record<string, string> {
  return {
    [VECTOR_TOKEN_HEADER]: getVectorToken(),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}
