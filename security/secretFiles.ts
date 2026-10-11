/**
 * security/secretFiles.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Files that hold keys, tokens or passwords, judged by their name. Shared by
 * the file tools, read_file, document indexing and browser uploads.
 */

import * as path from 'path';

/** Keys and credentials by their usual names and extensions. */
const SECRET_FILE = /(^|[\\/])(\.env(\.[^\\/]*)?|id_[a-z0-9]+(\.pub)?|credentials(\.json)?|[^\\/]*\.(pem|key|p12|pfx|kdbx|ppk|asc|gpg|keychain|keychain-db))$/i;

/**
 * Text files named for what they hold (SEC-14): "github tokens.txt",
 * "passwords.csv", "api_keys.json". Their contents have no fixed format, so
 * redaction may not recognise them. Whole words only ("tokenizer.py" is not
 * one), and text-like files only (source files such as password-reset.ts are
 * code, not credentials).
 */
const SECRET_WORDS = new Set([
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'credential', 'credentials',
  'apikey', 'apikeys', 'privatekey', 'privatekeys', 'accesskey', 'accesskeys', 'mnemonic',
]);
const SECRET_PAIRS = /\b(api|private|access|secret|recovery|seed|backup)[\s_-]+(keys?|codes?|phrase)\b/i;
const TEXT_LIKE = new Set(['', '.txt', '.md', '.csv', '.json', '.yml', '.yaml', '.ini', '.cfg', '.conf', '.log', '.xml', '.toml', '.dat', '.bak', '.rtf', '.tsv']);

export function isSecretFile(p: string): boolean {
  if (SECRET_FILE.test(p)) return true;
  const base = path.basename(String(p ?? ''));
  const ext = path.extname(base).toLowerCase();
  if (!TEXT_LIKE.has(ext)) return false;
  const stem = base.slice(0, base.length - ext.length);
  if (SECRET_PAIRS.test(stem.replace(/[_.]/g, ' '))) return true;
  return stem.toLowerCase().split(/[^a-z0-9]+/).some((word) => SECRET_WORDS.has(word));
}

/** The refusal for reading or sending one. */
export const SECRET_FILE_REFUSAL = 'JARVIS does not read, index or send files that hold keys, tokens or passwords (judged by the name).';
