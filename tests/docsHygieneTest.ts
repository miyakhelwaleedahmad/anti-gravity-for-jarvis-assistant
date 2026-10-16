/**
 * tests/docsHygieneTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-08: documentation and leftovers that misled readers.
 *
 *   1. no live source suggests a W:\ folder (the owner's old drive): the
 *      Chrome hints say %USERPROFILE%\jarvis-chrome-profile, as .env.example
 *   2. every file a requirements.txt comment names exists
 *   3. the README's tool count is the number of tools that register
 *   4. the dead Python stubs (only scaffold.ps1 referred to them) and
 *      scaffold.ps1 itself are in _legacy/, not in the live tree
 *   5. the pre-September reports are in docs/history/, not at the root
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Documentation and leftovers (ARCH-08) ===\n');

const live: string[] = [];
(function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '_legacy', 'tests', 'docs', 'dist', '.venv'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.ts')) live.push(p);
  }
})(repo);
const wDrive = live.filter((f) => /W:\\\\|W:\//.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(repo, f));
ok('no live source suggests a W:\\ folder', wDrive.length === 0, wDrive.join(', '));

const named = [...fs.readFileSync(path.join(repo, 'requirements.txt'), 'utf8').matchAll(/\(([\w./-]+\.py)\)/g)].map((m) => m[1]!);
const missing = named.filter((f) => !fs.existsSync(path.join(repo, f)) && !fs.readdirSync(repo, { recursive: true } as any).some((p: any) => String(p).endsWith(f)));
ok('every file a requirements.txt comment names exists', missing.length === 0, missing.join(', ') || `${named.length} named`);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();
const count = toolRegistryV2.names().length;
const readmeCounts = [...fs.readFileSync(path.join(repo, 'README.md'), 'utf8').matchAll(/(\d+) tools\b/g)].map((m) => Number(m[1]));
ok('the README\'s tool count is the number of tools that register', readmeCounts.length > 0 && readmeCounts.every((n) => n === count), `README: ${readmeCounts.join(', ') || 'none'}; registered: ${count}`);

const STUBS = ['agents/researchAgent.py', 'voice/wakeWord.py', 'bridge/pythonBridge.py', 'learning/improvementEngine.py', 'learning/mistakeAnalyzer.py',
  'memory/memoryIndexer.py', 'tools/browserTool.py', 'backend/memory/redis_client.py', 'backend/memory/test_redis.py', 'scaffold.ps1'];
const stillLive = STUBS.filter((f) => fs.existsSync(path.join(repo, f)));
const kept = STUBS.filter((f) => fs.existsSync(path.join(repo, '_legacy', f)));
ok('the dead Python stubs and scaffold.ps1 are out of the live tree', stillLive.length === 0, stillLive.join(', '));
ok('…kept in _legacy/ (moved, not deleted)', kept.length === STUBS.length, `${kept.length}/${STUBS.length}`);

const HISTORY = ['DEPENDENCY_CLEANUP_PROOF.md', 'JARVIS_FULL_PROJECT_AUDIT_REPORT.md', 'JARVIS_FULL_PROJECT_ERRORS_REPORT.md', 'JARVIS_LATENCY_AUDIT_2026.md',
  'JARVIS_PERFORMANCE_OPTIMIZATIONS_2026.md', 'JARVIS_PERFORMANCE_REPORT_2026.md', 'JARVIS_PHASE_2_YOUTUBE_VOICE_FIX_REPORT.md', 'JARVIS_PHASE_3_SECURITY_FIX_REPORT.md',
  'JARVIS_PHASE_4_PERFORMANCE_FIX_REPORT.md', 'JARVIS_STAGE_1_FOUNDATION_AUDIT.md', 'JARVIS_STAGE_1_FOUNDATION_ERRORS_REPORT.md',
  'JARVIS_STAGE_2_RUNTIME_PERFORMANCE_SECURITY_AUDIT.md', 'JARVIS_STAGE_2_RUNTIME_PERFORMANCE_SECURITY_ERRORS_REPORT.md', 'JARVIS_SYSTEM_HARDENING_REPORT.md',
  'JARVIS_SYSTEM_HEALTH_AUDIT.md', 'LEGACY_ARCHITECTURE_IMPORT_REPORT.md', 'jarvis_production_hardening_report.md', 'jarvis_system_audit.md', 'report.md',
  'jarvis_stability_report_2026-06-11T05-04-59-262Z.json'];
const atRoot = HISTORY.filter((f) => fs.existsSync(path.join(repo, f)));
const inHistory = HISTORY.filter((f) => fs.existsSync(path.join(repo, 'docs', 'history', f)));
ok('the pre-September reports are not at the root', atRoot.length === 0, atRoot.join(', '));
ok('…they are in docs/history/ (moved, not deleted)', inHistory.length === HISTORY.length, `${inHistory.length}/${HISTORY.length}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
