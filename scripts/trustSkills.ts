/**
 * scripts/trustSkills.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Marks skill folders as trusted (SEC-16): records each one's description.json
 * fingerprint in skills/trusted-skills.json. JARVIS loads only those.
 *
 *   npx tsx scripts/trustSkills.ts weather        one folder (new or changed)
 *   npx tsx scripts/trustSkills.ts --all          every folder in skills/
 *
 * Read the skill's skill.ts and description.json first: a trusted skill is a
 * tool the model can call.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { trustSkills } from '../core/skillTrust.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(repo, 'skills');
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Name the skill folder(s) to trust, or --all. Example: npx tsx scripts/trustSkills.ts weather');
  process.exit(1);
}
const all = fs.readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'description.json')))
  .map((e) => e.name);
const names = args.includes('--all') ? all : args;
const unknown = names.filter((n) => !all.includes(n));
if (unknown.length) {
  console.log(`Not a skill folder with a description.json: ${unknown.join(', ')}`);
  process.exit(1);
}
const list = trustSkills(skillsDir, names);
for (const n of names) console.log(`trusted: ${n}  ${list.skills[n]!.slice(0, 12)}…`);
console.log(`skills/trusted-skills.json now lists ${Object.keys(list.skills).length} skill(s).`);
