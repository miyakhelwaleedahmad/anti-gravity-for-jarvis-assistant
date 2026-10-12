/**
 * core/agentRouting.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The agent, goal and delegation part of the deterministic router. Moved out
 * of core/orchestrator.ts unchanged (ARCH-01); tests/routeGoldenTest.ts holds
 * the router's answers from before the move.
 */

import { explicitDelegation, isResearchRequest, specialistForName } from './agents/jarvisAgents.js';
import { delegationFit, parseGoalRequest, withoutBackgroundPhrase } from './delegationRouting.js';

/**
 * Questions about the agents (core/agents/jarvisAgents.ts), "stop this
 * research", and plain research requests, which go straight to the Research
 * Agent without a planning call. `clean` is lower case without punctuation.
 */
export function matchAgentRoute(clean: string, original: string): { type: string; target?: string; reply: string; specialist?: string } | null {
  const status = (q: string) => ({ type: 'agent_status', target: q, reply: '' });
  if (/^(how many|how much) (sub ?)?(agents|workers) (are|is) (running|working|active)/.test(clean)) return status('count');
  if (/\b(show|display|give|tell)( me)? (the |your )?task (tree|graph)\b|^task (tree|graph)$/.test(clean)) return status('tree');
  if (/^what (has|have|did) (each|the|your) (worker|workers|agent|agents|sub ?agents?) (discovered|found|find|discover)/.test(clean)) return status('findings');
  if (/^(which|what) (agents?|workers?|sub ?agents?) (failed|have failed|are waiting|is waiting|are stuck|are blocked)/.test(clean)) return status('failures');
  if (/^how much (work )?(remains|is left|is remaining)|^how much of the (research|task|work) is (left|done)/.test(clean)) return status('remaining');
  const spawns = /^(what|which) (sub ?agents|subagents|workers|agents) did (the |your )?([a-z ]+?) agent (create|make|start|spawn)/.exec(clean);
  if (spawns && specialistForName(spawns[4]!)) return status(`spawns|${specialistForName(spawns[4]!)}`);
  if (/^what (are|is) (your|the) (agents?|sub ?agents|workers) (doing|up to|working on)|^(agent|agents) status$|^status of (the |your )?agents$/.test(clean)) return status('summary');
  if (/^(stop|cancel|abort|end) (this|the|that|your) (research|agents|agent work|background task|delegated task)$/.test(clean)) return { type: 'agent_stop', target: 'latest', reply: '' };
  if (/^(stop|cancel|abort) (all|all the|all your) (agents|research|background tasks)$/.test(clean)) return { type: 'agent_stop', target: 'all', reply: '' };
  // Background goals (core/goalRuntime.ts): status, control, and goals asked for in plain words.
  if (/^(?:what are|show|list|tell me)(?: me)? (?:your|my|the) (?:background )?goals$|^(?:goals|goal status|my goals|status of (?:my|the|your) goals)$|^how (?:are|is) (?:my|the|your) goals? (?:going|doing)$/.test(clean)) {
    return { type: 'goal_status', reply: '' };
  }
  const control = /^(pause|resume|continue|cancel|stop|confirm|approve) (?:the |my |that |this )?goal(?: (?:called |named |about )?(.+))?$/.exec(clean);
  if (control) {
    const action = ({ continue: 'resume', stop: 'pause', approve: 'confirm' } as Record<string, string>)[control[1]!] ?? control[1]!;
    return { type: 'goal_control', target: `${action}|${control[2] ?? 'latest'}`, reply: '' };
  }
  const goal = parseGoalRequest(original);
  if (goal) return { type: 'goal_create', target: JSON.stringify(goal), reply: '' };
  // "Ask the data agent to …", "delegate: …", "in the background, …": an explicit hand-over.
  const handOver = explicitDelegation(original);
  if (handOver) return { type: 'delegate', target: handOver.task, specialist: handOver.specialist, reply: '' };
  // "… in the background", "… while I work": background work, unless it acts on the screen.
  const fit = delegationFit(original);
  if (fit.background) return { type: 'delegate', target: withoutBackgroundPhrase(original), specialist: fit.specialist, reply: '' };
  if (isResearchRequest(clean)) return { type: 'delegate', target: original.trim(), reply: '' };
  return null;
}
