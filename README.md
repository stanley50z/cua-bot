# cua-bot

cua-bot is a self-hosted assistant for one owner. It runs as an always-on Pi Durable service, uses a Cua Space when it needs a computer, and sends email when you are not in the chat. Models come from any OpenAI-compatible endpoint you list in `models.json`, in the same shape as Pi's custom providers ([src/models.ts](src/models.ts)). The computer-use helper uses the same model as the bot.

## Architecture

- `src/main.ts` opens a Pi Durable Harness on `data/cua-bot.sqlite`, resumes unfinished and sleeping work, and serves one HTTP server on `127.0.0.1:43142`: `POST /say` (plain text in, plain text out) plus the web app at `/` ([src/app.html](src/app.html)) with its JSON API under `/api/` (see [src/web.ts](src/web.ts)). The chat API ([src/chat.ts](src/chat.ts)): `GET /api/chat` pages the transcript, `POST /api/chat` with `{"text"}` queues a message without waiting, `POST /api/chat/stop` stops the current turn, `GET /api/chat/events` is a server-sent event stream of the live reply, running tools, and new messages, `GET /api/chat/computer` returns the computer pane (Space name, newest screenshot, steps of the latest computer-use run, from [src/computer-view.ts](src/computer-view.ts)), and `/shots/<name>.png` serves computer-use screenshots.
- `computer_use` runs in the foreground as a subagent on the bot's model with Cua driver tools. On-screen work goes there, one task at a time.
- Memory ([src/memory.ts](src/memory.ts)) is plain markdown under `data/memory/`: `profile.md` for lasting facts about the owner and `log/YYYY-MM.md` for dated ones, one fact per line as `- (YYYY-MM-DD) fact`. The bot saves with `remember`, removes with `forget`, and searches older facts with `recall`. Every request carries a memory section with the profile facts and the 30 most recent log facts, capped at 4,000 characters. The files are re-read on every request, so hand edits apply at once.
- Routines (`schedule`, `list_routines`, `run_routine`, `cancel_routine`) are durable sleeping tasks, one per routine. A schedule is a 5-field cron string, a nickname like `@daily`, or `@every 30m`, optionally prefixed `CRON_TZ=Area/City`, parsed with `croner` (see [src/cron.ts](src/cron.ts)). The legacy `everyMinutes`/`dailyAt`/`weeklyOn` objects are still accepted and converted. A deadline that passed while the bot was down fires once on restart; missed slots are not replayed. At most 50 routines. Definitions live in `routines.json` in the project root; the chat tools, the web app, and hand edits all sync through that file (a watcher applies hand edits within a second or two).
- Gmail, Google Calendar, and any other account you connect go through [Executor](https://github.com/UsefulSoftwareCo/executor) Cloud ([src/executor.ts](src/executor.ts)). Executor holds the Google sign-in; the bot holds only an Executor API key and talks to its MCP endpoint: `executor_search` finds a tool and its input type, `executor_describe` reads its full signature, `executor_call` runs it. Accounts you add in Executor later need no code change. Executor's `execute` tool (a JavaScript program over every tool) is not given to the bot, so every call goes through a path the bot can check. Call results are fenced as outside data, because mail and invites are written by other people.
- Approval cards ([src/approvals.ts](src/approvals.ts)): an Executor operation named send, delete, trash, clear, or remove (except mail only to you, below), or a call Executor itself pauses for approval, does not run. It becomes a card under the bot's reply in the web app. An email card shows the message decoded from what the bot actually wrote (To, Subject, and body are editable before sending, see [src/mime.ts](src/mime.ts)); other actions show the bot's one-line summary and the raw call under Details. Your click runs the call from the server, never from the model, and then the bot gets an `[approval]` message with the outcome. Waiting cards are kept in `data/approvals.json` across restarts and expire after 7 days. When Executor itself holds an approved call for approval, the server accepts the hold, since your click already approved it. The bot sends mail with Executor's `tools.google.gmail.send`, which takes To, Cc, Subject, and body as fields and keeps replies in their thread; Gmail `modify` with `trash: true` also needs a card. Known issue (2026-10-31): the raw Gmail API send (`tools.google.api.gmail…MessagesSend`) fails with HTTP 400, because Executor posts the upload to Gmail's non-upload URL; cards still decode it, but use the field send. `GET /api/approvals` lists them; `POST /api/approvals/<id>/approve` (optional JSON `{to, subject, body}` edits) and `POST /api/approvals/<id>/discard` decide one.
- Executor is the only email path, including reports to the owner. A `tools.google.gmail.send` or `tools.google.gmail.draft` whose every recipient (To, Cc, Bcc) is `OWNER_EMAIL` skips the card and runs at once, so a routine can email you on its own. Executor's Google app still holds both tools for approval (`approval: always()` in its `tools/gmail.ts`); for these calls only, the bot accepts that hold itself. A reply with no To still gets a card, since it goes to the original sender. Executor's Gmail send cannot attach files: when an email should carry a screenshot, the bot saves it as a Gmail draft with `tools.google.gmail.draft` and tells you which files under `data/shots/` to attach.

## Self-host setup

Node.js 22.19 or newer (this project is set up for Node 24) and pnpm.

1. Run `pnpm install` in the project root.
2. Pair a Cua Space so it shows up in `~/.cua/spaces.json`. With `CUA_SPACE_ID` left blank, the bot uses the first space in that file.
3. Copy `models.example.json` to `models.json` and list your model endpoints. Each provider has a `baseUrl` (for Azure AI Foundry, `https://<resource>.services.ai.azure.com/openai/v1`), an `api` (`openai-responses` or `openai-completions`, also settable per model), an `apiKey` (`"$NAME"` reads environment variable `NAME`, so the key can stay in `.env` or your user environment), and its `models`, each with the deployment name as `id` plus optional `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`, and `cost`. `"default"` is the model the bot runs on, as `"provider/model"`; `CUABOT_MODEL` overrides it. xAI is also built in as `xai/<model>`: sign in once with `node src/login.ts` or set `XAI_API_KEY`. `models.json` is gitignored.
4. Copy `.env.example` to `.env` and set `OWNER_EMAIL`.
5. For Gmail and Calendar: sign in at [executor.sh](https://executor.sh), add the Gmail and Google Calendar integrations and connect your Google account, then set `EXECUTOR_MCP_URL` to the URL on the Connect card and `EXECUTOR_API_KEY` to a key from the API keys page. Without them the bot runs with Gmail and Calendar off, and cannot email you.

Check everything with `node --env-file-if-exists=.env src/preflight.ts` while the bot is stopped. It prints one line per check (the model, the Space, Executor's connected accounts, the port) and never prints secrets.

`CUABOT_PORT` defaults to `43142`. The server listens on `127.0.0.1` only.

## Usage

Start it in the background. This does not open a terminal window.

```
python start.py
```

When the port accepts connections, the script prints the `/say` URL and the web app URL. If `data/cua-bot.pid.json` already points at a live process, it refuses to start another one.

### The web app

Open `http://127.0.0.1:43142/` in a browser. It has three parts:

- **Chat** in the middle. Replies stream in as the bot writes them. Each tool the bot used shows as a chip above its reply; click a finished chip to see the tool's result, and screenshots appear as thumbnails. Routine runs show as a line in the conversation. Enter sends, Shift+Enter adds a line, and the stop button ends the current reply. A message sent while the bot is busy waits its turn. When the bot wants to email anyone but you, or delete something, an approval card appears under its reply: edit the email if you like, then send it or discard it. Nothing goes out until you click.
- **Computer** on the right. The latest screenshot of the paired Space and each click and keystroke of the most recent computer-use task. The frame turns amber while the bot is driving.
- **Routines**, from the clock icon in the left rail. See the next section.
- **Memory**, from the page icon in the left rail. Everything the bot has saved about you, split into lasting facts and recent ones. Add a fact yourself or forget one with its ✕.

The page is served on loopback only and has no login, the same trust as `/say`.

### From the command line

Send a message:

```
python say.py "Open Notes and add milk to the list."
python say.py "Every weekday at 9:00, email me a short agenda."
```

`say.py` POSTs the text to `/say` and prints the reply. It waits up to 10 minutes, because a computer-use turn can take that long.

### Routines: web app and routines.json

The Routines view in the web app lists every routine with its schedule, next run, and last run. Add, edit, run now, and delete from there, with a live preview of the next runs while you type a cron schedule. Everything saved there lands in `routines.json` in the project root, which you can also edit by hand:

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

That stops the recorded process and its children, checks that the process has exited and the port is free, then removes `data/cua-bot.pid.json`. It only signals the pid in that file.

## Debugging artifacts

- `data/logs/cua-bot.log` — service log, one line per event.
- `data/logs/stdout.log` — stdout and stderr from the process `start.py` launched.
- `data/crash/` — crash reports. The file name is the time, and the file contains the stack trace.
- `data/cua-bot.sqlite` — Harness database, including sleeping routines and their last-fired times.
- `routines.json` — routine definitions (project root). Edit it directly or in the web app; the bot syncs from it.
- `data/shots/` — screenshots taken during computer use.
- `data/memory/` — what the bot remembers about you: `profile.md` and `log/YYYY-MM.md`.
- `data/approvals.json` — approval cards: waiting ones, and the last 200 decided with Executor's answer.

## Demo

1. Start the bot with `python start.py`, then schedule a routine one minute out that screenshots Notes on the Mac and drafts an email about it: `python say.py "Schedule a routine for one minute from now. Screenshot Notes on the Mac and email it to me."`
2. While the routine is sleeping, run `python stop.py`, then `python start.py`.
3. The draft still lands in Gmail on time, with the screenshot's path to attach. The schedule is stored in `data/cua-bot.sqlite`, and startup resumes sleeping work.
