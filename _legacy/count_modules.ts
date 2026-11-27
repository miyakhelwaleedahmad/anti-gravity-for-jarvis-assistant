import * as fs from 'fs';
import * as path from 'path';

const root: string = process.cwd();
const ignoreDirs: string[] = ['node_modules', '.git', 'dist', 'build', '.gemini', 'venv', '.venv', 'env'];

let tsCount: number = 0;
let pyCount: number = 0;
const folders: Set<string> = new Set();
const agents: Set<string> = new Set();
const tools: Set<string> = new Set();
const memory: Set<string> = new Set();
const planning: Set<string> = new Set();
const reasoning: Set<string> = new Set();
const voice: Set<string> = new Set();
const vision: Set<string> = new Set();
const selfHealing: Set<string> = new Set();
const security: Set<string> = new Set();

function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (ignoreDirs.includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
            folders.add(entry.name);
            walk(fullPath);
        } else {
            if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                tsCount++;
                categorize(fullPath, entry.name);
            } else if (entry.name.endsWith('.py')) {
                pyCount++;
                categorize(fullPath, entry.name);
            }
        }
    }
}

function categorize(fullPath: string, name: string): void {
    const p = fullPath.toLowerCase();
    if (p.includes('agent') && !p.includes('state')) agents.add(name);
    if (p.includes('tool')) tools.add(name);
    if (p.includes('memory') || p.includes('context')) memory.add(name);
    if (p.includes('plan') || p.includes('goal')) planning.add(name);
    if (p.includes('reason') || p.includes('grok') || p.includes('prompt')) reasoning.add(name);
    if (p.includes('voice') || p.includes('stt') || p.includes('tts') || p.includes('wake')) voice.add(name);
    if (p.includes('vision') || p.includes('screen')) vision.add(name);
    if (p.includes('self_healing') || p.includes('repair') || p.includes('recover') || p.includes('failure')) selfHealing.add(name);
    if (p.includes('secur') || p.includes('approv') || p.includes('validat') || p.includes('sandbox')) security.add(name);
}

walk(root);

console.log(JSON.stringify({
    tsCount,
    pyCount,
    foldersCount: folders.size,
    agents: agents.size,
    tools: tools.size,
    memory: memory.size,
    planning: planning.size,
    reasoning: reasoning.size,
    voice: voice.size,
    vision: vision.size,
    selfHealing: selfHealing.size,
    security: security.size
}, null, 2));
