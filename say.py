#!/usr/bin/env python3
"""POST a message to grokbot /say and print the plain-text answer."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PID_PATH = ROOT / "data" / "grokbot.pid.json"
DEFAULT_PORT = 43142
TIMEOUT_S = 600


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


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


def parse_port(raw: str) -> int:
    try:
        port = int(raw)
    except ValueError:
        raise SystemExit(f"GROKBOT_PORT is not an integer: {raw!r}")
    if port < 1 or port > 65535:
        raise SystemExit(f"GROKBOT_PORT is out of range: {port}")
    return port


# Prefer the port recorded by start.py. Otherwise use the environment, then .env, then 43142.
def resolve_port() -> int:
    if PID_PATH.is_file():
        try:
            data = json.loads(PID_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit(f"could not read {PID_PATH}: {exc}")
        if not isinstance(data, dict) or isinstance(data.get("port"), bool):
            raise SystemExit(f"{PID_PATH} must be a JSON object with pid and port")
        return parse_port(str(data.get("port")))

    if "GROKBOT_PORT" in os.environ:
        raw = os.environ["GROKBOT_PORT"]
    else:
        raw = load_dotenv(ROOT / ".env").get("GROKBOT_PORT")
    if raw is None or raw.strip() == "":
        return DEFAULT_PORT
    return parse_port(raw.strip())


def main() -> int:
    configure_stdio()
    if len(sys.argv) < 2:
        print('usage: python say.py "message"', file=sys.stderr)
        return 2

    message = " ".join(sys.argv[1:])
    url = f"http://127.0.0.1:{resolve_port()}/say"
    request = urllib.request.Request(
        url,
        data=message.encode("utf-8"),
        method="POST",
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        print(detail or f"HTTP {exc.code}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"could not reach {url}: {exc.reason}", file=sys.stderr)
        return 1

    text = body.decode("utf-8", errors="replace")
    print(text, end="" if text.endswith("\n") else "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
