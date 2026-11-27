import { memoryManager } from '../memory/memoryManager.js';

/**
 * Stores last N messages for follow-up understanding.
 * Refactored to use memoryManager as single source of truth.
 */
export class ContextManager {
    private maxHistory: number = 20;

    public addMessage(role: 'user' | 'assistant' | 'system', content: string): void {
        memoryManager.addMessage(role, content);
    }

    public getContext(): { role: 'user' | 'assistant' | 'system'; content: string }[] {
        return memoryManager.getShortTerm(this.maxHistory);
    }

    public clearContext(): void {
        // Handled by session lifecycle in memoryManager or Redis TTL
        console.log('[ContextManager] Clear context requested.');
    }
}

export const contextManager = new ContextManager();
