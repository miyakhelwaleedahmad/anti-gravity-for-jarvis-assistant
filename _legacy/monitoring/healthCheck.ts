/**
 * Detects when any module fails silently.
 */
export class HealthCheck {
    private moduleStatus: Map<string, boolean> = new Map();

    public registerModule(name: string) {
        this.moduleStatus.set(name, true);
    }

    public reportFailure(name: string) {
        this.moduleStatus.set(name, false);
        console.warn(`[HealthCheck] Module '${name}' reported a failure!`);
    }

    public isSystemHealthy(): boolean {
        for (const [name, isHealthy] of this.moduleStatus.entries()) {
            if (!isHealthy) return false;
        }
        return true;
    }
}

export const healthCheck = new HealthCheck();
