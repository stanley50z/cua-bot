#!/usr/bin/env python3
"""Start cua-bot in the background. Prints the /say and web app URLs, or the stdout log on failure."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PID_PATH = ROOT / "data" / "cua-bot.pid.json"
LOG_PATH = ROOT / "data" / "logs" / "stdout.log"
DEFAULT_PORT = 43142
LISTEN_TIMEOUT_S = 10.0


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


# Read KEY=VALUE pairs from a dotenv file. Absent file returns an empty map.
def load_dotenv(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].strip()
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


# Environment wins over .env, matching `node --env-file-if-exists`.
def configured(key: str, dotenv: dict[str, str]) -> str | None:
    if key in os.environ:
        return os.environ[key]
    return dotenv.get(key)


def parse_port(raw: str) -> int:
    try:
        port = int(raw)
    except ValueError:
        raise SystemExit(f"CUABOT_PORT is not an integer: {raw!r}")
    if port < 1 or port > 65535:
        raise SystemExit(f"CUABOT_PORT is out of range: {port}")
    return port


# A blank CUABOT_PORT becomes the documented default in the child environment, so an empty value from
# .env.example never binds port 0. The model defaults live in src/models.ts.
def child_environment(dotenv: dict[str, str]) -> tuple[dict[str, str], int]:
    env = os.environ.copy()
    port_raw = configured("CUABOT_PORT", dotenv)
    if port_raw is None or port_raw.strip() == "":
        port = DEFAULT_PORT
    else:
        port = parse_port(port_raw.strip())
    env["CUABOT_PORT"] = str(port)
    return env, port


def read_pid_record() -> dict | None:
    if not PID_PATH.is_file():
        return None
    try:
        data = json.loads(PID_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"could not read {PID_PATH}: {exc}")
    if not isinstance(data, dict) or "pid" not in data:
        raise SystemExit(f"{PID_PATH} must be a JSON object with pid and port")
    return data


def write_pid_file(pid: int, port: int) -> None:
    PID_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"pid": pid, "port": port}) + "\n"
    temporary = PID_PATH.with_suffix(".json.tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(PID_PATH)


# Flags that detach the service: no console window on Windows, new session on POSIX.
def popen_flags() -> dict:
    if os.name == "nt":
        detached_process = 0x00000008
        create_new_process_group = 0x00000200
        create_no_window = 0x08000000
        return {"creationflags": detached_process | create_new_process_group | create_no_window}
    return {"start_new_session": True}


def port_accepts(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def tail_text(path: Path, lines: int = 40) -> str:
    if not path.is_file():
        return "(stdout log is missing)"
    with path.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - 65536))
        data = handle.read()
    text = data.decode("utf-8", errors="replace")
    picked = text.splitlines()[-lines:]
    return "\n".join(picked) if picked else "(stdout log is empty)"


# Moves the Pi packages (@earendil-works/*) to their newest release within package.json's ranges, so each
# start picks up Pi's latest tools; every other dependency stays as the lockfile pins it. pnpm's one-day
# minimum release age still applies. A failure (offline, no pnpm) is reported and the start goes on.
def update_pi() -> None:
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        print("pi update skipped: pnpm was not found on PATH", file=sys.stderr)
        return
    try:
        result = subprocess.run(
            [pnpm, "update", "@earendil-works/*"],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            creationflags=0x08000000 if os.name == "nt" else 0,  # CREATE_NO_WINDOW
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"pi update skipped: {exc}", file=sys.stderr)
        return
    output = (result.stdout or "") + (result.stderr or "")
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as log:
        log.write(f"--- pnpm update @earendil-works/* (exit {result.returncode})\n{output}\n")
    if result.returncode != 0:
        print(f"pi update failed (exit {result.returncode}); starting with the installed versions. See {LOG_PATH}", file=sys.stderr)
        return
    changed = [line.strip() for line in output.splitlines() if line.strip().startswith(("+ @earendil-works", "- @earendil-works"))]
    if changed:
        print("pi updated: " + ", ".join(changed))


def main() -> int:
    configure_stdio()
    node = shutil.which("node")
    if node is None:
        print("node was not found on PATH", file=sys.stderr)
        return 1

    existing = read_pid_record()
    if existing is not None:
        try:
            existing_pid = int(existing["pid"])
        except (TypeError, ValueError):
            print(f"{PID_PATH} has a bad pid; remove it before starting", file=sys.stderr)
            return 1
        if isinstance(existing["pid"], bool):
            print(f"{PID_PATH} has a bad pid; remove it before starting", file=sys.stderr)
            return 1
        if process_alive(existing_pid):
            port = existing.get("port", DEFAULT_PORT)
            print(
                f"cua-bot is already running (pid {existing_pid}) at http://127.0.0.1:{port}/say",
                file=sys.stderr,
            )
            return 1

    update_pi()
    env, port = child_environment(load_dotenv(ROOT / ".env"))
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    log_handle = LOG_PATH.open("ab", buffering=0)
    try:
        process = subprocess.Popen(
            [node, "--env-file-if-exists=.env", "src/main.ts"],
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            **popen_flags(),
        )
    except OSError as exc:
        print(f"failed to start node: {exc}", file=sys.stderr)
        return 1
    finally:
        log_handle.close()

    try:
        write_pid_file(process.pid, port)
    except OSError as exc:
        print(f"started pid {process.pid} but could not write {PID_PATH}: {exc}", file=sys.stderr)
        return 1

    deadline = time.monotonic() + LISTEN_TIMEOUT_S
    exited = False
    while time.monotonic() < deadline:
        if not process_alive(process.pid):
            exited = True
            break
        if port_accepts(port):
            print(f"http://127.0.0.1:{port}/say")
            print(f"web app: http://127.0.0.1:{port}/")
            return 0
        time.sleep(0.2)

    if not exited and port_accepts(port):
        print(f"http://127.0.0.1:{port}/say")
        print(f"web app: http://127.0.0.1:{port}/")
        return 0

    if exited:
        print(f"cua-bot exited before it accepted connections on 127.0.0.1:{port}", file=sys.stderr)
    else:
        print(
            f"cua-bot (pid {process.pid}) did not accept connections on 127.0.0.1:{port} within 10s. "
            "It is still running; python stop.py will stop it.",
            file=sys.stderr,
        )
    print(tail_text(LOG_PATH), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
