/**
 * core/agents/jarvisAgents.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * How JARVIS (the main supervisor) uses the multi-agent system.
 *
 * Tools (registered with the other built-in tools; never given to agents):
 *   delegate_task      hands a request to a specialist over A2A and returns at
 *                      once; the result is spoken when JARVIS is idle
 *   agent_status       what the agents are doing, how many run, the task tree,
 *                      what each worker found, what failed, what remains, and
 *                      which sub-agents an agent created and why
 *   cancel_agent_task  "stop this research": cancels a root task and every
 *                      agent below it
 *
 * Also: the specialists are registered with the Agent Manager, the health
 * dashboard shows active agents, key events are logged to the console,
 * high-confidence findings are kept in long-term memory, root tasks left
 * RUNNING by a restart are marked INTERRUPTED, and the optional A2A HTTP
 * endpoint starts when JARVIS_A2A_PORT and JARVIS_A2A_TOKEN are set.
 */

import type { AgentTool } from '../toolRegistryV2.js';
import { getRequestSource } from '../traceContext.js';
import { agentManager, type RootResult } from './agentManager.js';
import { A2AHttpServer, A2AServer, InProcessA2AClient, userMessage } from './a2a.js';
import { registerAgentRoles, SPECIALIST_ROLES } from './specialists.js';
import { configWarnings, limitEnvNames } from './config.js';
import { isTerminal, type A2ATask, type AgentEvent, type LifecycleState } from './types.js';

const SPECIALISTS = SPECIALIST_ROLES.map((r) => r.role);

let initialised = false;
let a2aServer: A2AServer | undefined;
let a2aClient: InProcessA2AClient | undefined;
let httpServer: A2AHttpServer | undefined;
const shownAgents = new Set<string>();

/** Lazy imports: these modules pull in voice and storage, which tests of the agent core do not need. */
async function speak(text: string): Promise<void> {
  try {
    const [{ nodeBridge }, { conversationBus }] = await Promise.all([
      import('../../bridge/nodeBridge.js'), import('../conversationBus.js'),
    ]);
    const say = () => nodeBridge.speakToClients(text);
    if (conversationBus.isIdle) say();
    else conversationBus.onceIdle(say);
  } catch (err) {
    console.warn(`[Agents] Could not speak the result: ${(err as Error).message}`);
  }
}

async function updateDashboard(): Promise<void> {
  try {
    const { healthManager } = await import('../../monitoring/healthManager.js');
    const now = new Set(agentManager.status().agents.map((a) => a.name));
    for (const name of [...shownAgents]) if (!now.has(name)) { healthManager.unregisterAgent(name); shownAgents.delete(name); }
    for (const name of now) if (!shownAgents.has(name)) { healthManager.registerAgent(name); shownAgents.add(name); }
  } catch {
    // The dashboard is optional.
  }
}

function logEvent(e: AgentEvent): void {
  if (process.env['JARVIS_AGENT_LOG'] === '0') return;
  const name = (id?: string) => (id ? agentManager.agentOf(e.rootTaskId, id)?.name ?? id : '?');
  switch (e.type) {
    case 'AGENT_CREATED':
      console.log(`[Agents] + ${String(e.data['name'])} (by ${name(e.parentAgentId)}, depth ${String(e.data['depth'])}): ${String(e.data['reason'] ?? '')}`);
      break;
    case 'TASK_COMPLETED':
    case 'TASK_FAILED':
    case 'TASK_CANCELLED':
    case 'TASK_TIMED_OUT': {
      const err = e.data['error'] as { message?: string } | undefined;
      console.log(`[Agents] ${e.type === 'TASK_COMPLETED' ? '✓' : '✗'} ${name(e.agentId)} ${e.type.replace('TASK_', '').toLowerCase()}${err?.message ? `: ${err.message}` : ''}`);
      break;
    }
    case 'SPAWN_REJECTED':
      console.log(`[Agents] ⛔ ${name(e.agentId)} could not create ${String(e.data['childRole'])}: ${(e.data['reasons'] as string[]).join('; ')}`);
      break;
    case 'PERMISSION_DENIED':
      console.log(`[Agents] ⛔ ${name(e.agentId)}: ${String(e.data['reason'])}`);
      break;
    case 'CONFLICT_DETECTED':
      console.log(`[Agents] ⚠ Sources disagree on ${String(e.data['subject'])} ${String(e.data['attribute'])}: ${(e.data['values'] as unknown[]).join(' vs ')}`);
      break;
    default:
  }
}

/** Registers the specialists and the hooks once. Safe to call again. */
export async function ensureAgentSystem(opts: { startHttp?: boolean } = {}): Promise<void> {
  if (!initialised) {
    initialised = true;
    registerAgentRoles(agentManager);
    a2aServer = new A2AServer(agentManager);
    a2aClient = new InProcessA2AClient(a2aServer);
    for (const w of configWarnings) console.warn(`[Agents] ${w}`);
    agentManager.events.subscribe({}, (e) => {
      logEvent(e);
      if (e.type === 'AGENT_CREATED' || e.type === 'AGENT_STOPPED' || e.type === 'AGENT_STATE_CHANGED') void updateDashboard();
    });
    const marked = agentManager.markInterruptedArchives();
    if (marked.length) console.log(`[Agents] ${marked.length} delegated task(s) were cut off by the last shutdown; marked INTERRUPTED in data/agents.`);
  }
  if (opts.startHttp && !httpServer) {
    const port = Number(process.env['JARVIS_A2A_PORT'] ?? 0);
    const token = process.env['JARVIS_A2A_TOKEN']?.trim() ?? '';
    if (port > 0) {
      if (token.length < 16) {
        console.warn('[Agents] JARVIS_A2A_PORT is set but JARVIS_A2A_TOKEN is missing or shorter than 16 characters; the A2A endpoint stays off.');
      } else {
        httpServer = new A2AHttpServer(a2aServer!, { port, token });
        try {
          const bound = await httpServer.start();
          console.log(`[Agents] A2A endpoint: http://127.0.0.1:${bound}/.well-known/agent-card.json (token required)`);
        } catch (err) {
          console.warn(`[Agents] A2A endpoint did not start: ${(err as Error).message}`);
          httpServer = undefined;
        }
      }
    }
  }
}

/** Stops every running root task and the HTTP endpoint (JARVIS shutting down). */
export async function shutdownAgentSystem(): Promise<void> {
  agentManager.cancelAll();
  await httpServer?.stop();
  httpServer = undefined;
}

export function a2a(): { server: A2AServer; client: InProcessA2AClient } {
  if (!a2aServer || !a2aClient) {
    registerAgentRoles(agentManager);
    a2aServer = new A2AServer(agentManager);
    a2aClient = new InProcessA2AClient(a2aServer);
  }
  return { server: a2aServer, client: a2aClient };
}

// ─── Choosing a specialist ───────────────────────────────────────────────────

const ROUTES: [RegExp, string][] = [
  [/\b(git ?hub|pull request|\bpr\b|issues?|ci\b|commit|branch|push)\b/i, 'github_agent'],
  [/\b(test|tests|lint|type ?check|build fails?|qa)\b/i, 'qa_agent'],
  [/\b(code|function|file|refactor|bug|compile|typescript|source)\b/i, 'coding_agent'],
  [/\b(tab|tabs|page|website|browser|chrome|url)\b/i, 'browser_agent'],
  [/\b(window|windows|app|apps|desktop|pc|computer|cpu|memory usage|process)\b/i, 'pc_agent'],
  [/\b(remember|recall|memory|notes|documents?)\b/i, 'memory_agent'],
];

/** The specialist for a request: research wins for find/compare/best questions. */
export function chooseSpecialist(task: string): string {
  if (/\b(research|investigate|compare|comparison|best|recommend|alternatives?|find (?:me )?(?:the )?(?:best|good|top))\b/i.test(task)) return 'research_agent';
  for (const [pattern, role] of ROUTES) if (pattern.test(task)) return role;
  return 'research_agent';
}

// ─── Completion: speak, remember ─────────────────────────────────────────────

function firstSentences(text: string, max = 280): string {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) ?? [text];
  let out = '';
  for (const p of parts) {
    if ((out + p).length > max) break;
    out += p;
  }
  return (out || text.slice(0, max)).trim();
}

const SPEAKER: Record<string, string> = Object.fromEntries(SPECIALIST_ROLES.map((r) => [r.role, r.name]));

export function completionSpeech(result: RootResult): string {
  const who = SPEAKER[result.specialist.role] ?? 'The agents';
  switch (result.status) {
    case 'COMPLETED':
      return `Sir, the ${who} has finished. ${firstSentences(result.answer)} The full report is in the console.`;
    case 'CANCELLED':
      // "Stopped" was already said when the user stopped it; speak again only if there is something to report.
      return result.findings.length ? `Sir, before the ${who} was stopped it had ${result.findings.length} findings; they are in the console.` : '';
    case 'TIMED_OUT':
      return `Sir, the ${who} ran out of time. ${result.findings.length ? 'Its partial findings are in the console.' : ''}`.trim();
    default:
      return `Sir, the ${who} could not finish: ${firstSentences(result.specialist.error?.message ?? result.answer, 160)}`;
  }
}

/** The full result for the console. */
export function resultReport(result: RootResult): string {
  const lines = [
    `═══ Delegated task ${result.rootTaskId}: ${result.status} (${Math.round(result.durationMs / 1000)} s, confidence ${result.confidence.toFixed(2)}) ═══`,
    result.answer,
  ];
  const ranking = result.specialist.data?.['ranking'] as { fullName: string; url: string; score: number; license: string | null }[] | undefined;
  if (ranking?.length) lines.push('', 'Ranking:', ...ranking.map((r, i) => `  ${i + 1}. ${r.fullName}  ${r.url}  score ${r.score}  licence ${r.license ?? 'none'}`));
  if (result.sources.length) lines.push('', 'Sources:', ...result.sources.slice(0, 12).map((s) => `  - ${s.title}${s.url ? `  ${s.url}` : ''}`));
  if (result.conflicts.length) lines.push('', 'Conflicts:', ...result.conflicts.map((c) => `  - ${c.subject} ${c.attribute}: ${c.status}${c.resolution?.value ? ` → ${c.resolution.value}` : ''}`));
  if (result.limitations.length) lines.push('', 'Limitations:', ...result.limitations.slice(0, 12).map((l) => `  - ${l}`));
  if (result.recommendedNextActions.length) lines.push('', 'Next:', ...result.recommendedNextActions.map((a) => `  - ${a}`));
  return lines.join('\n');
}

/** Keeps the answer and up to three strong findings in long-term memory. */
export async function promoteToMemory(result: RootResult, request: string): Promise<number> {
  if (result.status !== 'COMPLETED' || process.env['JARVIS_AGENT_MEMORY'] === '0') return 0;
  let stored = 0;
  try {
    const { memoryManager } = await import('../../memory/memoryManager.js');
    const date = new Date().toISOString().slice(0, 10);
    await memoryManager.rememberFact(`Research (${date}) "${request.slice(0, 120)}": ${firstSentences(result.answer, 300)}`, 'agents', 6, result.confidence);
    stored++;
    const strong = result.findings
      .filter((f) => f.confidence >= 0.75 && !(f.tags ?? []).includes('tool-result'))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
    for (const f of strong) {
      await memoryManager.rememberFact(f.text.slice(0, 300), 'agents', 4, f.confidence);
      f.promoted = 'memory';
      stored++;
    }
  } catch (err) {
    console.warn(`[Agents] Could not store the result in memory: ${(err as Error).message}`);
  }
  return stored;
}

// ─── Status answers ──────────────────────────────────────────────────────────

/** Text cut at a word boundary. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 15)).trim()}…`;
}

/** The root task a question is about: the running one, else the latest. */
function currentRoot(): string | undefined {
  const runs = agentManager.rootRuns().sort((a, b) => b.startedAt - a.startedAt);
  return runs.find((r) => !r.endedAt)?.rootTaskId ?? runs[0]?.rootTaskId;
}

function nameOf(rootTaskId: string, agentId: string): string {
  return agentManager.agentOf(rootTaskId, agentId)?.name ?? agentId;
}

export type StatusQuestion = 'summary' | 'count' | 'tree' | 'findings' | 'failures' | 'remaining' | 'spawns';

/** First line: a sentence to say. The rest: detail for the console. */
export function agentStatusText(question: StatusQuestion, opts: { agent?: string; rootTaskId?: string } = {}): string {
  const s = agentManager.status();
  const root = opts.rootTaskId ?? currentRoot();
  if (!root) return 'No agents have been used yet, sir.';
  const run = agentManager.rootRuns().find((r) => r.rootTaskId === root)!;
  const running = s.agents.filter((a) => a.status === 'RUNNING');
  const waiting = s.agents.filter((a) => a.status === 'WAITING');
  const tasks = agentManager.tasksOfRoot(root).filter((t) => t.parentTaskId);
  const live = !run.endedAt;
  switch (question) {
    case 'count':
      return `${s.activeAgents} agent${s.activeAgents === 1 ? ' is' : 's are'} active, sir: ${running.length} working, ${waiting.length} waiting for others${s.startingOrQueued ? `, ${s.startingOrQueued} starting` : ''}.`
        + `\nWork slots in use: ${s.slots.inUse}/${s.slots.limit}; model calls at once: ${s.llmSlots.inUse}/${s.llmSlots.limit}.`;
    case 'tree':
      return `Here is the task tree for "${run.request.slice(0, 80)}", sir; it is in the console.\n${agentManager.renderTaskTree(root)}`;
    case 'findings': {
      const by = agentManager.findingsByAgent(root);
      const names = Object.keys(by);
      if (!names.length) return 'No agent has reported a finding yet, sir.';
      const total = names.reduce((n, k) => n + by[k].length, 0);
      return `${names.length} agent${names.length === 1 ? ' has' : 's have'} reported ${total} finding${total === 1 ? '' : 's'}, sir; the console lists them by agent.\n`
        + names.map((id) => `${nameOf(root, id)}:\n${by[id].slice(0, 8).map((f) => `  - ${f.text.slice(0, 160)}`).join('\n')}`).join('\n');
    }
    case 'failures': {
      const bad = tasks.filter((t) => ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(t.status));
      const wait = tasks.filter((t) => t.status === 'WAITING' || t.status === 'STARTING');
      const say = bad.length
        ? `${bad.length} agent${bad.length === 1 ? '' : 's'} did not finish: ${bad.slice(0, 3).map((t) => `${nameOf(root, t.agentId)} (${t.status.toLowerCase().replace('_', ' ')})`).join(', ')}.`
        : 'No agent has failed, sir.';
      return `${say}${wait.length ? ` ${wait.length} ${wait.length === 1 ? 'is' : 'are'} waiting.` : ''}\n`
        + [...bad.map((t) => `✗ ${nameOf(root, t.agentId)}: ${t.status} ${t.result?.error?.message ?? t.cancellation.reason ?? ''}`),
          ...wait.map((t) => `… ${nameOf(root, t.agentId)}: ${t.status}${t.dependencies.length ? ' (for its dependencies)' : ''}`)].join('\n');
    }
    case 'remaining': {
      const r = agentManager.remainingWork(root);
      return live
        ? `${r.finished} of ${r.total} tasks are done, about ${r.percent} percent, sir. ${r.running} running, ${r.waiting} waiting, ${r.notStarted} not started.`
        : `That task has ended (${run.status.toLowerCase()}); nothing remains, sir.`;
    }
    case 'spawns': {
      const target = opts.agent ?? 'research_agent';
      const id = agentManager.registry.findAgents({ rootTaskId: root }).find((a) => a.agentId === target || a.name.toLowerCase() === target.toLowerCase())?.agentId ?? target;
      const kids = agentManager.spawnedBy(root, id);
      if (!kids.length) return `The ${nameOf(root, id)} created no sub-agents for this task, sir.`;
      return `The ${nameOf(root, id)} created ${kids.length}: ${kids.map((k) => k.name).join(', ')}. The reasons are in the console.\n`
        + kids.map((k) => `- ${k.name} (${k.status.toLowerCase()}): ${k.reason}`).join('\n');
    }
    default: {
      if (!s.activeAgents) {
        return `No agents are working now, sir. The last task, "${run.request.slice(0, 80)}", ${run.status.toLowerCase().replace('_', ' ')}.\n${agentManager.renderTaskTree(root)}`;
      }
      const doing = running.slice(0, 3).map((a) => `the ${a.name} is ${a.progress ?? 'working'}`).join('; ');
      return `${s.activeAgents} agent${s.activeAgents === 1 ? ' is' : 's are'} working on "${clip(run.request, 80)}", sir${doing ? `: ${doing}` : ''}.`
        + `${waiting.length ? ` ${waiting.length} ${waiting.length === 1 ? 'is' : 'are'} waiting for others.` : ''}\n${agentManager.renderTaskTree(root)}`;
    }
  }
}

// ─── Tools ───────────────────────────────────────────────────────────────────

/** Delegated tasks started from this process, for "stop this research". */
const started: { rootTaskId: string; specialist: string; request: string }[] = [];

export const delegateTaskTool: AgentTool = {
  name: 'delegate_task',
  description:
    'Hands a larger task to one of JARVIS\'s specialist agents, which may create sub-agents and work in parallel in the background. '
    + 'Use for research ("find the best GitHub projects for X", "compare A and B"), multi-step investigations and anything that takes more than a few tool calls. '
    + `Parameters: task (what to do, in the user's words), specialist (optional: ${SPECIALISTS.join(', ')}; chosen automatically if omitted). `
    + 'Returns at once; JARVIS reports the result when the agents finish.',
  riskLevel: 'low',
  inputSchema: {
    task: { type: 'string', description: 'The task, in the user\'s words', required: true },
    specialist: { type: 'string', description: 'Which specialist (optional)', required: false, enum: SPECIALISTS },
  },
  fallbacks: [],
  async execute(args) {
    const task = String(args['task'] ?? '').trim();
    if (!task) return JSON.stringify({ success: false, error: 'delegate_task needs a task' });
    const specialist = SPECIALISTS.includes(String(args['specialist'])) ? String(args['specialist']) : chooseSpecialist(task);
    await ensureAgentSystem();
    const { client } = a2a();
    let created: A2ATask;
    try {
      const res = await client.sendMessage(specialist, {
        message: userMessage(task, undefined, { jarvis: { source: getRequestSource() ?? 'cli' } }),
        configuration: { returnImmediately: true },
      });
      created = (res as { task: A2ATask }).task;
    } catch (err) {
      return JSON.stringify({ success: false, error: (err as Error).message });
    }
    const rootTaskId = created.contextId;
    started.push({ rootTaskId, specialist, request: task });
    const name = SPEAKER[specialist] ?? specialist;
    void waitForRoot(rootTaskId).then(async (result) => {
      if (!result) return;
      console.log(`\n${resultReport(result)}\n`);
      const stored = await promoteToMemory(result, task);
      if (stored) console.log(`[Agents] Kept ${stored} item(s) from this task in long-term memory.`);
      const speech = completionSpeech(result);
      if (speech) await speak(speech);
    });
    return JSON.stringify({
      success: true,
      message: `The ${name} is working on it in the background. I will report when it is done; ask "what are your agents doing" to follow it.`,
      rootTaskId, taskId: created.id, specialist,
    });
  },
};

async function waitForRoot(rootTaskId: string): Promise<RootResult | undefined> {
  const done = agentManager.rootResult(rootTaskId);
  if (done) return done;
  return new Promise((resolve) => {
    const off = agentManager.events.subscribe({ rootTaskId, types: ['TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELLED', 'TASK_TIMED_OUT'] }, () => {
      // The root's own end event comes last; its result is set just before.
      setImmediate(() => {
        const r = agentManager.rootResult(rootTaskId);
        if (r) { off(); resolve(r); }
      });
    });
  });
}

const QUESTIONS: StatusQuestion[] = ['summary', 'count', 'tree', 'findings', 'failures', 'remaining', 'spawns'];

export const agentStatusTool: AgentTool = {
  name: 'agent_status',
  description:
    'Reports on JARVIS\'s agents: what they are doing (summary), how many are running (count), the task tree (tree), '
    + 'what each worker found (findings), which failed or wait (failures), how much work remains (remaining), '
    + 'and which sub-agents an agent created and why (spawns, with agent). Read-only.',
  riskLevel: 'low',
  inputSchema: {
    question: { type: 'string', description: QUESTIONS.join(' | '), required: false, enum: QUESTIONS },
    agent: { type: 'string', description: 'For spawns: the agent (e.g. research_agent)', required: false },
  },
  fallbacks: [],
  async execute(args) {
    await ensureAgentSystem();
    const q = QUESTIONS.includes(args['question'] as StatusQuestion) ? args['question'] as StatusQuestion : 'summary';
    return agentStatusText(q, { ...(typeof args['agent'] === 'string' ? { agent: args['agent'] } : {}) });
  },
};

export const cancelAgentTaskTool: AgentTool = {
  name: 'cancel_agent_task',
  description: 'Stops delegated agent work ("stop this research"): the running task and every agent below it. Parameter: which ("latest" or "all", default latest).',
  riskLevel: 'low',
  inputSchema: { which: { type: 'string', description: 'latest or all', required: false, enum: ['latest', 'all'] } },
  fallbacks: [],
  async execute(args) {
    await ensureAgentSystem();
    const running = agentManager.rootRuns().filter((r) => !r.endedAt).sort((a, b) => b.startedAt - a.startedAt);
    if (!running.length) return JSON.stringify({ success: true, message: 'No agents are working, sir.', stopped: 0 });
    const targets = args['which'] === 'all' ? running : running.slice(0, 1);
    for (const r of targets) agentManager.cancelRoot(r.rootTaskId, 'stopped by the user');
    // Wait briefly so the answer can say they stopped.
    const until = Date.now() + 3_000;
    while (Date.now() < until && targets.some((r) => !isTerminal((agentManager.tasks.get(r.rootTaskId)?.status ?? 'CANCELLED') as LifecycleState))) {
      await new Promise((res) => setTimeout(res, 50));
    }
    const what = targets.length === 1 ? `"${targets[0].request.slice(0, 60)}"` : `${targets.length} tasks`;
    return JSON.stringify({ success: true, message: `Stopped ${what} and all its agents, sir.`, stopped: targets.length, rootTaskIds: targets.map((t) => t.rootTaskId) });
  },
};

export const agentTools: AgentTool[] = [delegateTaskTool, agentStatusTool, cancelAgentTaskTool];

/** For docs and the status report: the settings and their environment variables. */
export function agentSettings(): Record<string, string> {
  const limits = agentManager.limits as unknown as Record<string, unknown>;
  const names = limitEnvNames();
  const out: Record<string, string> = {};
  for (const [k, env] of Object.entries(names)) {
    const value = k.startsWith('rootBudget.') ? (limits['rootBudget'] as Record<string, unknown>)[k.slice(11)] : limits[k];
    out[env] = String(value);
  }
  return out;
}

/**
 * A request plainly phrased as research about software projects, for the
 * orchestrator's fixed route: "research …", or find / compare / recommend /
 * best together with GitHub, repositories, libraries, frameworks or open
 * source. Anything else (including "investigate why my app is down") goes the
 * usual way, where the planner can still choose delegate_task.
 */
export function isResearchRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (/^(please )?(research|do (some )?research (on|about|into))\b/.test(t)) return true;
  return /\b(find|search for|recommend|compare|best|alternatives?)\b/.test(t)
    && /\b(github|repositor(?:y|ies)|repos|open[- ]source|librar(?:y|ies)|frameworks?|sdks?)\b/.test(t);
}

