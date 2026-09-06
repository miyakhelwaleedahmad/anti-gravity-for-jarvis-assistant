import { messageBus } from '../core/messageBus.js';
import { modelRouter } from '../bridge/modelRouter.js';
// toolRegistry (v1) removed — toolRegistryV2 is the single execution authority
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { memoryManager } from '../memory/memoryManager.js';
import { llmConfig } from '../config/llmconfig.js';
import { nodeBridge } from '../bridge/nodeBridge.js';
import { systemController, SystemState } from '../core/systemController.js';
import { cacheManager } from '../memory/cacheManager.js';

export class GrokCore {
    private currentMessages: any[] = [];
    private pendingToolCalls: any[] = [];

    constructor() {
        messageBus.subscribe('FAST_PATH_INFERENCE', async (data) => {
            await this.handleFastPath(data);
        });

        messageBus.subscribe('DEEP_PATH_INFERENCE', async (data) => {
            // ✅ FIXED: Dual-Model System - Qwen Based Routing
            const intentType = data.intent?.type || 'complex';
            const modelToUse = llmConfig.model;
            
            console.log(`[GrokCore] Reasoning on intent: ${intentType}. Using model: ${modelToUse}`);
            
            // Build Context
            this.currentMessages = [];
            this.currentMessages.push({ role: "system", content: llmConfig.systemPrompt });
            
            const context = memoryManager.buildContextSummary();
            if (context) {
                this.currentMessages.push({ role: "system", content: context });
            }

            const history = memoryManager.getConversationHistory(10);
            this.currentMessages.push(...history);
            
            const visionFrame = nodeBridge.getLatestScreenFrame();
            let userContent: any = data.rawInput;
            let persistText = data.rawInput;
            
            if (visionFrame) {
                const textOnlyVisionContext = `[SYSTEM: Current active window is "${visionFrame.active_window}". OCR text on screen: "${visionFrame.ocr_text}"]`;
                persistText = `${data.rawInput}\n${textOnlyVisionContext}`;
                
                if (modelToUse.toLowerCase().includes("vision") || modelToUse.toLowerCase().includes("llava")) {
                    userContent = [
                        { type: "text", text: data.rawInput },
                        { type: "text", text: textOnlyVisionContext },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${visionFrame.data}` } }
                    ];
                } else {
                    userContent = persistText; // Graceful fallback
                }
                console.log(`[GrokCore] 👁️ Injecting vision frame into LLM context.`);
            }

            this.currentMessages.push({ role: "user", content: userContent });
            await memoryManager.addMessage("user", persistText);

            await this.inferenceLoop(modelToUse, intentType);
        });

        messageBus.subscribe('TOOL_EXECUTED', async (data) => {
            console.log(`[GrokCore] Tool executed: ${data.toolName}, resuming reasoning...`);
            // Find the pending tool call ID for this tool
            const toolCall = this.pendingToolCalls.find(t => t.function.name === data.toolName);
            if (toolCall) {
                this.currentMessages.push({
                    role: "tool",
                    content: String(data.result),
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                });
                
                await memoryManager.addMessage("system", `[Tool Result - ${data.toolName}]: ${String(data.result).substring(0, 500)}`);
                
                // Remove from pending
                this.pendingToolCalls = this.pendingToolCalls.filter(t => t.id !== toolCall.id);
                
                // If all tools are resolved, continue inference
                if (this.pendingToolCalls.length === 0) {
                    await this.inferenceLoop(llmConfig.model, 'complex'); // Tools use complex reasoning
                }
            }
        });
    }

    private async handleFastPath(data: any) {
        console.log(`[GrokCore] ⚡ Fast Path Reasoning triggered.`);
        const modelToUse = llmConfig.model;
        
        this.currentMessages = [
            { role: "system", content: "You are JARVIS. Answer briefly and directly." }
        ];

        // Minimal history
        const history = memoryManager.getConversationHistory(3);
        this.currentMessages.push(...history);
        
        this.currentMessages.push({ role: "user", content: data.rawInput });
        await memoryManager.addMessage("user", data.rawInput);

        await this.inferenceLoop(modelToUse, 'simple');
    }

    private async inferenceLoop(modelName: string, intentType: string) {
        // ✅ SYSTEM V2 FIX
        systemController.setState(SystemState.THINKING);
        if (!systemController.can("grok_inference")) {
            console.log("[GrokCore] 🛑 Inference blocked by SystemController gating.");
            return;
        }
        
        console.log(`[GrokCore] Running inference...`);
        
        // If simple intent, skip tools and stream directly for latency
        if (intentType === 'simple') {
            const request = {
                model: modelName,
                messages: this.currentMessages,
            };

            const cachedResult = cacheManager.getLLMCache(this.currentMessages);
            if (cachedResult) {
                console.log(`\n🤖 JARVIS: ${cachedResult}\n`);
                nodeBridge.speakToClients(cachedResult);
                await memoryManager.addMessage("assistant", cachedResult);
                messageBus.publish('TASK_COMPLETED', { goal: 'user_request', result: cachedResult });
                return;
            }

            await this.streamResponse(request);
            return;
        }

        const request = {
            model: modelName,
            messages: this.currentMessages,
            tools: toolRegistryV2.getLLMDefinitions(),
            tool_choice: "auto" as "auto",
        };

        // ✅ SYSTEM V2 FIX
        if (systemController.isInterrupted()) {
            console.log("[GrokCore] 🛑 Aborting inference: Interrupt active.");
            return;
        }

        try {
            let response = cacheManager.getLLMCache(this.currentMessages);
            if (!response) {
                response = await modelRouter.chat(request);
                if (!systemController.isInterrupted()) {
                    cacheManager.setLLMCache(this.currentMessages, response);
                }
            }

            // ✅ SYSTEM V2 FIX
            if (systemController.isInterrupted()) {
                console.log("[GrokCore] 🛑 Discarding response: Interrupt active.");
                return;
            }

            if (!response.tool_calls || response.tool_calls.length === 0) {
                // Done! Direct answer
                let reply = response.content?.trim() || "";
                reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                console.log(`\n🤖 JARVIS: ${reply}\n`);
                await memoryManager.addMessage("assistant", reply);
                
                // Route output to voice
                nodeBridge.speakToClients(reply);
                
                // Complete task
                messageBus.publish('TASK_COMPLETED', { goal: 'user_request', result: reply });
                return;
            }

            // LLM wants to call tools
            const toolNames = response.tool_calls.map((t: any) => t.function.name).join(", ");
            console.log(`[GrokCore] LLM requested tools: ${toolNames}`);
            this.pendingToolCalls.push(...response.tool_calls);
            this.currentMessages.push({
                role: "assistant",
                content: null,
                tool_calls: response.tool_calls,
            });

            await memoryManager.addMessage("assistant", `[Action Taken]: Called tools ${toolNames}`);

            // Instead of executing directly, we pass the desired tools to the Planner
            messageBus.publish('REASONING_COMPLETED', { intent: 'llm_goal', tool_calls: response.tool_calls });
            
        } catch (err) {
            console.error("[GrokCore] Inference error:", err);
            
            // Context-aware fallback instead of dead error
            const history = memoryManager.getConversationHistory(1);
            const lastUserText = history.length > 0 ? history[0].content.split("\n")[0] : "your request";
            const fallbackReply = `I am experiencing network degradation, but I have noted your command: "${lastUserText}". I will keep monitoring the situation.`;
            
            console.log(`\n🤖 JARVIS: ${fallbackReply}\n`);
            await memoryManager.addMessage("assistant", fallbackReply);
            nodeBridge.speakToClients(fallbackReply);
            messageBus.publish('TASK_COMPLETED', { goal: 'user_request', result: fallbackReply });
        }
    }

    // ✅ FIXED: Streaming Pipeline (STT -> Brain -> TTS)
    private async streamResponse(request: any) {
        try {
            let fullReply = "";
            let spokenBuffer = "";
            let lastIndex = 0;
            process.stdout.write("\n🤖 JARVIS: ");
            
            for await (let chunk of modelRouter.streamChat(request)) {
                // ✅ SYSTEM V2 FIX
                if (systemController.isInterrupted()) {
                    console.log("\n[GrokCore] 🛑 Stream aborted due to user interrupt.");
                    break;
                }

                // Fix encoding glitches: replace broken unicode and fancy quotes
                chunk = chunk.replace(/\uFFFD/g, "'").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
                
                fullReply += chunk;
                process.stdout.write(chunk);
                
                // Strip <think> blocks from what gets spoken
                const cleanReply = fullReply.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/, '').trimStart();
                const newCleanPart = cleanReply.substring(lastIndex);
                
                if (newCleanPart) {
                    spokenBuffer += newCleanPart;
                    lastIndex = cleanReply.length;
                    
                    // Stream to TTS when a chunk is formed
                    if (/[.!?\n]\s/.test(spokenBuffer)) {
                        const parts = spokenBuffer.split(/(?<=[.!?\n])\s+/);
                        spokenBuffer = parts.pop() || "";
                        
                        let chunkToSend = "";
                        for (const part of parts) {
                            chunkToSend += part + " ";
                            if (chunkToSend.length > 25) { // Minimum TTS chunk size
                                nodeBridge.speakToClients(chunkToSend.trim());
                                chunkToSend = "";
                            }
                        }
                        if (chunkToSend.trim()) {
                            spokenBuffer = chunkToSend + spokenBuffer;
                        }
                    }
                }
            }
            if (spokenBuffer.trim() && !systemController.isInterrupted()) {
                nodeBridge.speakToClients(spokenBuffer.trim());
            }
            console.log("\n");
            
            // Only save to memory if not interrupted, or partial memory
            if (!systemController.isInterrupted()) {
                cacheManager.setLLMCache(request.messages, fullReply);
                await memoryManager.addMessage("assistant", fullReply);
                messageBus.publish('TASK_COMPLETED', { goal: 'user_request', result: fullReply });
            }
        } catch (err) {
            console.error("[GrokCore] Streaming error:", err);
            const fallbackReply = "Streaming error encountered. I am resetting.";
            console.log(`\n🤖 JARVIS: ${fallbackReply}\n`);
            nodeBridge.speakToClients(fallbackReply);
            messageBus.publish('TASK_COMPLETED', { goal: 'user_request', result: fallbackReply });
        }
    }
}

export const grokCore = new GrokCore();
