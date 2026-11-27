/**
 * core/tools/memoryTool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Memory operation AgentTools — graph relations and semantic fact search.
 * Exposes memory capabilities directly to the LLM as callable tools.
 */

import type { AgentTool } from '../toolRegistryV2.js';
import { graphMemory } from '../../memory/graphMemory.js';
import { factOrigin, memoryManager } from '../../memory/memoryManager.js';
import { hasSecret } from '../../security/redactor.js';
import { relationFact } from '../verifiers.js';
import { approvalGate } from '../../security/approvalGate.js';
import { buildApprovalRequest, voiceApprovalMaxRisk } from '../../security/approvalRequest.js';
import { getAgentIds, getAgentPath, getGoalContext, getRequestSource, getRequestText, getTraceId } from '../traceContext.js';
import { stripMarkdown } from '../spokenText.js';
import { whileOwnerAnswers } from '../toolExecutionSandbox.js';

/**
 * What the owner is shown must be what is stored (review M-1): the console
 * shows a question's target up to 160 characters on one line, and voice says
 * about 60. Longer facts, or facts whose text the screen would fold or hide,
 * are not asked about at all.
 */
const MAX_SHOWN_FACT = 150;
const MAX_SPOKEN_FACT = 56;
/** Seconds the owner has to answer: inside the registry's 25 s limit for a low-risk call (review M-2). */
const ANSWER_SECONDS = 20;

/**
 * Characters the question would not show: line breaks, control and format
 * characters, default-ignorable ones (variation selectors, Hangul fillers),
 * and the blank Braille pattern (final review L-2). An emoji's own U+FE0F is
 * allowed.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;

/** Why a fact cannot be shown to the owner exactly as it would be stored; undefined when it can. Short: the reply quotes it. */
export function unshownFact(parts: string[], fact: string): string | undefined {
  if (parts.some((p) => HIDDEN.test(p.replace(/(\p{Extended_Pictographic})\uFE0F/gu, '$1')))) return 'the fact has a line break, a control or an invisible character';
  if (/\s{2,}/.test(fact)) return 'the fact has a run of spaces';
  if (fact.length > MAX_SHOWN_FACT) return `the fact is ${fact.length} characters; keep it under ${MAX_SHOWN_FACT}`;
  return undefined;
}

/**
 * The owner's answer for a fact, kept for the task (an agent's root task) or
 * the owner's request it was asked in (final review L-5, L-6): a "no" is not
 * asked again, a "yes" is not asked again and the fact is stored once, and a
 * store that failed after a "yes" is tried again without asking. Kept an hour
 * at most, and for the latest 500 facts.
 */
const answers = new Map<string, { yes: boolean; stored: boolean; at: number }>();
const ANSWER_KEPT_MS = 60 * 60_000;
function answerKey(fact: string): string {
  return `${getAgentIds()?.rootTaskId ?? getTraceId() ?? getRequestText()}\u0000${fact}`;
}
function keptAnswer(key: string): { yes: boolean; stored: boolean; at: number } | undefined {
  const now = Date.now();
  for (const [k, v] of answers) if (now - v.at > ANSWER_KEPT_MS) answers.delete(k);
  return answers.get(key);
}
function keepAnswer(key: string, value: { yes: boolean; stored: boolean }): void {
  answers.delete(key);
  answers.set(key, { ...value, at: Date.now() });
  while (answers.size > 500) answers.delete(answers.keys().next().value!);
}

/**
 * A fact being handled right now under the same key (final-lows review LL-1):
 * a second call for the same fact in the same task or request waits for the
 * first one instead of asking again, then reads the kept answer. `answered`
 * settles when the first call's question is over, `done` when the call has
 * finished, its store included. Both always settle.
 */
const inFlight = new Map<string, { answered: Promise<void>; done: Promise<void> }>();

/** Settles when `p` does, or as soon as `signal` is aborted. */
function settledOrStopped(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    signal.addEventListener('abort', stop, { once: true });
    void p.then(() => { signal.removeEventListener('abort', stop); resolve(); });
  });
}

/** A request stopped while the owner was asked stores nothing, whatever the answer (review M-2, final review L-4). */
const STOPPED = 'Error: save_relation stopped by memory policy - this request was stopped before your answer counted, so nothing was stored. Ask me again.';

/** The owner did not approve: reported as the registry reports its own denials (APPROVAL_DENIED; final review L-4). */
const NOT_CONFIRMED = JSON.stringify({
  success: false,
  error: 'APPROVAL_DENIED',
  message: 'save_relation cancelled by user - the fact was not confirmed, so nothing was stored.',
});

/**
 * Unverified information never enters trusted long-term memory (owner,
 * 2026-11-17, L-5; LR2_L5_PLAN.md §10): save_relation stores what the owner
 * confirms. Inside a goal nothing is stored and nobody is asked: a goal's
 * facts come from other agents' results, which are not verified, and the goal
 * runs while the owner may be away. Undefined: the call may go on to ask.
 */
export function relationRefusedInGoal(): string | undefined {
  const goal = getGoalContext();
  return goal
    ? `inside the goal "${goal.title.slice(0, 80)}" facts come from other agents' results, which are not verified, so nothing was stored `
      + '(the result stays in the goal\'s record). Say the fact yourself to keep it'
    : undefined;
}

/**
 * During a request (the owner's, or an agent's root task), the owner confirms
 * the exact fact, relation included, before it is kept: a fact the model chose,
 * took from an agent's result, a page or a document is never stored on its own
 * (review M-1, M-2). With no request in flight (code calling the registry) it
 * is not asked. False: not confirmed.
 */
async function ownerConfirms(fact: string): Promise<boolean> {
  const request = getRequestText();
  if (request === undefined) return true;
  const source = getRequestSource() ?? 'cli';
  // By voice, a fact that is not spoken exactly as stored (too long, or markdown that speech drops)
  // cannot be approved by voice: it needs a typed answer (review M-1, final review L-1).
  const unspoken = fact.length > MAX_SPOKEN_FACT || stripMarkdown(fact) !== fact;
  const risk = source === 'voice' && unspoken ? Math.min(4, voiceApprovalMaxRisk() + 1) : 1;
  const agent = getAgentPath();
  const agentIds = getAgentIds();
  // A full request names the tool and the asking agent, as the registry's own questions do (review L-3).
  const question = buildApprovalRequest({
    tool: 'save_relation',
    title: 'Keep in long-term memory',
    target: `"${fact}"`,
    request,
    effect: 'Only what you confirm is kept in long-term memory. Say no unless you said it yourself or have checked it.',
    risk,
    // forget_memory removes the fact, not a graph edge (final review L-9; toolCatalog: partial).
    reversible: 'partial',
    source,
    ...(agent ? { agent } : {}),
    ...(agentIds ? { agentIds } : {}),
  });
  return approvalGate.requestApproval(question, '', undefined, undefined, ANSWER_SECONDS);
}

// ─── Save Graph Relation ──────────────────────────────────────────────────────

export const saveRelationTool: AgentTool = {
  name: 'save_relation',
  description:
    'Use to save long-term semantic relationships between entities into graph memory (e.g., User, WORKS_ON, EcommerceApp). DO NOT use for temporary task state or web searching. Required parameters: entity1 (subject), relation (uppercase relationship), and entity2 (object). Returns confirmation string.',
  riskLevel: 'low',
  asksOwner: true,
  inputSchema: {
    entity1: {
      type: 'string',
      description: 'The subject entity (e.g. "User", "JARVIS").',
      required: true,
    },
    relation: {
      type: 'string',
      description: 'The relationship type in UPPER_CASE (e.g. "WORKS_ON", "LIKES", "IS_A").',
      required: true,
    },
    entity2: {
      type: 'string',
      description: 'The object entity (e.g. "EcommerceApp", "Python").',
      required: true,
    },
  },
  fallbacks: [],

  async execute(args, signal) {
    const entity1 = String(args['entity1'] ?? '');
    const relation = String(args['relation'] ?? '');
    const entity2 = String(args['entity2'] ?? '');

    if (!entity1 || !relation || !entity2) {
      return 'Error: save_relation requires entity1, relation, and entity2.';
    }
    if ([entity1, relation, entity2].some(hasSecret)) {
      return "Error: save_relation refused - I don't store passwords, keys or tokens, sir.";
    }
    const inGoal = relationRefusedInGoal();
    if (inGoal) return `Error: save_relation refused - ${inGoal}.`;

    if (signal?.aborted) throw new Error('ABORTED');
    const fact = relationFact(args);
    // A credential split across the parts (final review L-3).
    if (hasSecret(fact)) return "Error: save_relation refused - I don't store passwords, keys or tokens, sir.";
    // Refused by policy: the same call fails the same way, so it is not asked again (review M-1).
    const unshown = unshownFact([entity1, relation, entity2], fact);
    if (unshown) return `Error: save_relation refused by memory policy - ${unshown}; nothing was stored.`;

    // With no request in flight (code calling the registry) nothing is asked or kept, as before.
    const key = getRequestText() === undefined ? undefined : answerKey(fact);
    // The same fact at the same moment in this task or request (two graph nodes, two workers;
    // LL-1): wait for that call rather than asking again. Waiting for the owner's answer to its
    // question does not count against this call's time; its store does.
    let mine: { answered: Promise<void>; done: Promise<void> } | undefined;
    let answered = (): void => {};
    let finished = (): void => {};
    if (key !== undefined) {
      for (let busy = inFlight.get(key); busy; busy = inFlight.get(key)) {
        const other = busy;
        await whileOwnerAnswers(() => settledOrStopped(other.answered, signal));
        await settledOrStopped(other.done, signal);
        if (signal?.aborted) return STOPPED;
      }
      mine = {
        answered: new Promise<void>((r) => { answered = r; }),
        done: new Promise<void>((r) => { finished = r; }),
      };
      inFlight.set(key, mine);
    }

    try {
      const kept = key === undefined ? { yes: true, stored: false, at: 0 } : keptAnswer(key);
      if (kept?.stored) return `Already kept in long-term memory: "${fact}". Not stored again.`;
      // The owner's "no", or no answer, is final (review M-3, final review L-4, L-5): reported as the owner's
      // denial, which the task graph and the repair step do not retry, and not asked again in this task.
      if (kept && !kept.yes) return NOT_CONFIRMED;
      if (!kept) {
        const yes = await ownerConfirms(fact);
        // A request stopped while it was asked stores nothing, whatever the answer (review M-2, final review L-4).
        if (signal?.aborted) return STOPPED;
        keepAnswer(key!, { yes, stored: false });
        if (!yes) return NOT_CONFIRMED;
      }
      answered();

      try {
        // Also a long-term fact: search_memory reads facts, not the graph, and
        // with graph memory off (the default) the graph write does nothing — the
        // relation was reported saved and could never be recalled.
        await memoryManager.rememberFact(fact, 'relation', 6);
        if (key !== undefined) keepAnswer(key, { yes: true, stored: true });
        await graphMemory.saveRelation(entity1, relation, entity2);
        const where = graphMemory.isAvailable() ? 'long-term memory and the graph' : 'long-term memory';
        return `Saved relation: (${entity1})-[${relation.toUpperCase()}]->(${entity2}) in ${where}.`;
      } catch (err) {
        throw new Error(`save_relation failed: ${String(err)}`);
      }
    } finally {
      answered();
      finished();
      if (key !== undefined && inFlight.get(key) === mine) inFlight.delete(key);
    }
  },
};

// ─── Search Memory ────────────────────────────────────────────────────────────

export const searchMemoryTool: AgentTool = {
  name: 'search_memory',
  description:
    'Use to search long-term memory for recalled facts about the user or past conversations. DO NOT use for live web queries or local file searching. Required parameter: query (string memory topic). Returns list of matching memory facts.',
  riskLevel: 'low',
  inputSchema: {
    query: {
      type: 'string',
      description: 'Natural language query to search memory for.',
      required: true,
    },
    top_k: {
      type: 'number',
      description: 'Maximum number of facts to return (default: 5).',
      required: false,
    },
  },
  fallbacks: [],

  async execute(args, signal) {
    const query = String(args['query'] ?? '');
    const topK = Math.min(Number(args['top_k'] ?? 5), 20);

    if (!query.trim()) {
      return 'Error: search_memory requires a query argument.';
    }

    if (signal?.aborted) throw new Error('ABORTED');

    try {
      const facts = await memoryManager.searchFacts(query, topK);
      if (facts.length === 0) {
        return 'No relevant facts found in memory.';
      }
      return facts
        .map((f, i) => `${i + 1}. [importance: ${f.importance}, id: ${f.id}, ${ORIGIN_TEXT[factOrigin(f)]}] ${f.fact}`)
        .join('\n');
    } catch (err) {
      throw new Error(`search_memory failed: ${String(err)}`);
    }
  },
};

/** How a fact's origin reads (SEC-05). */
const ORIGIN_TEXT = { user: 'from you', agent: 'inferred by JARVIS', external: 'from research, unverified' } as const;

// ─── Forget ───────────────────────────────────────────────────────────────────

/**
 * The owner's way to make JARVIS forget something (OPS-03). Risk 2: it asks
 * first, and agents (limited to 1) cannot use it. The fact goes from the fact
 * store and from the semantic index; the answer says, per store, what was
 * done, so a fact left in the index is never reported as gone.
 */
export const forgetMemoryTool: AgentTool = {
  name: 'forget_memory',
  description:
    'Use when the user asks JARVIS to forget something it remembers. Parameters: fact (words the remembered fact contains, at least 3 characters) or id (from search_memory). '
    + 'Removes at most 5 matching facts; with more matches, asks for more specific words. Returns JSON: removed facts and what each memory store did.',
  riskLevel: 'medium',
  inputSchema: {
    fact: { type: 'string', description: 'Words the fact to forget contains.', required: false },
    id: { type: 'string', description: 'The fact id from search_memory.', required: false },
  },
  fallbacks: [],
  async execute(args, signal) {
    const fact = typeof args['fact'] === 'string' ? args['fact'] : '';
    const id = typeof args['id'] === 'string' ? args['id'] : '';
    if (!id && fact.trim().length < 3) return JSON.stringify({ success: false, error: 'Say which fact to forget (at least 3 characters), or give its id.' });
    if (signal?.aborted) throw new Error('ABORTED');
    const r = await memoryManager.forgetFacts({ id, text: fact });
    if ('tooMany' in r) return JSON.stringify({ success: false, error: `${r.tooMany} facts match; use more specific words or an id from search_memory.` });
    if (!r.removed.length) return JSON.stringify({ success: false, error: 'Nothing in memory matches that.' });
    const indexed = r.vectorIndex.every((v) => v === 'deleted');
    return JSON.stringify({
      success: true,
      removed: r.removed,
      factStore: 'deleted',
      vectorIndex: r.vectorIndex,
      message: indexed
        ? `Forgotten: ${r.removed.length} fact(s), from the fact store and the search index.`
        : `Removed ${r.removed.length} fact(s) from the fact store, but the search index could not be updated (${r.vectorIndex.find((v) => v !== 'deleted')}); it may still find them until it is cleared.`,
    });
  },
};
