# Configuration

[Back to README](../README.md)

## Requirements

- Node.js 22.19 or newer. The project is set up for Node 24.
- pnpm.
- At least one Cua Space, signed in with `cua auth login`. The bots see every Space your Cua account lists: ones you added (`~/.cua/spaces.json`) and computers the Cua Spaces app shares, such as the one cua-bot runs on. The default Space is `CUA_SPACE_ID`, or the first in `~/.cua/spaces.json` when that's blank.

## Models (`models.json`)

Copy `models.example.json` to `models.json` (gitignored) and list your endpoints. The shape matches Pi's custom providers ([src/models.ts](../src/models.ts)).

```json
{
  "default": "azure-foundry/grok-4.6",
  "providers": {
    "azure-foundry": {
      "baseUrl": "https://<resource>.services.ai.azure.com/openai/v1",
      "api": "openai-responses",
      "apiKey": "$AZURE_FOUNDRY_API_KEY",
      "models": [{ "id": "grok-4.6", "reasoning": true, "input": ["text", "image"] }]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `default` | The model the bot runs on, as `"provider/model"`. `CUABOT_MODEL` overrides it. |
| `baseUrl` | The provider's endpoint. For Azure AI Foundry, `https://<resource>.services.ai.azure.com/openai/v1`. |
| `api` | `openai-responses` or `openai-completions`. A model can set its own. |
| `apiKey` | The key, or `"$NAME"` to read environment variable `NAME` from `.env` or your user environment. |
| `models[].id` | The deployment name. |
| `models[]` optional | `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`, `cost`. |

Two subscriptions are built in, signed in once with the bot stopped and saved to `data/credentials.json`:

| Provider | Sign in | Or set |
| --- | --- | --- |
| `openai/<model>` | `node src/login.ts openai` (your ChatGPT plan) | `OPENAI_API_KEY` |
| `xai/<model>` | `node src/login.ts xai` (SuperGrok or X Premium) | `XAI_API_KEY` |

Pick the model and reasoning effort in Settings > Model, or with `CUABOT_MODEL` and `CUABOT_REASONING` in `.env`. The page writes those two lines and moves every bot over from its next turn, with no restart. A variable set in your real environment wins over `.env` at the next start. These are the defaults: a bot's edit dialog can pick its own model and effort, which stay in the database and win over them.

The `computer_use` helper runs on the model and effort of the bot that called it.

## Environment (`.env`)

Copy `.env.example` to `.env`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `OWNER_EMAIL` | yes | Your address. Mail sent only to it skips the approval card. |
| `AZURE_FOUNDRY_API_KEY` (or whatever `models.json` names) | yes | Model provider key. |
| `XAI_API_KEY` | no | For `xai/<model>`, instead of `node src/login.ts xai`. |
| `OPENAI_API_KEY` | no | For `openai/<model>`, instead of `node src/login.ts openai`. |
| `EXECUTOR_MCP_URL` | no | The URL on Executor's Connect card, e.g. `https://executor.sh/<org>/mcp`. |
| `EXECUTOR_API_KEY` | no | A key from Executor's API keys page. |
| `CUA_SPACE_ID` | no | The default Space's id: the one `computer_use` and `space_bash` use when the bot names no Space, and the one the live screen shows. Defaults to the first in `~/.cua/spaces.json`. |
| `CUA_MCP_COMMAND` | no | The `cua` CLI to run `cua mcp` with. Defaults to the Cua Spaces app's bundled `cua.exe` on Windows, else `cua` on PATH. |
| `CUABOT_MODEL` | no | `"provider/model"`, overriding `default` in `models.json`. |
| `CUABOT_REASONING` | no | The bots' reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Defaults to `medium`. A model that doesn't support the effort uses its nearest one. |
| `CUABOT_PORT` | no | HTTP port. Defaults to `43142`. The server listens on `127.0.0.1` only. |

## Gmail and Calendar

1. Sign in at [executor.sh](https://executor.sh).
2. Add the Gmail and Google Calendar integrations and connect your Google account.
3. Set `EXECUTOR_MCP_URL` and `EXECUTOR_API_KEY` in `.env`.

Without them the bot runs with Gmail and Calendar off, and can't email you. Accounts you add in Executor later need no code change. How the bot uses Executor is in [How it works](architecture.md#accounts-through-executor).

## Preflight

With the bot stopped, run:

```sh
node --env-file-if-exists=.env src/preflight.ts
```

It prints one line per check (the model, the Space, Executor's connected accounts, the port) and never prints secrets.

## Other machines

The coding tools reach any `Host` alias in your `~/.ssh/config`. cua-bot stores no machine names of its own. The one requirement is that each host key is already in `~/.ssh/known_hosts`, so connect once with `ssh <machine>` first. Details in [How it works](architecture.md#coding-tools-on-every-machine).

## `start.py` and `stop.py`

`python start.py` starts the service in the background without opening a terminal window. In order, it:

1. Refuses to start if `data/cua-bot.pid.json` points at a live process that answers on the recorded port. A live pid with nothing on the port is taken as reused after a reboot, and the start goes on.
2. Runs `pnpm update "@earendil-works/*"`. This moves the Pi packages to their newest release within `package.json`'s ranges, once that release is a day old (pnpm's minimum release age), and records it in the lockfile. Every other dependency stays pinned. It prints any version that changed; the full pnpm output goes to `data/logs/stdout.log`. If the update fails, for example offline, it says so and starts with the installed versions.
3. Waits for the port to accept connections, then prints the `/say` URL and the web app URL.

Every Pi package shares the same `^` range in `package.json` because each `pi-env` release requires the exact `pi-durable` of the same version. The update moves them together.

It passes `CUABOT_PYTHON` (its own interpreter, or `pythonw.exe` beside it on Windows) to the service, which Settings > Startup uses for the sign-in entry. Run without a console, as at sign-in, `start.py` writes what it would print to `data/logs/stdout.log`.

`python stop.py` signals only the pid in `data/cua-bot.pid.json`. It stops that process and its children, checks that the process exited and the port is free, then removes the pid file.
