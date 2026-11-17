#!/usr/bin/env python3
"""Restart cua-bot: stop.py, then start.py. Settings > General runs it after updating cua-bot's packages (src/updates.ts).

Run by cua-bot itself, it is a child that stop.py would end along with cua-bot, so it first hands off to a detached
copy of itself and returns. That copy writes to data/logs/stdout.log, like start.py.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG_PATH = ROOT / "data" / "logs" / "stdout.log"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW


# No console window and out of the caller's process tree: a new process group on Windows, a new session on POSIX.
def detached() -> dict:
    if os.name == "nt":
        return {"creationflags": 0x00000008 | 0x00000200 | NO_WINDOW}  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    return {"start_new_session": True}


def main() -> int:
    if "--detached" not in sys.argv:
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--detached"],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **detached(),
        )
        return 0
    # On Windows stop.py ends cua-bot's tree by parent pid, so let the first copy exit before it runs.
    time.sleep(1)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as log:
        log.write(f"--- restart.py at {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        log.flush()
        for script in ("stop.py", "start.py"):
            code = subprocess.run(
                [sys.executable, str(ROOT / script)],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                creationflags=NO_WINDOW,
            ).returncode
            if code != 0:
                log.write(f"restart.py: {script} exited {code}\n")
                return code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
