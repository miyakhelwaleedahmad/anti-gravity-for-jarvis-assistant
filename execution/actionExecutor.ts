import { messageBus } from '../core/messageBus.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { systemController } from '../core/systemController.js';

export class ActionExecutor {
    private activeExecutions: Map<string, { abort: () => void }> = new Map();
    private readonly GLOBAL_EXECUTION_TIMEOUT_MS = 25000; // 25s max tool execution

    constructor() {
        messageBus.subscribe('TOOL_REQUESTED', async (data: any) => {
            await this.handleToolRequest(data);
        });

        // ✅ Execution Kill System: Abort all pending executions on interrupt
        systemController.on("interrupted", () => {
            console.log(`[ActionExecutor] 🛑 Interrupt received. Aborting ${this.activeExecutions.size} active executions.`);
            for (const [id, execution] of this.activeExecutions.entries()) {
                execution.abort();
            }
            this.activeExecutions.clear();
        });
    }

    private async handleToolRequest(data: any) {
        const executionId = `${data.toolName}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        console.log(`[ActionExecutor] Processing tool request for: ${data.toolName} (ID: ${executionId})`);
        
        let isAborted = false;
        
        // Timeout Promise
        const timeoutPromise = new Promise<string>((_, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`TIMEOUT: Tool execution exceeded ${this.GLOBAL_EXECUTION_TIMEOUT_MS}ms`));
            }, this.GLOBAL_EXECUTION_TIMEOUT_MS);
            
            // Allow early abort
            this.activeExecutions.set(executionId, {
                abort: () => {
                    clearTimeout(timer);
                    isAborted = true;
                    reject(new Error("ABORTED: Execution killed by user interrupt"));
                }
            });
        });

        try {
            // Race the tool execution against the timeout and kill signal
            // Using toolRegistryV2 natively instead of deprecated facade
            const resultObj = await toolRegistryV2.execute(data.toolName, data.args);
            const result = resultObj.success ? resultObj.output : `Error: ${resultObj.error}`;
            const executePromise = Promise.resolve(result);
            
            const finalResult = await Promise.race([
                executePromise,
                timeoutPromise
            ]);
            
            if (isAborted) return; // Prevent publishing if aborted

            // Publish completion
            messageBus.publish('TOOL_EXECUTED', { toolName: data.toolName, result: finalResult });
            
            if (data.stepId) {
                messageBus.publish('STEP_EXECUTED', { stepId: data.stepId, result: finalResult });
            }
        } catch (err: any) {
            if (isAborted) {
                console.log(`[ActionExecutor] 🛑 Execution ID ${executionId} gracefully terminated.`);
                return;
            }

            console.error(`[ActionExecutor] Task failed:`, err.message);
            
            // Return the failure back to the LLM so it knows the tool failed
            const errorResult = `Execution Failed: ${err.message}`;
            messageBus.publish('TOOL_EXECUTED', { toolName: data.toolName, result: errorResult });
            
            if (data.stepId) {
                messageBus.publish('STEP_EXECUTED', { stepId: data.stepId, result: errorResult });
            }
        } finally {
            this.activeExecutions.delete(executionId);
        }
    }
}

export const actionExecutor = new ActionExecutor();
