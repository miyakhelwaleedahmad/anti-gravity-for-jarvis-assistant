// Measures how long the first import of each skill module takes (cold, in one process).
import { pathToFileURL } from 'node:url';
import path from 'node:path';
for (const name of process.argv.slice(2)) {
  const t = performance.now();
  await import(pathToFileURL(path.resolve('skills', name, 'skill.ts')).href);
  console.log(`${name}: ${(performance.now() - t).toFixed(0)} ms`);
}
process.exit(0);
