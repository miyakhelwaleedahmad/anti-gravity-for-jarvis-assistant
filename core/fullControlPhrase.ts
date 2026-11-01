/**
 * core/fullControlPhrase.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "Enable full control mode" as it is typed or heard (phase A3): one typo or
 * mishearing per word ("controll", "contol", "fool"), "turn on / switch on /
 * activate", "mode" optional. On the owner's PC "enable full controll mode"
 * reached neither the fast route nor the full-control tool (2026-10-27).
 * Matching only: turning full control on still needs the owner's typed
 * approval every time (risk 3). Never "disable", "turn off" or another mode.
 */

const VERB = /^(?:enable|enabled|unable|inable|anable|turn on|switch on|activate)$/;
const FULL = /^f[uoa]{1,2}l{1,3}$/;
const MODE = /^(?:mode|modes|mod|mood)$/;

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length]!;
}

/** `clean`: lower case, letters, digits and spaces (the route matcher's text). */
export function isEnableFullControlPhrase(clean: string): boolean {
  const m = /^((?:turn|switch) on|\S+) (\S+) (\S+)(?: (\S+))?(?: (?:on|now))?$/.exec(clean.trim());
  if (!m || !VERB.test(m[1]!) || !FULL.test(m[2]!)) return false;
  const control = m[3]!;
  if (control.length < 5 || control.length > 9 || !/^[ck]/.test(control) || distance(control, 'control') > 2) return false;
  return m[4] === undefined || MODE.test(m[4]);
}
