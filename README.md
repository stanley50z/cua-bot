# cua-bot

cua-bot (formerly the Grokbot hackathon project) is a self-hosted assistant for one owner. It runs as an always-on Pi Durable service, uses a Cua Space when it needs a computer, and sends email when you are not in the chat. The main model is xAI Grok 4.7.

## Architecture

- `src/main.ts` opens a Pi Durable Harness on `data/grokbot.sqlite`, resumes unfinished and sleeping work, and answers `POST /say` with plain text.
- `computer_use` runs in the foreground as a Grok subagent with Cua driver tools. On-screen work goes there, one task at a time.
- `send_email` sends only to the owner, through Gmail SMTP.
- Routines (`schedule`, `list_routines`, `run_routine`, `cancel_routine`) are durable sleeping tasks, one per routine. A schedule is a 5-field cron string, a nickname like `@daily`, or `@every 30m`, optionally prefixed `CRON_TZ=Area/City`, parsed with `croner` (see [src/cron.ts](src/cron.ts)). The legacy `everyMinutes`/`dailyAt`/`weeklyOn` objects are still accepted and converted. A deadline that passed while the bot was down fires once on restart; missed slots are not replayed. At most 50 routines.
- Outbound mail is plain SMTP. Google's official Gmail MCP is Developer Preview only and has no send tool.

## Self-host setup

Node.js 22.19 or newer (this project is set up for Node 24) and pnpm.

1. Run `pnpm install` in the project root.
2. Pair a Cua Space so it shows up in `~/.cua/spaces.json`. With `CUA_SPACE_ID` left blank, the bot uses the first space in that file.
3. Create a Gmail app password for the account that will send mail.
4. Sign in to xAI once with `node src/login.ts`. It runs the device-code flow for your SuperGrok or X Premium account (the same sign-in Grok Build uses) and saves the credential to `data/xai-credential.json`; the bot refreshes it on its own. An `XAI_API_KEY` in `.env` works instead.
5. Copy `.env.example` to `.env` and set `OWNER_EMAIL`, `SMTP_USER`, and `SMTP_PASS`.

`GROKBOT_MODEL` defaults to `grok-4.7`. `GROKBOT_PORT` defaults to `43142`. The server listens on `127.0.0.1` only.

## Usage

Start it in the background. This does not open a terminal window.

```
python start.py
```

When the port accepts connections, the script prints `http://127.0.0.1:43142/say`. If `data/grokbot.pid.json` already points at a live process, it refuses to start another one.

Send a message:

```
python say.py "Open Notes and add milk to the list."
python say.py "Every weekday at 9:00, email me a short agenda."
```

`say.py` POSTs the text to `/say` and prints the reply. It waits up to 10 minutes, because a computer-use turn can take that long.

Stop it:

```
python stop.py
```

That stops the recorded process and its children, checks that the process has exited and the port is free, then removes `data/grokbot.pid.json`. It only signals the pid in that file.

## Debugging artifacts

- `data/logs/grokbot.log` — service log, one line per event.
- `data/logs/stdout.log` — stdout and stderr from the process `start.py` launched.
- `data/crash/` — crash reports. The file name is the time, and the file contains the stack trace.
- `data/grokbot.sqlite` — Harness database, including sleeping routines.
- `data/shots/` — screenshots taken during computer use.

## Demo

1. Start the bot with `python start.py`, then schedule a routine one minute out that screenshots Notes on the Mac and emails the shot: `python say.py "Schedule a routine for one minute from now. Screenshot Notes on the Mac and email it to me."`
2. While the routine is sleeping, run `python stop.py`, then `python start.py`.
3. The email still arrives on time. The schedule is stored in `data/grokbot.sqlite`, and startup resumes sleeping work.
