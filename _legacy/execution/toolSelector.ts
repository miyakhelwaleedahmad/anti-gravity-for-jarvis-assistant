export class ToolSelector {
    public selectTool(taskName: string): string {
        // Map abstract goals to concrete tools.
        // For now, if the task explicitly names a tool, use it.
        // Otherwise fallback to systemTool or execution skills.
        return taskName;
    }
}

export const toolSelector = new ToolSelector();
