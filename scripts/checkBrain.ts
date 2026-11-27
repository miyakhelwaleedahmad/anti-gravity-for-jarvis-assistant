/**
 * scripts/checkBrain.ts — pnpm check:brain [--keep]
 * Checks the second brain on the vault in .env (JARVIS_OBSIDIAN_VAULT) by
 * writing, reading, finding and removing one test note (memory/brainCheck.ts).
 */

import 'dotenv/config';
import { checkBrainConnection } from '../memory/brainCheck.js';

const r = checkBrainConnection({ keep: process.argv.includes('--keep') });
for (const s of r.steps) console.log(`${s.ok ? 'OK  ' : 'FAIL'} ${s.step.padEnd(13)} ${s.detail}`);
console.log(r.ok ? '\nSecond brain: CONNECTED (write, read and search work).' : '\nSecond brain: NOT WORKING (see the FAIL line above).');
process.exit(r.ok ? 0 : 1);
