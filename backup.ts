/**
 * backup.ts — copy JARVIS's data somewhere Git cannot touch.
 *
 *   pnpm backup                 → <folder above the project>/jarvis-backups/<timestamp>/
 *   pnpm backup -- D:\my-backups → D:\my-backups\<timestamp>\
 *
 * Copies memory/ and data/ (live goals, memory, vector store) but not data/logs
 * or data/backups. Plain Node, so it behaves the same in CMD, PowerShell and
 * any other shell; a PowerShell-only command (New-Item) failed in CMD.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from './core/workspaceRoot.js';

const SKIP = new Set([path.join('data', 'logs'), path.join('data', 'backups')]);

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function main(): number {
  const root = getWorkspaceRoot();
  const base = process.argv[2] ? path.resolve(process.argv[2]) : path.join(path.dirname(root), 'jarvis-backups');
  const dest = path.join(base, stamp());

  if (dest === root || dest.startsWith(root + path.sep)) {
    console.error(`[backup] Refusing to back up into the project itself (${dest}).`);
    return 1;
  }

  let files = 0;
  let bytes = 0;
  for (const dir of ['memory', 'data']) {
    const src = path.join(root, dir);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dest, dir), {
      recursive: true,
      filter: (from) => {
        const rel = path.relative(root, from);
        if (SKIP.has(rel)) return false;
        const st = fs.statSync(from);
        if (st.isFile()) { files++; bytes += st.size; }
        return true;
      },
    });
  }

  if (files === 0) {
    console.error(`[backup] Nothing to back up: no memory/ or data/ under ${root}.`);
    return 1;
  }
  console.log(`[backup] Copied ${files} file(s), ${(bytes / 1024).toFixed(1)} KB, to:\n  ${dest}`);
  return 0;
}

process.exit(main());
