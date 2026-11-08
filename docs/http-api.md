# HTTP API

[Back to README](../README.md)

One server on `127.0.0.1:43142` (`CUABOT_PORT` changes the port), loopback only, no login. Routes live in [src/web.ts](../src/web.ts).

Every route answers 403 when the `Host` header isn't `127.0.0.1`, `localhost` or `[::1]`, or when an `Origin` header names any other origin. This stops other sites open in your browser from calling the API. Local clients such as `say.py` and `curl` send no `Origin` and pass.

## Plain text

| Route | Does |
| --- | --- |
| `POST /say` | Plain text in, plain text out, on the main bot. Waits for the reply. |

## Chat

Code: [src/chat.ts](../src/chat.ts).

Every `/api/chat*` route takes `?bot=<id>`, or a `bot` field in the POST body. Without one, it's the main bot's chat.

| Route | Does |
| --- | --- |
| `GET /api/chat` | Pages the transcript. |
| `POST /api/chat` | `{"text", "images"?}` queues a message without waiting. Text or an image is required. |
| `GET /api/chat/image?entry=<id>&index=<n>` | Serves back one of the owner's images. |
| `POST /api/chat/react` | `{"entryId", "emoji", "on"}` turns the owner's reaction to a reply on or off. Either change starts a turn, or queues behind the current one. |
| `POST /api/chat/stop` | Stops the current turn. |
| `GET /api/chat/events` | Server-sent events: the live reply, running tools, new messages, the bot list whenever it changes, and a `control` event when control of the Space's screen changes. |
| `GET /api/chat/computer` | The computer pane: Space name, newest screenshot, steps of the latest computer-use run ([src/computer-view.ts](../src/computer-view.ts)). |

`images` are the owner's pasted images as `[{"data": <base64>, "mimeType"}]`. pi-durable's Photon processor fits them to the model's limits.

## Bots

Code: [src/bots.ts](../src/bots.ts).

| Route | Does |
| --- | --- |
| `GET /api/bots` | Lists every bot. |
| `POST /api/bots` | `{name, instructions, avatar, model, thinkingLevel}` adds one. `instructions` becomes its agent file; without `avatar`, `model` or `thinkingLevel` it gets the default. `model` is `provider/model` and needs a key or sign-in. |
| `PUT /api/bots/<id>` | Edits one. An edit without `avatar`, `model` or `thinkingLevel` keeps it; `null` goes back to the default. |
| `DELETE /api/bots/<id>` | Stops a bot and removes it. Its transcript stays in the database. |

Each listed bot carries:

| Field | Meaning |
| --- | --- |
| `preview` | Its newest message to or from the owner |
| `botPreview` | Its newest message from another bot |
| `folder`, `file` | Paths of its folder and agent file |
| `avatar` | The avatar to draw |
| `defaultAvatar` | The avatar it gets without a pick |
| `model`, `thinkingLevel` | Its own model and effort, present only while it overrides the default |
| `activeModel` | The id of the model it runs on, for the chat header |

It also says whether the bot is working.

## Computer

| Route | Does |
| --- | --- |
| `GET /shots/<name>.png` | Serves a computer-use screenshot. |
| `GET /api/computer/live` | Streams the Space's screen as H.264 ([src/live-screen.ts](../src/live-screen.ts)). |
| `POST /api/computer/control` | `{"owner": true}` gives the owner control of the Space's screen; `{"owner": false}` hands it back ([src/screen-control.ts](../src/screen-control.ts)). |
| `POST /api/computer/input` | `{"events"}` performs the owner's mouse and keyboard on the Space over the live stream's media session, in cua-spacesd's `interactive_input` format. Only while the owner has control. |

## Approvals

Code: [src/approvals.ts](../src/approvals.ts).

| Route | Does |
| --- | --- |
| `GET /api/approvals` | Lists the cards. |
| `POST /api/approvals/<id>/approve` | Runs the call. Optional JSON `{to, subject, body}` edits an email first. |
| `POST /api/approvals/<id>/discard` | Drops it. |

## Memory, connections, push, startup, model

| Route | Does |
| --- | --- |
| `GET /api/memory` | The shared memory and, under `bots`, each bot's own ([src/memory.ts](../src/memory.ts)). |
| `POST /api/memory/edit` | `{"fact", "to", "tier", "bot"}` rewords the fact whose text matches `fact` in that tier, keeping its date; without `bot`, in the shared memory. 400 for an empty or oversized `to`, or one another fact in the tier already has. 404 when nothing matches. |
| `GET /api/connections` | Checks this computer, the owner's SSH hosts and the Cua Spaces for the Connections tab ([src/connections.ts](../src/connections.ts)). |
| `GET /api/push` | The Web Push public key ([src/push.ts](../src/push.ts)). |
| `POST /api/push` | Saves a browser's `PushSubscription`. |
| `GET /sw.js` | The service worker that shows the pushes ([src/sw.js](../src/sw.js)). |
| `GET /api/autostart` | `{supported, enabled, where}`: whether `start.py` runs when the owner signs in, and where that is saved ([src/autostart.ts](../src/autostart.ts)). |
| `PUT /api/autostart` | `{"enabled": true}` or `false` adds or removes the sign-in entry and returns the new state. |
| `GET /api/model` | `{model, thinkingLevel, choices}`: the bots' model as `provider/model`, their reasoning effort, and every model with a key or sign-in with the efforts it supports ([src/model-settings.ts](../src/model-settings.ts)). |
| `PUT /api/model` | `{"model", "thinkingLevel"}` saves both to `.env`, applies them to every bot and returns the new state. An effort the model doesn't support becomes its nearest one. 400 for a model with no key or sign-in. |
