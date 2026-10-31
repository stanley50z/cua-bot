# Handoff: cua-bot MVP (Executor Gmail/Calendar, approval cards, models.json)

Written 2026-10-31. Repo: github.com/stanley50z/cua-bot (private, `main`, HTTPS remote). Working tree was clean at `782a810` when this was written.

## What the project is

A self-hosted assistant for one owner on Pi Durable and Cua Spaces. MVP scope is memory, cron routines, and Gmail/Calendar through Executor Cloud. Proactive notifications are out of scope.

The current architecture, setup, and debugging paths are in [README.md](README.md). Read it first. These three commits did the recent work, and their diffs show it:

- `f63fc61`: Gmail and Google Calendar through Executor Cloud (`src/executor.ts`)
- `f380efd`: approval cards for sends and deletes (`src/approvals.ts`, `src/mime.ts`, the card UI in `src/app.html`, routes in `src/web.ts`), and the move to Azure AI Foundry
- `782a810`: Pi-style `models.json` (`src/models.ts`), the `azure-foundry-2` provider, Gmail field send, and the rename to cua-bot

## State at handoff

- **Default model** is `azure-foundry-2/gpt-6.1-terra`, set in `models.json`. That file is gitignored, so this change has no commit. Preflight passed: `node --env-file-if-exists=.env src/preflight.ts` gets a reply from the model.
- **The bot is stopped.** On the next `python start.py`, `main.ts` commits a `configure()` that moves the existing root conversation onto the new model. `Harness.root()` only sets the agent when it creates the conversation, which is why the `configure()` is needed. A full chat turn has not run on gpt-6.1-terra yet, so do that first.
- **Tests:** `pnpm test` passes 65/65, and `tsc` is clean.
- **`.env` (gitignored)** holds the key names `EXECUTOR_MCP_URL`, `EXECUTOR_API_KEY`, `AZURE_FOUNDRY_2_API_KEY`, and `OWNER_EMAIL` (plus the now-unused SMTP pair). `AZURE_FOUNDRY_API_KEY` is a Windows user environment variable, shared with Pi's `~/.pi/agent/models.json`. Never print the values. To collect a new secret, use T3's `request_secret` with `delivery: "file"`.
- **Local-only, untracked files:** `docs/brainstorm-*.html` (gitignored) and `docs/mocks/2026-10-31-app-directions.html`.

### Verified live

- Executor calendar and mail reads.
- A discarded card, run through the API.
- An approved send with edits through `tools.google.gmail.send`. It reached the owner's inbox with the edit in place.
- Preflight replies from azure-foundry `grok-4.6`, azure-foundry-2 `gpt-6.1-terra`, and azure-foundry-2 `FW-MiniMax-M2.5`.

### Not verified live

- A Calendar insert that Executor holds for its own approval. Only `test/executor.test.ts` covers it.
- Trash through Gmail `modify`.

## Decisions made after the first draft of this handoff

1. **No history rewrite.** The user said no. Don't offer it again.
2. **Executor is the only email path.** SMTP `send_email`, nodemailer, and the `SMTP_*` variables were removed (uncommitted at this point; `pnpm test` 63/63, `tsc` clean, preflight all PASS). Every send, including reports to the owner, waits on an approval card.
3. **Screenshots and other files go in drafts.** Executor's Gmail send has no attachments. The bot saves a draft with `tools.google.gmail.draft`, which needs no card, and tells the owner which files to attach.
4. **The Gmail catalog app is gone.** The user deleted it from Executor. All mail goes through the Google integration (`tools.google.gmail.*`).

## Still open

- Should a send whose only recipient is `OWNER_EMAIL` skip the card, so routines can email the owner unattended? I asked and the user didn't answer. The default is a card for every send.
- `.env` still has the unused `SMTP_USER` and `SMTP_PASS`. The owner may want to revoke that Gmail app password.

## Gotchas

- **Executor Cloud v2 differs from the open-source repo.** Its MCP tools are `skills`, `search`, `describe`, `call`, `execute`, and `resume`, and `?mode=passthrough` is ignored. The bot gets only search, describe, and call. A paused call returns `"status":"approval-required"` with an `apr_…` request id.
- **Executor bug with the raw Gmail send.** `tools.google.api.gmail.users.gmailUsersMessagesSend` returns HTTP 400 because Executor posts the upload to the non-upload URL. Use `tools.google.gmail.send`, whose fields are `to[]`, `cc`, `bcc`, `subject`, `body`, `replyToMessageId`, and `replyAll`. The README records this bug.
- **`start.py` no longer pins a model.** Pinning a model there once made the bot run an id that doesn't exist. The model comes from `CUABOT_MODEL` if set, otherwise the `models.json` default.
- **Reference checkouts:**
  - Pi: `~/github repo ref/pi`
  - The Cua fork: `~/cua`
  - The other reference checkout (ideas only, no licence) is listed in the project memory. Never name it in the repo.
- **Cua Space:** the paired Space is the Mac mini over Tailscale (`~/.cua/spaces.json`).
- **Port:** the default is 43142. After stopping a test server, check that the port is free.

## Standing constraints from the user

- The project is **cua-bot**. Never call it Grokbot or describe it as a clone of, or built on, leaked code. This applies in code, docs, prompts, and env names (`CUABOT_*`).
- Don't propose Google's hosted MCP servers or a Gmail path with your own OAuth client. Don't re-add notifications.
- No computer use unless the user explicitly asks.
- Make targeted edits with the Edit tool, not sed, Python, or `node -e` string replacement.
- Mock UI first and let the user pick a direction before touching real components.
- Answers longer than a few paragraphs go in an HTML report.
- Search the web when the user half-remembers a product name. Don't guess.

## Suggested skills

- `tdd`: for any feature or fix. Tests are `node:test` under `test/`, with a fake Executor in `test/fake-executor.ts`.
- `unslop`: for README text, prompts, and chat replies.
- `diagnosing-bugs`: if the first run on gpt-6.1-terra misbehaves (tool-call format, reasoning levels).
- `browser-harness`: for the Executor dashboard. Close the tabs afterwards.
- `frontend-design` and `prototype`: for any change to the approval cards or the web app (mock first).
- `commit`: when the user asks to commit.
