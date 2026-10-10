/**
 * core/delegationRouting.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Which requests go to the specialist agents, which become goals, and which
 * stay with the orchestrator — decided from what the request is, not from
 * fixed phrases such as "delegate:" (docs/GOAL_RUNTIME.md §Routing).
 *
 *   foreground   acting on what the user sees (open, play, click, close,
 *                type, scroll, "show me", "on YouTube"): the orchestrator
 *                does it now, on the desktop. Never sent to the background.
 *   background   said to be background work ("in the background", "while I
 *                work", "let me know when it's done"): a specialist, now.
 *   substantial  research, analysis, comparison, review, a report, or several
 *                steps in one request: the planner is offered delegate_task
 *                and decides; short and simple requests are not.
 *   goal         a goal, a schedule ("every morning at 9 …") or something to
 *                keep doing: goal_create.
 */

import { chooseSpecialist } from './agents/jarvisAgents.js';
import type { GoalSchedule } from './goalLifecycle.js';
import { parseSchedule } from './goalTools.js';

const BACKGROUND = /\b(in the background|while i(?:'m| am)? (?:work|working|busy|away|do (?:my|other) (?:work|things))|let me know when (?:it'?s|you'?re|you are|it is) (?:done|finished|ready)|report back|without (?:disturbing|interrupting|bothering) me|don'?t (?:disturb|interrupt) me|quietly)\b/;
const FOREGROUND_START = /^(?:please |can you |could you |jarvis,? )?(?:open|launch|start|close|quit|click|press|play|pause|resume playing|type|scroll|show me|go to|navigate to|switch to|maximi[sz]e|minimi[sz]e|focus|bring up|watch|put on)\b/;
const ON_SCREEN = /\b(on youtube|in chrome|in the browser|on my screen|in (?:a )?new tab|on the desktop)\b/;
const SUBSTANTIAL = /\b(research|investigate|analy[sz]e|analysis|compare|comparison|evaluate|assess|review|audit|summari[sz]e|study|find out|look into|dig into|deep dive|report on|gather|survey|benchmark|pros and cons|trade-?offs|recommend(?:ation)?s?|latest (?:news|developments|updates))\b|\b(?:write|prepare|make|give me) (?:a|an|me a) (?:report|summary|comparison|overview|analysis|brief(?:ing)?)\b/;
const MULTI_STEP = /;|\band then\b|\bafter that\b|\bthen\b|\bfirst\b[\s\S]*\bthen\b|(?:^|\s)\d+[.)]\s/;

export interface DelegationFit {
  delegate: boolean;
  /** Clearly asked for as background work: hand it over without the planner. */
  background: boolean;
  /** Acting on what the user sees: never sent to the background. */
  foreground: boolean;
  specialist: string;
  reason: string;
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Strips the background phrase off a request ("research X in the background" → "research X"). */
export function withoutBackgroundPhrase(text: string): string {
  return text.replace(/[,;\s]*(?:and )?(?:please )?(?:do (?:it|this|that) )?(?:in the background|while i(?:'m| am)? (?:work|working|busy|away)|and let me know when (?:it'?s|you'?re|you are|it is) (?:done|finished|ready)|and report back|without (?:disturbing|interrupting|bothering) me)[.!]*$/i, '')
    .replace(/^(?:in the background|quietly)[,:]?\s+/i, '')
    .trim();
}

export function delegationFit(text: string): DelegationFit {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const n = words(t);
  const background = BACKGROUND.test(t);
  const foreground = FOREGROUND_START.test(t) || (ON_SCREEN.test(t) && !background);
  const specialist = chooseSpecialist(withoutBackgroundPhrase(text));
  if (foreground) return { delegate: false, background: false, foreground: true, specialist, reason: 'acts on what you see: done now, on the desktop' };
  if (background && n >= 4) return { delegate: true, background: true, foreground: false, specialist, reason: 'asked for as background work' };
  if (n < 5) return { delegate: false, background: false, foreground: false, specialist, reason: 'short and simple: answered directly' };
  if (SUBSTANTIAL.test(t)) return { delegate: true, background: false, foreground: false, specialist, reason: 'research, analysis or a report: worth a specialist' };
  if (MULTI_STEP.test(t) && n >= 12) return { delegate: true, background: false, foreground: false, specialist, reason: 'several steps in one request' };
  return { delegate: false, background: false, foreground: false, specialist, reason: 'a single, direct request' };
}

/** Words that mean a goal, a schedule or something to keep doing. */
const GOAL_WORDS = /\b(goals?|long[- ]term|keep (?:doing|working on|checking|monitoring|improving|an eye on)|from now on|every (?:day|morning|evening|night|week|weekday|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+ (?:minutes?|hours?|days?))|each (?:day|morning|evening|week)|daily|weekly|hourly|on weekdays|remind me)\b/;

export function goalIntent(text: string): boolean {
  return GOAL_WORDS.test(text.toLowerCase());
}

export interface GoalRequest {
  kind: 'temporary' | 'permanent' | 'recurring';
  objective: string;
  schedule?: GoalSchedule;
  scheduleText?: string;
}

const PART_OF_DAY: Record<string, string> = { morning: '9:00', evening: '18:00', night: '21:00', afternoon: '14:00' };

/**
 * A request that plainly asks for a goal, without the model:
 *   "make it a goal to …", "set a long-term goal: …", "keep improving …"
 *   "every morning at 9, check …", "every 2 hours, …", "weekdays at 8am: …"
 * Undefined when it does not (the planner may still choose goal_create).
 */
export function parseGoalRequest(text: string): GoalRequest | undefined {
  const t = text.trim().replace(/[.!]+$/, '');
  let m = /^(?:please )?(?:make it|set|create|add|start)(?: me)?(?: a| an)? (permanent |long[- ]term |ongoing |background |temporary )?goal(?: to|:|,)\s+(.{6,})$/i.exec(t);
  if (m) {
    const kind = /permanent|long|ongoing/i.test(m[1] ?? '') ? 'permanent' : 'temporary';
    return { kind, objective: m[2]!.trim() };
  }
  m = /^(?:please )?keep (improving|maintaining|working on|monitoring|an eye on) (.{6,})$/i.exec(t);
  if (m) return { kind: 'permanent', objective: `${m[1]} ${m[2]}`.trim() };
  m = /^(every (?:day|morning|evening|night|afternoon|weekday|week|hour|\d+ (?:minutes?|hours?|days?)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: and \w+day)*(?: at [\d:]+ ?(?:am|pm)?)?|daily at [\d:]+ ?(?:am|pm)?|hourly|weekdays at [\d:]+ ?(?:am|pm)?|on weekdays at [\d:]+ ?(?:am|pm)?)[,:]\s*(.{6,})$/i.exec(t);
  if (m) {
    let phrase = m[1]!.toLowerCase();
    const pod = /^every (morning|evening|night|afternoon)(?: at (.+))?$/.exec(phrase);
    if (pod) phrase = `daily at ${pod[2] ?? PART_OF_DAY[pod[1]!]}`;
    if (/^every (?:day|weekday)$/.test(phrase)) phrase = phrase === 'every day' ? 'daily at 9:00' : 'weekdays at 9:00';
    if (phrase === 'every week') phrase = 'every monday at 9:00';
    if (/^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: and \w+day)*$/.test(phrase)) phrase = `${phrase} at 9:00`;
    const schedule = parseSchedule(phrase);
    if (typeof schedule === 'string') return undefined;
    return { kind: schedule.type === 'once' ? 'temporary' : 'recurring', objective: m[2]!.trim(), schedule, scheduleText: phrase };
  }
  return undefined;
}
