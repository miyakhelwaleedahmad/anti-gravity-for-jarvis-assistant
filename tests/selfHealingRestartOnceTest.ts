/**
 * tests/selfHealingRestartOnceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SH-1 (docs/SELF_HEALING_CAPABILITY_INVENTORY.md, "Existing defect found, not
 * changed"; owner authorization 2026-11-24): one crash of a voice service is
 * reported up to three times (its traceback on stderr, its exit code, the exit
 * itself) and each report scheduled its own restart. Reproduced before the fix:
 * one crash, four starts, three copies running at once, two of them no longer
 * tracked, and the crash used up all three restarts before the circuit breaker.
 *
 *   1  one real crash (traceback, exit 1): exactly one new copy, counted once
 *   2  three restart requests while one is waiting: one start, counted once
 *   3  control: the circuit breaker still stops a service after three restarts
 *   4  a requested restart (repair run) cancels a waiting automatic restart
 *   5  …also when the running process takes time to stop
 *
 * Process arrangements (SH-1d, 2026-11-24). JARVIS tracks the process it
 * spawns. With a direct interpreter that is the service itself; with the
 * Windows venv launcher (CPython PC/venvlauncher.c, copied into a venv as
 * Scripts\python.exe) it is the launcher, and the service is its direct child.
 * Each service records its pid and parent pid, and a tracked pid matches it
 * only as itself (direct) or as its running direct parent (launcher). On Linux
 * the cases run twice: directly, and under a launcher stand-in that behaves
 * like the venv launcher (starts the service as a child, waits, passes its exit
 * code back, and ending it ends the service). Elsewhere they run once, under
 * whatever this host's Python is. JARVIS_TEST_PROCESS_TOPOLOGY = direct |
 * launcher | both overrides this.
 *
 * Real Python stand-in processes, written to this test's temporary folder.
 * Without Python the test is BLOCKED (exit 3), never a pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py = process.platform === 'win32' ? 'python' : 'python3';
if (spawnSync(py, ['--version']).status !== 0) {
  console.log(`BLOCKED: ${py} is not available, so no real service process can be started`);
  process.exit(3);
}

// ── Process arrangement (SH-1d) ──────────────────────────────────────────────
type Topology = 'direct' | 'launcher';
/** created / parentCreated: Windows creation times (FILETIME, 100-ns units) as exact decimal strings; never JS numbers. */
interface WorkerStart { pid: number; ppid: number; label: string; created?: string; parentCreated?: string }
/** A FILETIME as written by a stand-in: 1 .. 2^64-1 in plain decimal digits, else not recorded. Checked exactly (BigInt). */
const filetime = (s: string | undefined): string | undefined => (s !== undefined && /^[1-9]\d{0,19}$/.test(s) && BigInt(s) < 2n ** 64n ? s : undefined);
/** One starts.log line: "pid ppid label created parentCreated"; "-" or a missing field means not recorded (always, off Windows). */
const parseStart = (l: string): WorkerStart => {
  const [pid, ppid, label, created, parentCreated] = l.split(' ');
  const c = filetime(created), pc = filetime(parentCreated);
  return { pid: Number(pid), ppid: Number(ppid), label: label!, ...(c ? { created: c } : {}), ...(pc ? { parentCreated: pc } : {}) };
};

function topologies(): Topology[] {
  const want = process.env['JARVIS_TEST_PROCESS_TOPOLOGY'] ?? (process.platform === 'linux' ? 'both' : 'direct');
  if (want === 'direct') return ['direct'];
  if (want !== 'launcher' && want !== 'both') { console.error(`JARVIS_TEST_PROCESS_TOPOLOGY must be direct, launcher or both, not "${want}"`); process.exit(2); }
  if (process.platform !== 'linux') { console.log(`BLOCKED: the launcher stand-in needs Linux (prctl); this host is ${process.platform}`); process.exit(3); }
  return want === 'both' ? ['direct', 'launcher'] : ['launcher'];
}

/** The venv launcher's behaviour (PC/venvlauncher.c launch()), for Linux: the worker dies with it, like KILL_ON_JOB_CLOSE. */
const LAUNCHER_PRELUDE = [
  'import os as _o, sys as _s, signal as _sg, subprocess as _sp',
  'if _o.environ.get("SH1_ROLE") != "worker":',
  '    with open(_o.path.join(_o.path.dirname(_o.path.abspath(__file__)), "launchers.log"), "a") as _f:',
  '        _f.write(f"{_o.getpid()}\\n")',
  '    _c = _sp.Popen([_s.executable, _o.path.abspath(__file__)], env=dict(_o.environ, SH1_ROLE="worker", SH1_LAUNCHER=str(_o.getpid())))',
  '    _sg.signal(_sg.SIGTERM, lambda *_: _o._exit(1))   # like TerminateProcess(launcher, 1)',
  '    _rc = _c.wait()',
  '    _s.exit(_rc if _rc >= 0 else 1)',
  'import ctypes as _ct',
  '_ct.CDLL(None).prctl(1, 9)   # PR_SET_PDEATHSIG = SIGKILL',
  'if _o.getppid() != int(_o.environ["SH1_LAUNCHER"]):',
  '    _s.exit(1)',
].join('\n') + '\n';

/** Running and this test's own (Linux: not an unreaped zombie, command line in this folder). */
function running(pid: number, dir: string): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;   // exited, not yet reaped
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir);
  } catch { return false; }
}
/** What the operating system reports about a process (SH-1d, Windows identity). */
interface OsFacts { alive: boolean; ppid: number | null; created: number | null; exe: string | null }
/**
 * Read with a probe that uses only Python's standard library (no new dependency).
 * Linux: /proc/<pid>/stat (state, parent, start time) and /proc/<pid>/exe. Windows (ctypes):
 * Toolhelp snapshot (th32ParentProcessID: the process that created it), GetProcessTimes
 * (creation time), WaitForSingleObject(h, 0) (still running), QueryFullProcessImageNameW.
 */
const PROBE = String.raw`
import json, os, sys
def linux(pid):
    try:
        with open("/proc/%d/stat" % pid) as f:
            s = f.read()
        rest = s[s.rindex(")") + 2:].split()
        try:
            exe = os.readlink("/proc/%d/exe" % pid)
        except OSError:
            exe = None
        return {"alive": rest[0] != "Z", "ppid": int(rest[1]), "created": int(rest[19]), "exe": exe}
    except (OSError, ValueError, IndexError):
        return {"alive": False, "ppid": None, "created": None, "exe": None}
def windows(pids):
    import ctypes
    from ctypes import wintypes as w
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    class PE(ctypes.Structure):
        _fields_ = [("dwSize", w.DWORD), ("cntUsage", w.DWORD), ("th32ProcessID", w.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", w.DWORD), ("cntThreads", w.DWORD),
                    ("th32ParentProcessID", w.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", w.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]
    # Every argument and result type is declared: a HANDLE is pointer-sized, and ctypes would
    # otherwise pass a Python int as a C int, masked to 32 bits (ctypes docs).
    H, P = w.HANDLE, ctypes.POINTER
    k.CreateToolhelp32Snapshot.argtypes, k.CreateToolhelp32Snapshot.restype = [w.DWORD, w.DWORD], H
    k.Process32FirstW.argtypes, k.Process32FirstW.restype = [H, P(PE)], w.BOOL
    k.Process32NextW.argtypes, k.Process32NextW.restype = [H, P(PE)], w.BOOL
    k.OpenProcess.argtypes, k.OpenProcess.restype = [w.DWORD, w.BOOL, w.DWORD], H
    k.GetProcessTimes.argtypes, k.GetProcessTimes.restype = [H, P(w.FILETIME), P(w.FILETIME), P(w.FILETIME), P(w.FILETIME)], w.BOOL
    k.WaitForSingleObject.argtypes, k.WaitForSingleObject.restype = [H, w.DWORD], w.DWORD
    k.QueryFullProcessImageNameW.argtypes, k.QueryFullProcessImageNameW.restype = [H, w.DWORD, w.LPWSTR, P(w.DWORD)], w.BOOL
    k.CloseHandle.argtypes, k.CloseHandle.restype = [H], w.BOOL
    TH32CS_SNAPPROCESS, PROCESS_QUERY_LIMITED_INFORMATION, SYNCHRONIZE, WAIT_TIMEOUT = 0x2, 0x1000, 0x00100000, 258
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    parents = {}
    snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE_VALUE:
        raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot failed")
    e = PE(); e.dwSize = ctypes.sizeof(PE)
    ok = k.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        parents[e.th32ProcessID] = e.th32ParentProcessID
        ok = k.Process32NextW(snap, ctypes.byref(e))
    k.CloseHandle(snap)
    if not parents:
        raise OSError(ctypes.get_last_error(), "the process snapshot listed no process")
    out = {}
    for pid in pids:
        f = {"alive": False, "ppid": parents.get(pid), "created": None, "exe": None}
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid)
        if h:
            c, x, kt, ut = w.FILETIME(), w.FILETIME(), w.FILETIME(), w.FILETIME()
            if k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(x), ctypes.byref(kt), ctypes.byref(ut)):
                f["created"] = (c.dwHighDateTime << 32) | c.dwLowDateTime
            f["alive"] = k.WaitForSingleObject(h, 0) == WAIT_TIMEOUT
            buf = ctypes.create_unicode_buffer(32768); n = w.DWORD(32768)
            if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                f["exe"] = buf.value
            k.CloseHandle(h)
        out[pid] = f
    return out
pids = [int(a) for a in sys.argv[1:]]
facts = windows(pids) if os.name == "nt" else {p: linux(p) for p in pids}
print(json.dumps({str(p): facts[p] for p in pids}))
`;

function osFacts(pids: number[]): Map<number, OsFacts> {
  const r = spawnSync(py, ['-c', PROBE, ...pids.map(String)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`process probe failed (exit ${r.status}): ${r.stderr}`);
  const o = JSON.parse(r.stdout) as Record<string, OsFacts>;
  return new Map(pids.map((p) => [p, o[String(p)]!]));
}

/**
 * Is `tracked` (the pid JARVIS spawned) the process of worker `w`? Decided from operating-system
 * facts, not only from what the worker recorded. A parent id alone is not trusted: on Windows it is
 * not updated when the parent exits and the id can be reused, so a launcher must also still be
 * running, have been created no later than the worker (the check psutil.Process.parent() makes),
 * be a child of this test process and be a Python executable. Every predicate is named, so a
 * rejection says exactly why. On Linux each arrangement accepts only its own form; on Windows the
 * host's Python decides, so the direct run accepts either form and names it.
 */
interface RuleInput {
  mode: Topology;
  platform: NodeJS.Platform;
  testPid: number;
  tracked: number | undefined;
  worker: WorkerStart | undefined;
  all: WorkerStart[];
  facts: Map<number, OsFacts>;
  /** Linux: the pid is running and its command line is in this test's folder. */
  ownedOnLinux?: (pid: number) => boolean;
}

/** Every predicate is named, so a rejection says exactly why. */
function identityRule(i: RuleInput): { ok: boolean; form: string; failing: string[] } {
  const { tracked, worker: w, facts } = i;
  const F = (p: number | undefined): OsFacts => (p !== undefined && facts.get(p)) || { alive: false, ppid: null, created: null, exe: null };
  const test = F(i.testPid), wf = F(w?.pid), tf = F(tracked);
  const le = (a: number | null, b: number | null) => a !== null && b !== null && a <= b;
  const owned = (p: number | undefined) => p !== undefined && (i.platform !== 'linux' || !i.ownedOnLinux || i.ownedOnLinux(p));
  const common: Record<string, boolean> = {
    'C1 tracked and worker known': tracked !== undefined && !!w,
    'C2 worker is the latest start': !!w && w === i.all[i.all.length - 1],
    'C3 worker running (OS)': wf.alive && owned(w?.pid),
  };
  const direct: Record<string, boolean> = {
    'D1 tracked === worker pid': !!w && w.pid === tracked,
    'D2 worker parent (OS) === test process': wf.ppid === i.testPid,
    'D3 worker created after test process (OS)': le(test.created, wf.created),
  };
  const launcher: Record<string, boolean> = {
    'L1 tracked !== worker pid': !!w && w.pid !== tracked,
    'L2 tracked !== test process': tracked !== i.testPid,
    'L3 recorded parent === tracked': !!w && w.ppid === tracked,
    'L4 tracked running (OS)': tf.alive && owned(tracked),
    'L5 worker parent (OS) === tracked': wf.ppid !== null && wf.ppid === tracked,
    'L6 tracked created no later than worker (OS)': le(tf.created, wf.created),
    'L7 tracked parent (OS) === test process': tf.ppid === i.testPid,
    'L8 tracked created after test process (OS)': le(test.created, tf.created),
    'L9 tracked is a Python executable (OS)': !!tf.exe && /^python/i.test((tf.exe.split(/[\\/]/).pop() ?? '')),
  };
  const fails = (o: Record<string, boolean>) => Object.keys(o).filter((k) => !o[k]);
  const baseOk = fails(common).length === 0;
  const dOk = baseOk && fails(direct).length === 0;
  const lOk = baseOk && fails(launcher).length === 0;
  if (i.mode === 'launcher') return { ok: lOk, form: 'launcher', failing: [...fails(common), ...fails(launcher)] };
  if (i.platform === 'win32' && !dOk && lOk) return { ok: true, form: 'launcher', failing: [] };
  return { ok: dOk, form: dOk ? 'direct' : i.platform === 'win32' ? 'neither' : 'direct', failing: i.platform === 'win32' && !dOk ? [...fails(common), ...fails(direct).map((k) => `${k} (direct)`), ...fails(launcher).map((k) => `${k} (launcher)`)] : [...fails(common), ...fails(direct)] };
}

function tracks(tracked: number | undefined, w: WorkerStart | undefined, all: WorkerStart[], dir: string, mode: Topology): { ok: boolean; how: string } {
  const pids = [process.pid, ...(tracked !== undefined ? [tracked] : []), ...(w ? [w.pid] : [])];
  // A probe that cannot run fails the identity check, not the whole test, so cleanup still runs.
  let facts: Map<number, OsFacts>;
  try { facts = osFacts([...new Set(pids)]); }
  catch (err) { return { ok: false, how: `tracked ${tracked}, worker ${w?.pid}: process facts unavailable (${err instanceof Error ? err.message : String(err)})` }; }
  const r = identityRule({ mode, platform: process.platform, testPid: process.pid, tracked, worker: w, all, facts, ownedOnLinux: (p) => running(p, dir) });
  const how = r.ok
    ? (r.form === 'direct' ? `direct: tracked ${tracked} is the worker` : `launcher: tracked ${tracked} is the parent of worker ${w?.pid}`)
    : `tracked ${tracked}, worker ${w?.pid}: rejected by ${r.failing.join('; ')}`;
  return { ok: r.ok, how };
}

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Windows cleanup: stop a stand-in only by verified identity, never by PID alone ──
/**
 * Python (Windows only, ctypes as in the probe above). Arguments: a wait limit in ms, then "kind:pid:created" entries.
 * Kind S, a stand-in: opened with PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE; only when its
 * creation time equals the recorded one is it terminated and waited for, all through that one handle, so a later
 * process that reused the PID is never stopped. Kind W, a stand-in's venv launcher: opened without terminate rights,
 * verified the same way and only waited for; never terminated. An invalid record or no recorded time: no API call.
 * ERROR_INVALID_PARAMETER counts as "already exited" only when a fresh process snapshot no longer lists the PID.
 * Every handle is closed. Prints one result per entry, in order.
 */
const STOP = String.raw`
import json, re, sys
def stop(entries, timeout_ms):
    import ctypes
    from ctypes import wintypes as w
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    H, P = w.HANDLE, ctypes.POINTER
    class PE(ctypes.Structure):
        _fields_ = [("dwSize", w.DWORD), ("cntUsage", w.DWORD), ("th32ProcessID", w.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", w.DWORD), ("cntThreads", w.DWORD),
                    ("th32ParentProcessID", w.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", w.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]
    k.OpenProcess.argtypes, k.OpenProcess.restype = [w.DWORD, w.BOOL, w.DWORD], H
    k.GetProcessTimes.argtypes, k.GetProcessTimes.restype = [H, P(w.FILETIME), P(w.FILETIME), P(w.FILETIME), P(w.FILETIME)], w.BOOL
    k.TerminateProcess.argtypes, k.TerminateProcess.restype = [H, w.UINT], w.BOOL
    k.WaitForSingleObject.argtypes, k.WaitForSingleObject.restype = [H, w.DWORD], w.DWORD
    k.CloseHandle.argtypes, k.CloseHandle.restype = [H], w.BOOL
    k.CreateToolhelp32Snapshot.argtypes, k.CreateToolhelp32Snapshot.restype = [w.DWORD, w.DWORD], H
    k.Process32FirstW.argtypes, k.Process32FirstW.restype = [H, P(PE)], w.BOOL
    k.Process32NextW.argtypes, k.Process32NextW.restype = [H, P(PE)], w.BOOL
    PROCESS_TERMINATE, PROCESS_QUERY_LIMITED_INFORMATION, SYNCHRONIZE = 0x0001, 0x1000, 0x00100000
    WAIT_OBJECT_0, WAIT_TIMEOUT = 0, 258
    ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER = 5, 87
    TH32CS_SNAPPROCESS, INVALID_HANDLE_VALUE = 0x2, ctypes.c_void_p(-1).value
    def created_of(h):
        c, x, kt, ut = w.FILETIME(), w.FILETIME(), w.FILETIME(), w.FILETIME()
        if not k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(x), ctypes.byref(kt), ctypes.byref(ut)):
            return None
        return (c.dwHighDateTime << 32) | c.dwLowDateTime
    def listed(pid):
        snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if not snap or snap == INVALID_HANDLE_VALUE:
            return None
        try:
            e = PE(); e.dwSize = ctypes.sizeof(PE)
            seen, count, ok = False, 0, k.Process32FirstW(snap, ctypes.byref(e))
            while ok:
                count += 1
                seen = seen or e.th32ProcessID == pid
                ok = k.Process32NextW(snap, ctypes.byref(e))
            return seen if count else None
        finally:
            k.CloseHandle(snap)
    def not_opened(pid, err):
        if err == ERROR_INVALID_PARAMETER:
            seen = listed(pid)
            if seen is False:
                return {"result": "already-exited", "evidence": "not in a process snapshot"}
            return {"result": "failed", "step": "OpenProcess", "error": err, "detail": "no process snapshot" if seen is None else "still in the process snapshot"}
        return None
    def stop_one(pid, recorded):
        h = k.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid)
        if not h:
            err = ctypes.get_last_error()
            gone = not_opened(pid, err)
            if gone:
                return gone
            if err != ERROR_ACCESS_DENIED:
                return {"result": "failed", "step": "OpenProcess", "error": err}
            q = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not q:
                return {"result": "access-denied", "step": "OpenProcess", "error": err}
            try:
                now = created_of(q)
            finally:
                k.CloseHandle(q)
            if now is not None and now != recorded:
                return {"result": "identity-mismatch", "now": str(now)}
            return {"result": "access-denied", "step": "OpenProcess", "error": err}
        try:
            now = created_of(h)
            if now is None:
                return {"result": "failed", "step": "GetProcessTimes", "error": ctypes.get_last_error()}
            if now != recorded:
                return {"result": "identity-mismatch", "now": str(now)}
            state = k.WaitForSingleObject(h, 0)
            if state == WAIT_OBJECT_0:
                return {"result": "already-exited"}
            if state != WAIT_TIMEOUT:
                return {"result": "failed", "step": "WaitForSingleObject", "error": ctypes.get_last_error()}
            if not k.TerminateProcess(h, 1):
                err = ctypes.get_last_error()
                if k.WaitForSingleObject(h, 0) == WAIT_OBJECT_0:
                    return {"result": "already-exited"}
                return {"result": "access-denied" if err == ERROR_ACCESS_DENIED else "failed", "step": "TerminateProcess", "error": err}
            done = k.WaitForSingleObject(h, timeout_ms)
            if done == WAIT_OBJECT_0:
                return {"result": "stopped"}
            if done == WAIT_TIMEOUT:
                return {"result": "timeout"}
            return {"result": "failed", "step": "WaitForSingleObject", "error": ctypes.get_last_error()}
        finally:
            k.CloseHandle(h)
    def wait_one(pid, recorded):
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid)
        if not h:
            err = ctypes.get_last_error()
            gone = not_opened(pid, err)
            if gone:
                return gone
            return {"result": "access-denied" if err == ERROR_ACCESS_DENIED else "failed", "step": "OpenProcess", "error": err}
        try:
            now = created_of(h)
            if now is None:
                return {"result": "failed", "step": "GetProcessTimes", "error": ctypes.get_last_error()}
            if now != recorded:
                return {"result": "identity-mismatch", "now": str(now)}
            state = k.WaitForSingleObject(h, 0)
            if state == WAIT_OBJECT_0:
                return {"result": "already-exited"}
            if state != WAIT_TIMEOUT:
                return {"result": "failed", "step": "WaitForSingleObject", "error": ctypes.get_last_error()}
            done = k.WaitForSingleObject(h, timeout_ms)
            if done == WAIT_OBJECT_0:
                return {"result": "exited"}
            if done == WAIT_TIMEOUT:
                return {"result": "still-running"}
            return {"result": "failed", "step": "WaitForSingleObject", "error": ctypes.get_last_error()}
        finally:
            k.CloseHandle(h)
    PID, TIME = re.compile(r"[1-9][0-9]{0,9}"), re.compile(r"[1-9][0-9]{0,19}")
    out = []
    for kind, pid_s, created_s in entries:
        r = {"kind": kind, "pid": pid_s, "created": created_s}
        try:
            if kind not in ("S", "W") or not PID.fullmatch(pid_s) or int(pid_s) > 0xFFFFFFFF:
                r["result"] = "invalid-record"
            elif not (TIME.fullmatch(created_s) and int(created_s) < 1 << 64):
                r["result"] = "missing-identity"
            else:
                r.update((stop_one if kind == "S" else wait_one)(int(pid_s), int(created_s)))
        except Exception as e:
            r.update({"result": "failed", "error": repr(e)})
        out.append(r)
    return out
if __name__ == "__main__":
    print(json.dumps(stop([tuple((a.split(":", 2) + ["", "", ""])[:3]) for a in sys.argv[2:]], int(sys.argv[1]))))
`;
/** S: a stand-in, stopped when verified. W: a stand-in's venv launcher, waited for when verified, never terminated. */
interface StopEntry { kind: 'S' | 'W'; pid: number; created?: string }
interface StopResult { kind: string; pid: string; created: string; result: string; step?: string; error?: unknown; now?: string; detail?: string }
/** Outcomes after which nothing of this test's runs under that entry; any other outcome is unresolved and reported. */
const RESOLVED = new Set(['stopped', 'exited', 'already-exited', 'identity-mismatch']);
/** Each recorded stand-in, plus its parent when that is not this test process (the venv launcher on Windows). */
const stopEntries = (records: WorkerStart[], testPid: number): StopEntry[] => {
  const parents = new Map<string, StopEntry>();
  for (const w of records) {
    if (w.ppid !== testPid) parents.set(`${w.ppid}:${w.parentCreated ?? '-'}`, { kind: 'W', pid: w.ppid, ...(w.parentCreated ? { created: w.parentCreated } : {}) });
  }
  return [...records.map((w): StopEntry => ({ kind: 'S', pid: w.pid, ...(w.created ? { created: w.created } : {}) })), ...parents.values()];
};
const stopArgs = (entries: StopEntry[]): string[] => entries.map((e) => `${e.kind}:${e.pid}:${e.created ?? '-'}`);
const unresolved = (results: StopResult[]): StopResult[] => results.filter((r) => !RESOLVED.has(r.result));
/** Runs STOP. If it cannot run, or its answer is not one result per entry for exactly that entry, every entry is unresolved: no PID-only fallback. */
function stopVerifiedOnWindows(entries: StopEntry[]): StopResult[] {
  if (entries.length === 0) return [];
  const args = stopArgs(entries);
  const failed = (why: string): StopResult[] => args.map((a) => {
    const [kind, pid, created] = a.split(':');
    return { kind: kind!, pid: pid!, created: created!, result: 'failed', step: 'helper', error: why };
  });
  try {
    const r = spawnSync(py, ['-c', STOP, '5000', ...args], { encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) return failed(`exit ${r.status}${r.error ? ` (${r.error.message})` : ''}: ${(r.stderr ?? '').trim().slice(-300)}`);
    const out = JSON.parse(r.stdout) as StopResult[];
    const exact = Array.isArray(out) && out.length === args.length
      && out.every((o, i) => !!o && typeof o.result === 'string' && `${o.kind}:${o.pid}:${o.created}` === args[i]);
    return exact ? out : failed(`unexpected answer: ${r.stdout.slice(0, 300)}`);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}
/**
 * The Windows cleanup: a verified stop, then another 1.5 s later (a copy that started just before its service was
 * disabled has recorded itself by then, like the second pass of the Linux path). Prints every outcome other than
 * "already-exited", "stopped" and "exited". Returns the PIDs still unresolved; never throws.
 */
async function cleanUpOnWindows(records: () => WorkerStart[], tag: string): Promise<number[]> {
  const report = (pass: string, rs: StopResult[]): void => {
    const counts = rs.reduce<Record<string, number>>((a, r) => ({ ...a, [`${r.kind === 'W' ? 'launcher' : 'stand-in'} ${r.result}`]: (a[`${r.kind === 'W' ? 'launcher' : 'stand-in'} ${r.result}`] ?? 0) + 1 }), {});
    console.log(`  ${tag}Windows cleanup, ${pass}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing recorded'}`);
    for (const r of rs.filter((x) => !['already-exited', 'stopped', 'exited'].includes(x.result))) {
      console.log(`    ${r.kind === 'W' ? 'launcher' : 'stand-in'} pid ${r.pid} (recorded ${r.created}): ${r.result}${r.step ? ` at ${r.step}` : ''}${r.error !== undefined ? ` [${String(r.error)}]` : ''}${r.detail ? ` (${r.detail})` : ''}`);
    }
  };
  report('pass 1', stopVerifiedOnWindows(stopEntries(records(), process.pid)));
  await sleep(1_500);
  const final = stopVerifiedOnWindows(stopEntries(records(), process.pid));
  report('pass 2', final);
  return unresolved(final).map((r) => Number(r.pid));
}

/**
 * Windows only: the verified stop tried on a throwaway process this test starts itself (never another program). It
 * records its creation time with the stand-ins' own code; one unit off must be refused with the process left running,
 * the exact time must stop it. The test's own child handle ends it in every case. Elsewhere: not run, no checks.
 */
async function windowsVerifiedStopSelfCheck(): Promise<void> {
  if (process.platform !== 'win32') { console.log(`\n--- Windows verified-stop self-check: not run on ${process.platform} ---`); return; }
  console.log('\n--- Windows verified-stop self-check (a throwaway process started by this test) ---');
  const child = spawn(py, ['-c', ['import os, sys, time', CREATED, 'print(_identity()[0], flush=True)', 'time.sleep(120)'].join('\n')], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const first = await new Promise<string>((resolve) => {
      let out = '';
      const timer = setTimeout(() => resolve(''), 15_000);
      child.stdout?.on('data', (d: Buffer) => { out += String(d); if (out.includes('\n')) { clearTimeout(timer); resolve(out.split('\n')[0]!.trim()); } });
      child.on('exit', () => { clearTimeout(timer); resolve(out.split('\n')[0]!.trim()); });
    });
    const time = filetime(first);
    if (!time || child.pid === undefined) { ok('Windows self-check: the throwaway process recorded its creation time', false, `recorded "${first}"`); return; }
    const off = stopVerifiedOnWindows([{ kind: 'S', pid: child.pid, created: (BigInt(time) + 1n).toString() }]);
    await sleep(300);
    ok('Windows self-check: a creation time one unit off is refused, and the process keeps running', off[0]?.result === 'identity-mismatch' && child.exitCode === null && child.signalCode === null, JSON.stringify(off));
    const exact = stopVerifiedOnWindows([{ kind: 'S', pid: child.pid, created: time }]);
    await sleep(300);
    ok('Windows self-check: the exact creation time stops it through the verified handle', exact[0]?.result === 'stopped' && (child.exitCode !== null || child.signalCode !== null), JSON.stringify(exact));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

const { selfHealingManager } = await import('../self_healing/selfHealingManager.js');
const voiceDir = path.join(repo, 'voice');
// The stand-ins live in the repository's git-ignored data/verify-windows-* (as scripts/verifyWindows.ts), not in
// the temp folder: the manager runs path.join(voice/, script), and on Windows the temp folder can be on another
// drive, where no path relative to voice/ exists.
const work = fs.mkdtempSync(path.join(repo, 'data', 'verify-windows-sh1-'));
/**
 * The stand-in's path as the manager needs it: relative to voice/. Checked before the manager gets it: the same
 * volume (Windows: the same drive), and path.join(voice/, result) leads back to the stand-in.
 */
function scriptPathFor(voice: string, file: string, p: typeof path = path): string {
  const same = (a: string, b: string) => (p.sep === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const rel = p.relative(voice, file);
  if (!same(p.parse(voice).root, p.parse(file).root) || p.isAbsolute(rel) || !same(p.join(voice, rel), p.resolve(file))) {
    throw new Error(`stand-in ${file} cannot be reached from ${voice} by a relative path (another volume?); the manager would not find it`);
  }
  return rel;
}
/** Removes this run's own folder, and only once none of its processes is still running (they use its files). */
function removeWork(stillRunning: number[]): void {
  const own = path.dirname(work) === path.join(repo, 'data') && path.basename(work).startsWith('verify-windows-sh1-');
  if (own && stillRunning.length === 0) {
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* reported below */ }
  }
  ok('the test folder is removed', own && !fs.existsSync(work), stillRunning.length ? `kept: ${stillRunning.join(',')} still running` : work);
}
const entry = (label: string) => selfHealingManager.getManagedProcesses().get(label)!;
const dirs: string[] = [];
const labels: string[] = [];

/**
 * Python for a stand-in: its own creation time and its parent's, so the Windows cleanup can tell it (and its venv
 * launcher) from a later process that reuses the PID. Windows: GetProcessTimes, the 64-bit FILETIME as an exact
 * integer; "-" elsewhere or when unknown. A parent created after the stand-in is not its parent ("-").
 */
const CREATED = String.raw`
def _identity():
    if os.name != "nt":
        return "-", "-"
    import ctypes
    from ctypes import wintypes as w
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.GetCurrentProcess.argtypes, k.GetCurrentProcess.restype = [], w.HANDLE
    k.OpenProcess.argtypes, k.OpenProcess.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
    k.GetProcessTimes.argtypes = [w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4
    k.GetProcessTimes.restype = w.BOOL
    k.CloseHandle.argtypes, k.CloseHandle.restype = [w.HANDLE], w.BOOL
    def created(h):
        t = [w.FILETIME() for _ in range(4)]
        if not k.GetProcessTimes(h, *[ctypes.byref(x) for x in t]):
            return None
        return (t[0].dwHighDateTime << 32) | t[0].dwLowDateTime
    own = created(k.GetCurrentProcess())
    if own is None:
        return "-", "-"
    parent = None
    h = k.OpenProcess(0x1000, False, os.getppid())
    if h:
        try:
            parent = created(h)
        finally:
            k.CloseHandle(h)
    return str(own), (str(parent) if parent is not None and parent <= own else "-")
`;
/** A stand-in service in its own folder; every start of the worker appends "pid ppid label created parentCreated" to starts.log there. */
function standIn(name: string, label: string, mode: Topology, body: string): { dir: string; rel: string } {
  const dir = path.join(work, `${mode}-${name}`);
  fs.mkdirSync(dir);
  dirs.push(dir); labels.push(label);
  const file = path.join(dir, 'service.py');
  fs.writeFileSync(file, (mode === 'launcher' ? LAUNCHER_PRELUDE : '') + [
    'import os, pathlib, sys, time',
    'here = pathlib.Path(__file__).resolve().parent',
    CREATED,
    '_created, _parent_created = _identity()',
    'with open(here / "starts.log", "a") as f:',
    `    f.write(f"{os.getpid()} {os.getppid()} ${label} {_created} {_parent_created}\\n")`,
    body,
  ].join('\n') + '\n');
  return { dir, rel: scriptPathFor(voiceDir, file) };
}
const CRASH_ONCE = [
  'marker = here / "crashed.marker"',
  'if not marker.exists():',
  '    marker.write_text("1")',
  '    raise RuntimeError("stand-in crash")',
  'while True:',
  '    time.sleep(1)',
].join('\n');
const EXIT_CLEAN = 'sys.exit(0)';

const starts = (dir: string): WorkerStart[] => {
  try {
    return fs.readFileSync(path.join(dir, 'starts.log'), 'utf8').trim().split('\n').filter(Boolean).map(parseStart);
  } catch { return []; }
};
const launchers = (dir: string): number[] => {
  try { return fs.readFileSync(path.join(dir, 'launchers.log'), 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
};

console.log('\n=== Self-healing: one crash, one restart (SH-1) ===');
await windowsVerifiedStopSelfCheck();

// try/finally: the cleanup below also runs after an exception, which still ends the test as a failure. The lines
// inside are not re-indented, so they read exactly as before.
try { for (const mode of topologies()) {
  const tag = `[${mode}] `;
  const L = (base: string) => `${base}${mode === 'launcher' ? 'L' : 'D'}`;
  console.log(`\n##### Process arrangement: ${mode}${mode === 'direct' && process.platform === 'win32' ? ' (this host\'s Python; a venv launcher is accepted as the verified parent)' : ''} #####`);

  console.log('\n--- 1. One real crash ---');
  {
    const label = L('Sh1CrashSvc');
    const svc = standIn('crash', label, mode, CRASH_ONCE);
    selfHealingManager.launchPythonService(svc.rel, label);
    await sleep(11_000);   // past every back-off the crash's reports schedule (the longest is 9 s)
    const all = starts(svc.dir);
    const alive = all.filter((w) => running(w.pid, svc.dir));
    const e = entry(label);
    const t = tracks(e.proc?.pid, alive[0], all, svc.dir, mode);
    ok(`${tag}the crash is followed by exactly one new start`, all.length === 2, `${all.length} starts`);
    ok(`${tag}exactly one copy is running`, alive.length === 1, `${alive.length} running`);
    ok(`${tag}…and it is the one JARVIS tracks`, alive.length === 1 && t.ok, t.how);
    ok(`${tag}one crash counts as one restart`, e.restarts === 1 && !e.disabledAt, `restarts ${e.restarts}`);
  }

  console.log('\n--- 2. Several requests while a restart is waiting ---');
  {
    const label = L('Sh1BurstSvc');
    const svc = standIn('burst', label, mode, EXIT_CLEAN);
    selfHealingManager.launchPythonService(svc.rel, label);
    await sleep(800);                                         // started and exited cleanly (no restart)
    for (let i = 0; i < 3; i++) selfHealingManager.scheduleRestart(label, 200);
    await sleep(1_500);
    const all = starts(svc.dir);
    ok(`${tag}three requests at once start the service once`, all.length === 2, `${all.length} starts`);
    ok(`${tag}…and are counted once`, entry(label).restarts === 1, `restarts ${entry(label).restarts}`);
  }

  console.log('\n--- 3. Control: the circuit breaker is unchanged ---');
  {
    const label = L('Sh1BreakerSvc');
    const svc = standIn('breaker', label, mode, EXIT_CLEAN);
    selfHealingManager.launchPythonService(svc.rel, label);
    await sleep(800);
    for (let i = 0; i < 4; i++) { selfHealingManager.scheduleRestart(label, 100); await sleep(900); }
    const all = starts(svc.dir);
    const e = entry(label);
    ok(`${tag}three restarts are made, one at a time`, all.length === 4, `${all.length} starts`);
    ok(`${tag}the fourth request disables the service`, !!e.disabledAt && e.restarts === 4, `restarts ${e.restarts}, disabled ${!!e.disabledAt}`);
  }

  console.log('\n--- 4. A requested restart while an automatic one is waiting ---');
  {
    const label = L('Sh1PendingSvc');
    const svc = standIn('pending', label, mode, EXIT_CLEAN);
    selfHealingManager.launchPythonService(svc.rel, label);
    await sleep(800);
    selfHealingManager.scheduleRestart(label, 1_500);  // automatic restart waiting
    const res = await selfHealingManager.restartService(label);
    await sleep(2_500);                                 // past the automatic restart's time
    const all = starts(svc.dir);
    ok(`${tag}the requested restart starts the service`, res.ok, JSON.stringify(res));
    ok(`${tag}…and the waiting automatic restart does not start another copy`, all.length === 2, `${all.length} starts`);
  }

  console.log('\n--- 5. A requested restart of a running service while an automatic one is waiting ---');
  {
    // Takes about a second to stop on SIGTERM when run directly on Linux, so a
    // waiting restart could fire during the stop. Under a launcher the stop is
    // immediate (ending the launcher ends the service), as on Windows.
    const label = L('Sh1SlowStopSvc');
    const svc = standIn('slowstop', label, mode, [
      'import signal',
      'def _term(*_):',
      '    time.sleep(1)',
      '    sys.exit(0)',
      'signal.signal(signal.SIGTERM, _term)',
      'while True:',
      '    time.sleep(0.2)',
    ].join('\n'));
    selfHealingManager.launchPythonService(svc.rel, label);
    await sleep(800);
    selfHealingManager.scheduleRestart(label, 0);       // automatic restart waiting
    const res = await selfHealingManager.restartService(label);
    await sleep(1_500);
    const all = starts(svc.dir);
    const alive = all.filter((w) => running(w.pid, svc.dir));
    const t = tracks(entry(label).proc?.pid, alive[0], all, svc.dir, mode);
    ok(`${tag}the requested restart starts the service`, res.ok, JSON.stringify(res));
    ok(`${tag}one new start, not two`, all.length === 2, `${all.length} starts`);
    ok(`${tag}exactly one copy is running, the tracked one`, alive.length === 1 && t.ok, `${alive.length} running; ${t.how}`);
  }
} } finally {

// Leave nothing running: no further starts for these services, then stop only this test's processes.
for (const label of labels) {
  const e = selfHealingManager.getManagedProcesses().get(label);
  if (!e) continue;
  e.disabledAt ??= new Date();
  if (e.proc) (selfHealingManager as unknown as { intendedStops: WeakSet<object> }).intendedStops.add(e.proc);
}
// Windows: stop only by verified identity, never by PID alone. Elsewhere: the existing /proc-checked path, unchanged.
let leftover: number[];
if (process.platform === 'win32') {
  leftover = await cleanUpOnWindows(() => dirs.flatMap((d) => starts(d)), '');
} else {
const ours = () => dirs.flatMap((d) => [...starts(d).map((w) => w.pid), ...launchers(d)].filter((pid) => running(pid, d)));
for (const pid of ours()) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
await sleep(1_500);
for (const pid of ours()) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
await sleep(500);
leftover = ours();
}
ok('no stand-in process is left running', leftover.length === 0, leftover.join(','));
removeWork(leftover);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
