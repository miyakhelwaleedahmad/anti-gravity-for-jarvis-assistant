/**
 * core/agents/behaviors/memory.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Memory & Personalization Agent and its two workers.
 *
 *  - Memory Consistency Worker: before anything new is kept, it searches what
 *    is already remembered and proposes ADD (new), UPDATE (same subject,
 *    different detail) or NONE (already known). This is mem0's update step
 *    (mem0/configs/prompts.py: ADD / UPDATE / DELETE / NONE) done with word
 *    overlap instead of a model. It never writes and never deletes; deleting
 *    a memory stays the user's decision.
 *  - Memory Retrieval Worker: one search (memory or documents).
 *  - The specialist: "remember …" goes through the consistency check first;
 *    an already-known fact is not stored again. Other requests go to the tool
 *    loop, which can split independent searches across retrieval workers.
 *
 * Storage is JARVIS's existing memory (search_memory, save_relation); there
 * is no second store.
 */

import type { AgentBehavior } from '../registry.js';
import type { AgentContext } from '../agentContextApi.js';
import type { AgentOutcome } from '../types.js';
import { SpawnRejectedError } from '../agentContextApi.js';
import { similarity } from '../similarity.js';
import { toolLoopBehavior, type FallbackRule } from './toolLoop.js';
import { keywords } from './common.js';

export const MEMORY_RETRIEVAL_ROLE = 'memory_retrieval_worker';
export const MEMORY_CONSISTENCY_ROLE = 'memory_consistency_worker';

export type MemoryOperation = 'ADD' | 'UPDATE' | 'NONE';

export interface MemoryProposal {
  operation: MemoryOperation;
  fact: string;
  /** The stored fact it duplicates or would update. */
  existing?: string;
  similarity: number;
}

const SAME = 0.8;
const RELATED = 0.4;

/** Lines of search_memory output ("1. [importance: 3] fact") → facts. */
export function parseFacts(output: string): string[] {
  return output.split(/\r?\n/).map((l) => l.replace(/^\s*\d+\.\s*(\[[^\]]*\]\s*)?/, '').trim()).filter((l) => l && !/^no relevant facts/i.test(l));
}

/** ADD / UPDATE / NONE for a new fact against the stored ones. */
export function proposeMemoryOperation(fact: string, stored: string[]): MemoryProposal {
  let best: { text: string; score: number } | undefined;
  for (const s of stored) {
    const score = similarity(fact, s);
    if (!best || score > best.score) best = { text: s, score };
  }
  if (!best || best.score < RELATED) return { operation: 'ADD', fact, similarity: best?.score ?? 0 };
  return { operation: best.score >= SAME ? 'NONE' : 'UPDATE', fact, existing: best.text, similarity: Math.round(best.score * 100) / 100 };
}

/** "Remember that my sister lives in Lahore" → "my sister lives in Lahore". */
export function factToRemember(task: string): string | undefined {
  const m = /^\s*(?:please\s+)?(?:remember|note|keep in mind|save|don't forget)\s+(?:that\s+)?(.+?)[.!]?\s*$/i.exec(task);
  return m?.[1]?.trim() || undefined;
}

export const memoryConsistencyWorker: AgentBehavior = {
  async run(ctx) {
    const fact = String(ctx.input['fact'] ?? ctx.task.description);
    const out = await ctx.callTool('search_memory', { query: fact, top_k: 5 });
    if (!out.success) return { summary: `could not search memory: ${out.error ?? out.output}`, confidence: 0.2, limitations: ['search_memory failed'] };
    const proposal = proposeMemoryOperation(fact, parseFacts(out.output));
    return {
      summary: proposal.operation === 'ADD' ? `New: nothing similar is remembered.`
        : proposal.operation === 'NONE' ? `Already remembered: "${proposal.existing}".`
          : `Related to "${proposal.existing}"; the new detail would update it.`,
      confidence: 0.8,
      data: { proposal },
    };
  },
};

const query = (task: string) => ({ query: keywords(task, 6).join(' ') || task });

/** Without the model: search memory, and documents when the request mentions them (as before 7A). */
const MEMORY_RULES: FallbackRule[] = [
  { pattern: /.*/, tool: 'search_memory', args: query },
  { pattern: /document|file|notes|pdf/i, tool: 'search_documents', args: query },
];

const loop = toolLoopBehavior({
  purpose: 'You are the Memory & Personalization Agent: you search what JARVIS remembers and the user\'s documents, '
    + 'and keep only durable facts the user asks to keep. Never store temporary task details.',
  fallbackRules: MEMORY_RULES,
  workerRole: MEMORY_RETRIEVAL_ROLE,
});

export const memoryRetrievalWorker: AgentBehavior = toolLoopBehavior({
  purpose: 'You search JARVIS\'s memory or the user\'s documents for one thing and report what you found.',
  fallbackRules: MEMORY_RULES,
});

async function rememberFlow(ctx: AgentContext, fact: string): Promise<AgentOutcome> {
  let proposal: MemoryProposal | undefined;
  const limitations: string[] = [];
  try {
    const h = await ctx.spawn({ childRole: MEMORY_CONSISTENCY_ROLE, childTask: { description: `Check against memory: ${fact}`, input: { fact } }, reason: 'check for duplicates before storing' });
    const [r] = await ctx.wait([h]);
    proposal = (r?.data?.['proposal'] as MemoryProposal | undefined);
    if (!proposal) limitations.push(`consistency check ${r?.status.toLowerCase() ?? 'did not run'}`);
  } catch (err) {
    limitations.push(err instanceof SpawnRejectedError ? err.reasons.join('; ') : (err as Error).message);
  }
  if (proposal?.operation === 'NONE') {
    return { summary: `I already remember that: "${proposal.existing}". Nothing new was stored.`, confidence: 0.85, data: { proposal }, limitations };
  }
  // ADD or UPDATE (or no check): the tool loop may store it with save_relation, through the registry.
  const outcome = await loop.run(ctx);
  return {
    ...outcome,
    summary: proposal?.operation === 'UPDATE'
      ? `${outcome.summary}\n(This updates what I had: "${proposal.existing}".)`
      : outcome.summary,
    limitations: [...limitations, ...(outcome.limitations ?? [])],
    data: { ...(outcome.data ?? {}), ...(proposal ? { proposal } : {}) },
  };
}

export const memorySpecialist: AgentBehavior = {
  run(ctx) {
    const fact = factToRemember(ctx.task.description);
    return fact ? rememberFlow(ctx, fact) : loop.run(ctx);
  },
};
