/**
 * core/goalSchedule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Due times for scheduled and recurring goals (core/goalLifecycle.ts
 * GoalSchedule): once at a time, every N milliseconds, or daily / on chosen
 * weekdays at a local "HH:MM" in an IANA time zone. Daylight-saving changes
 * are handled by asking Intl for the zone's offset at the time itself.
 *
 * No scheduling library: these three shapes cover the goals JARVIS runs, and
 * Node's Intl already knows every time zone.
 */

import type { GoalSchedule } from './goalLifecycle.js';

const MIN_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;

/** The PC's own time zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseHHMM(text: string): { h: number; m: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : undefined;
}

/** Why the schedule cannot be used, or undefined. */
export function scheduleProblem(s: GoalSchedule | undefined): string | undefined {
  if (!s) return undefined;
  switch (s.type) {
    case 'once':
      return Number.isFinite(s.at) ? undefined : 'a one-time schedule needs a time ("at")';
    case 'interval':
      if (!Number.isFinite(s.everyMs) || s.everyMs < MIN_INTERVAL_MS) return 'an interval must be at least one minute';
      return undefined;
    case 'daily':
      if (!parseHHMM(s.time)) return `"${s.time}" is not a time of day (HH:MM)`;
      if (s.timezone && !isValidTimeZone(s.timezone)) return `"${s.timezone}" is not a time zone`;
      if (s.weekdays && (!s.weekdays.length || s.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
        return 'weekdays are numbers 0 (Sunday) to 6 (Saturday)';
      }
      return undefined;
    default:
      return 'unknown schedule type';
  }
}

/** Wall-clock parts of `t` in `tz`. */
function partsIn(t: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p['year']!, mo: p['month']!, d: p['day']!, h: p['hour']! % 24, mi: p['minute']!, s: p['second']! };
}

/** How far `tz` is ahead of UTC at instant `t`, in ms. */
function offsetAt(t: number, tz: string): number {
  const p = partsIn(t, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}

/** The instant of local time y-mo-d h:mi in `tz`. A time skipped by a clock change moves forward. */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  const shows = (t: number) => { const p = partsIn(t, tz); return p.h === h && p.mi === mi; };
  if (shows(second)) return second;
  if (shows(first)) return first;
  // The clocks skipped this time (spring forward): the same moment after the jump.
  return Math.max(first, second);
}

/**
 * The first due time strictly after `after`. `anchor`: when an interval
 * without `startAt` began (the goal's creation). Undefined: never again.
 */
export function nextRunAfter(s: GoalSchedule, after: number, anchor: number): number | undefined {
  switch (s.type) {
    case 'once':
      return s.at > after ? s.at : undefined;
    case 'interval': {
      const start = s.startAt ?? anchor;
      if (after < start) return start;
      const n = Math.floor((after - start) / s.everyMs) + 1;
      return start + n * s.everyMs;
    }
    case 'daily': {
      const hm = parseHHMM(s.time);
      if (!hm) return undefined;
      const tz = s.timezone || localTimeZone();
      const today = partsIn(after, tz);
      for (let i = 0; i <= 8; i++) {
        const day = new Date(Date.UTC(today.y, today.mo - 1, today.d) + i * DAY_MS);
        if (s.weekdays && !s.weekdays.includes(day.getUTCDay())) continue;
        const t = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hm.h, hm.m, tz);
        if (t > after) return t;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Due times in (from, to], oldest first, at most `limit`. Used after downtime
 * to count missed runs and to find the latest one.
 */
export function dueTimesBetween(s: GoalSchedule, from: number, to: number, anchor: number, limit = 1000): number[] {
  const out: number[] = [];
  let t = from;
  while (out.length < limit) {
    const next = nextRunAfter(s, t, anchor);
    if (next === undefined || next > to) break;
    out.push(next);
    t = next;
  }
  return out;
}

/** "daily at 09:00 (Asia/Karachi)" and the like, for status reports. */
export function describeSchedule(s: GoalSchedule | undefined): string {
  if (!s) return 'not scheduled';
  switch (s.type) {
    case 'once': return `once at ${new Date(s.at).toISOString()}`;
    case 'interval': {
      const mins = Math.round(s.everyMs / 60_000);
      return mins % 1440 === 0 ? `every ${mins / 1440} day(s)` : mins % 60 === 0 ? `every ${mins / 60} hour(s)` : `every ${mins} minute(s)`;
    }
    case 'daily': {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = s.weekdays ? ` on ${s.weekdays.map((d) => names[d]).join(', ')}` : ' every day';
      return `at ${s.time}${days} (${s.timezone || localTimeZone()})`;
    }
    default: return 'unknown schedule';
  }
}
