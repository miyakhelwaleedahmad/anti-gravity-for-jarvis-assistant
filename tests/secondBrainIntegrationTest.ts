/**
 * tests/secondBrainIntegrationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The second brain inside real JARVIS parts, against a disposable vault:
 *
 *   1. Errors: the real issue store mirrors an open issue into
 *      01 Active Errors; a verified resolution moves it to 02 Resolved Errors
 *      and, through the startup hook, becomes a lesson; an unverified one does
 *      not. A recurrence reopens it. The issue store stays the authority.
 *   2. The memory_brain tool through the tool registry: per-action risk,
 *      verification, each of the owner's commands.
 *   3. Routes for the nine spoken commands; existing routes unchanged.
 *   4. Retrieval during a task: the context builder includes the notes as
 *      data when relevant, and nothing without a vault.
 *   5. Facts JARVIS keeps (memoryManager.rememberFact) are filed in the vault.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-brain-int-')));
for (const dir of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
const vault = path.join(workspace, 'Vault');
fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
const ownerNote = '# Router\nThe router admin page is at the usual address; Cat6 cables run to the main PC.\n';
fs.writeFileSync(path.join(vault, 'Notes', 'Router.md'), ownerNote);
process.env['JARVIS_OBSIDIAN_VAULT'] = vault;
process.chdir(workspace);

const { issueStore } = await import('../core/issueStore.js');
const { secondBrain, startSecondBrain } = await import('../memory/secondBrain.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { TOOL_CATALOG } = await import('../core/toolCatalog.js');
const { matchDeterministicCommand, brainPayload } = await import('../core/deterministicRoutes.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const J = (...p: string[]) => path.join(vault, 'JARVIS', ...p);
const logs: string[] = [];
startSecondBrain((s) => logs.push(s), (fn) => { issueStore.onResolved(fn); });

// ── 1. Errors ────────────────────────────────────────────────────────────────
console.log('\n--- 1. Errors ---');
{
  ok('startup initialized the second brain', fs.existsSync(J('00 Index', 'JARVIS Memory Index.md')) && logs.some((l) => /Second brain ready/.test(l)), logs.join(' | '));
  const { issue } = issueStore.recordOccurrence({ component: 'browser:cdp', message: 'tab lookup timed out after reconnect', tool: 'get_browser_tabs' });
  issueStore.flush();
  const active = J('01 Active Errors', `${issue.issueId}.md`);
  ok('an open issue is mirrored into 01 Active Errors', fs.existsSync(active) && issue.obsidian?.syncStatus === 'synced', JSON.stringify(issue.obsidian));
  ok('the error note is a JARVIS note the brain recognizes', secondBrain.vault.readAny(vault, `JARVIS/01 Active Errors/${issue.issueId}.md`)?.managed === true);
  ok('an unknown source location is not invented', /UNKNOWN|location/i.test(fs.readFileSync(active, 'utf8')) && !/\.ts:\d+/.test(fs.readFileSync(active, 'utf8').split('## Recent')[0]!));
  issueStore.resolve(issue.issueId, { passed: false, evidence: 'tabs still not listed' });
  issueStore.flush();
  ok('a failed verification: still active, no lesson', issueStore.active().some((i) => i.issueId === issue.issueId) && fs.readdirSync(J('04 Lessons Learned')).filter((f) => !/Index/.test(f)).length === 0);
  issueStore.resolve(issue.issueId, { passed: true, evidence: 'get_browser_tabs listed 4 tabs after reconnect' });
  issueStore.flush();
  ok('verified: the note moves to 02 Resolved Errors', fs.existsSync(J('02 Resolved Errors', `${issue.issueId}.md`)) && !fs.existsSync(active));
  ok('resolved issues leave the active list but stay searchable', !issueStore.active().some((i) => i.issueId === issue.issueId) && issueStore.searchHistory('tab lookup').some((i) => i.issueId === issue.issueId));
  const lessons = fs.readdirSync(J('04 Lessons Learned')).filter((f) => !/Index/.test(f));
  ok('…and becomes a lesson with its evidence', lessons.length === 1 && /listed 4 tabs/.test(fs.readFileSync(J('04 Lessons Learned', lessons[0]!), 'utf8')), lessons.join(','));
  const again = issueStore.recordOccurrence({ component: 'browser:cdp', message: 'tab lookup timed out after reconnect', tool: 'get_browser_tabs' });
  issueStore.flush();
  ok('the same failure again reopens the same issue (recurrence counted)', again.issue.issueId === issue.issueId && again.reopened && again.issue.recurrenceCount === 1);
  ok('…and its note is back in 01 Active Errors', fs.existsSync(active) && !fs.existsSync(J('02 Resolved Errors', `${issue.issueId}.md`)));
}

// ── 2. The tool ──────────────────────────────────────────────────────────────
console.log('\n--- 2. The memory_brain tool ---');
registerAllTools();
{
  const meta = TOOL_CATALOG['memory_brain']!;
  ok('catalog: reads are risk 0, writes risk 1', meta.actions!['search']!.risk === 0 && meta.actions!['status']!.risk === 0 && meta.actions!['remember']!.risk === 1 && meta.actions!['organize']!.risk === 1 && meta.risk === 1);
  const run = async (action: string, value = '') => {
    const r = await toolRegistryV2.execute('memory_brain', { action, value });
    let body: any = {};
    try { body = JSON.parse(r.output); } catch { /* not JSON */ }
    return { r, body };
  };
  let x = await run('status');
  ok('"check your memory connection": connected', x.r.success && x.body.success && /connected/.test(x.body.message), x.r.output.slice(0, 200));
  x = await run('remember_preference', 'I want spoken answers in Urdu after 10 PM, always.');
  ok('"remember this preference": saved in Preferences and verified', x.body.success && /Preferences/.test(x.body.message) && x.r.verification?.status === 'verified', `${x.r.output.slice(0, 200)} / ${x.r.verification?.status}`);
  ok('…with the owner\'s casing kept', fs.readdirSync(J('03 Preferences')).some((f) => f.startsWith('I want spoken answers in Urdu after 10 PM')));
  x = await run('remember', 'my password is hunter2 and the api key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
  ok('a secret is refused, nothing written', !x.body.success && /passwords, keys or tokens/.test(x.body.message));
  x = await run('create_space', 'Attendance System');
  ok('"create a new memory space": folder created and verified', x.body.success && fs.existsSync(J('10 Attendance System', 'Attendance System Index.md')) && x.r.verification?.status === 'verified', x.r.output.slice(0, 200));
  x = await run('create_space', '../../evil');
  ok('a path as a space name is refused', !x.body.success && !fs.existsSync(path.join(workspace, 'evil')));
  x = await run('search', 'router cables');
  ok('"search your notes": finds the owner\'s note, as data', x.body.success && /Router/.test(x.body.message) && /<untrusted_context/.test(x.body.notes));
  ok('…and the owner\'s note is unchanged', fs.readFileSync(path.join(vault, 'Notes', 'Router.md'), 'utf8') === ownerNote);
  x = await run('find_error', 'tab lookup');
  ok('"find the last time this error happened": the issue, when and where', x.body.success && /The last time was/.test(x.body.message) && /browser:cdp/.test(x.body.message), x.body.message);
  x = await run('find_error', 'quokka meltdown');
  ok('…no invented match for an unknown error', /no record/.test(x.body.message));
  x = await run('lessons');
  ok('"what have you learned from previous failures": the verified fix', /listed 4 tabs/.test(x.body.message) || /lesson/.test(x.body.message), x.body.message);
  ok('refusals (a secret, a bad space name, an unknown action) are not recorded as JARVIS errors', !issueStore.active().some((i) => i.component === 'tool:memory_brain'), issueStore.active().map((i) => i.component).join(', '));
  x = await run('unresolved');
  ok('"show me unresolved errors": lists the reopened issue', /1 unresolved error/.test(x.body.message) && /browser:cdp/.test(x.body.message), x.body.message);
  x = await run('review_inbox');
  ok('"review and organize the memory inbox": reported', x.body.success && /Memory organized/.test(x.body.message) && /still in the Memory Inbox/.test(x.body.message), x.body.message);
  x = await run('init');
  ok('"initialize your second brain" again: nothing missing, nothing duplicated', x.body.success && /already initialized/.test(x.body.message), x.body.message);
  x = await run('bogus');
  ok('an unknown action is refused', !x.body.success);
}

// ── 3. Routes ────────────────────────────────────────────────────────────────
console.log('\n--- 3. Routes ---');
{
  const want: [string, string][] = [
    ['Initialize your second brain.', 'init'], ['Organize your memory.', 'organize'],
    ['Remember this preference: answers in Urdu after 10 PM.', 'remember_preference'],
    ['Create a new memory space for cooking recipes.', 'create_space'],
    ['Find the last time this error happened.', 'find_error'], ['What have you learned from previous failures?', 'lessons'],
    ['Show me unresolved errors.', 'unresolved'], ['Check your memory connection.', 'status'],
    ['Review and organize the Memory Inbox.', 'review_inbox'],
  ];
  for (const [p, a] of want) {
    const r = matchDeterministicCommand(p);
    ok(`"${p}" → memory_brain ${a}`, r?.type === 'memory_brain' && r.target === a, JSON.stringify(r));
  }
  ok('the preference text keeps its casing', brainPayload('Remember this preference: answers in Urdu after 10 PM.', 'remember_preference') === 'answers in Urdu after 10 PM.');
  for (const p of ['Remember this preference.', 'Create a new memory space for this subject.']) ok(`"${p}" (points at earlier context) is left to the planner`, matchDeterministicCommand(p) === null);
  for (const [p, t] of [['what are your open issues', 'repair_report'], ['do you have any errors', 'health_check'], ['check yourself', 'health_check'], ['heal yourself', 'heal']] as const) ok(`"${p}" keeps ${t}`, matchDeterministicCommand(p)?.type === t);
  ok('"show me open issues" (maybe a repository\'s) is not taken', matchDeterministicCommand('show me open issues') === null);
}

// ── 4. Retrieval during a task ───────────────────────────────────────────────
console.log('\n--- 4. Retrieval during a task ---');
const { memoryManager } = await import('../memory/memoryManager.js');
await memoryManager.init();
const { unifiedContextBuilder } = await import('../memory/unifiedContextBuilder.js');
{
  secondBrain.reset();
  const ctx = await unifiedContextBuilder.buildContext('In what language should spoken answers be after 10 PM in Urdu?', 'brain-int', { includeHeavy: true });
  ok('a planning context includes the relevant note, as data', /\[SECOND BRAIN NOTES\]/.test(ctx.mergedContext) && /<untrusted_context source="second_brain:obsidian">/.test(ctx.mergedContext) && /Urdu/.test(ctx.mergedContext), ctx.mergedContext.slice(-600));
  const light = await unifiedContextBuilder.buildContext('In what language should spoken answers be after 10 PM in Urdu?', 'brain-int-2', { includeHeavy: false });
  ok('a light (simple) context does not read the vault', !/SECOND BRAIN/.test(light.mergedContext));
  const saved = process.env['JARVIS_OBSIDIAN_VAULT'];
  delete process.env['JARVIS_OBSIDIAN_VAULT'];
  const none = await unifiedContextBuilder.buildContext('Urdu spoken answers after 10 PM language', 'brain-int-3', { includeHeavy: true });
  ok('no vault configured: no second-brain section', !/SECOND BRAIN/.test(none.mergedContext));
  process.env['JARVIS_OBSIDIAN_VAULT'] = saved;
}

// ── 5. Facts JARVIS keeps ────────────────────────────────────────────────────
console.log('\n--- 5. Facts JARVIS keeps ---');
{
  await memoryManager.rememberFact('The attendance project deadline for the camera milestone is the end of November.', 'conversation', 6);
  await memoryManager.rememberFact('Startup check passed', 'system', 9);
  await memoryManager.rememberFact('A low-importance aside about the weather today in the project room', 'conversation', 3);
  await sleep(300);
  const projects = fs.readdirSync(J('06 Projects and Tasks')).filter((f) => !/Index/.test(f));
  ok('an owner fact of importance ≥ 5 is filed in the fitting space', projects.some((f) => /attendance project deadline/i.test(f)), projects.join(', '));
  const all = secondBrain.vault.listNotes(vault, 'JARVIS').join('\n');
  ok('a system fact is not filed', !/Startup check passed/.test(all));
  ok('a low-importance fact is not filed', !/weather today/.test(all));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { issueStore.flush(); } catch { /* best effort */ }
try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
