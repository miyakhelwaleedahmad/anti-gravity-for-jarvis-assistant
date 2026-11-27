import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();

function replaceInFile(filePath: string, searchRegex: RegExp, replaceWith: string): void {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const newContent = content.replace(searchRegex, replaceWith);
    if (content !== newContent) {
        fs.writeFileSync(filePath, newContent, 'utf-8');
        console.log(`Updated ${filePath}`);
    }
}

function safeDelete(filePath: string): void {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted ${filePath}`);
    }
}

function safeMove(src: string, dest: string): void {
    if (fs.existsSync(src)) {
        const dir = path.dirname(dest);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        
        fs.renameSync(src, dest);
        console.log(`Moved ${src} to ${dest}`);
    }
}

// 1. Resolve core/toolExecutor.ts vs execution/toolExecutor.ts
replaceInFile('self_healing/selfHealingManager.ts', 
    /import \{ toolExecutor \} from "\.\.\/core\/toolExecutor\.js";/g, 
    `import { toolRegistryV2 } from "../core/toolRegistryV2.js";`
);
replaceInFile('self_healing/selfHealingManager.ts', 
    /toolExecutor\.reload\(\);/g, 
    `// toolRegistryV2.reload() not needed in V2`
);
safeDelete('core/toolExecutor.ts');

// 2. Resolve tools duplicates
safeMove('core/tools/fileTool.ts', 'tools/fileTool.ts');
safeMove('core/tools/terminalTool.ts', 'tools/terminalTool.ts');
safeMove('core/tools/webSearchTool.ts', 'tools/webSearchTool.ts');

replaceInFile('core/tools/index.ts', /\.\/webSearchTool\.js/g, '../../tools/webSearchTool.js');
replaceInFile('core/tools/index.ts', /\.\/fileTool\.js/g, '../../tools/fileTool.js');
replaceInFile('core/tools/index.ts', /\.\/terminalTool\.js/g, '../../tools/terminalTool.js');

// 3. Resolve fileManager duplicates
replaceInFile('system/codeGenerator.ts', /\.\/fileManager\.js/g, '../core/fileManager.js');
replaceInFile('tools/fileTool.ts', /\.\.\/system\/fileManager\.js/g, '../core/fileManager.js');
safeDelete('system/fileManager.ts');

// 4. Resolve reflectionEngine duplicates
safeDelete('learning/reflectionEngine.py');

// 5. Resolve scheduler duplicates
safeDelete('scheduler/taskScheduler.ts');
if (fs.existsSync('scheduler') && fs.readdirSync('scheduler').length === 0) {
    fs.rmdirSync('scheduler');
}

console.log("Phase 2 Duplications Removed.");
