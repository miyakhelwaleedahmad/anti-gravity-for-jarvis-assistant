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
  ]) {
    const r = redactSecrets(plain);
    ok(`unchanged: "${plain.slice(0, 40)}"`, r.text === plain && r.count === 0, r.text);
  }
  ok('empty text', redactSecrets('').text === '' && redactSecrets('').count === 0);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
