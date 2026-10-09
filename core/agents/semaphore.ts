/**
 * core/agents/semaphore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A counting semaphore with priorities and cancellation, for the "agents at
 * work at once" and "model calls at once" limits. Waiters with a higher
 * priority go first; equal priorities keep arrival order. A waiter whose
 * signal aborts leaves the queue and its promise rejects.
 */

interface Waiter {
  priority: number;
  order: number;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class PrioritySemaphore {
  private inUse = 0;
  private queue: Waiter[] = [];
  private counter = 0;

  constructor(private capacity: number) {}

  setCapacity(capacity: number): void {
    this.capacity = Math.max(1, capacity);
    this.drain();
  }

  get active(): number {
    return this.inUse;
  }

  get waiting(): number {
    return this.queue.length;
  }

  get limit(): number {
    return this.capacity;
  }

  /** Resolves with a release function once a slot is free. */
  acquire(priority = 5, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.inUse < this.capacity && this.queue.length === 0) {
      this.inUse++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { priority, order: this.counter++, resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.queue.indexOf(waiter);
          if (i !== -1) this.queue.splice(i, 1);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.inUse < this.capacity && this.queue.length) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      this.inUse++;
      next.resolve(this.releaser());
    }
  }
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'Aborted');
  err.name = 'AbortError';
  return err;
}
