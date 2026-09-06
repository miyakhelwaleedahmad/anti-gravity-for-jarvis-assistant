/**
 * Time triggers: morning brief, auto git push.
 */
export class Scheduler {
    private jobs: Map<string, NodeJS.Timeout> = new Map();

    public scheduleJob(name: string, intervalMs: number, task: () => void) {
        console.log(`[Scheduler] Scheduling job '${name}' every ${intervalMs}ms`);
        const timer = setInterval(task, intervalMs);
        this.jobs.set(name, timer);
    }

    public cancelJob(name: string) {
        if (this.jobs.has(name)) {
            clearInterval(this.jobs.get(name));
            this.jobs.delete(name);
            console.log(`[Scheduler] Canceled job '${name}'`);
        }
    }
}

export const scheduler = new Scheduler();
