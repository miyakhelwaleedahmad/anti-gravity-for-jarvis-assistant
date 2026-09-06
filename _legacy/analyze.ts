import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const ignoreDirs = ['node_modules', '.venv', '.vscode', '.git', 'dist', 'build', '.next'];

interface ExportInfo {
  type: string;
  name: string;
}

interface FileAnalysis {
  imports: string[];
  exports: ExportInfo[];
  lines: number;
  status: string;
  size: number;
}

function getFiles(dir: string, fileList: string[] = []): string[] {
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (ignoreDirs.includes(file)) continue;
      const filePath = path.join(dir, file);
      const stat = fs.lstatSync(filePath);
      if (stat.isDirectory()) {
        getFiles(filePath, fileList);
      } else if (stat.isFile()) {
        if (filePath.endsWith('.ts') || filePath.endsWith('.py')) {
          if (!filePath.endsWith('.d.ts')) {
             fileList.push(filePath);
          }
        }
      }
    }
  } catch (e) {
    // Ignore errors
  }
  return fileList;
}

const files = getFiles(root);
const map: Record<string, FileAnalysis> = {};

for (const f of files) {
  try {
    const content = fs.readFileSync(f, 'utf-8');
    const relativePath = path.relative(root, f).replace(/\\/g, '/');
    const imports: string[] = [];
    const lines = content.split('\n');
    let status = 'Active'; 
    if (content.match(/TODO:?\s*Implement/i) || content.match(/Not Implemented/i)) status = 'Partial';
    if (content.match(/DEPRECATED/i) || content.match(/unused/i)) status = 'Unused';
    
    const importRegexTs = /import\s+(?:.*?)\s+from\s+['"](.*?)['"]/g;
    const importRegexPy = /^(?:from\s+(.*?)\s+import|import\s+(.*?)(?:\s+as|$))/gm;
    
    let match;
    while ((match = importRegexTs.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = importRegexPy.exec(content)) !== null) {
      if (match[1]) imports.push(match[1]);
      if (match[2]) imports.push(match[2].split(',')[0].trim());
    }

    const exportsList: ExportInfo[] = [];
    const classRegex = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
    while ((match = classRegex.exec(content)) !== null) {
      exportsList.push({ type: 'class', name: match[1] });
    }
    
    const fnRegex = /export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g;
    while ((match = fnRegex.exec(content)) !== null) {
      exportsList.push({ type: 'function', name: match[1] });
    }

    const interfaceRegex = /export\s+interface\s+(\w+)/g;
    while ((match = interfaceRegex.exec(content)) !== null) {
      exportsList.push({ type: 'interface', name: match[1] });
    }

    map[relativePath] = {
      imports: [...new Set(imports)],
      exports: exportsList,
      lines: lines.length,
      status,
      size: content.length
    };
  } catch (e) {
    // Ignore errors
  }
}

fs.writeFileSync('analysis.json', JSON.stringify(map, null, 2));
console.log('Analysis written to analysis.json, files:', Object.keys(map).length);
