/**
 * Reusable prompts for planning, coding, research.
 */
export const PromptTemplates = {
    PLANNING: (goal: string) => `
Create a step-by-step plan to achieve the following goal:
Goal: ${goal}
List each step clearly.
`,
    CODING: (task: string, language: string) => `
Write clean, well-documented ${language} code for the following task:
Task: ${task}
`,
    RESEARCH: (query: string) => `
Conduct comprehensive research on the following topic:
Topic: ${query}
Summarize the findings and provide key takeaways.
`
};
