import { messageBus } from '../core/messageBus.js';

export type IntentClassification = 'fast_path' | 'deep_path';

export class DecisionRouter {
    constructor() {
        // Intercept all raw user intents
        messageBus.subscribe('INTENT_DETECTED', this.routeIntent.bind(this));
    }

    private async routeIntent(data: any) {
        console.log(`[DecisionRouter] Analyzing intent for optimal routing...`);
        const input = (data.rawInput || "").trim().toLowerCase();
        
        // 1. Keyword / Heuristic based fast routing (Zero Latency)
        const classification = this.classifyInput(input);

        console.log(`[DecisionRouter] Routed to: ${classification.toUpperCase()}`);

        // 2. Dispatch to the appropriate reasoning pipeline
        if (classification === 'fast_path') {
            messageBus.publish('FAST_PATH_INFERENCE', data);
        } else {
            messageBus.publish('DEEP_PATH_INFERENCE', data);
        }
    }

    private classifyInput(input: string): IntentClassification {
        // Simple heuristic rules to bypass LLM classification for maximum speed.
        // If it looks like a command, file op, or complex query -> deep_path
        
        const fastPathTriggers = [
            "hello", "hi", "hey", "how are you", "what's up", "good morning", 
            "good night", "thanks", "thank you", "okay", "stop", "nevermind",
            "who are you", "what time is it"
        ];

        const deepPathTriggers = [
            "open", "close", "create", "delete", "remove", "update", "write",
            "run", "execute", "start", "stop process", "search", "find",
            "read", "summarize", "analyze", "explain", "why", "how do i",
            "calculate", "code", "file", "terminal", "system"
        ];

        // Exact match or very short inputs -> Fast path
        if (input.split(' ').length <= 3 && fastPathTriggers.includes(input)) {
            return 'fast_path';
        }

        // Contains deep path action verb -> Deep path
        if (deepPathTriggers.some(trigger => input.includes(trigger))) {
            return 'deep_path';
        }

        // Default to deep path for safety if ambiguous, or fast path if we want to lean on LLM speed.
        // For an agent, defaulting to deep_path ensures tool availability.
        return 'deep_path';
    }
}

export const decisionRouter = new DecisionRouter();
