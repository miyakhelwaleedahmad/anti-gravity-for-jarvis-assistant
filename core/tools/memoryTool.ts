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

// ─── Save Graph Relation ──────────────────────────────────────────────────────

export const saveRelationTool: AgentTool = {
  name: 'save_relation',
  description:
    'Use to save long-term semantic relationships between entities into graph memory (e.g., User, WORKS_ON, EcommerceApp). DO NOT use for temporary task state or web searching. Required parameters: entity1 (subject), relation (uppercase relationship), and entity2 (object). Returns confirmation string.',
  riskLevel: 'low',
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

    if (signal?.aborted) throw new Error('ABORTED');

    try {
      // Also a long-term fact: search_memory reads facts, not the graph, and
      // with graph memory off (the default) the graph write does nothing — the
      // relation was reported saved and could never be recalled.
      await memoryManager.rememberFact(relationFact(args), 'relation', 6);
      await graphMemory.saveRelation(entity1, relation, entity2);
      const where = graphMemory.isAvailable() ? 'long-term memory and the graph' : 'long-term memory';
      return `Saved relation: (${entity1})-[${relation.toUpperCase()}]->(${entity2}) in ${where}.`;
    } catch (err) {
      throw new Error(`save_relation failed: ${String(err)}`);
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
