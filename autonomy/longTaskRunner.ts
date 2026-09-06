/**
 * Keeps multi-step tasks alive without timeout.
 */
export class LongTaskRunner {
    public async run(taskFn: () => Promise<void>) {
        console.log('[LongTaskRunner] Starting long-running task...');
        // In a real environment, this might offload to a worker thread
        await taskFn();
        console.log('[LongTaskRunner] Long-running task completed.');
    }
}

export const longTaskRunner = new LongTaskRunner();
