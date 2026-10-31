# cua-bot

cua-bot (formerly the Grokbot hackathon project) is a self-hosted assistant for one owner. It runs as an always-on Pi Durable service, uses a Cua Space when it needs a computer, and sends email when you are not in the chat. The main model is xAI Grok 4.7.

## Architecture

- `src/main.ts` opens a Pi Durable Harness on `data/grokbot.sqlite`, resumes unfinished and sleeping work, and serves one HTTP server on `127.0.0.1:43142`: `POST /say` (plain text in, plain text out) plus the routines web UI at `/` with its JSON API under `/api/` (see [src/web.ts](src/web.ts)).
- `computer_use` runs in the foreground as a Grok subagent with Cua driver tools. On-screen work goes there, one task at a time.
- `send_email` sends only to the owner, through Gmail SMTP.
- Routines (`schedule`, `list_routines`, `run_routine`, `cancel_routine`) are durable sleeping tasks, one per routine. A schedule is a 5-field cron string, a nickname like `@daily`, or `@every 30m`, optionally prefixed `CRON_TZ=Area/City`, parsed with `croner` (see [src/cron.ts](src/cron.ts)). The legacy `everyMinutes`/`dailyAt`/`weeklyOn` objects are still accepted and converted. A deadline that passed while the bot was down fires once on restart; missed slots are not replayed. At most 50 routines. Definitions live in `routines.json` in the project root; the chat tools, the web UI, and hand edits all sync through that file (a watcher applies hand edits within a second or two).
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

When the port accepts connections, the script prints the `/say` URL and the routines UI URL. If `data/grokbot.pid.json` already points at a live process, it refuses to start another one.

Send a message:

```
python say.py "Open Notes and add milk to the list."
python say.py "Every weekday at 9:00, email me a short agenda."
```

`say.py` POSTs the text to `/say` and prints the reply. It waits up to 10 minutes, because a computer-use turn can take that long.

### Routines without chat: web UI and routines.json

Open `http://127.0.0.1:43142/` for the routines page: add, edit, run now, and delete, with a live next-fire preview while you type a cron schedule. Everything saved there lands in `routines.json` in the project root, which you can also edit by hand:

```json
[
  {
    "title": "Morning agenda",
    "prompt": "Email me today's calendar and overnight mail worth reading.",
    "cron": "30 7 * * 1-5"
  }
]
```

`id` is optional; the bot fills it in. The file is the source of truth for definitions: on start and on every change the bot syncs its durable tasks to match, so editing a title, prompt, or cron replaces that routine's sleeper, and removing an entry cancels it. An invalid file (bad JSON, bad cron, duplicate ids, more than 50 entries) is rejected whole — running routines keep going and the log says why. If the file is missing, the bot recreates it from the routines it already has instead of deleting them. Routines created in chat are written to the same file. Run history (last fired) stays in the bot's database, not the file. `routines.json` is gitignored like `.env`.

Stop it:

```
python stop.py
```

That stops the recorded process and its children, checks that the process has exited and the port is free, then removes `data/grokbot.pid.json`. It only signals the pid in that file.

## Debugging artifacts

- `data/logs/grokbot.log` — service log, one line per event.
- `data/logs/stdout.log` — stdout and stderr from the process `start.py` launched.
- `data/crash/` — crash reports. The file name is the time, and the file contains the stack trace.
- `data/grokbot.sqlite` — Harness database, including sleeping routines and their last-fired times.
- `routines.json` — routine definitions (project root). Edit it directly or through the web UI; the bot syncs from it.
- `data/shots/` — screenshots taken during computer use.

## Demo

1. Start the bot with `python start.py`, then schedule a routine one minute out that screenshots Notes on the Mac and emails the shot: `python say.py "Schedule a routine for one minute from now. Screenshot Notes on the Mac and email it to me."`
2. While the routine is sleeping, run `python stop.py`, then `python start.py`.
3. The email still arrives on time. The schedule is stored in `data/grokbot.sqlite`, and startup resumes sleeping work.
