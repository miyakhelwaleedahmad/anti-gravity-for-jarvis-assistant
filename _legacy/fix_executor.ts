import * as fs from 'fs';

const executorPath = 'execution/actionExecutor.ts';
if (fs.existsSync(executorPath)) {
    let content = fs.readFileSync(executorPath, 'utf-8');

    content = content.replace(
        /import \{ toolExecutor \} from '\.\/toolExecutor\.js';/g,
        `import { toolRegistryV2 } from '../core/toolRegistryV2.js';`
    );

    content = content.replace(
        /const executePromise = toolExecutor\.execute\(data\.toolName, data\.args\);/g,
        `// Using toolRegistryV2 natively instead of deprecated facade
            const resultObj = await toolRegistryV2.execute(data.toolName, data.args);
            const result = resultObj.success ? resultObj.output : \`Error: \${resultObj.error}\`;
            const executePromise = Promise.resolve(result);`
    );

    fs.writeFileSync(executorPath, content, 'utf-8');
}

if (fs.existsSync('execution/toolExecutor.ts')) {
    fs.unlinkSync('execution/toolExecutor.ts');
}

console.log('ActionExecutor updated, toolExecutor removed.');
