/**
 * Caches logic to save RAM/CPU by reusing previous interpretations.
 */
export class SemanticCache {
    private cache: Map<string, any> = new Map();

    public get(key: string): any {
        return this.cache.get(key);
    }

    public set(key: string, value: any) {
        this.cache.set(key, value);
    }

    public has(key: string): boolean {
        return this.cache.has(key);
    }

    public clear() {
        this.cache.clear();
    }
}

export const semanticCache = new SemanticCache();
