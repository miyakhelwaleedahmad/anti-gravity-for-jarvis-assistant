import { PlanStep } from './taskPlanner.js';

export class GoalDecomposer {
    public async decompose(toolCalls: any[]): Promise<PlanStep[]> {
        const steps: PlanStep[] = [];
        let index = 1;
        
        for (const call of toolCalls) {
            let args = {};
            try {
                args = JSON.parse(call.function.arguments);
            } catch {
                args = {};
            }
            
            steps.push({
                step: index++,
                tool: call.function.name,
                args: args,
                description: `Execute ${call.function.name}`,
                parentId: (args as any)?.parentId,
                dependsOn: (args as any)?.dependsOn,
                assignedTo: (args as any)?.assignedTo
            });
        }
        
        return steps;
    }
}

export const goalDecomposer = new GoalDecomposer();
