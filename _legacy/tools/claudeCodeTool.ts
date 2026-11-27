/**
 * Calls Claude Code CLI for project edits.
 */
export class ClaudeCodeTool {
    public async execute(prompt: string): Promise<string> {
        console.log(`[ClaudeCodeTool] Sending prompt to Claude Code CLI...`);
        // Mock execution
        return "Changes applied by Claude Code CLI.";
    }
}

export const claudeCodeTool = new ClaudeCodeTool();
