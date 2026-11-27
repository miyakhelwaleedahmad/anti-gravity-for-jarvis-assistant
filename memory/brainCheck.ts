/**
 * memory/brainCheck.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "Is my second brain connected?", answered by doing it: on the vault named
 * in JARVIS_OBSIDIAN_VAULT, write a new test note under JARVIS/, read it
 * back, find it by search, then remove that note (and only that note: it is
 * removed only if it still carries this check's own id).
 *
 * Nothing else in the vault is written, moved or deleted; an existing file is
 * never overwritten (Vault.writeManaged refuses). Run: pnpm check:brain
 */

import * as fs from 'fs';
import * as path from 'path';
import { SecondBrain } from './secondBrain.js';
import { BRAIN_ROOT } from './vault.js';

export interface BrainCheckStep { step: string; ok: boolean; detail: string }

export function checkBrainConnection(opts: { env?: Record<string, string | undefined>; dataDir?: string; keep?: boolean } = {}): { ok: boolean; steps: BrainCheckStep[] } {
  const brain = new SecondBrain({ ...(opts.env ? { env: opts.env } : {}), ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) });
  const steps: BrainCheckStep[] = [];
  const done = (step: string, ok: boolean, detail: string) => { steps.push({ step, ok, detail }); return ok; };

  const st = brain.vault.state();
  if (!done('vault', st.ok, st.ok ? `connected to ${st.vault}` : st.detail)) return { ok: false, steps };
  const v = (st as { vault: string }).vault;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `check-${stamp}`;
  const rel = `JARVIS Connection Check ${stamp}.md`;
  const word = `brainchk${stamp.replace(/\D/g, '').slice(-10)}`;
  const file = path.join(v, BRAIN_ROOT, rel);
  if (fs.existsSync(file)) { done('write', false, `${BRAIN_ROOT}/${rel} already exists; nothing written`); return { ok: false, steps }; }
  try {
    brain.vault.writeManaged(v, rel, id, { jarvis_kind: 'check' }, `# Connection check\n\nWritten by pnpm check:brain to test reading and writing. Marker: ${word}\n`);
    done('write', true, `wrote ${BRAIN_ROOT}/${rel}`);
  } catch (err) { done('write', false, (err as Error).message); return { ok: false, steps }; }

  const back = brain.vault.readBrain(v, rel);
  done('read', !!back && back.managed && back.meta['jarvis_id'] === id && back.body.includes(word), back ? 'read back with its marker' : 'could not read it back');

  const hits = brain.search(word, 3);
  done('search', hits.some((h) => h.path === `${BRAIN_ROOT}/${rel}`), hits.length ? `found as ${hits[0]!.path}` : 'not found by search');

  if (!opts.keep) {
    // Remove the note this check wrote, only if it is still that note.
    const again = brain.vault.readBrain(v, rel);
    if (again?.managed && again.meta['jarvis_id'] === id) { fs.unlinkSync(file); done('cleanup', !fs.existsSync(file), 'removed the test note (only that note)'); }
    else done('cleanup', false, 'the test note changed; left in place');
  }
  const s = brain.status();
  done('second brain', true, s.initialized ? `initialized, ${s.categories} spaces, ${s.pending} queued write(s)` : 'connected, not initialized yet: start JARVIS or say "initialize your second brain"');
  return { ok: steps.every((x) => x.ok), steps };
}
