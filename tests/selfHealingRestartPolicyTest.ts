/**
 * tests/selfHealingRestartPolicyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SH-1 follow-up, Option C (owner decision 2026-11-24): a restart depends on
 * why it is asked for.
 *
 *   A  a service exits on its own with an error  → one restart after back-off,
 *      counted once, duplicate reports joined (SH-1)
 *   B  the pipeline watchdog or the file watcher  → stop the running copy, wait
 *      for it to exit, then start one (watchdog counted, file change not)
 *   C  an error line from a service still running → recorded, no restart, not counted
 *   D  a requested restart ("heal yourself")      → cancels a waiting restart,
 *      stops, waits, starts one; not counted
 *
 *    1  one crash, several reports: one restart                         (A)
 *    2  an error line while running: no restart, no second copy        (C)
 *    3  …and no restart attempt used                                   (C)
 *    4  the watchdog: old copy stopped before the new one starts       (B)
 *    5  the file watcher's request: same, not counted                  (B)
 *    6  "heal yourself" with a restart waiting: one replacement        (D)
 *    7  several requests at once on a running service: one replacement
 *    8  a waiting restart does not bring back a stopped service
 *    9  control: three crashes, then the circuit breaker (unchanged)
 *   10  an exit with an error code and no traceback: one restart        (A)
 *   10b control: a clean exit (code 0) is not restarted (unchanged)
 *   11  a copy that will not stop: no second copy, failure reported
 *       (only where a process can refuse to stop: run directly on Linux)
 *   12  requests arriving while a replacement is in progress: one replacement
 *
 * Process arrangements (SH-1d, 2026-11-24). JARVIS tracks the process it
 * spawns. With a direct interpreter that is the service itself; with the
 * Windows venv launcher (CPython PC/venvlauncher.c, copied into a venv as
 * Scripts\python.exe) it is the launcher, and the service is its direct child.
 * Each service records its pid and parent pid, and a tracked pid matches it
 * only as itself (direct) or as its running direct parent (launcher). On Linux
 * the cases run twice: directly, and under a launcher stand-in that behaves
 * like the venv launcher (starts the service as a child, waits, passes its exit
 * code back, and ending it ends the service at once). Elsewhere they run once,
 * under whatever this host's Python is. JARVIS_TEST_PROCESS_TOPOLOGY = direct |
 * launcher | both overrides this.
 *
 * Real Python stand-ins in this test's temporary folder; each case has its own
 * service. Every case samples its service's processes every 20 ms and fails if
 * two copies ever run at once. Only processes this test started are stopped.
 * Without Python the test is BLOCKED (exit 3), never a pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

/** Running and this test's own (Linux: not an unreaped zombie, command line in this folder). Never touch another process. */
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

const { selfHealingManager } = await import('../self_healing/selfHealingManager.js');
const mgr = selfHealingManager as unknown as {
  stopTimeoutMs: number;
  intendedStops: WeakSet<object>;
};
const voiceDir = path.join(repo, 'voice');
// The stand-ins live in the repository's git-ignored data/verify-windows-* (as scripts/verifyWindows.ts), not in
// the temp folder: the manager runs path.join(voice/, script), and on Windows the temp folder can be on another
// drive, where no path relative to voice/ exists.
const work = fs.mkdtempSync(path.join(repo, 'data', 'verify-windows-sh1c-'));
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
/** Every stand-in this test creates, in either arrangement: the cleanup after an exception finds them here. */
const created: Svc[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Check = { label: string; ok: boolean; detail: string; skipped?: boolean };

// ── Stand-in services ────────────────────────────────────────────────────────
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
const header = (label: string) => [
  'import os, pathlib, signal, sys, time',
  'here = pathlib.Path(__file__).resolve().parent',
  CREATED,
  '_created, _parent_created = _identity()',
  'with open(here / "starts.log", "a") as f:',
  `    f.write(f"{os.getpid()} {os.getppid()} ${label} {_created} {_parent_created}\\n")`,
  'def forever():',
  '    while True:',
  '        time.sleep(0.2)',
].join('\n');
const BODY = {
  runs: 'forever()',
  crashOnce: ['m = here / "crashed.marker"', 'if not m.exists():', '    m.write_text("1")', '    raise RuntimeError("stand-in crash")', 'forever()'].join('\n'),
  crashAlways: 'raise RuntimeError("stand-in crash")',
  exitCodeOnce: ['m = here / "exited.marker"', 'if not m.exists():', '    m.write_text("1")', '    sys.exit(3)', 'forever()'].join('\n'),
  exitClean: 'sys.exit(0)',
  // Writes a traceback to stderr but keeps working (a handled error).
  errorLine: ['time.sleep(0.5)', 'print("Traceback (most recent call last):\\n  File \\"x.py\\", line 1\\nValueError: handled, still working", file=sys.stderr, flush=True)',
    'time.sleep(4)', 'print("Traceback (most recent call last):\\nValueError: handled again", file=sys.stderr, flush=True)', 'forever()'].join('\n'),
  // Takes about a second to stop on SIGTERM when run directly on Linux.
  slowStop: ['def _term(*_):', '    time.sleep(1)', '    sys.exit(0)', 'signal.signal(signal.SIGTERM, _term)', 'forever()'].join('\n'),
  // Ignores SIGTERM when run directly on Linux: a copy that will not stop.
  stubborn: ['signal.signal(signal.SIGTERM, signal.SIG_IGN)', 'forever()'].join('\n'),
};

class Svc {
  readonly dir: string;
  readonly rel: string;
  maxAlive = 0;
  private sampler?: ReturnType<typeof setInterval>;
  constructor(readonly label: string, readonly mode: Topology, body: string) {
    this.dir = path.join(work, label);
    fs.mkdirSync(this.dir);
    const file = path.join(this.dir, 'service.py');
    fs.writeFileSync(file, `${mode === 'launcher' ? LAUNCHER_PRELUDE : ''}${header(label)}\n${body}\n`);
    this.rel = scriptPathFor(voiceDir, file);
    created.push(this);
  }
  launch(): void {
    selfHealingManager.launchPythonService(this.rel, this.label);
    // Copies running at once: workers, and in launcher mode launchers too.
    this.sampler = setInterval(() => { this.maxAlive = Math.max(this.maxAlive, this.alive().length, this.launchersAlive().length); }, 20);
  }
  starts(): WorkerStart[] {
    try {
      return fs.readFileSync(path.join(this.dir, 'starts.log'), 'utf8').trim().split('\n').filter(Boolean).map(parseStart);
    } catch { return []; }
  }
  /** This service's workers still running. */
  alive(): number[] { return this.starts().map((w) => w.pid).filter((p) => running(p, this.dir)); }
  launchersAlive(): number[] {
    try { return fs.readFileSync(path.join(this.dir, 'launchers.log'), 'utf8').trim().split('\n').filter(Boolean).map(Number).filter((p) => running(p, this.dir)); } catch { return []; }
  }
  entry() { return selfHealingManager.getManagedProcesses().get(this.label)!; }
  tracked(): number | undefined { return this.entry().proc?.pid; }
  /** The one running worker is the process JARVIS tracks (itself, or through its verified launcher). */
  tracksRunning(): { ok: boolean; how: string } {
    const run = this.alive();
    if (run.length !== 1) return { ok: false, how: `${run.length} running` };
    const all = this.starts();
    return tracks(this.tracked(), all.find((w) => w.pid === run[0]), all, this.dir, this.mode);
  }
  stopSampling(): void { if (this.sampler) clearInterval(this.sampler); }
}

const heal = (s: Svc) => selfHealingManager.executeHealAction('test_pipeline', { action: 'restart_process', target: s.label });

// ── Cases (run in parallel within an arrangement; each has its own service) ──
async function runArrangement(mode: Topology): Promise<{ checks: Check[]; services: Svc[] }> {
  const services: Svc[] = [];
  const svc = (base: string, body: string) => { const s = new Svc(`${base}${mode === 'launcher' ? 'L' : 'D'}`, mode, body); services.push(s); return s; };
  /** A stop takes time only for a process run directly on Linux; a launcher (and Windows) ends it at once. */
  const stopCanBeSlow = mode === 'direct' && process.platform !== 'win32';

  async function case1(): Promise<Check[]> {
    const s = svc('Sh1cCrash', BODY.crashOnce); s.launch();
    await sleep(11_000);
    const t = s.tracksRunning();
    return [
      { label: '1  one crash, several reports: exactly one restart', ok: s.starts().length === 2, detail: `${s.starts().length} starts` },
      { label: '1  …one copy running, the tracked one, counted once', ok: s.alive().length === 1 && t.ok && s.entry().restarts === 1, detail: `running ${s.alive().join(',')}; ${t.how}; restarts ${s.entry().restarts}` },
    ];
  }

  async function case2and3(): Promise<Check[]> {
    const s = svc('Sh1cErrLine', BODY.errorLine); s.launch();
    await sleep(10_000);   // two error lines, and past every back-off they could schedule
    const first = s.starts()[0];
    const t = s.tracksRunning();
    return [
      { label: '2  an error line from a running service: no restart', ok: s.starts().length === 1, detail: `${s.starts().length} starts` },
      { label: '2  …the same copy keeps running, no second copy', ok: s.alive().length === 1 && s.alive()[0] === first?.pid && t.ok && s.maxAlive === 1, detail: `running ${s.alive().join(',')}, max at once ${s.maxAlive}; ${t.how}` },
      { label: '3  …and no restart attempt is used', ok: s.entry().restarts === 0 && !s.entry().disabledAt, detail: `restarts ${s.entry().restarts}` },
    ];
  }

  async function case4(): Promise<Check[]> {
    const s = svc('Sh1cWatchdog', BODY.slowStop); s.launch();
    await sleep(800);
    const old = s.starts()[0]?.pid;
    await heal(s);
    await sleep(4_500);
    const t = s.tracksRunning();
    return [
      { label: '4  watchdog: one replacement', ok: s.starts().length === 2, detail: `${s.starts().length} starts` },
      { label: '4  …the old copy stopped before the new one started (never two at once)', ok: s.maxAlive === 1 && !s.alive().includes(old!), detail: `max at once ${s.maxAlive}` },
      { label: '4  …the new copy is tracked; the watchdog restart is counted once', ok: s.alive().length === 1 && t.ok && s.entry().restarts === 1, detail: `${t.how}; restarts ${s.entry().restarts}` },
    ];
  }

  async function case5(): Promise<Check[]> {
    const s = svc('Sh1cFileChange', BODY.slowStop); s.launch();
    await sleep(800);
    const old = s.starts()[0]?.pid;
    selfHealingManager.scheduleRestart(s.label);   // the file watcher's call (self_healing/fsWatcher.ts)
    await sleep(4_500);
    const t = s.tracksRunning();
    return [
      { label: '5  file change: one replacement', ok: s.starts().length === 2, detail: `${s.starts().length} starts` },
      { label: '5  …old copy stopped first (never two at once)', ok: s.maxAlive === 1 && !s.alive().includes(old!) && s.alive().length === 1 && t.ok, detail: `max at once ${s.maxAlive}; ${t.how}` },
      { label: '5  …a file change is not counted as a failure', ok: s.entry().restarts === 0, detail: `restarts ${s.entry().restarts}` },
    ];
  }

  async function case6(): Promise<Check[]> {
    const s = svc('Sh1cHealPending', BODY.crashOnce); s.launch();
    await sleep(1_000);                                  // crashed; an automatic restart is waiting
    const waiting = !!(s.entry() as { pendingRestart?: unknown }).pendingRestart;
    const res = await selfHealingManager.restartService(s.label);
    await sleep(10_000);                                 // past the waiting restart's time
    const t = s.tracksRunning();
    return [
      { label: '6  heal yourself: an automatic restart was waiting', ok: waiting, detail: '' },
      { label: '6  …one replacement, the waiting restart cancelled', ok: res.ok && s.starts().length === 2 && s.alive().length === 1 && t.ok && s.maxAlive === 1, detail: `${JSON.stringify(res)}; ${s.starts().length} starts; ${t.how}` },
    ];
  }

  async function case7(): Promise<Check[]> {
    const s = svc('Sh1cTogether', BODY.slowStop); s.launch();
    await sleep(800);
    const [, , r] = await Promise.all([heal(s), Promise.resolve(selfHealingManager.scheduleRestart(s.label)), selfHealingManager.restartService(s.label), heal(s)]);
    await sleep(4_500);
    const t = s.tracksRunning();
    return [
      { label: '7  four requests at once: one replacement', ok: s.starts().length === 2, detail: `${s.starts().length} starts` },
      { label: '7  …never two copies at once; the requested restart reports success', ok: s.maxAlive === 1 && s.alive().length === 1 && t.ok && r.ok, detail: `max at once ${s.maxAlive}; ${t.how}; ${JSON.stringify(r)}` },
    ];
  }

  async function case8(): Promise<Check[]> {
    const s = svc('Sh1cNoResurrect', BODY.crashOnce); s.launch();
    await sleep(1_000);                                  // crashed; an automatic restart is waiting
    await selfHealingManager.restartService(s.label);    // started again on request
    await sleep(600);
    const p = s.entry().proc!;
    mgr.intendedStops.add(p);                            // then stopped on purpose
    p.kill();
    await sleep(10_000);                                 // past the first restart's time
    return [
      { label: '8  a waiting restart does not bring back a service stopped on purpose', ok: s.starts().length === 2 && s.alive().length === 0 && s.launchersAlive().length === 0, detail: `${s.starts().length} starts, ${s.alive().length} running` },
    ];
  }

  async function case9(): Promise<Check[]> {
    const s = svc('Sh1cBreaker', BODY.crashAlways); s.launch();
    await sleep(24_000);                                 // three restarts with back-off 3 s, 6 s, 9 s
    const e = s.entry();
    return [
      { label: '9  three crashes are restarted, the fourth disables the service', ok: s.starts().length === 4 && !!e.disabledAt && e.restarts === 4, detail: `${s.starts().length} starts, restarts ${e.restarts}, disabled ${!!e.disabledAt}` },
      { label: '9  …never two copies at once', ok: s.maxAlive <= 1, detail: `max at once ${s.maxAlive}` },
    ];
  }

  async function case10(): Promise<Check[]> {
    const s = svc('Sh1cExitCode', BODY.exitCodeOnce); s.launch();
    const c = svc('Sh1cExitClean', BODY.exitClean); c.launch();
    await sleep(9_000);
    const t = s.tracksRunning();
    return [
      { label: '10 an exit with an error code (no traceback): exactly one restart', ok: s.starts().length === 2 && s.alive().length === 1 && t.ok && s.entry().restarts === 1, detail: `${s.starts().length} starts, restarts ${s.entry().restarts}; ${t.how}` },
      { label: '10b control: a clean exit (code 0) is not restarted', ok: c.starts().length === 1 && c.entry().restarts === 0, detail: `${c.starts().length} starts` },
    ];
  }

  async function case11(): Promise<Check[]> {
    if (!stopCanBeSlow) {
      return [{ label: '11 a copy that will not stop', ok: true, detail: `not run: ${mode === 'launcher' ? 'ending the launcher ends the service at once' : 'Windows ends a process at once'}, so a copy cannot refuse to stop here`, skipped: true }];
    }
    const s = svc('Sh1cStubborn', BODY.stubborn); s.launch();
    await sleep(800);
    const old = s.starts()[0]!.pid;
    await heal(s);                                       // watchdog: stop times out (stopTimeoutMs 1.5 s)
    const manual = await selfHealingManager.restartService(s.label, 1_500);
    await sleep(4_000);
    const t = s.tracksRunning();
    return [
      { label: '11 a copy that will not stop: no second copy is started', ok: s.starts().length === 1 && s.alive().length === 1 && s.alive()[0] === old && t.ok, detail: `${s.starts().length} starts; ${t.how}` },
      { label: '11 …and the failure is reported with the reason', ok: !manual.ok && /did not stop/.test(manual.reason), detail: JSON.stringify(manual) },
    ];
  }

  async function case12(): Promise<Check[]> {
    const s = svc('Sh1cDuringStop', BODY.slowStop); s.launch();
    await sleep(800);
    const replacing = heal(s);                           // watchdog stop in progress
    // Where a stop takes time (about 1 s), the other requests arrive in the middle
    // of it; where it is immediate, they arrive while the replacement is in progress.
    if (stopCanBeSlow) await sleep(300);
    selfHealingManager.scheduleRestart(s.label);         // file watcher
    selfHealingManager.reportError('Traceback (most recent call last):\nValueError: late report', s.label.toLowerCase());
    const manual = await selfHealingManager.restartService(s.label);
    await replacing;
    await sleep(5_000);                                  // past any back-off a late report could schedule
    const t = s.tracksRunning();
    return [
      { label: '12 requests during a replacement: one replacement, never two copies at once', ok: s.starts().length === 2 && s.maxAlive === 1 && s.alive().length === 1 && t.ok, detail: `${s.starts().length} starts, max at once ${s.maxAlive}; ${t.how}` },
      { label: '12 …the requested restart joins it and reports success; counted once', ok: manual.ok && s.entry().restarts === 1, detail: `${JSON.stringify(manual)}; restarts ${s.entry().restarts}` },
    ];
  }

  // Every case finishes before an error is raised, so no case is still starting services during the cleanup.
  const settled = await Promise.allSettled([case1(), case2and3(), case4(), case5(), case6(), case7(), case8(), case9(), case10(), case11(), case12()]);
  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  const groups = settled.map((r) => (r as PromiseFulfilledResult<Check[]>).value);
  return { checks: groups.flat().map((c) => ({ ...c, label: `[${mode}] ${c.label}` })), services };
}

// ── Run ──────────────────────────────────────────────────────────────────────
console.log('\n=== Self-healing restart policy: Option C (SH-1 follow-up) ===\n');
mgr.stopTimeoutMs = 1_500;   // the watchdog's and file watcher's stop limit, shortened for case 11
const all: Check[] = [];
/** Removes this run's own folder, and only once none of its processes is still running (they use its files). */
function removeWork(stillRunning: number[]): void {
  const own = path.dirname(work) === path.join(repo, 'data') && path.basename(work).startsWith('verify-windows-sh1c-');
  if (own && stillRunning.length === 0) {
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* reported below */ }
  }
  all.push({ label: 'the test folder is removed', ok: own && !fs.existsSync(work), detail: stillRunning.length ? `kept: ${stillRunning.join(',')} still running` : work });
}
// try/finally: the cleanup below also runs after an exception, which still ends the test as a failure. The lines
// inside are not re-indented, so they read exactly as before.
try { for (const mode of topologies()) {
  console.log(`##### Process arrangement: ${mode}${mode === 'direct' && process.platform === 'win32' ? ' (this host\'s Python; a venv launcher is accepted as the verified parent)' : ''} #####`);
  const { checks, services } = await runArrangement(mode);

  // Leave nothing running: no further starts for these services, then stop only this test's processes.
  for (const s of services) {
    s.stopSampling();
    const e = s.entry();
    e.disabledAt ??= new Date();
    if (e.proc) mgr.intendedStops.add(e.proc);
  }
  // Windows: stop only by verified identity, never by PID alone. Elsewhere: the existing /proc-checked path, unchanged.
  let leftover: number[];
  if (process.platform === 'win32') {
    leftover = await cleanUpOnWindows(() => services.flatMap((s) => s.starts()), `[${mode}] `);
  } else {
  const ours = () => services.flatMap((s) => [...s.alive(), ...s.launchersAlive()]);
  for (const pid of ours()) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(1_500);
  for (const pid of ours()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(500);
  leftover = ours();
  }
  all.push(...checks, { label: `[${mode}] no stand-in process is left running`, ok: leftover.length === 0, detail: leftover.join(',') });
} } finally {
  // After a normal run nothing is left; after an exception, stop what this test still has running, then remove its folder.
  for (const s of created) {
    s.stopSampling();
    const e = selfHealingManager.getManagedProcesses().get(s.label);
    if (e) { e.disabledAt ??= new Date(); if (e.proc) mgr.intendedStops.add(e.proc); }
  }
  // Windows: stop only by verified identity, never by PID alone. Elsewhere: the existing /proc-checked path, unchanged.
  if (process.platform === 'win32') {
    removeWork(await cleanUpOnWindows(() => created.flatMap((s) => s.starts()), ''));
  } else {
  const ours = () => created.flatMap((s) => [...s.alive(), ...s.launchersAlive()]);
  if (ours().length > 0) {
    for (const pid of ours()) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    await sleep(1_500);
    for (const pid of ours()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(500);
  }
  removeWork(ours());
  }
}

let passed = 0, failed = 0, skipped = 0;
for (const c of all) {
  if (c.skipped) { skipped++; console.log(`  SKIP: ${c.label} (${c.detail})`); }
  else if (c.ok) { passed++; console.log(`  PASS: ${c.label}${c.detail ? ` (${c.detail})` : ''}`); }
  else { failed++; console.error(`  FAIL: ${c.label}${c.detail ? ` (${c.detail})` : ''}`); }
}
console.log(`\n=== Results: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} ===`);
process.exit(failed > 0 ? 1 : 0);
