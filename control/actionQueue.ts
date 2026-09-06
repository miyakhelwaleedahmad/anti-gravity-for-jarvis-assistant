/**
 * control/actionQueue.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Serializes all control actions to prevent overlaps, manages timeouts,
 * handles transient retries, and supports emergency pause/stop.
 */

export class ActionQueue {
  private queue: Promise<any> = Promise.resolve();
  private isPaused: boolean = false;
  private currentAbortController: AbortController | null = null;

  public async enqueue<T>(
    actionName: string,
    actionFn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number = 10000
  ): Promise<T> {
    if (this.isPaused) {
      throw new Error(`Execution queue is PAUSED. Action "${actionName}" deferred or blocked.`);
    }

    const taskPromise = new Promise<T>((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        if (this.isPaused) {
          reject(new Error(`Queue paused before execution of "${actionName}"`));
          return;
        }

        const ac = new AbortController();
        this.currentAbortController = ac;

        // Set timeout
        const timeoutId = setTimeout(() => {
          ac.abort();
        }, timeoutMs);

        try {
          // Wrap execution with transient retry (up to 1 retry on non-safety errors)
          let attempt = 0;
          let lastError: any = null;
          
          while (attempt < 2) {
            if (ac.signal.aborted) {
              throw new Error(`Timeout or Aborted during "${actionName}"`);
            }

            try {
              const res = await actionFn(ac.signal);
              clearTimeout(timeoutId);
              this.currentAbortController = null;
              resolve(res);
              return;
            } catch (err: any) {
              lastError = err;
              
              // Do NOT retry safety blocks or abort errors
              if (err.message.includes('safety policy') || err.message.includes('blocked') || err.message.includes('ABORTED') || err.message.includes('User did not confirm')) {
                break;
              }
              
              attempt++;
              if (attempt < 2) {
                console.warn(`[ActionQueue] Action "${actionName}" failed (attempt ${attempt}/2). Retrying... Error: ${err.message}`);
                await new Promise(r => setTimeout(r, 500)); // small delay
              }
            }
          }

          clearTimeout(timeoutId);
          this.currentAbortController = null;
          reject(lastError || new Error(`Action "${actionName}" failed after retries`));

        } catch (err) {
          clearTimeout(timeoutId);
          this.currentAbortController = null;
          reject(err);
        }
      });
    });

    return taskPromise;
  }

  public pause(): void {
    this.isPaused = true;
    console.log('[ActionQueue] Queue paused.');
    this.cancelCurrent();
  }

  public resume(): void {
    this.isPaused = false;
    console.log('[ActionQueue] Queue resumed.');
  }

  public cancelCurrent(): void {
    if (this.currentAbortController) {
      console.log('[ActionQueue] Aborting currently running action...');
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
  }

  public getStatus(): { isPaused: boolean; isRunning: boolean } {
    return {
      isPaused: this.isPaused,
      isRunning: this.currentAbortController !== null
    };
  }
}

export const actionQueue = new ActionQueue();
