#!/usr/bin/env python3
"""Stop the grokbot pid recorded in data/grokbot.pid.json, and its children."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PID_PATH = ROOT / "data" / "grokbot.pid.json"
GRACE_S = 5.0


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


# True when a process with this pid still exists. Permission errors count as alive.
def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        # os.kill(pid, 0) on Windows sends CTRL_C_EVENT instead of probing, so ask the kernel.
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5 or kernel32.GetLastError() == 5  # access denied: alive
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def port_accepts(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def require_pid(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise SystemExit(f"{PID_PATH} has a bad pid")
    if value <= 0 or value == os.getpid():
        raise SystemExit(f"refusing to signal pid {value}")
    if os.name == "nt" and value <= 4:
        raise SystemExit(f"refusing to signal system pid {value}")
    if os.name != "nt" and value == 1:
        raise SystemExit("refusing to signal pid 1")
    return value


def require_port(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise SystemExit(f"{PID_PATH} has a bad port")
    if value < 1 or value > 65535:
        raise SystemExit(f"{PID_PATH} has a bad port")
    return value


def wait_until_dead(pid: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not process_alive(pid):
            return True
        time.sleep(0.1)
    return not process_alive(pid)


def signal_pid(pid: int, sig: int) -> None:
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        return
    except OSError as exc:
        print(f"could not signal pid {pid}: {exc}", file=sys.stderr)


# Stop pid and its children. Never selects a process by name.
def terminate(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            check=False,
            capture_output=True,
        )
        return

    if not process_alive(pid):
        return
    try:
        group = os.getpgid(pid)
    except ProcessLookupError:
        return
    except OSError as exc:
        print(f"could not read the process group for pid {pid}: {exc}", file=sys.stderr)
        signal_pid(pid, signal.SIGTERM)
        if not wait_until_dead(pid, GRACE_S):
            signal_pid(pid, signal.SIGKILL)
        return

    if group != pid:
        print(
            f"pid {pid} is in process group {group}; signaling only that pid",
            file=sys.stderr,
        )
        signal_pid(pid, signal.SIGTERM)
        if not wait_until_dead(pid, GRACE_S):
            signal_pid(pid, signal.SIGKILL)
        return

    try:
        os.killpg(group, signal.SIGTERM)
    except ProcessLookupError:
        return
    except OSError as exc:
        print(f"could not signal process group {group}: {exc}", file=sys.stderr)
        return
    if not wait_until_dead(pid, GRACE_S):
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            return
        except OSError as exc:
            print(f"could not kill process group {group}: {exc}", file=sys.stderr)


def main() -> int:
    configure_stdio()
    if not PID_PATH.is_file():
        print("grokbot is not running")
        return 0
    try:
        data = json.loads(PID_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"could not read {PID_PATH}: {exc}", file=sys.stderr)
        return 1
    if not isinstance(data, dict):
        print(f"{PID_PATH} must be a JSON object with pid and port", file=sys.stderr)
        return 1

    pid = require_pid(data.get("pid"))
    port = require_port(data.get("port"))

    if process_alive(pid):
        terminate(pid)
    if not wait_until_dead(pid, GRACE_S):
        print(f"pid {pid} is still running", file=sys.stderr)
        return 1

    deadline = time.monotonic() + GRACE_S
    while port_accepts(port) and time.monotonic() < deadline:
        time.sleep(0.1)
    try:
        PID_PATH.unlink()
    except OSError as exc:
        print(f"pid {pid} exited, but could not remove {PID_PATH}: {exc}", file=sys.stderr)
        return 1
    if port_accepts(port):
        print(f"pid {pid} exited, but 127.0.0.1:{port} is still accepting connections", file=sys.stderr)
        return 1
    print(f"stopped {pid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
