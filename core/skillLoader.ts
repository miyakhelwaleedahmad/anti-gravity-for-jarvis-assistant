/**
 * core/skillLoader.ts  (v2 — real AgentTool integration)
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans the skills/ folder, loads each skill's description.json,
 * wraps it as an AgentTool, and registers it directly into toolRegistryV2.
 *
 * Each skill directory must contain:
 *   - description.json  { id, name, description, parameters }
 *   - skill.js          (compiled output) with a default export: SkillModule
 *
 * SkillModule shape:
 *   { execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string> }
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { toolRegistryV2 } from './toolRegistryV2.js';
import type { AgentTool } from './toolRegistryV2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SkillDescription {
  id: string;
  name: string;
  description: string;
  riskLevel?: 'low' | 'medium' | 'high';
  parameters?: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description: string;
    required?: boolean;
  }>;
  fallbacks?: string[];
}

export interface SkillModule {
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export class SkillLoader {
  private skillsDir: string;
  private loadedCount = 0;
  private failedCount = 0;
  private metadataCache = new Map<string, SkillDescription>();
  private moduleCache = new Map<string, SkillModule>();
  /** Phase 5: tracks skills that failed to load so callers get a clear error */
  private degradedSkills = new Set<string>();
  /** Phase 5: max ms to wait for a skill module import() before giving up */
  private readonly IMPORT_TIMEOUT_MS = 5_000;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  async loadSkills(): Promise<number> {
    if (!fs.existsSync(this.skillsDir)) {
      console.warn(`[SkillLoader] Skills directory not found: ${this.skillsDir}`);
      return 0;
    }

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    const subDirs = entries.filter(e => e.isDirectory()).map(e => path.join(this.skillsDir, e.name));

    await Promise.all(subDirs.map(dirPath => this.loadSkillFromDirectory(dirPath)));

    if (this.failedCount > 0) {
      console.warn(`[SkillLoader] ⚠️  ${this.failedCount} skill(s) failed to load and are marked degraded.`);
    }
    console.log(`[SkillLoader] ✅ Loaded ${this.loadedCount} skill(s) into ToolRegistry.`);
    return this.loadedCount;
  }

  private async loadSkillFromDirectory(dirPath: string): Promise<void> {
    const descPath = path.join(dirPath, 'description.json');

    if (!fs.existsSync(descPath)) return;

    let desc: SkillDescription;
    if (this.metadataCache.has(descPath)) {
      desc = this.metadataCache.get(descPath)!;
    } else {
      try {
        const raw = fs.readFileSync(descPath, 'utf-8');
        desc = JSON.parse(raw);
        if (!desc.id || !desc.name) {
          console.warn(`[SkillLoader] Skipping ${dirPath}: description.json missing 'id' or 'name'`);
          return;
        }
        this.metadataCache.set(descPath, desc);
      } catch (err) {
        console.error(`[SkillLoader] Failed to parse description.json in ${dirPath}:`, err);
        return;
      }
    }

    // Determine target module file path
    const jsPath = path.join(dirPath, 'skill.js');
    const tsPath = path.join(dirPath, 'skill.ts');
    let targetPathToImport = '';

    const isTypeScriptMode = process.execArgv.some(arg => arg.includes('ts-node') || arg.includes('tsx')) || 
                             process.argv[1]?.endsWith('.ts') || 
                             import.meta.url.endsWith('.ts');

    if (isTypeScriptMode && fs.existsSync(tsPath)) {
      targetPathToImport = tsPath;
    } else if (fs.existsSync(jsPath)) {
      targetPathToImport = jsPath;
    } else if (fs.existsSync(tsPath)) {
      targetPathToImport = tsPath;
    } else {
      console.warn(`[SkillLoader] ${desc.name}: no skill.js or skill.ts found in ${dirPath}. Skipping.`);
      return;
    }

    // Lazy load handler function with Phase 5 import timeout
    const skillName = desc.name;
    const getOrImportModule = async (): Promise<SkillModule | null> => {
      if (this.moduleCache.has(targetPathToImport)) {
        return this.moduleCache.get(targetPathToImport)!;
      }

      // Phase 5: race import() against a timeout to prevent hanging loads
      let mod: any;
      try {
        const importPromise = import(pathToFileURL(targetPathToImport).href);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`import timeout after ${this.IMPORT_TIMEOUT_MS}ms`)), this.IMPORT_TIMEOUT_MS)
        );
        mod = await Promise.race([importPromise, timeoutPromise]);
      } catch (err) {
        console.warn(`[SkillLoader] ${skillName}: failed to import skill module:`, err);
        this.degradedSkills.add(skillName);
        return null;
      }

      let skillModule: SkillModule | null = null;
      if (typeof mod?.default?.execute === 'function') {
        skillModule = mod.default as SkillModule;
      } else if (typeof mod?.execute === 'function') {
        skillModule = mod as SkillModule;
      }
      if (skillModule) {
        this.moduleCache.set(targetPathToImport, skillModule);
        return skillModule;
      }
      console.warn(`[SkillLoader] ${skillName}: module loaded but missing execute() export.`);
      this.degradedSkills.add(skillName);
      return null;
    };

    // Phase 5: capture degradedSkills by closure reference (execute() has its own `this`)
    const degradedSkillsRef = this.degradedSkills;

    // Build AgentTool from description with lazy module resolution
    const tool: AgentTool = {
      name: desc.id,
      description: desc.description || desc.name,
      riskLevel: desc.riskLevel ?? 'medium',
      inputSchema: Object.fromEntries(
        Object.entries(desc.parameters ?? {}).map(([key, p]) => [
          key,
          {
            type: p.type,
            description: p.description,
            required: p.required ?? false,
          },
        ])
      ),
      fallbacks: desc.fallbacks ?? [],

      async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
        // Phase 5: fast-fail for degraded skills
        if (degradedSkillsRef.has(skillName)) {
          return `Error: Skill "${skillName}" is degraded and cannot execute. Check logs for import errors.`;
        }
        const mod = await getOrImportModule();
        if (!mod) {
          return `Error: Skill "${desc.name}" module could not be loaded.`;
        }
        return mod.execute(args, signal);
      },
    };

    toolRegistryV2.register(tool);
    this.loadedCount++;
  }

  /** Phase 5: check if a skill is degraded by name */
  private _isSkillDegraded(name: string): boolean {
    return this.degradedSkills.has(name);
  }

  /** Phase 5: returns a summary of skill health */
  getHealthSummary(): { loaded: number; failed: number; degraded: string[] } {
    return {
      loaded: this.loadedCount,
      failed: this.failedCount,
      degraded: [...this.degradedSkills],
    };
  }
}
