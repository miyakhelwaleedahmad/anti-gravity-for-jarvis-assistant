import { semanticCache } from './semanticCache.js';
import { visionIntentManager } from './visionIntentManager.js';
import { modelRouter } from '../bridge/modelRouter.js';
import { llmConfig } from '../config/llmconfig.js';

export interface Intent {
    type: 'simple' | 'complex' | 'command';
    priority: 'low' | 'normal' | 'high';
    requires_vision?: boolean;
}

/**
 * ✅ FIXED: Extracts intent via LLM using FAST Qwen model.
 * ✅ Added vision detection to trigger on-demand screen capture.
 */
export class IntentAnalyzer {
    public async analyze(text: string): Promise<Intent> {
        if (semanticCache.has(text)) {
            console.log('[IntentAnalyzer] Cache hit for:', text);
            const cachedIntent = semanticCache.get(text);
            if (cachedIntent.requires_vision) {
                visionIntentManager.startVision();
            }
            return cachedIntent;
        }

        console.log('[IntentAnalyzer] Classifying intent for:', text);
        
        // Fast keyword fallback for vision before LLM
        const visionKeywords = ["screen", "look at", "see this", "read this", "what am i looking at", "display", "monitor", "what's on my screen", "vision"];
        const lowerText = text.toLowerCase();
        let fastVisionTrigger = false;
        if (visionKeywords.some(kw => lowerText.includes(kw))) {
            visionIntentManager.startVision();
            fastVisionTrigger = true;
        }

        const prompt = `Classify the following user input: "${text}".
Return ONLY a valid JSON object matching this schema:
{
  "type": "simple" | "complex" | "command",
  "priority": "low" | "normal" | "high",
  "requires_vision": boolean // true if the user is referring to their screen, asking you to look at something visible, or using words like "this" in a visual context
}
Do not output any markdown formatting, just the raw JSON object.`;

        try {
            // Using fast model router for intent classification
            const response = await modelRouter.chat({
                model: llmConfig.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1,
                max_tokens: 500
            });
            
            let rawJson = response.content.trim();
            rawJson = rawJson.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            rawJson = rawJson.replace(/```json/g, '').replace(/```/g, '').trim();
            const intent = JSON.parse(rawJson) as Intent;
            
            // If LLM detected vision but fast trigger missed it
            if (intent.requires_vision && !fastVisionTrigger) {
                visionIntentManager.startVision();
            }
            
            semanticCache.set(text, intent);
            return intent;
        } catch (err) {
            console.error('[IntentAnalyzer] LLM Classification failed, falling back:', err);
            // Ensure stable fallback instead of crashing
            const fallbackIntent: Intent = { type: 'complex', priority: 'normal', requires_vision: fastVisionTrigger };
            return fallbackIntent;
        }
    }
}

export const intentAnalyzer = new IntentAnalyzer();
