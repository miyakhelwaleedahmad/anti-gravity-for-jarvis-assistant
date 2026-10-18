/**
 * tests/issueStoreTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-healing Phase 2: one failure signature for every layer, and a
 * persistent issue record with every occurrence.
 *
 *   1. Signatures: volatile parts (numbers, ids, paths, quoted values) do not
 *      split one failure in two; different failures stay different; one
 *      category taxonomy.
 *   2. Source locations from a real thrown error in this file (file, line,
 *      column, function, commit); EXTERNAL and UNKNOWN when it is not JARVIS's
 *      code or there is no stack, never a guessed line; Python tracebacks.
 *   3. Occurrences: each has its own time, correlation id (or UNKNOWN),
 *      task/goal id and location, appended to occurrences.jsonl; three of the
 *      same failure are one active issue with three occurrences.
 *   4. Lifecycle: resolved only with evidence, leaves the active queue, stays
 *      searchable; the same failure again reopens it and counts a recurrence;
 *      an illegal transition throws; a ledger success resolves a runtime
 *      issue of that pipeline but not a code defect.
 *   5. Persistence: a new store reads the issues back; a corrupt file is set
 *      aside, not lost; a file of an unknown schema is never overwritten.
 *   6. Redaction: a key in a message never reaches the files.
 *   7. Obsidian mirror: off by default; writes to its own folder, moves to
 *      Resolved/, never overwrites a note it did not write.
 *   8. The three classifiers (service, reflection, goal recovery) give the
 *      same failure the same signature, and the real tool registry, ledger
 *      and failure detector record occurrences.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-issue-store-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
delete process.env['JARVIS_OBSIDIAN_VAULT'];

const { failureSignature, normalizeMessage, categorize } = await import('../core/failureSignature.js');
const { sourceLocationOf, parseStack, REPO_ROOT, currentCommit } = await import('../core/sourceLocation.js');
const { IssueStore } = await import('../core/issueStore.js');
const { HealthLedger } = await import('../monitoring/healthLedger.js');
const { mirrorIssue } = await import('../core/obsidianMirror.js');
const { beginTrace, endTrace } = await import('../core/traceContext.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

// ── 1. Signatures ────────────────────────────────────────────────────────────
console.log('\n--- 1. Failure signatures ---');
const a = failureSignature({ component: 'tool:run_tests', message: 'Command timed out after 5012 ms (pid 4411) in /home/x/proj/a.ts' });
const b = failureSignature({ component: 'tool:run_tests', message: 'Command timed out after 4987 ms (pid 92) in /tmp/other/b.ts' });
ok('numbers, pids and paths do not split one failure', a.id === b.id, `${a.normalized} | ${b.normalized}`);
const c = failureSignature({ component: 'tool:run_tests', message: 'connect ECONNREFUSED 127.0.0.1:9222' });
ok('a different failure has a different signature', c.id !== a.id);
const d = failureSignature({ component: 'tool:open_app', message: 'Command timed out after 5012 ms (pid 4411) in /home/x/proj/a.ts' });
ok('the same message in another component is another failure', d.id !== a.id);
ok('quoted values and ids are replaced', normalizeMessage(`Cannot read 'foo' of goal-abc123 at 0xdeadbeef`) === 'cannot read <q> of <id> at <hex>', normalizeMessage(`Cannot read 'foo' of goal-abc123 at 0xdeadbeef`));
ok('signature id shape', /^sig-[0-9a-f]{12}$/.test(a.id), a.id);
ok('category: TypeError is a code defect', categorize("TypeError: Cannot read properties of undefined (reading 'x')") === 'code_defect');
ok('category: 429 is external', categorize('Groq API error 429: rate limit reached') === 'external');
ok('category: permission denied is permission', categorize('Permission denied by the owner') === 'permission');
ok('category: missing module is environment', categorize("ModuleNotFoundError: No module named 'edge_tts'") === 'environment');
ok('category: timeout is runtime', categorize('tts timed out') === 'runtime');
ok('category: nothing recognisable is unknown', categorize('something odd happened') === 'unknown');

// ── 2. Source locations ──────────────────────────────────────────────────────
console.log('\n--- 2. Source locations ---');
function throwsHere(): Error {
  try { throw new TypeError('boom from the test'); } catch (e) { return e as Error; }   // THROW_LINE
}
const thrown = throwsHere();
const testFile = 'tests/issueStoreTest.ts';
const throwLine = fs.readFileSync(path.join(REPO_ROOT, testFile), 'utf8').split('\n').findIndex((l) => l.includes('// THROW_LINE')) + 1;
const here = sourceLocationOf(thrown);
ok('KNOWN: repository-relative file of the throw', here.status === 'KNOWN' && here.file === testFile, JSON.stringify(here));
ok('…the exact line', here.line === throwLine, `got ${here.line}, expected ${throwLine}`);
ok('…a column and the function', typeof here.column === 'number' && here.symbol === 'throwsHere', `${here.column} ${here.symbol}`);
ok('…the commit the line refers to', here.commit === currentCommit() && (here.commit === 'unknown' || /^[0-9a-f]{12}$/.test(here.commit)), here.commit);
const ext = new Error('socket hang up');
ext.stack = 'Error: socket hang up\n    at TLSSocket.onClose (node:_http_client:520:23)\n    at Object.parse (/opt/app/node_modules/undici/lib/core.js:10:5)';
const extLoc = sourceLocationOf(ext);
ok('EXTERNAL when every frame is outside JARVIS (Node, node_modules)', extLoc.status === 'EXTERNAL' && !extLoc.line && !!extLoc.reason, JSON.stringify(extLoc));
const nm = path.join(REPO_ROOT, 'node_modules', 'lowdb', 'lib', 'x.js');
ok('node_modules inside the repository is not JARVIS code', !parseStack(`Error\n    at f (${nm}:1:2)`)[0]!.inRepo);
const stripped = new Error('no stack'); stripped.stack = 'Error: no stack';
ok('UNKNOWN for an error without a readable stack', sourceLocationOf(stripped).status === 'UNKNOWN' && !!sourceLocationOf(stripped).reason);
ok('UNKNOWN for a failure reported as text', sourceLocationOf('tts timed out').status === 'UNKNOWN');
const py = `Traceback (most recent call last):\n  File "${path.join(REPO_ROOT, 'voice', 'tts.py')}", line 210, in speak\n    self._synth(text)\n  File "${path.join(REPO_ROOT, 'voice', 'tts.py')}", line 155, in _synth\n    raise RuntimeError("x")\nRuntimeError: x`;
const pyLoc = sourceLocationOf(py);
ok('Python traceback: the innermost frame in the repository', pyLoc.status === 'KNOWN' && pyLoc.file === 'voice/tts.py' && pyLoc.line === 155 && pyLoc.symbol === '_synth', JSON.stringify(pyLoc));
const pyExt = 'Traceback (most recent call last):\n  File "/usr/lib/python3.12/asyncio/base_events.py", line 664, in run\nOSError: x';
ok('Python traceback in the standard library: EXTERNAL', sourceLocationOf(pyExt).status === 'EXTERNAL');

// ── 3. Occurrences ───────────────────────────────────────────────────────────
console.log('\n--- 3. Occurrences and deduplication ---');
const dir = path.join(root, 'data', 'repairs');
function timesOut(): Error {
  return new Error('Command timed out after 5012 ms');   // PLAIN_LINE
}
const plain = timesOut();
const plainLine = fs.readFileSync(path.join(REPO_ROOT, testFile), 'utf8').split('\n').findIndex((l) => l.includes('// PLAIN_LINE')) + 1;
const store = new IssueStore();
ok('the store lives under the data root', store.dir() === dir, store.dir());
const trace1 = beginTrace('cli', 'run the tests');
const r1 = store.recordOccurrence({ component: 'tool:run_tests', tool: 'run_tests', message: 'Command timed out after 5012 ms', error: plain, taskId: 'task-1', goalId: 'goal-1' });
endTrace();
const r2 = store.recordOccurrence({ component: 'tool:run_tests', tool: 'run_tests', message: 'Command timed out after 4410 ms', correlationId: 'corr-two' });
const r3 = store.recordOccurrence({ component: 'tool:run_tests', tool: 'run_tests', message: 'Command timed out after 7000 ms' });
ok('three occurrences of one failure are one issue', r1.issue.issueId === r2.issue.issueId && r2.issue.issueId === r3.issue.issueId && store.active().length === 1);
ok('…counted three times', r3.issue.occurrenceCount === 3, String(r3.issue.occurrenceCount));
ok('…only the first is new', r1.isNew && !r2.isNew && !r3.isNew);
ok('occurrence: its own ISO time', !Number.isNaN(Date.parse(r1.occurrence.at)) && r1.occurrence.occurrenceId !== r2.occurrence.occurrenceId);
ok('occurrence: the current trace id when none is given', r1.occurrence.correlationId === trace1, `${r1.occurrence.correlationId} vs ${trace1}`);
ok('occurrence: an explicit correlation id', r2.occurrence.correlationId === 'corr-two');
ok('occurrence: UNKNOWN outside a request, not invented', r3.occurrence.correlationId === 'UNKNOWN');
ok('occurrence: task and goal ids', r1.occurrence.taskId === 'task-1' && r1.occurrence.goalId === 'goal-1');
ok('occurrence: file:line from the thrown error', r1.occurrence.source.status === 'KNOWN' && r1.occurrence.source.file === testFile && r1.occurrence.source.line === plainLine && r1.occurrence.source.symbol === 'timesOut', JSON.stringify(r1.occurrence.source));
const named = new IssueStore(path.join(root, 'scratch-named'));
ok('a thrown TypeError is recorded with its class, so every layer names it alike', named.recordOccurrence({ component: 'x', message: 'boom from the test', error: thrown }).occurrence.message === 'TypeError: boom from the test');
ok('occurrence: UNKNOWN location for a text-only report', r2.occurrence.source.status === 'UNKNOWN' && !r2.occurrence.source.line);
const onDisk = store.occurrencesOf(r1.issue.issueId);
ok('every occurrence is appended to occurrences.jsonl', onDisk.length === 3 && onDisk.map((o) => o.occurrenceId).join() === [r1, r2, r3].map((r) => r.occurrence.occurrenceId).join());
ok('the issue keeps first/last seen and correlation ids', r3.issue.firstSeen === r1.occurrence.at && r3.issue.lastSeen === r3.occurrence.at && r3.issue.correlationIds.join() === `${trace1},corr-two`);
ok('repeated occurrences raise severity', r3.issue.severity === 'high', r3.issue.severity);

// ── 4. Lifecycle ─────────────────────────────────────────────────────────────
console.log('\n--- 4. Lifecycle ---');
const id = r1.issue.issueId;
let threw = false;
try { store.transition(id, 'RESOLVED', 'just because'); } catch { threw = true; }
ok('cannot be marked resolved without verification', threw && store.get(id)!.status === 'OPEN');
threw = false;
try { store.resolve(id, { passed: true, evidence: '   ' }); } catch { threw = true; }
ok('resolve() needs evidence', threw && store.get(id)!.status === 'OPEN');
store.resolve(id, { passed: false, evidence: 'ran run_tests again: timed out' });
ok('a failed verification does not resolve; the issue stays active', store.get(id)!.status === 'OPEN' && store.get(id)!.verification?.passed === false);
threw = false;
try { store.transition(id, 'REPAIRING', 'skip ahead'); } catch { threw = true; }
ok('an illegal transition throws (OPEN → REPAIRING)', threw && store.get(id)!.status === 'OPEN');
store.resolve(id, { passed: true, evidence: 'ran run_tests again: finished in 3 s' });
ok('resolved with evidence: leaves the active queue', store.get(id)!.status === 'RESOLVED' && store.active().length === 0);
ok('…but stays searchable as history', store.searchHistory('timed out').some((i) => i.issueId === id));
const back = store.recordOccurrence({ component: 'tool:run_tests', tool: 'run_tests', message: 'Command timed out after 9999 ms' });
ok('the same failure again reopens the same issue', back.reopened && back.issue.issueId === id && back.issue.status === 'REOPENED');
ok('…and counts a recurrence (not a fresh start)', back.issue.recurrenceCount === 1 && back.issue.occurrenceCount === 4);
ok('…and is active again', store.active().some((i) => i.issueId === id));

const ledger = new HealthLedger();
store.attachLedger(ledger);
ledger.record('brain_to_tts', false, 'synthesis_failed: edge-tts timed out');
const ttsIssue = store.active().find((i) => i.pipeline === 'brain_to_tts');
ok('a ledger failure becomes an occurrence of its pipeline', !!ttsIssue && ttsIssue.category === 'runtime');
ledger.record('tool_execution', false, 'crash');
ok('…but not a tool failure (recorded where it happens, with its stack)', !store.active().some((i) => i.component === 'tool_execution'));
ledger.record('brain_to_tts', true, 'played (edge-tts)');
ok('the effect observed working resolves its runtime issue, with evidence', store.get(ttsIssue!.issueId)!.status === 'RESOLVED' && /played/.test(store.get(ttsIssue!.issueId)!.verification!.evidence));
const defect = store.recordOccurrence({ component: 'brain_to_llm', pipeline: 'brain_to_llm', message: "TypeError: Cannot read properties of undefined (reading 'choices')" });
ledger.record('brain_to_llm', true, 'chat answered');
ok('a suspected code defect is not resolved by one later success', store.get(defect.issue.issueId)!.status === 'OPEN');
store.transition(defect.issue.issueId, 'DIAGNOSING', 'reading the provider');
store.note(defect.issue.issueId, 'fact', 'the provider returned an empty body');
store.note(defect.issue.issueId, 'hypothesis', 'the response parser assumes choices[0]');
const dx = store.get(defect.issue.issueId)!.diagnosis;
ok('facts and hypotheses are kept apart', dx.facts.length === 1 && dx.hypotheses.length === 1);

// ── 5. Persistence ───────────────────────────────────────────────────────────
console.log('\n--- 5. Persistence ---');
store.flush();
const again = new IssueStore();
ok('a new store (a restart) reads the issues back', again.get(id)?.recurrenceCount === 1 && again.get(defect.issue.issueId)?.status === 'DIAGNOSING');
ok('…active and history both', again.active().length === store.active().length && again.all().length === store.all().length);
fs.writeFileSync(path.join(dir, 'issues.json'), '{ not json');
const afterCorrupt = new IssueStore();
ok('a corrupt file: the store starts empty and says why', afterCorrupt.all().length === 0 && /could not be read/.test(afterCorrupt.loadProblem ?? ''));
ok('…and the corrupt file is set aside, not deleted', fs.readdirSync(dir).some((f) => f.startsWith('issues.json.corrupt-')));
const future = JSON.stringify({ schemaVersion: 99, issues: [] });
fs.writeFileSync(path.join(dir, 'issues.json'), future);
const newer = new IssueStore();
newer.recordOccurrence({ component: 'service:stt', message: 'x' });
newer.flush();
ok('a file of an unknown schema version is never overwritten', fs.readFileSync(path.join(dir, 'issues.json'), 'utf8') === future && /schema version 99/.test(newer.loadProblem ?? ''));
fs.rmSync(path.join(dir, 'issues.json'));

// ── 6. Redaction ─────────────────────────────────────────────────────────────
console.log('\n--- 6. Redaction ---');
const secret = 'gsk_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4';
const leaky = new IssueStore();
leaky.recordOccurrence({ component: 'brain_to_llm', message: `401 Unauthorized for key ${secret}` });
leaky.flush();
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
ok('a key in a message reaches neither issues.json nor occurrences.jsonl', !files.includes(secret) && files.includes('REDACTED'));

// ── 7. Obsidian mirror ───────────────────────────────────────────────────────
console.log('\n--- 7. Obsidian mirror ---');
const issue = leaky.active()[0]!;
ok('off unless JARVIS_OBSIDIAN_VAULT is set', mirrorIssue(issue).syncStatus === 'disabled' && issue.obsidian?.syncStatus === 'disabled');
const vault = path.join(root, 'vault');
ok('a vault folder that does not exist: failed, not synced', mirrorIssue(issue, vault).syncStatus === 'failed');
fs.mkdirSync(vault);
const m1 = mirrorIssue(issue, vault);
const note = path.join(vault, 'JARVIS', 'Repairs', `${issue.issueId}.md`);
ok('writes its own note in JARVIS/Repairs', m1.syncStatus === 'synced' && m1.path === `JARVIS/Repairs/${issue.issueId}.md` && fs.existsSync(note));
const text = fs.readFileSync(note, 'utf8');
ok('…with the issue id, status and a redacted summary', text.includes(`jarvis_issue_id: ${issue.issueId}`) && text.includes('status: OPEN') && !text.includes(secret));
leaky.resolve(issue.issueId, { passed: true, evidence: 'chat answered with the new key' });
const m2 = mirrorIssue(issue, vault);
ok('resolved: moved to Resolved/, the open note removed', m2.syncStatus === 'synced' && fs.existsSync(path.join(vault, 'JARVIS', 'Repairs', 'Resolved', `${issue.issueId}.md`)) && !fs.existsSync(note));
const other = leaky.recordOccurrence({ component: 'service:wakeword', message: 'wake word model missing' }).issue;
const otherNote = path.join(vault, 'JARVIS', 'Repairs', `${other.issueId}.md`);
fs.writeFileSync(otherNote, '# My own note\n\nnot written by JARVIS\n');
const m3 = mirrorIssue(other, vault);
ok('a note JARVIS did not write is never overwritten: conflict', m3.syncStatus === 'conflict' && fs.readFileSync(otherNote, 'utf8') === '# My own note\n\nnot written by JARVIS\n');
fs.writeFileSync(otherNote, `---\r\njarvis_issue_id: ${other.issueId}\r\n---\r\nold\r\n`);
ok('…its own note saved with Windows line endings is still recognised', mirrorIssue(other, vault).syncStatus === 'synced');
process.env['JARVIS_OBSIDIAN_VAULT'] = vault;
leaky.flush();
ok('the store records the sync status on the issue', leaky.get(other.issueId)!.obsidian?.syncStatus === 'synced');
delete process.env['JARVIS_OBSIDIAN_VAULT'];

// ── 8. One signature across layers, recorded by the real components ──────────
console.log('\n--- 8. The classifiers and the real recording points ---');
const { classifyFailure: classifyService } = await import('../self_healing/failureClassifier.js');
const { goalFailureSignature, decideRecovery } = await import('../core/goalRecovery.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { reflectionEngine } = await import('../core/reflectionEngine.js');
const { TaskGraphBuilder } = await import('../core/taskGraphEngine.js');
const { agentMemory } = await import('../memory/agentMemory.js');
const { failureDetector } = await import('../self_healing/failureDetector.js');
const { issueStore, startIssueRecording } = await import('../core/issueStore.js');
const { healthLedger } = await import('../monitoring/healthLedger.js');
startIssueRecording(healthLedger);

const svcMsg = 'connect ECONNREFUSED 127.0.0.1:8765';
ok('service classifier: the shared signature', classifyService(svcMsg, 'tts').signature.id === failureSignature({ component: 'service:tts', message: svcMsg }).id);
const toolMsg = "TypeError: Cannot read properties of undefined (reading 'title')";
const shared = failureSignature({ component: 'tool:test_issue_crasher', tool: 'test_issue_crasher', message: toolMsg });
ok('goal recovery: the same tool failure has the same signature', goalFailureSignature({ tool: 'test_issue_crasher', message: toolMsg }).id === shared.id);
const decision = decideRecovery({ task: { attempts: 1, maxAttempts: 3, sideEffects: 'none' } as never, failure: { tool: 'test_issue_crasher', message: toolMsg }, cls: 'unrecoverable', now: Date.now() });
ok('…and decideRecovery carries it', decision.signature?.id === shared.id && decision.signature.category === 'code_defect', JSON.stringify(decision.signature));

function crash(): never {
  const o: { x?: { title: string } } = {};
  return (o.x as { title: string }).title as never;   // CRASH_LINE
}
const crashLine = fs.readFileSync(path.join(REPO_ROOT, testFile), 'utf8').split('\n').findIndex((l) => l.includes('// CRASH_LINE')) + 1;
toolRegistryV2.register({
  name: 'test_issue_crasher',
  description: 'Stand-in tool with a code defect.',
  riskLevel: 'low',
  meta: { category: 'SYSTEM', risk: 0, reversible: 'yes', external: 'none', effect: 'Reads nothing.', output: { format: 'text', description: 'Text' } },
  inputSchema: {},
  fallbacks: [],
  retryPolicy: { maxRetries: 0, baseDelayMs: 0 },
  async execute() { crash(); },
} as never);
const started = Date.now();
const res = await toolRegistryV2.execute('test_issue_crasher', {});
const crashIssue = issueStore.active().find((i) => i.component === 'tool:test_issue_crasher');
ok('a tool that throws: the registry records an occurrence', !res.success && !!crashIssue, JSON.stringify(res));
ok('…as a code defect, at the exact line that threw', crashIssue?.category === 'code_defect' && crashIssue.sourceLocation.status === 'KNOWN'
  && crashIssue.sourceLocation.file === testFile && crashIssue.sourceLocation.line === crashLine && crashIssue.sourceLocation.symbol === 'crash', JSON.stringify(crashIssue?.sourceLocation));
ok('…with the signature the other layers give it', crashIssue?.signature === shared.id, `${crashIssue?.signature} vs ${shared.id}`);
await toolRegistryV2.execute('test_issue_crasher', {});
ok('the same crash again: one issue, two occurrences', issueStore.active().filter((i) => i.component === 'tool:test_issue_crasher').length === 1 && issueStore.get(crashIssue!.issueId)!.occurrenceCount === 2);

const graph = TaskGraphBuilder.fromToolCalls('read the title', [{ id: 'c1', type: 'function', function: { name: 'test_issue_crasher', arguments: '{}' } }] as never);
for (const node of graph.nodes.values()) {
  node.status = 'failed';
  node.startedAt = started;
  node.error = `test_issue_crasher failed: ${toolMsg} (attempt 1)`;   // the task graph rewords it
  node.retryCount = node.maxRetries + 1;
}
const reflection = await reflectionEngine.reflect(graph, agentMemory);
ok('reflection names the failure with the registry\'s signature, not a reworded one', reflection.failureSignatures?.[0]?.id === crashIssue?.signature, JSON.stringify(reflection.failureSignatures));

const refusal = await toolRegistryV2.execute('test_no_such_tool', {});
ok('a refusal (unknown tool) is not recorded as a fault', !refusal.success && !issueStore.all().some((i) => i.component === 'tool:test_no_such_tool'));

failureDetector.reportError(new Error('edge-tts websocket closed'), 'tts');
const svcIssue = issueStore.active().find((i) => i.component === 'service:tts');
ok('failure detector: a service failure is recorded under its pipeline', svcIssue?.pipeline === 'brain_to_tts' && svcIssue.category === 'runtime', JSON.stringify(svcIssue && { p: svcIssue.pipeline, c: svcIssue.category }));
healthLedger.record('brain_to_tts', true, 'played (edge-tts)');
ok('…and resolved, with evidence, when speech is observed playing again', issueStore.get(svcIssue!.issueId)?.status === 'RESOLVED');
ok('the code defect stays open (one success elsewhere proves nothing about it)', issueStore.get(crashIssue!.issueId)?.status === 'OPEN');
issueStore.flush();
ok('the singleton writes under the data root', fs.existsSync(path.join(root, 'data', 'repairs', 'issues.json')));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
