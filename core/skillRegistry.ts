export interface Skill {
    id: string;
    name: string;
    description: string;
    execute: (args: any) => Promise<any>;
}

/**
 * Live database of all loaded skills.
 */
export class SkillRegistry {
    private skills: Map<string, Skill> = new Map();

    public registerSkill(skill: Skill) {
        if (this.skills.has(skill.id)) {
            console.warn(`[SkillRegistry] Skill with ID ${skill.id} is already registered. Overwriting.`);
        }
        this.skills.set(skill.id, skill);
        console.log(`[SkillRegistry] Registered skill: ${skill.name}`);
    }

    public getSkill(id: string): Skill | undefined {
        return this.skills.get(id);
    }

    public getAllSkills(): Skill[] {
        return Array.from(this.skills.values());
    }

    public unregisterSkill(id: string) {
        this.skills.delete(id);
        console.log(`[SkillRegistry] Unregistered skill: ${id}`);
    }
}

export const skillRegistry = new SkillRegistry();
