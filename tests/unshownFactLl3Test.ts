/**
 * tests/unshownFactLl3Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review INDEPENDENT_REVIEW_FINAL_LOWS.md, LL-3 (owner decision 2026-11-28:
 * allow these characters where they belong). save_relation refuses a fact the
 * owner would not see exactly as stored (review M-1, final review L-2); its
 * rule also refused ordinary text that needs a joiner or a variation selector.
 *
 *   A  accepted now: ZWNJ/ZWJ between two letters of a script that uses them
 *      (Persian, Urdu, Devanagari, Sinhala, Malayalam), a Mongolian free
 *      variation selector after a Mongolian letter, ZWJ between emoji, U+FE0F
 *      or U+FE0E after an emoji (keycaps, ☎︎), the three subdivision flags
 *   B  still refused: the same characters anywhere else (between Latin
 *      letters, at the start or end, next to a space, between an emoji and a
 *      letter), tag letters that are not one of those flags, and every
 *      character the review found refused as intended
 *   C  what was accepted before is still accepted
 *
 * Calls unshownFact() directly; no model, no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unshown-ll3-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const { unshownFact } = await import('../core/tools/memoryTool.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const code = (s: string) => [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
/** The fact as save_relation builds it from its three parts. */
const check = (value: string) => unshownFact(['User', 'LIKES', value], `User LIKES ${value}`);
const accepted = (label: string, value: string) => { const r = check(value); ok(`${label}: accepted`, r === undefined, r ?? code(value)); };
const refused = (label: string, value: string) => { const r = check(value); ok(`${label}: refused`, r !== undefined && /invisible character/.test(r), r ?? `accepted: ${code(value)}`); };

const ZWNJ = '‌', ZWJ = '‍', VS15 = '︎', VS16 = '️', KEYCAP = '⃣';
const tags = (s: string) => [...s].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
const CANCEL = '\u{E007F}', BLACK_FLAG = '\u{1F3F4}';

console.log('\n=== Characters a fact may hold (LL-3) ===\n');

console.log('--- A. Accepted where they belong ---');
accepted('Persian with ZWNJ (می‌خواهم)', `می${ZWNJ}خواهم`);
accepted('Urdu with ZWNJ', `نا${ZWNJ}ممکن`);
accepted('Devanagari half form with ZWJ (क्‍ष)', `क्${ZWJ}ष`);
accepted('Devanagari with ZWNJ (क्‌ष)', `क्${ZWNJ}ष`);
accepted('Sinhala yansaya with ZWJ (ක්‍ය)', `ක්${ZWJ}ය`);
accepted('Malayalam old chillu with ZWJ at a word end (ന്‍)', `ന്${ZWJ}`);
accepted('Mongolian with a free variation selector', `ᠪ᠋ᠠ`);
accepted('family emoji 👨‍👩‍👧', `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`);
accepted('technologist with a skin tone 👩🏽‍💻', `\u{1F469}\u{1F3FD}${ZWJ}\u{1F4BB}`);
accepted('rainbow flag 🏳️‍🌈', `\u{1F3F3}${VS16}${ZWJ}\u{1F308}`);
accepted('keycap 1️⃣', `1${VS16}${KEYCAP}`);
accepted('keycap #️⃣', `#${VS16}${KEYCAP}`);
accepted('England flag', `${BLACK_FLAG}${tags('gbeng')}${CANCEL}`);
accepted('Scotland flag', `${BLACK_FLAG}${tags('gbsct')}${CANCEL}`);
accepted('telephone in text style ☎︎', `☎${VS15}`);

console.log('\n--- B. Still refused anywhere else ---');
refused('ZWNJ between Latin letters (pass‌word)', `pass${ZWNJ}word`);
refused('ZWJ between Latin letters', `ab${ZWJ}cd`);
refused('ZWNJ between Arabic and Latin letters', `م${ZWNJ}a`);
refused('ZWNJ at the start', `${ZWNJ}می`);
refused('ZWNJ before a space', `می${ZWNJ} خ`);
refused('two ZWNJ in a row between Persian letters', `می${ZWNJ}${ZWNJ}خ`);
refused('ZWJ between an emoji and a letter', `\u{1F468}${ZWJ}a`);
refused('ZWJ at the end after an emoji', `\u{1F468}${ZWJ}`);
refused('ZWJ at a Malayalam word end without a virama', `ന${ZWJ}`);
refused('a Mongolian free variation selector after a Latin letter', `a᠋`);
refused('U+FE0F after a plain letter', `a${VS16}`);
refused('U+FE0F twice after an emoji', `❤${VS16}${VS16}`);
refused('a stray U+FE0F', `${VS16}tea`);
refused('tag letters after the black flag that are not a subdivision flag (hidden "hello")', `${BLACK_FLAG}${tags('hello')}${CANCEL}`);
refused('tag letters hidden after an ordinary word', `tea${tags('gbeng')}${CANCEL}`);
refused('a black flag with tag letters but no cancel tag', `${BLACK_FLAG}${tags('gbeng')}`);
for (const [name, ch] of [['zero-width space', '​'], ['word joiner', '⁠'], ['Hangul filler U+3164', 'ㅤ'], ['halfwidth Hangul filler', 'ﾠ'],
  ['Hangul choseong filler', 'ᅟ'], ['blank Braille pattern', '⠀'], ['combining grapheme joiner', '͏'], ['Khmer vowel U+17B4', '឴'],
  ['variation selector-17', '\u{E0100}'], ['Mongolian vowel separator', '᠎'], ['Arabic letter mark', '؜'], ['soft hyphen', '­'], ['line feed', '\n']] as const) {
  refused(`${name} inside a word`, `te${ch}a`);
}

console.log('\n--- C. Accepted before, still accepted ---');
for (const [name, value] of [['accents', 'café'], ['combining accent', 'café'], ['Chinese', '中文'], ['Japanese', '日本語'], ['Korean', '한국어'],
  ['Arabic', 'العربية'], ['Urdu without ZWNJ', 'اردو'], ['Hindi conjunct', 'क्ष'], ['Hebrew with niqqud', 'שָׁלוֹם'],
  ['Thai', 'ภาษาไทย'], ['emoji', '☕'], ['heart with U+FE0F', `❤${VS16}`], ['copyright with U+FE0F', `©${VS16}`],
  ['skin tone', '\u{1F44D}\u{1F3FD}'], ['regional-indicator flag', '\u{1F1F5}\u{1F1F0}']] as const) {
  accepted(name, value);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
