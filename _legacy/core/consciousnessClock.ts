import { EventEmitter } from 'events';

export class ConsciousnessClock extends EventEmitter {
    private timer: NodeJS.Timeout | null = null;
    private tickRateMs: number = 1000; // 1 second by default

    constructor(tickRateMs?: number) {
        super();
        if (tickRateMs) this.tickRateMs = tickRateMs;
    }

    public start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.emit('tick');
        }, this.tickRateMs);
        console.log(`[ConsciousnessClock] Started heartbeat at ${this.tickRateMs}ms intervals.`);
    }

    public stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
        console.log('[ConsciousnessClock] Heartbeat stopped.');
    }

    public setTickRate(ms: number) {
        this.tickRateMs = ms;
        if (this.timer) {
            this.stop();
            this.start();
        }
    }
}
