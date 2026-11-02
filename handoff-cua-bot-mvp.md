# Handoff: cua-bot MVP, first live run on gpt-6.1-terra

Updated 2026-10-31. Repo: github.com/stanley50z/cua-bot (private, `main`, HTTPS remote). The handoff was last updated after `22fda52` (pushed, tree clean).

## What the project is

cua-bot is a self-hosted assistant for one owner, built on Pi Durable and Cua Spaces. The MVP scope is memory, cron routines, and Gmail/Calendar through Executor Cloud. Proactive notifications are browser Web Push only (since 2026-11-02): `cua_notify_user` calls and new approval cards. No Telegram.

Read [README.md](README.md) first. It covers the architecture, setup, approval cards, and debugging paths. The recent work is in these commits:

- `f63fc61`: Executor (`src/executor.ts`).
- `f380efd`: approval cards (`src/approvals.ts`, `src/mime.ts`, the card UI in `src/app.html`, the routes in `src/web.ts`).
- `782a810`: Pi-style `models.json` (`src/models.ts`) and the rename to cua-bot.
- `22fda52`: Executor became the only email path.

## Live run result (2026-10-31 evening, uncommitted)

All six steps below passed on gpt-6.1-terra after two fixes. `pnpm test` is now 66 tests.

- **No date in the prompt.** The bot ran `computer_use` on the Mac just to read the clock. Fix: a `today` section in the persona (`src/today.ts`, test in `test/today.test.ts`).
- **Screenshots stayed on the Mac.** The child passed `screenshot_out_file`, so the driver returned no image: the child acted blind and nothing reached `data/shots/`. Fix: `shotArgs` in `src/computer.ts` drops that argument and hides it from the schema (`test/computer.test.ts`).
- **Executor holds `tools.google.gmail.draft` for approval** (an `apr_…` paused request), so a draft shows a card too. The prompt in `src/executor.ts` and the README no longer say "no card". Settled since: drafts and sends only to the owner have their hold accepted by cua-bot (see "Owner-only sends" below).
- Later fixed: chips now read "Calendar: list events" instead of "calendar calendar list list"; the approve log names edits only when the owner changed something; `POST /api/approvals/<id>/approve` accepts an empty body.
- Later verified live (2026-10-31 night): a routine's "Run now" emailed the owner with no card; a Calendar insert held by Executor became a card and created the event once approved; deleting that event and trashing a test email each became a card and ran once approved. The bot trashed with the raw `gmailUsersMessagesTrash`, so Gmail `modify` with `trash: true` is still covered only by tests.

## Next step (done, kept for reference): run the bot end to end on gpt-6.1-terra

Everything so far was checked through preflight, the API, or tests. The bot has not had a real chat turn on its new default model, and the email flows changed in `22fda52`. Work through the checks below, fixing what breaks, and report what you saw.

1. **Check, then start.**
   - Run `node --env-file-if-exists=.env src/preflight.ts`. The last run was all PASS: env, model, Space, Executor, and the port.
   - Then run `python start.py` and open `http://127.0.0.1:43142/`.
   - On start, `main.ts` runs `configure()`, which moves the existing root conversation from xAI onto `azure-foundry-2/gpt-6.1-terra`. `data/logs/cua-bot.log` should say `cua-bot up: model azure-foundry-2/gpt-6.1-terra`.
2. **Have a plain chat turn.** Check that the reply streams in, that tool chips show, and that memory recall works.
3. **Read Gmail and Calendar.** For example, ask "what's on my calendar tomorrow" and "any unread mail from today". Watch for wrong tool paths or guessed `accountId` values. gpt-6.1-terra uses `openai-responses` with a `thinkingLevelMap` (off→"none" … max→"max"), and the bot asks for `thinkingLevel: "medium"`. If tool calling or reasoning misbehaves, look there first.
4. **Send an email to the owner.**
   - It should become an editable approval card using `tools.google.gmail.send`, and nothing should go out before the click.
   - Approve it once, then check that the bot acknowledges the `[approval]` message.
   - Send only to `OWNER_EMAIL`. Never send to anyone else without the user's go-ahead.
5. **Email a screenshot.** This is the new path from `22fda52`.
   - Ask the bot to screenshot something on the Mac and email it.
   - It should save a draft with `tools.google.gmail.draft` (no card) and give the absolute path of the file under `data/shots/` to attach.
   - This step drives the paired Space through `computer_use`. That is the bot's own tool, which is fine. You yourself must not use computer use.
6. **Stop.** Run `python stop.py` and check that port 43142 is free.

The guidance the model sees lives in the persona in `src/main.ts`, the section and `executor_call` description in `src/executor.ts`, and the routine guidance in `src/routines.ts`. Keep prompt edits small, and add a test when behaviour changes.

## Owner-only sends (decided 2026-10-31: skip the card)

The user said yes. `onlyToOwner` in `src/executor.ts` lets a `tools.google.gmail.send` whose To, Cc and Bcc are all `OWNER_EMAIL` skip cua-bot's card (tests in `test/executor.test.ts`, 68 total). Executor's Google app declares `approval: always()` on `gmail.send`, `gmail.draft` and `gmail.modify` (its source, `tools/gmail.ts`; there is no dashboard toggle). The user chose to keep that gate: for owner-only sends and drafts, `executor_call` accepts Executor's hold itself via `acceptHolds` in `src/approvals.ts` (70 tests). Verified live 2026-10-31: an owner send went out with no card. A brief `never()` edit to the Executor app was pushed and reverted without deploying (latest is `aaebf46`, same as the original). An older test card (`ap_mvx6147eeqqog5`) is still waiting in the app.

## Decision to raise with the user (superseded by the section above)

Every send now waits on a card, including a routine's report to the owner. A morning-agenda routine therefore leaves a card in the app instead of emailing on its own. I asked whether a send addressed only to `OWNER_EMAIL` should skip the card, and the user hasn't answered yet. Bring it up once the live run shows how it feels. Don't build it unasked.

The Calendar insert Executor holds, and a trash, were verified live later the same night (see the live run result above).

## Settled decisions (don't reopen)

- **No git history rewrite.** The user said no.
- **Executor is the only email path.** Don't add SMTP or any other sender back.
- **Files go in drafts.** Executor's Gmail send has no attachments field. A screenshot goes into a draft, and the owner attaches it.
- **The Gmail catalog app is gone.** The user deleted it, so all mail uses the Google integration (`tools.google.gmail.*`). Executor's connected Google account is the owner's CMU Workspace account.
- **Model:** the default is `azure-foundry-2/gpt-6.1-terra`, set in the gitignored `models.json`. `CUABOT_MODEL` overrides it. `start.py` deliberately pins no model.

## Environment and secrets

- **`.env` (gitignored)** holds `OWNER_EMAIL`, `EXECUTOR_MCP_URL`, `EXECUTOR_API_KEY`, and `AZURE_FOUNDRY_2_API_KEY`. The unused `SMTP_USER` and `SMTP_PASS` were deleted on 2026-10-31.
- **`AZURE_FOUNDRY_API_KEY`** is a Windows user environment variable, shared with Pi.
- **Never print secret values or the owner's addresses.** To collect a new secret, use T3's `request_secret` with `delivery: "file"`.
- **Logs:**
  - `data/logs/cua-bot.log`
  - `data/logs/stdout.log`
  - `data/crash/`
  - Approval cards are in `data/approvals.json`.

## Gotchas

- **Executor Cloud v2 differs from the open-source repo.** Its MCP tools are `skills`, `search`, `describe`, `call`, `execute`, and `resume`. The bot gets only search, describe, and call. A paused call returns `"status":"approval-required"` with an `apr_…` id, and the server accepts that id after the owner clicks.
- **Raw Gmail send is broken.** `tools.google.api.gmail.users.gmailUsersMessagesSend` returns HTTP 400 because of an Executor bug. Use `tools.google.gmail.send`.
- **The model is only set when the conversation is created.** `Harness.root()` sets the agent only on creation, so the `configure()` commit on start is what changes the model of an existing conversation.
- **Reference checkouts:**
  - Pi: `~/github repo ref/pi`
  - The Cua fork: `~/cua`
  - The paired Space is the Mac mini over Tailscale (`~/.cua/spaces.json`).

## Standing constraints from the user

- **Naming:** the project is **cua-bot**. Never call it Grokbot or describe it as a clone of, or as built on, leaked code. This applies in code, docs, prompts, and env names.
- **Out of bounds:** don't propose Google's hosted MCP servers or a Gmail path with your own OAuth client. Don't add notification channels beyond Web Push and Cua's feed (no Telegram).
- **No computer use by the agent** unless the user explicitly asks. The bot's own `computer_use` tool is separate.
- **Edits:** make targeted edits with the Edit tool, not sed, Python, or `node -e`.
- **UI:** mock first, and let the user pick before you touch real components.
- **Long answers:** anything longer than a few paragraphs goes in an HTML report.
- **Look things up:** search the web instead of guessing product names or facts.
- **Commits:** commit only when the user asks.

## Suggested skills

- `diagnosing-bugs`: if the live run misbehaves (tool paths, reasoning, approval flow).
- `tdd`: for any fix. Tests are `node:test` under `test/`, with a fake Executor in `test/fake-executor.ts`. Run `pnpm test` (63 tests) and `pnpm check`.
- `browser-harness`: to drive the web app at `127.0.0.1:43142` during the live run, or the Executor dashboard. Close the tabs afterwards.
- `unslop`: for prompt text, README changes, and replies.
- `frontend-design` and `prototype`: for any change to the cards or the app. Mock first.
- `commit`: only when the user asks.
