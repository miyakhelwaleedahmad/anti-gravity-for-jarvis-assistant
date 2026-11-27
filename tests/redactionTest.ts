/**
 * tests/redactionTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * security/redactor.ts: each kind of credential is replaced with a marker that
 * keeps its kind; ordinary text is left alone.
 *
 * Every "secret" here is built from repeated filler at run time, in the shape
 * of the real format. None is a real credential.
 */

let redactSecrets: ((text: string) => { text: string; count: number; kinds: string[] }) | undefined;
try { ({ redactSecrets } = await import('../security/redactor.js' as string)); } catch { /* not on the old code */ }

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const fill = (n: number, s = 'aB3') => s.repeat(Math.ceil(n / s.length)).slice(0, n);

console.log('\n=== Redaction Test ===\n');

if (!redactSecrets) {
  ok('security/redactor.ts exists', false);
} else {
  const cases: Array<[string, string, string]> = [
    ['Google key', `key is AIza${fill(35)} ok`, 'google-key'],
    ['Google AQ token', `token AQ.${fill(40)}`, 'google-key'],
    ['OpenAI-style key', `OPENAI sk-proj-${fill(40)}`, 'openai-key'],
    ['Groq key', `use gsk_${fill(40, 'xY7')}`, 'groq-key'],
    ['GitHub token', `ghp_${fill(36, 'Qw9')}`, 'github-token'],
    ['GitHub fine-grained token', `github_pat_${fill(50, 'Ab_1')}`, 'github-token'],
    ['AWS access key', `AKIA${'Q'.repeat(16)}`, 'aws-key'],
    ['Slack token', `xoxb-${fill(30, '12-')}`, 'slack-token'],
    ['JWT', `eyJ${fill(20)}.${fill(30)}.${fill(25)}`, 'jwt'],
    ['Bearer header', `Authorization: Bearer ${fill(32, 'z9')}`, 'bearer'],
    ['Cookie header', `Cookie: session=${fill(20)}; theme=dark`, 'cookie'],
    ['Set-Cookie header', `Set-Cookie: sid=${fill(20)}; HttpOnly`, 'cookie'],
    ['URL with a password', `https://admin:${fill(12)}@example.com/path`, 'url-credentials'],
    ['.env key line', `GEMINI_API_KEY=${fill(30)}`, 'env-secret'],
    ['.env token line', `export JARVIS_BRIDGE_TOKEN=${fill(24)}`, 'env-secret'],
    ['password in prose', `the password: ${fill(10)} works`, 'secret'],
    ['api_key in a command', `curl --data api_key=${fill(16)}`, 'secret'],
    ['JSON secret', `{"client_secret": "${fill(20)}"}`, 'secret'],
    ['a password said in words', `my wifi password is ${fill(10)} thanks`, 'secret'],
    // P13: names with words joined to them, inside a log line.
    ['a prefixed name in a log line', `Error: lost the database (DB_PASSWORD=${fill(14)})`, 'secret'],
    ['a long prefixed name', `started with AWS_SECRET_ACCESS_KEY=${fill(20)} set`, 'secret'],
    ['a camelCase name in JSON', `{"dbPassword":"${fill(14)}"}`, 'secret'],
    ['NAME: value', `env API_TOKEN: ${fill(16)}`, 'secret'],
  ];
  for (const [label, input, kind] of cases) {
    const r = redactSecrets(input);
    ok(`${label} → [REDACTED:${kind}]`, r.text.includes(`[REDACTED:${kind}]`) && r.count >= 1 && r.kinds.includes(kind), r.text);
  }

  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${fill(64)}\n${fill(64)}\n-----END RSA PRIVATE KEY-----`;
  const key = redactSecrets(`before\n${pem}\nafter`);
  ok('a private key block, all of it', key.text === 'before\n[REDACTED:private-key]\nafter', key.text);

  const bearer = redactSecrets(`Authorization: Bearer ${fill(32, 'z9')}`);
  ok('the header name stays', bearer.text === 'Authorization: Bearer [REDACTED:bearer]', bearer.text);
  const url = redactSecrets(`https://admin:${fill(12)}@example.com/path`);
  ok('the URL stays usable without the password', url.text === 'https://[REDACTED:url-credentials]@example.com/path', url.text);

  const two = redactSecrets(`a gsk_${fill(40, 'xY7')} and b ghp_${fill(36, 'Qw9')}`);
  ok('two secrets, two markers', two.count === 2 && two.kinds.length === 2, two.text);

  for (const plain of [
    'Open notepad and type hello world',
    'git status && npm run test',
    'The token limit is 4000 words; the key point is speed.',
    'C:\\Users\\me\\Documents\\notes.txt',
    'https://www.youtube.com/results?search_query=cats',
    'JARVIS_BRAIN_MODEL=gemini-3.5-flash',
    'usage max_tokens: 4096, inputTokens: 12, tokens: 1500',
  ]) {
    const r = redactSecrets(plain);
    ok(`unchanged: "${plain.slice(0, 40)}"`, r.text === plain && r.count === 0, r.text);
  }
  ok('empty text', redactSecrets('').text === '' && redactSecrets('').count === 0);

  // Long words with many separators used to take over a second (the URL rule).
  for (const [label, text] of [['dashes', 'ab-'.repeat(22_000)], ['dots', 'ab.'.repeat(22_000)], ['names', 'password-'.repeat(7_000)]] as const) {
    const t0 = performance.now();
    redactSecrets(text);
    const ms = Math.round(performance.now() - t0);
    ok(`64 KB of ${label} is redacted in under 300 ms`, ms < 300, `${ms} ms`);
  }

  // Text shortened before redaction: what is left of a key is still hidden.
  for (const cut of [`User [voice]: my key is gsk_${fill(9, 'xY7')}`, `token prefix AIza${fill(12)}…`, `line one\nsk-proj-${fill(8)}\nline three`]) {
    const r = redactSecrets(cut);
    ok(`a key cut short is hidden: "${cut.slice(0, 30).replace('\n', ' ')}…"`, r.kinds.includes('truncated-key') && !/gsk_x|AIzaa|sk-proj-a/i.test(r.text), r.text.replace('\n', ' '));
  }
  ok('…but a word that merely ends in such letters is not', redactSecrets('ask-help desk-top').count === 0);

  // Tool output is often JSON: it must stay parseable.
  const json = JSON.stringify({ success: true, token: fill(20), nested: { api_key: fill(16), note: 'ok' }, list: [`Bearer ${fill(20)}`] });
  const masked = redactSecrets(json).text;
  let parsed: any = null;
  try { parsed = JSON.parse(masked); } catch { /* invalid */ }
  ok('JSON stays valid JSON', parsed !== null, masked);
  ok('…with the values hidden', parsed?.token === '[REDACTED:secret]' && parsed?.nested?.api_key === '[REDACTED:secret]'
    && parsed?.nested?.note === 'ok' && parsed?.list?.[0] === 'Bearer [REDACTED:bearer]', masked);

  const { redactDeep } = await import('../security/redactor.js' as string);
  const entry = { tool: 'run_command', args: { command: `curl -H "Authorization: Bearer ${fill(24)}"` }, count: 3, ok: true, when: null };
  const deep = redactDeep(entry);
  let nested: any = { v: `gsk_${fill(30, 'xY7')}` };
  for (let i = 0; i < 20; i++) nested = { next: nested };
  ok('deeper than it walks: fails closed', JSON.stringify(redactDeep(nested)).includes('[REDACTED]') && !JSON.stringify(redactDeep(nested)).includes('gsk_'));
  ok('objects: every string redacted, other values kept',
    deep.args.command.includes('[REDACTED:bearer]') && deep.count === 3 && deep.ok === true && deep.when === null && entry.args.command.includes(fill(24)),
    JSON.stringify(deep));
}

console.log('\n--- JSON flags and numbers (the owner\'s Windows run) ---');
if (redactSecrets) {
  // ui_elements marks each element "password": true/false. Redacting the flag
  // left `"password": [REDACTED:secret]`, which is not JSON: the Notepad and
  // Calculator checks of pnpm verify:windows could not read the list.
  const elements = JSON.stringify({
    success: true,
    window: { hwnd: '197924', title: 'Untitled - Notepad', process: 'notepad' },
    elements: [
      { ref: 'u1', type: 'Edit', name: 'Text Editor', password: false, patterns: ['Value'], value: '' },
      { ref: 'u2', type: 'Edit', name: 'PIN', password: true, patterns: ['Value'], value: '' },
      { ref: 'u3', type: 'Button', name: 'Close', isPassword: false, token: null },
    ],
  }, null, 2);
  const shown = redactSecrets(elements).text;
  let parsed: any = null;
  try { parsed = JSON.parse(shown); } catch { /* reported below */ }
  ok('a UI element list with "password": true/false stays valid JSON', parsed !== null, shown.split('\n').find((l: string) => l.includes('REDACTED')) ?? '');
  ok('…and its flags are kept (true, false and null are not secrets)',
    parsed?.elements?.[0]?.password === false && parsed?.elements?.[1]?.password === true
    && parsed?.elements?.[2]?.isPassword === false && parsed?.elements?.[2]?.token === null);
  ok('a flag in prose or a command line is kept too', redactSecrets('password=false token: TRUE secret = null').count === 0,
    redactSecrets('password=false token: TRUE secret = null').text);

  // A number under a credential's name is still a secret (a PIN, a numeric
  // password): replaced by a quoted marker, so the JSON stays JSON.
  const numeric = JSON.stringify({ user: 'sam', password: 48151623, apiKey: -12345, count: 3 });
  const masked = redactSecrets(numeric).text;
  let back: any = null;
  try { back = JSON.parse(masked); } catch { /* reported below */ }
  ok('a number under "password" or "apiKey" is hidden, and the JSON still parses',
    back !== null && !masked.includes('48151623') && !masked.includes('12345') && back.password === '[REDACTED:secret]' && back.count === 3, masked);
  ok('a value that only starts like a flag is still hidden', !redactSecrets('password=falsehood99 token=nullify-me').text.match(/falsehood99|nullify-me/),
    redactSecrets('password=falsehood99 token=nullify-me').text);
} else {
  ok('redactor exists', false);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
