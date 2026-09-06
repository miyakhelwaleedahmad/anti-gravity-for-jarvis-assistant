import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../core/workspaceRoot.js';

const ROOT = getWorkspaceRoot();
const SOURCE_DIRS = [
  'bridge',
  'config',
  'control',
  'core',
  'memory',
  'monitoring',
  'perception',
  'security',
  'self_healing',
  'skills',
  'tests',
  'tools',
  'voice',
];

const IMPORT_RE = /\b(?:import\s+[^'"]*from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
const DEPENDENCIES = new Set(['next', 'react', 'react-dom']);

interface Hit {
  file: string;
  specifier: string;
}

function walk(dir: string, hits: Hit[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.venv' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, hits);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) continue;
    const content = fs.readFileSync(full, 'utf8');
    for (const match of content.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      const rootSpecifier = specifier.split('/')[0];
      if (DEPENDENCIES.has(rootSpecifier)) {
        hits.push({ file: path.relative(ROOT, full), specifier });
      }
    }
  }
}

const hits: Hit[] = [];
for (const dir of SOURCE_DIRS) {
  walk(path.join(ROOT, dir), hits);
}

console.log('\n=== Dependency Import Check ===\n');
for (const hit of hits) {
  console.log(`  ${hit.file} -> ${hit.specifier}`);
}

const nextHits = hits.filter(hit => hit.specifier === 'next' || hit.specifier.startsWith('next/'));
const reactHits = hits.filter(hit => hit.specifier === 'react' || hit.specifier.startsWith('react/'));
const reactDomHits = hits.filter(hit => hit.specifier === 'react-dom' || hit.specifier.startsWith('react-dom/'));

console.log(`\nnext imports: ${nextHits.length}`);
console.log(`react imports: ${reactHits.length}`);
console.log(`react-dom imports: ${reactDomHits.length}`);

// The orphan `app/api/memory/route.ts` — which exposed unauthenticated
// arbitrary-key Redis read/write to anyone who started a Next server — has been
// deleted, along with the five dependencies only it used. This check now guards
// the reverse: nothing may reintroduce those imports without also restoring the
// dependencies to package.json.
const strays = [...nextHits, ...reactHits, ...reactDomHits];
if (strays.length > 0) {
  console.error('Unexpected next/react imports — these dependencies were removed from package.json:');
  for (const s of strays) console.error(`  ${s.file} -> ${s.specifier}`);
  process.exit(1);
}

console.log('\nResult: no next/react/react-dom imports remain; the dependencies stay removed.');
