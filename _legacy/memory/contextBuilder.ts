/**
 * @deprecated memory/contextBuilder.ts — LEGACY (TOMBSTONED 2026-06-10)
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS NO LONGER THE ACTIVE CONTEXT BUILDER.
 *
 * Replaced by: memory/unifiedContextBuilder.ts
 *   - Simpler, faster, Redis-integrated, budget-aware
 *   - Used by orchestrator.ts and all current agent paths
 *
 * This file is preserved for reference. The advanced rankFactsFusion() and
 * estimateContextTokens() algorithms here may be ported to unifiedContextBuilder
 * in a future upgrade.
 *
 * SAFE TO DELETE: Yes, after porting rankFactsFusion() if needed.
 */

import { memoryManager, MemoryEntry, LongTermFact } from "./memoryManager.js";
import { graphMemory } from "./graphMemory.js";
import { getCachedContextPacket, cacheContextPacket } from "./redisCache.js";

export interface AIContextPacket {
  metadata: {
    sessionId: string;
    timestamp: number;
    tokensEstimated: number;
  };
  workingMemory: {
    systemState: string;
    activeTools: string[];
    userState: string;
  };
  sessionContext: {
    summary: string | null;      // Compressed older STM
    recentMessages: MemoryEntry[];   // Uncompressed recent STM
  };
  longTermContext: {
    facts: LongTermFact[];         // Filtered semantic facts
    graphContext: any[];         // Traversed Neo4j context
  };
  userInput: string;             // The current query
}

export class ContextBuilder {
  /**
   * Builds the AI Context Packet for the Python AI Engine.
   */
  async buildContext(userInput: string, activeTools: string[] = []): Promise<AIContextPacket> {
    const start = Date.now();
    const sessionId = (memoryManager as any).db?.data?.sessionId || "default";

    // ── REDIS fast path: Context Packet ─────────────────────────────────────────
    const cachedPacket = await getCachedContextPacket<AIContextPacket>(sessionId);
    if (cachedPacket && cachedPacket.userInput === userInput) {
      console.log(`[ContextBuilder] Redis cache hit for context packet in ${Date.now() - start}ms.`);
      return cachedPacket;
    }
    
    // Total Context Budget Constraints
    const MAX_BUDGET = 4000;
    const STM_BUDGET = 2000;   // 50%
    const VECTOR_BUDGET = 1200; // 30%
    const GRAPH_BUDGET = 800;  // 20%
    
    // 1. Parallel Fetching for Performance
    const entities = this.extractEntities(userInput);
    
    // Execute all retrievals concurrently to eliminate sequential blocking latency
    const [
      recentMessagesRaw, 
      sessionSummary, 
      relevantFactsWithScores, 
      graphContextRaw
    ] = await Promise.all([
      Promise.resolve(memoryManager.getShortTerm(20)),
      Promise.resolve((memoryManager as any).db?.data?.sessionSummary || null),
      memoryManager.searchFactsWithScores(userInput, 15).catch(() => []), // Failover handled
      graphMemory.traverseGraphContext(entities, 2).catch(() => [])       // Failover handled
    ]);

    // 2. Apply Token Budgets (Safe Degradation Strategy)
    // A. STM Processing
    let recentMessages = [...recentMessagesRaw];
    let stmTokens = this.estimateContextTokens(recentMessages, sessionSummary, [], [], userInput);
    
    if (stmTokens > STM_BUDGET) {
      console.warn(`[ContextBuilder] STM exceeded budget (${stmTokens} > ${STM_BUDGET}). Aggressively truncating.`);
      // Keep only last 5 messages, drop the rest to fit budget
      recentMessages = recentMessages.slice(-5);
      stmTokens = this.estimateContextTokens(recentMessages, sessionSummary, [], [], userInput);
    }

    // B. Vector & Graph Fusion (LTM)
    let rankedFacts = this.rankFactsFusion(relevantFactsWithScores, graphContextRaw, userInput);
    let graphContext = [...graphContextRaw];
    
    // C. Budget Verification & Fallback Priority Cuts
    let currentTokens = this.estimateContextTokens(recentMessages, sessionSummary, rankedFacts, graphContext, userInput);
    
    if (currentTokens > MAX_BUDGET) {
       console.warn(`[ContextBuilder] Total budget exceeded (${currentTokens} > ${MAX_BUDGET}). Triggering priority cuts.`);
       
       // Priority Cut 1: Degrade Graph Context
       graphContext = graphContext.slice(0, 5); // Severely limit graph context
       currentTokens = this.estimateContextTokens(recentMessages, sessionSummary, rankedFacts, graphContext, userInput);
       
       if (currentTokens > MAX_BUDGET) {
         // Priority Cut 2: Degrade Vector Facts
         rankedFacts = rankedFacts.filter(f => f.importance > 5.0).slice(0, 3);
         currentTokens = this.estimateContextTokens(recentMessages, sessionSummary, rankedFacts, graphContext, userInput);
       }

       if (currentTokens > MAX_BUDGET) {
          // Priority Cut 3: Absolute Fallback
          rankedFacts = [];
          graphContext = [];
          console.error("[ContextBuilder] Absolute Fallback Triggered. Dropping all LTM.");
       }
    }

    // Compress to Final Array
    const prunedFacts = rankedFacts.slice(0, 10); 
    const finalTokensEstimated = this.estimateContextTokens(recentMessages, sessionSummary, prunedFacts, graphContext, userInput);

    // 5. Build Final Packet
    const packet: AIContextPacket = {
      metadata: {
        sessionId: (memoryManager as any).db?.data?.sessionId || "unknown",
        timestamp: Date.now(),
        tokensEstimated: finalTokensEstimated,
      },
      workingMemory: {
        systemState: "Active",
        activeTools,
        userState: "Engaged",
      },
      sessionContext: {
        summary: sessionSummary,
        recentMessages,
      },
      longTermContext: {
        facts: prunedFacts,
        graphContext,
      },
      userInput,
    };

    console.log(`[ContextBuilder] Built Context Packet in ${Date.now() - start}ms. Estimated Tokens: ${finalTokensEstimated}`);
    
    // REDIS: Cache the newly built context packet (fire-and-forget)
    cacheContextPacket(sessionId, packet).catch(() => {});

    return packet;
  }

  private extractEntities(query: string): string[] {
    // Naive implementation: Extract capitalized words or known subjects
    // For a real production system, this could use an NER model via Python backend.
    const words = query.split(/\s+/);
    const possibleEntities = words.filter(w => w.match(/^[A-Z][a-z]+/));
    
    // Fallback: If no explicit entities, use words longer than 5 chars to seed graph
    if (possibleEntities.length === 0) {
      return words.filter(w => w.length > 5);
    }
    return possibleEntities;
  }

  private rankFactsFusion(
    factsWithScores: { fact: LongTermFact; score: number }[],
    graphContext: any[],
    query: string
  ): LongTermFact[] {
    // Formula: FinalScore = (VectorSim * 0.4) + (Importance * 0.3) + (RecencyBonus * 0.2) + (GraphCentrality * 0.1)
    
    const now = Date.now();
    const ONE_DAY_MS = 86_400_000;

    return factsWithScores.map(fs => {
      const f = fs.fact;
      const vectorSim = fs.score; // 0.0 to 1.0 from cosine sim
      
      // Normalize importance (0-10 -> 0-1.0)
      const importanceScore = Math.min(f.importance, 10) / 10.0;
      
      // Recency bonus: 1.0 if today, degrading over 30 days
      const ageMs = now - (f.lastAccessed || f.timestamp);
      const daysOld = ageMs / ONE_DAY_MS;
      const recencyBonus = Math.max(0, 1.0 - (daysOld / 30));

      // Graph Centrality: check if this fact's text contains any node names from the active graph
      let graphCentrality = 0.0;
      for (const edge of graphContext) {
        if (f.fact.includes(edge.source) || f.fact.includes(edge.target)) {
           graphCentrality = 1.0;
           break;
        }
      }

      const finalScore = 
        (vectorSim * 0.4) + 
        (importanceScore * 0.3) + 
        (recencyBonus * 0.2) + 
        (graphCentrality * 0.1);

      return { fact: f, score: finalScore };
    })
    .sort((a, b) => b.score - a.score)
    // Noise filtering threshold (e.g. must be > 0.25 final score)
    .filter(r => r.score >= 0.25)
    .map(r => r.fact);
  }

  private estimateContextTokens(msgs: any[], summary: string | null, facts: any[], graph: any[], query: string): number {
    let text = query + " " + (summary || "");
    msgs.forEach(m => text += " " + m.content);
    facts.forEach(f => text += " " + f.fact);
    graph.forEach(g => text += ` ${g.source} ${g.relation} ${g.target}`);
    return Math.ceil(text.length / 4);
  }
}

export const contextBuilder = new ContextBuilder();
