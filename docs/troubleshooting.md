# Troubleshooting

[Back to README](../README.md)

Start with `node --env-file-if-exists=.env src/preflight.ts` while the bot is stopped. It checks the model, the Space, Executor's connected accounts and the port, one line each, without printing secrets.

## Logs and crash reports

| Path | Contents |
| --- | --- |
| `data/logs/cua-bot.log` | Service log, one line per event. Lists the bots on start (`bots: ...`), web edits to them, and failed pushes as `push:` lines. |
| `data/logs/stdout.log` | stdout and stderr of the process `start.py` launched, including the full `pnpm update` output. A `start.py` run at sign-in logs here too, under a `--- start.py at` line. |
| `data/crash/` | Crash reports. Each file is named by the time and holds the stack trace. |

## Data files

| Path | Contents |
| --- | --- |
| `data/cua-bot.sqlite` | Harness database: every bot's transcript, the bot list, sleeping routines and their last-fired times. |
| `bots/<folder>/` | Each bot's `agent.md`, `routines.json` (only when it has routines) and `memory/`. Edit them directly or in the web app; the bot syncs from them. |
| `data/memory/` | The shared memory every bot sees: `profile.md` and `log/YYYY-MM.md`. |
| `data/shots/` | Screenshots taken during computer use. |
| `data/approvals.json` | Waiting approval cards, plus the last 200 decided with Executor's answer. |
| `data/push.json` | The Web Push VAPID key pair and each subscribed browser. Delete it to make new keys; open browsers re-subscribe on their next page load. |
| `data/cua-bot.pid.json` | The running service's pid, written by `start.py` and removed by `stop.py`. |

## Common problems

**A routine file change did nothing.** An invalid `routines.json` (bad JSON, bad cron, duplicate ids, more than 50 entries) is rejected whole. The log says why, and that bot's running routines keep going.

**A call to another machine hangs about 40 seconds, then fails.** The machine is asleep or unreachable. The next call tries again.

**A call to another machine fails on the host key.** Connect once with `ssh <machine>` so its key is in `~/.ssh/known_hosts`. pi-env never writes to that file.

**The bot has no `cua_*` tools.** `cua mcp` didn't start; the log says why. Set `CUA_MCP_COMMAND` if `cua` isn't where the bot looks.

**The computer pane stays black.** If the caption says Connecting…, the live stream is down and the pane retries with backoff. Otherwise the browser lacks WebCodecs; use a current Chrome or Edge.

**`start.py` refuses to start.** `data/cua-bot.pid.json` points at a live process that answers on the bot's port. Run `python stop.py` first.

**The bot didn't come back after a restart.** Turn on Settings > Startup > Start when I sign in. It starts the bot when you sign in, not at boot, so a machine that sits at the sign-in screen stays off. If it's on and the bot still didn't start, look for the `--- start.py at` line in `data/logs/stdout.log`.
