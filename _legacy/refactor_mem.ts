import * as fs from 'fs';
import * as path from 'path';

function replaceInFile(filePath: string, searchRegex: RegExp, replaceWith: string): void {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const newContent = content.replace(searchRegex, replaceWith);
    if (content !== newContent) {
        fs.writeFileSync(filePath, newContent, 'utf-8');
        console.log(`Updated ${filePath}`);
    }
}

// 1. Refactor conversation/contextManager.ts to use memoryManager
const contextManagerCode = `import { memoryManager } from '../memory/memoryManager.js';

/**
 * Stores last N messages for follow-up understanding.
 * Refactored to use memoryManager as single source of truth.
 */
export class ContextManager {
    private maxHistory: number = 20;

    public addMessage(role: string, content: string): void {
        memoryManager.addMessage(role, content);
    }

    public getContext(): { role: string; content: string }[] {
        return memoryManager.getShortTerm(this.maxHistory);
    }

    public clearContext(): void {
        // Handled by session lifecycle in memoryManager or Redis TTL
        console.log('[ContextManager] Clear context requested.');
    }
}

export const contextManager = new ContextManager();
`;
fs.writeFileSync('conversation/contextManager.ts', contextManagerCode, 'utf-8');
console.log('Updated conversation/contextManager.ts');

// 2. Refactor memoryManager.ts for optimization
let memMgrPath = 'memory/memoryManager.ts';
if (fs.existsSync(memMgrPath)) {
    let memMgr = fs.readFileSync(memMgrPath, 'utf-8');
    
    if (!memMgr.includes('const lastMsg = this.memory.messages')) {
        memMgr = memMgr.replace(
            /public addMessage\(role: string, content: string, metadata\?: any\): void \{/g,
            `public addMessage(role: string, content: string, metadata?: any): void {\n    const lastMsg = this.memory.messages[this.memory.messages.length - 1];\n    if (lastMsg && lastMsg.role === role && lastMsg.content === content) return; // Deduplicate sequential identical messages\n`
        );
        fs.writeFileSync(memMgrPath, memMgr, 'utf-8');
        console.log('Updated memoryManager.ts deduplication.');
    }
}

// 3. unifiedContextBuilder.ts token budget / cache
let unifiedPath = 'memory/unifiedContextBuilder.ts';
if (fs.existsSync(unifiedPath)) {
    let unified = fs.readFileSync(unifiedPath, 'utf-8');
    if (!unified.includes('function enforceTokenBudget')) {
        unified += `\n// Quick token budget approximation (1 token ~= 4 chars)\nfunction enforceTokenBudget(text: string, maxTokens: number = 4000): string {\n  const maxChars = maxTokens * 4;\n  return text.length > maxChars ? text.substring(0, maxChars) + '... [TRUNCATED]' : text;\n}\n`;
        
        unified = unified.replace(
            /const mergedContext = \`/g,
            `const mergedContext = enforceTokenBudget(\``
        ).replace(
            /    \.trim\(\);\n\n    return \{/g,
            `    .trim()\n    );\n\n    return {`
        );
        fs.writeFileSync(unifiedPath, unified, 'utf-8');
        console.log('Updated unifiedContextBuilder.ts budget limits.');
    }
}
