import { PlanStep } from '../planner/taskPlanner.js';
import { messageBus } from '../core/messageBus.js';

/**
 * Priority queue of tasks waiting to execute.
 */
export class TaskQueue {
    private queue: PlanStep[] = [];

    constructor() {
        // Automatically enqueue steps when a plan is created
        messageBus.subscribe('PLAN_CREATED', (data) => {
            console.log(`[TaskQueue] Enqueueing ${data.steps.length} steps for goal: ${data.goal}`);
            for (const step of data.steps) {
                this.enqueue(step);
            }
        });
    }

    public enqueue(task: PlanStep) {
        this.queue.push(task);
    }

    public dequeue(): PlanStep | undefined {
        return this.queue.shift();
    }

    public dequeueAll(): PlanStep[] {
        const items = [...this.queue];
        this.queue = [];
        return items;
    }

    public peek(): PlanStep | undefined {
        return this.queue[0];
    }

    public isEmpty(): boolean {
        return this.queue.length === 0;
    }
}

export const taskQueue = new TaskQueue();
