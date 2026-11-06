"""Build pipeline helpers: typecheck+emit, then reboot the Node core gracefully.

Windows notes baked in here (each one bit us before):
- `npx` is `npx.cmd`; subprocess without a shell cannot find it -> call node + tsc directly.
- Decode child output as UTF-8 explicitly (locale cp1252 mojibakes everything).
- `taskkill /F` mid-write once produced `disk I/O error`; ask the core to stop first.
"""

import json
import shutil
import socket
import subprocess
import time
import urllib.request

try:
    from .config import DASHBOARD_PORT, DASHBOARD_TOKEN, PROJECT_ROOT, STORE_DIR
except ImportError:  # run as a script
    from config import DASHBOARD_PORT, DASHBOARD_TOKEN, PROJECT_ROOT, STORE_DIR

CORE_PID_FILE = STORE_DIR / "kings-reach.pid"
CORE_LOG_FILE = STORE_DIR / "logs" / "core.log"
TSC_JS = PROJECT_ROOT / "node_modules" / "typescript" / "bin" / "tsc"


def node_exe():
    return shutil.which("node") or "node"


def run_tsc():
    """Typecheck + emit dist/. Returns {ok, output}. Never throws."""
    try:
        p = subprocess.run(
            [node_exe(), str(TSC_JS)], cwd=str(PROJECT_ROOT), capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=300,
        )
        return {"ok": p.returncode == 0, "output": ((p.stdout or "") + (p.stderr or ""))[-2000:]}
    except Exception as exc:  # noqa: BLE001 - report, never crash the room
        return {"ok": False, "output": f"{type(exc).__name__}: {exc}"}


def _node_check(files):
    results = []
    for path in files:
        p = subprocess.run(["node", "--check", str(path)], cwd=PROJECT_ROOT, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60)
        if p.returncode != 0:
            results.append(f"{path.name}: {(p.stderr or p.stdout)[-1200:]}")
    return {"ok": not results, "output": "; ".join(results) or "clean"}


def preflight(python_exe):
    """Cheap baseline gate before an agent spends tokens or mutates files."""
    results = []
    tsc = run_tsc()
    results.append("tsc: " + ("clean" if tsc["ok"] else tsc["output"]))
    js_files = [PROJECT_ROOT / "public" / name for name in
                ("warroom-app.js", "warroom-voice.js", "warroom-live.js", "warroom-demo.js", "mic-worklet.js")]
    js = _node_check(js_files)
    results.append("browser JS: " + js["output"])
    py_files = [PROJECT_ROOT / "warroom" / name for name in
                ("server.py", "council.py", "agent_bridge.py", "build.py", "router.py", "config.py",
                 "live.py", "mindchange.py")]
    p = subprocess.run([python_exe, "-m", "py_compile", *map(str, py_files)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120)
    results.append("python: " + ("clean" if p.returncode == 0 else p.stderr[-1500:]))
    return {"ok": tsc["ok"] and js["ok"] and p.returncode == 0, "output": "; ".join(results)}


def gate(changed_files, python_exe):
    """Automated checks for what actually changed: tsc for TypeScript, py_compile for Python.
    Returns {ok, output}. Nothing checkable changed -> ok with a note (reviewers still read it)."""
    rel = [f.replace("\\", "/").lstrip("./") for f in changed_files]
    results, ok = [], True
    if any(f.endswith((".ts", ".tsx")) or f in ("tsconfig.json", "package.json") for f in rel):
        tsc = run_tsc()
        ok &= tsc["ok"]
        results.append("tsc: " + ("clean" if tsc["ok"] else tsc["output"]))
    js_files = [PROJECT_ROOT / f for f in rel if f.endswith((".js", ".mjs")) and (PROJECT_ROOT / f).exists()]
    if js_files:
        js = _node_check(js_files)
        ok &= js["ok"]
        results.append(f"node --check ({len(js_files)} files): {js['output']}")
    py = [str(PROJECT_ROOT / f) for f in rel if f.endswith(".py") and (PROJECT_ROOT / f).exists()]
    if py:
        p = subprocess.run([python_exe, "-m", "py_compile", *py], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=120)
        ok &= p.returncode == 0
        results.append(f"py_compile ({len(py)} files): " + ("clean" if p.returncode == 0 else p.stderr[-1500:]))
    missing = [f for f in rel if not (PROJECT_ROOT / f).exists() and not f.startswith("workspace/")]
    if missing:
        results.append("reported but not found (deleted or outside repo): " + ", ".join(missing[:10]))
    return {"ok": ok, "output": "; ".join(results) or "no code changed (nothing to compile)"}


def port_open(port, host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def wait_port(port, want_open, timeout_s):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if port_open(port) == want_open:
            return True
        time.sleep(0.3)
    return False


def _request_core_shutdown():
    """POST /api/admin/shutdown (no Origin header -> passes the CSRF guard). True if accepted."""
    req = urllib.request.Request(
        f"http://127.0.0.1:{DASHBOARD_PORT}/api/admin/shutdown", data=b"{}", method="POST",
        headers={"Content-Type": "application/json", "x-kings-reach-token": DASHBOARD_TOKEN},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return bool(json.loads(resp.read().decode("utf-8")).get("ok"))
    except Exception:  # noqa: BLE001
        return False


def _read_core_pid():
    try:
        return int(CORE_PID_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def reboot_core(log=print):
    """Stop the core (graceful first, hard kill by real pid as fallback), start a fresh one.
    Returns {ok, detail}."""
    if port_open(DASHBOARD_PORT):
        graceful = _request_core_shutdown()
        log("core shutdown requested, graceful =", graceful)
        if not wait_port(DASHBOARD_PORT, False, 15):
            pid = _read_core_pid()
            if not pid:
                return {"ok": False, "detail": f":{DASHBOARD_PORT} still held and no core pid file"}
            log("graceful stop timed out; taskkill /F pid", pid)
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, timeout=30)
            if not wait_port(DASHBOARD_PORT, False, 10):
                return {"ok": False, "detail": f"pid {pid} killed but :{DASHBOARD_PORT} still open"}
    CORE_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    with open(CORE_LOG_FILE, "ab") as logf:
        proc = subprocess.Popen(
            [node_exe(), "dist/index.js"], cwd=str(PROJECT_ROOT), stdin=subprocess.DEVNULL,
            stdout=logf, stderr=subprocess.STDOUT, creationflags=flags, close_fds=True,
        )
    if wait_port(DASHBOARD_PORT, True, 30):
        return {"ok": True, "detail": f"core pid {proc.pid} listening on :{DASHBOARD_PORT} (log: store/logs/core.log)"}
    return {"ok": False, "detail": f"new core (pid {proc.pid}) did not open :{DASHBOARD_PORT}; see store/logs/core.log"}
