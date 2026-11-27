/**
 * agents/supervisorAgent.ts
 * NON-FUNCTIONAL STUB
 * Lightweight facade for future multi-agent delegation.
 * Prepares the system for routing without breaking the orchestrator.
 */
export class SupervisorAgent {
    public async delegateTask(task: string, agentType: string): Promise<string> {
        console.warn(`[SupervisorAgent] NON-FUNCTIONAL STUB: Attempted to delegate task "${task}" to agent: ${agentType}`);
        throw new Error(`[SupervisorAgent] Agent routing is not yet implemented. Cannot delegate to ${agentType}.`);
    }
}
export const supervisorAgent = new SupervisorAgent();
