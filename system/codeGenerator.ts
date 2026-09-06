import { fileManager } from '../core/fileManager.js';

/**
 * Generates new skill files from templates.
 */
export class CodeGenerator {
    public generateSkill(skillName: string, targetDir: string): void {
        const skillCode = `
export const ${skillName}Skill = {
    id: '${skillName}',
    name: '${skillName}',
    description: 'Auto-generated skill',
    execute: async (args: any) => {
        console.log('Executing ${skillName}');
        return true;
    }
};
`;
        fileManager.createDirectory(targetDir);
        fileManager.writeFile(`${targetDir}/skill.ts`, skillCode);
        
        const descriptionJson = JSON.stringify({
            id: skillName,
            name: skillName,
            description: "Auto-generated skill"
        }, null, 2);
        
        fileManager.writeFile(`${targetDir}/description.json`, descriptionJson);
        console.log(`[CodeGenerator] Generated skill: ${skillName} at ${targetDir}`);
    }
}

export const codeGenerator = new CodeGenerator();
