import { messageBus } from '../core/messageBus.js';
import { intentAnalyzer } from './intentAnalyzer.js';

export class InputProcessor {
    constructor() {
        messageBus.subscribe('INPUT_RECEIVED', async (data) => {
            const cleaned = this.process(data.input);
            console.log(`[InputProcessor] Cleaned input: "${cleaned}"`);
            
            // Pass to IntentAnalyzer
            const intent = await intentAnalyzer.analyze(cleaned);
            
            // Emit the intent to the system
            messageBus.publish('INTENT_DETECTED', {
                intent: intent,
                entities: {},
                urgency: intent.priority === 'high' ? 1 : 0,
                rawInput: cleaned
            });
        });
    }

    public process(rawText: string): string {
        if (!rawText) return '';
        return rawText.trim().replace(/\s+/g, ' ');
    }
}

export const inputProcessor = new InputProcessor();
