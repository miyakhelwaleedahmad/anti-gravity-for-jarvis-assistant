/**
 * memory/intentClassifier.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Semantic Intent Classification Layer.
 * Intercepts user input between the Node Router and MemoryController to
 * categorize the request and guide memory routing decisions.
 */

export enum IntentCategory {
  CHAT = "CHAT",
  TASK = "TASK",
  FACT_LEARNING = "FACT_LEARNING",
  SYSTEM_COMMAND = "SYSTEM_COMMAND"
}

export interface IntentResult {
  category: IntentCategory;
  confidence: number;
  extractedEntities?: string[];
}

export class IntentClassifier {
  /**
   * Semantically classifies the user's intent to guide routing and memory behavior.
   * In a production environment, this could be backed by a lightweight fast LLM call.
   * Here we use a robust heuristic-based fallback structure.
   */
  async classify(input: string): Promise<IntentResult> {
    const text = input.trim().toLowerCase();

    // 1. SYSTEM COMMAND
    // Fast administrative directives that bypass deep memory
    if (
      text.startsWith("/") || 
      text.startsWith("system:") ||
      text.includes("restart system") || 
      text.includes("clear memory") ||
      text.includes("shut down")
    ) {
      return { category: IntentCategory.SYSTEM_COMMAND, confidence: 0.95 };
    }

    // 2. FACT LEARNING
    // Explicit knowledge provision that heavily impacts LTM vectors
    const factPatterns = [
      "my name is", "i prefer", "i like", "i work as", "i am", 
      "remember that", "important note", "keep in mind", "take note"
    ];
    if (factPatterns.some(pattern => text.includes(pattern))) {
      return { category: IntentCategory.FACT_LEARNING, confidence: 0.85 };
    }

    // 3. TASK
    // Action-oriented requests requiring tool execution context
    const taskPatterns = [
      "create a", "build a", "write a", "fix the", "execute", 
      "run", "calculate", "search for", "find", "implement", "deploy"
    ];
    if (taskPatterns.some(pattern => text.startsWith(pattern) || text.includes(pattern))) {
      return { category: IntentCategory.TASK, confidence: 0.80 };
    }

    // 4. CHAT
    // General conversational input, low impact on LTM
    return { category: IntentCategory.CHAT, confidence: 0.60 };
  }
}

export const intentClassifier = new IntentClassifier();
