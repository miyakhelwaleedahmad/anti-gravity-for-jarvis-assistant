/**
 * tests/spokenTextTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-13: voice answers were too long and read markdown out. A numbered list
 * with **bold** was spoken marker by marker, the 3-sentence cap ran on each
 * streamed chunk instead of the whole reply, and senders that call
 * nodeBridge.speakToClients directly skipped the cleanup.
 *
 *   1. stripMarkdown: no markers or ** in what is said; a list item is a sentence.
 *   2. speakableStream: whatever the chunking, the spoken text only grows
 *      (the stream code takes the new part by index).
 *   3. SpokenStream: a long streamed reply says 3 sentences and the console
 *      note once; the console gets the full text.
 *   4. speakToClients cleans every sender's text; both orchestrator streams
 *      use SpokenStream.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const { stripMarkdown, speakableStream, SpokenStream, CONSOLE_NOTE } = await import('../core/spokenText.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length;

const LIST = 'Here are three songs, sir:\n1. **Sanam Re** by Arijit Singh\n2. **Tum Hi Ho**\n- `Kesariya`\n## More\nSay the word and I will play one.';

console.log('\n--- 1. stripMarkdown ---');
{
  const s = stripMarkdown(LIST);
  ok('no ** , backticks or heading marks are read out', !/[*`#]/.test(s), s);
  ok('no list numbers or bullets are read out', !/(^|\s)(?:\d\.|-)\s/.test(s), s);
  ok('each list item is its own sentence', s.includes('Sanam Re by Arijit Singh. Tum Hi Ho. Kesariya. More.'), s);
  ok('plain text is left as it is', stripMarkdown('Opening Chrome, sir.') === 'Opening Chrome, sir.');
  ok('<think> blocks are dropped', stripMarkdown('<think>plan</think>Done, sir.') === 'Done, sir.');
  ok('[text](url) is read as its text', stripMarkdown('See [the docs](https://x.y/z).') === 'See the docs.');
  ok('numbers that are not list markers stay', stripMarkdown('It costs 1.5 dollars and 12 apples.') === 'It costs 1.5 dollars and 12 apples.');
}

console.log('\n--- 2. speakableStream only grows ---');
{
  let grows = true;
  let where = '';
  for (const size of [1, 2, 3, 5, 7, 11]) {
    let prev = '';
    for (let i = size; i <= LIST.length + size; i += size) {
      const cur = speakableStream(LIST.slice(0, i));
      if (!cur.startsWith(prev)) { grows = false; where = `chunk ${size} at ${i}: "${prev}" → "${cur}"`; break; }
      prev = cur;
    }
  }
  ok('the text spoken so far never changes as more arrives', grows, where);
  const done = speakableStream(LIST);
  ok('…and the finished stream has no markers', !/[*`]|(^|\n)\s*(?:\d\.|-|##)\s/.test(done), done);
}

console.log('\n--- 3. SpokenStream: one cap for the whole reply ---');
{
  const reply = 'First point. Second point. Third point. Fourth point. Fifth point. Sixth point.';
  const said: string[] = [];
  let printed = '';
  const s = new SpokenStream((t) => said.push(t), (t) => { printed += t; });
  for (let i = 0; i < reply.length; i += 9) s.push(reply.slice(i, i + 9));
  s.end();
  const words = said.filter((t) => t !== CONSOLE_NOTE).join(' ');
  ok('a six-sentence streamed reply says three sentences', sentences(words) === 3, JSON.stringify(said));
  ok('…then the console note, once', said.filter((t) => t === CONSOLE_NOTE).length === 1 && said[said.length - 1] === CONSOLE_NOTE, JSON.stringify(said));
  ok('the console gets the full reply', printed === reply, printed);

  const short: string[] = [];
  const s2 = new SpokenStream((t) => short.push(t));
  for (const c of ['Opening ', 'Chrome, ', 'sir.']) s2.push(c);
  s2.end();
  ok('a short reply is said in full, with no console note', short.join(' ') === 'Opening Chrome, sir.', JSON.stringify(short));

  const list: string[] = [];
  const s3 = new SpokenStream((t) => list.push(t));
  for (let i = 0; i < LIST.length; i += 4) s3.push(LIST.slice(i, i + 4));
  s3.end();
  ok('a streamed list is spoken without markers', !/[*`#]|(^|\s)\d\.\s/.test(list.join(' ')), JSON.stringify(list));
}

console.log('\n--- 4. Every sender ---');
{
  const { nodeBridge } = await import('../bridge/nodeBridge.js');
  const bridge = nodeBridge as any;
  const realReady = bridge.readyClients;
  bridge.readyClients = new Map();   // no TTS client: the phrase waits in pendingTTS
  bridge.pendingTTS = [];
  nodeBridge.speakToClients('Goal done, sir:\n1. **Report** written\n2. `tests` passed');
  const queued: string = bridge.pendingTTS[bridge.pendingTTS.length - 1] ?? '';
  ok('speakToClients (goal and agent messages) removes markers too', queued === 'Goal done, sir: Report written. tests passed', queued);
  bridge.pendingTTS = [];
  bridge.readyClients = realReady;

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const orch = fs.readFileSync(path.join(root, 'core', 'orchestrator.ts'), 'utf8');
  ok('both orchestrator streams (direct chat, synthesis) speak through SpokenStream', (orch.match(/new SpokenStream\(/g) ?? []).length === 2 && !/speakBuffer/.test(orch));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
