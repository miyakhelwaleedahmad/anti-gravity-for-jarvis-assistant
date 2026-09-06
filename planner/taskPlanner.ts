import { messageBus } from '../core/messageBus.js';
import { goalDecomposer } from './goalDecomposer.js';

export interface PlanStep {
    step: number;
    tool: string;
    args?: any;
    description: string;
    /** INACTIVE FEATURE: Hierarchical parent ID for multi-level plans */
    parentId?: string;
    /** INACTIVE FEATURE: Array of dependent task IDs for ordering */
    dependsOn?: string[];
    /** INACTIVE FEATURE: Specific agent type to delegate this task to */
    assignedTo?: string;
}

export class TaskPlanner {
    constructor() {
        // Listen for reasoning layer to formulate a goal
        messageBus.subscribe('REASONING_COMPLETED', async (data) => {
            console.log(`[TaskPlanner] Received reasoning output. Creating plan...`);
            const steps = await goalDecomposer.decompose(data.tool_calls);
            messageBus.publish('PLAN_CREATED', { goal: data.intent, steps });
        });
    }
}

export const taskPlanner = new TaskPlanner();
