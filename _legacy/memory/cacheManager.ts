import crypto from 'crypto';

interface CacheEntry {
    data: any;
    expiresAt: number;
}

export class CacheManager {
    private llmCache: Map<string, CacheEntry> = new Map();
    private toolCache: Map<string, CacheEntry> = new Map();

    // Default TTLs
    private readonly DEFAULT_LLM_TTL_MS = 1000 * 60 * 10; // 10 minutes
    private readonly DEFAULT_TOOL_TTL_MS = 1000 * 60 * 5;  // 5 minutes

    /**
     * Generate a deterministic, context-aware hash key.
     */
    private generateKey(input: any): string {
        const str = typeof input === 'string' ? input : JSON.stringify(input);
        return crypto.createHash('sha256').update(str).digest('hex');
    }

    /**
     * ─── LLM RESPONSE CACHE ──────────────────────────────────────
     */
    public getLLMCache(messages: any[]): any | null {
        const key = this.generateKey(messages);
        const entry = this.llmCache.get(key);
        if (!entry) return null;

        if (Date.now() > entry.expiresAt) {
            this.llmCache.delete(key);
            return null;
        }

        console.log(`[CacheManager] ⚡ LLM Cache HIT! Bypassing inference.`);
        return entry.data;
    }

    public setLLMCache(messages: any[], response: any, ttlMs: number = this.DEFAULT_LLM_TTL_MS): void {
        const key = this.generateKey(messages);
        this.llmCache.set(key, {
            data: response,
            expiresAt: Date.now() + ttlMs
        });
    }

    /**
     * ─── TOOL EXECUTION CACHE ────────────────────────────────────
     */
    public getToolCache(toolName: string, args: any): any | null {
        // Only cache idempotent or read-only tools
        const cacheableTools = ['web_search', 'get_system_info', 'read_file'];
        if (!cacheableTools.includes(toolName)) return null;

        const key = `${toolName}_${this.generateKey(args)}`;
        const entry = this.toolCache.get(key);
        
        if (!entry) return null;

        if (Date.now() > entry.expiresAt) {
            this.toolCache.delete(key);
            return null;
        }

        console.log(`[CacheManager] ⚡ Tool Cache HIT for [${toolName}]! Bypassing execution.`);
        return entry.data;
    }

    public setToolCache(toolName: string, args: any, result: any, ttlMs: number = this.DEFAULT_TOOL_TTL_MS): void {
        const cacheableTools = ['web_search', 'get_system_info', 'read_file'];
        if (!cacheableTools.includes(toolName)) return;

        const key = `${toolName}_${this.generateKey(args)}`;
        this.toolCache.set(key, {
            data: result,
            expiresAt: Date.now() + ttlMs
        });
    }

    /**
     * System Maintenance
     */
    public clearExpired(): void {
        const now = Date.now();
        for (const [key, entry] of this.llmCache.entries()) {
            if (now > entry.expiresAt) this.llmCache.delete(key);
        }
        for (const [key, entry] of this.toolCache.entries()) {
            if (now > entry.expiresAt) this.toolCache.delete(key);
        }
    }
}

export const cacheManager = new CacheManager();
