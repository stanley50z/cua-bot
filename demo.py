#!/usr/bin/env python3
"""Set up the live demo on Windows: `python demo.py` (add --fresh to archive the old conversation first).

Runs the pre-flight check, starts the bot, then opens the demo layout: a Windows Terminal with a live log
pane and a command pane, the Cua Spaces app (Mac mini live view), and Gmail. Stop afterwards with stop.py.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
LOG = DATA / "logs" / "grokbot.log"


# Moves the conversation, logs, shots, and crash reports into data/archive-<time>/. Keeps the xAI sign-in.
def archive() -> None:
    names = ["grokbot.sqlite", "grokbot.sqlite-shm", "grokbot.sqlite-wal", "logs", "shots", "crash"]
    present = [DATA / n for n in names if (DATA / n).exists()]
    if not present:
        return
    target = DATA / f"archive-{time.strftime('%Y%m%d-%H%M%S')}"
    target.mkdir()
    for path in present:
        shutil.move(str(path), str(target / path.name))
    print(f"archived old state to {target}")


def main() -> int:
    if "--fresh" in sys.argv:
        if (DATA / "grokbot.pid.json").exists():
            print("bot is running; run python stop.py before --fresh")
            return 1
        archive()

    node = shutil.which("node") or "node"
    if (DATA / "grokbot.pid.json").exists():
        print("bot already running; skipping pre-flight")
    else:
        if subprocess.run([node, "--env-file-if-exists=.env", "src/preflight.ts"], cwd=ROOT).returncode != 0:
            print("pre-flight failed; fix the FAIL lines above")
            return 1
        if subprocess.run([sys.executable, "start.py"], cwd=ROOT).returncode != 0:
            return 1

    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.touch()
    tail = f"Get-Content -Encoding utf8 -Wait -Tail 15 '{LOG}'"
    subprocess.Popen(
        [
            "wt.exe", "-w", "new", "--title", "grokbot log", "-d", str(ROOT),
            "powershell.exe", "-NoExit", "-Command", tail,
            ";", "split-pane", "-V", "--title", "grokbot", "-d", str(ROOT), "powershell.exe", "-NoExit",
        ]
    )
    subprocess.Popen(["explorer.exe", r"shell:AppsFolder\ai.cua.spaces.desktop"])
    webbrowser.open("https://mail.google.com/mail/u/0/#inbox")
    print("demo layout open; prompts are in DEMO.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
