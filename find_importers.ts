import * as fs from 'fs';

const data = JSON.parse(fs.readFileSync('analysis.json', 'utf8'));

function findImporters(modulePath: string): string[] {
  const importers: string[] = [];
  const baseName = modulePath.replace(/\.(ts|js|py)$/, '');
  const simpleName = baseName.split('/').pop() || '';
  
  for (const [file, info] of Object.entries<any>(data)) {
    for (const imp of info.imports) {
      if (imp.includes(simpleName) || imp.includes(baseName)) {
        importers.push(file);
        break; // found one import
      }
    }
  }
  return importers;
}

const targets = [
  'core/toolExecutor.ts', 'execution/toolExecutor.ts',
  'core/tools/fileTool.ts', 'tools/fileTool.ts',
  'core/tools/terminalTool.ts', 'tools/terminalTool.ts',
  'core/tools/webSearchTool.ts', 'tools/webSearchTool.ts',
  'core/fileManager.ts', 'system/fileManager.ts',
  'core/reflectionEngine.ts', 'learning/reflectionEngine.py',
  'scheduler/taskScheduler.ts', 'autonomy/scheduler.ts'
];

const results: Record<string, string[]> = {};
for (const t of targets) {
  results[t] = findImporters(t);
}

console.log(JSON.stringify(results, null, 2));
