/**
 * core/skillTrust.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Which skill folders JARVIS loads (SEC-16).
 *
 * The skill loader registered every folder under skills/ that had a
 * description.json: whatever was placed there (by a download, an agent with
 * file access, another program) became a tool the model could call, its code
 * ran on the first call, and its description.json could declare its own risk
 * (`meta`, which overrides the catalogue) as 0.
 *
 * skills/trusted-skills.json lists the folders the owner trusts, with a
 * SHA-256 of each description.json. A folder not listed, or whose description
 * changed, is not loaded; the log says how to trust it. Line endings are
 * normalised first, so a Windows checkout (CRLF) has the same fingerprint.
 *
 * To trust a new or changed skill: npx tsx scripts/trustSkills.ts <folder>
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const TRUST_FILE = 'trusted-skills.json';

export interface TrustList {
  version: 1;
  /** Folder name → SHA-256 (hex) of its description.json. */
  skills: Record<string, string>;
}

/** SHA-256 of a skill's description.json, line endings and BOM normalised. */
export function skillFingerprint(dirPath: string): string {
  const raw = fs.readFileSync(path.join(dirPath, 'description.json'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** The trust list in `skillsDir`, or null when there is none or it cannot be read. */
export function readTrustList(skillsDir: string): TrustList | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(skillsDir, TRUST_FILE), 'utf8')) as TrustList;
    return parsed && parsed.version === 1 && parsed.skills && typeof parsed.skills === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Why the skill in `dirPath` is not loaded, or null when it is trusted. */
export function untrustedReason(skillsDir: string, dirPath: string, list: TrustList | null): string | null {
  const name = path.basename(dirPath);
  const how = `To trust it: npx tsx scripts/trustSkills.ts ${name}`;
  if (!list) return `skills/${TRUST_FILE} is missing or unreadable, so no skill is trusted. To trust all current skills: npx tsx scripts/trustSkills.ts --all`;
  try {
    if (fs.lstatSync(dirPath).isSymbolicLink()) return 'it is a link to a folder elsewhere.';
    const real = fs.realpathSync(dirPath);
    if (path.dirname(real) !== fs.realpathSync(skillsDir)) return 'it is not directly inside the skills folder.';
  } catch {
    return 'its folder cannot be read.';
  }
  const expected = list.skills[name];
  if (!expected) return `it is not in skills/${TRUST_FILE}. ${how}`;
  let actual: string;
  try { actual = skillFingerprint(dirPath); } catch { return 'its description.json cannot be read.'; }
  if (actual !== expected) return `its description.json changed since it was trusted. ${how}`;
  return null;
}

/** Writes the trust list with the current fingerprints of `names` (kept entries stay). */
export function trustSkills(skillsDir: string, names: string[]): TrustList {
  const list = readTrustList(skillsDir) ?? { version: 1 as const, skills: {} };
  for (const name of names) {
    list.skills[name] = skillFingerprint(path.join(skillsDir, name));
  }
  const sorted: TrustList = { version: 1, skills: Object.fromEntries(Object.entries(list.skills).sort(([a], [b]) => a.localeCompare(b))) };
  fs.writeFileSync(path.join(skillsDir, TRUST_FILE), JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  return sorted;
}
