import * as fs from 'fs';

function fixImports(file: string, oldPrefix: string, newPrefix: string): void {
    if (!fs.existsSync(file)) return;
    let content = fs.readFileSync(file, 'utf8');
    
    // Replace imports like `import ... from '../toolRegistryV2.js'` 
    // with `import ... from '../core/toolRegistryV2.js'`
    const regex = new RegExp(`from\\s+['"]\\.\\.\\/([^'"]+)['"]`, 'g');
    content = content.replace(regex, `from '${newPrefix}/$1'`);

    fs.writeFileSync(file, content, 'utf8');
    console.log(`Fixed imports in ${file}`);
}

fixImports('tools/fileTool.ts', '../', '../core');
fixImports('tools/terminalTool.ts', '../', '../core');
fixImports('tools/webSearchTool.ts', '../', '../core');
