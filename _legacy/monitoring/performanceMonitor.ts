import * as os from 'os';

/**
 * CPU, RAM, latency — critical for your hardware.
 */
export class PerformanceMonitor {
    public getSystemStats() {
        return {
            cpuUsage: os.loadavg(),
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            uptime: os.uptime()
        };
    }

    public logStats() {
        const stats = this.getSystemStats();
        console.log(`[PerformanceMonitor] Memory Usage: ${((stats.totalMemory - stats.freeMemory) / stats.totalMemory * 100).toFixed(2)}%`);
    }
}

export const performanceMonitor = new PerformanceMonitor();
