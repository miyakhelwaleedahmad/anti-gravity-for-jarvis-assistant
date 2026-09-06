import { fileReadTool, fileWriteTool } from '../tools/fileTool.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== File Tool Workspace Safety Test ===\n');

const traversalRead = await fileReadTool.execute({ filePath: '..\\package.json' });
ok('read_file blocks path traversal', traversalRead.startsWith('Error: read_file denied'));

const outsideRead = await fileReadTool.execute({ filePath: 'C:\\Windows\\win.ini' });
ok('read_file blocks external absolute path', outsideRead.startsWith('Error: read_file denied'));

const traversalWrite = await fileWriteTool.execute({ filePath: '..\\outside.txt', content: 'nope' });
ok('write_file blocks path traversal', traversalWrite.startsWith('Error: write_file denied'));

const systemWrite = await fileWriteTool.execute({ filePath: 'C:\\Windows\\Temp\\jarvis.txt', content: 'nope' });
ok('write_file blocks Windows system folder', systemWrite.startsWith('Error: write_file denied'));

const executableWrite = await fileWriteTool.execute({ filePath: 'data\\unsafe-test.exe', content: 'nope' });
ok('write_file blocks executable extension', executableWrite.startsWith('Error: write_file denied'));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
