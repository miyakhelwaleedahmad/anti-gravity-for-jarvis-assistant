import { messageBus } from './messageBus.js';
import { conversationBus } from './conversationBus.js';

// Boot all layers to ensure they subscribe to messageBus
import '../perception/inputProcessor.js';
import '../perception/intentAnalyzer.js';
import '../reasoning/decisionRouter.js';
import '../reasoning/grokCore.js';
import '../planner/taskPlanner.js';
import '../autonomy/taskQueue.js';
import '../core/brainLoop.js';
import '../execution/actionExecutor.js';

export class JarvisBrain {
    public async execute(input: string, source: "cli" | "voice" = "cli"): Promise<void> {
        console.log(`[Brain] Orchestrating input from ${source}...`);
        
        // Signal start
        conversationBus.conversationStarted();

        try {
            // Trigger the pipeline
            messageBus.publish('INPUT_RECEIVED', { input, source });
        } finally {
            // Signal end (Note: since the pipeline is async/event-driven, 
            // conversationEnd might need to be triggered by TASK_COMPLETED. 
            // For now, we release the lock here so other things can run).
            conversationBus.conversationEnded();
        }
    }
}

export const jarvisBrain = new JarvisBrain();
