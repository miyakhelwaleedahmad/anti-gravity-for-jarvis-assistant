/**
 * system/childEnv.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The environment a child process gets (SEC-06).
 *
 * JARVIS loads its .env into process.env: model provider keys, the bridge
 * token, A2A tokens, search keys. Child processes used to get all of it
 * (`{ ...process.env }`), so a project's npm script, a git hook, a shell
 * command or an app JARVIS opened could read every key.
 *
 * childEnv() passes what programs need to run (paths, the user's folders,
 * locale, the toolchains' own homes) and nothing that looks like a secret,
 * even when its name is on the list.
 */

/** Variables passed by exact name (compared case-insensitively: Windows names vary). */
const ALLOWED = new Set([
  // Finding programs and the system
  'path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec', 'os',
  'processor_architecture', 'processor_identifier', 'number_of_processors', 'psmodulepath',
  // The user and their folders
  'home', 'userprofile', 'homedrive', 'homepath', 'username', 'user', 'logname', 'userdomain',
  'appdata', 'localappdata', 'programdata', 'programfiles', 'programfiles(x86)', 'programw6432',
  'commonprogramfiles', 'commonprogramfiles(x86)', 'commonprogramw6432', 'public', 'allusersprofile',
  'temp', 'tmp', 'tmpdir',
  // Terminal and locale
  'lang', 'language', 'tz', 'term', 'shell', 'colorterm', 'no_color', 'force_color',
  // Toolchains (where they live, not credentials)
  'node_env', 'nvm_dir', 'nvm_home', 'nvm_symlink', 'pnpm_home', 'npm_config_cache', 'npm_config_prefix',
  'java_home', 'python', 'pythonpath', 'pythonhome', 'virtual_env', 'conda_prefix', 'pyenv_root',
  'gopath', 'goroot', 'cargo_home', 'rustup_home', 'dotnet_root',
  // Git without prompts, and the user's own SSH agent for push
  'git_terminal_prompt', 'git_askpass', 'ssh_askpass', 'ssh_auth_sock', 'git_ssh', 'git_ssh_command',
  // CI-style output for scripts JARVIS runs
  'ci', 'browser', 'port',
  // Display (Linux desktop apps)
  'display', 'wayland_display', 'xdg_runtime_dir', 'dbus_session_bus_address',
]);

/** Prefixes passed (locale settings). */
const ALLOWED_PREFIXES = ['lc_'];

/** Never passed, whatever the list says: names that hold credentials. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASS$|API_?KEY|_KEY$|^KEY$|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION)/i;

/** Whether `name` looks like it holds a credential. */
export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Whether `name` reaches a child process. */
export function passesToChild(name: string): boolean {
  if (SECRET_NAME.test(name)) return false;
  const lower = name.toLowerCase();
  return ALLOWED.has(lower) || ALLOWED_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * For a child Python process: its output in UTF-8. On Windows Python writes
 * to a pipe in the ANSI code page, and the log showed \u2714 and \U0001f3a4
 * escapes and replacement characters (BUG-21). A PYTHON* setting the owner
 * passes on (voiceServiceEnv, vectorServiceEnv) comes after and wins.
 */
export const PYTHON_UTF8: Readonly<Record<string, string>> = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

/** The allowed part of `env` (default: this process's), plus `extra` set by the caller. */
export function childEnv(
  extra: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && passesToChild(name)) out[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}
