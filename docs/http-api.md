# HTTP API

[Back to README](../README.md)

One server on `127.0.0.1:43142` (`CUABOT_PORT` changes the port), loopback only, no login. Routes live in [src/web.ts](../src/web.ts).

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
| `POST /api/chat/react` | `{"entryId", "emoji", "on"}` turns the owner's reaction to a reply on or off. |
| `POST /api/chat/stop` | Stops the current turn. |
| `GET /api/chat/events` | Server-sent events: the live reply, running tools, new messages, the bot list whenever it changes, and a `control` event when control of the Mac changes. |
| `GET /api/chat/computer` | The computer pane: Space name, newest screenshot, steps of the latest computer-use run ([src/computer-view.ts](../src/computer-view.ts)). |

`images` are the owner's pasted images as `[{"data": <base64>, "mimeType"}]`. pi-durable's Photon processor fits them to the model's limits.

## Bots

Code: [src/bots.ts](../src/bots.ts).

| Route | Does |
| --- | --- |
| `GET /api/bots` | Lists every bot. |
| `POST /api/bots` | `{name, instructions, avatar}` adds one. `instructions` becomes its agent file; without `avatar` it gets the default. |
| `PUT /api/bots/<id>` | Edits one. An edit without `avatar` keeps it; `avatar: null` goes back to the default. |
| `DELETE /api/bots/<id>` | Stops a bot and removes it. Its transcript stays in the database. |

Each listed bot carries:

| Field | Meaning |
| --- | --- |
| `preview` | Its newest message to or from the owner |
| `botPreview` | Its newest message from another bot |
| `folder`, `file` | Paths of its folder and agent file |
| `avatar` | The avatar to draw |
| `defaultAvatar` | The avatar it gets without a pick |

It also says whether the bot is working.

## Computer

| Route | Does |
| --- | --- |
| `GET /shots/<name>.png` | Serves a computer-use screenshot. |
| `GET /api/computer/live` | Streams the Mac's screen as H.264 ([src/live-screen.ts](../src/live-screen.ts)). |
| `POST /api/computer/control` | `{"owner": true}` gives the owner control of the Mac; `{"owner": false}` hands it back ([src/screen-control.ts](../src/screen-control.ts)). |
| `POST /api/computer/input` | `{"events"}` performs the owner's mouse and keyboard on the Mac over the live stream's media session, in cua-spacesd's `interactive_input` format. Only while the owner has control. |

## Approvals

Code: [src/approvals.ts](../src/approvals.ts).

| Route | Does |
| --- | --- |
| `GET /api/approvals` | Lists the cards. |
| `POST /api/approvals/<id>/approve` | Runs the call. Optional JSON `{to, subject, body}` edits an email first. |
| `POST /api/approvals/<id>/discard` | Drops it. |

## Memory, connections, push

| Route | Does |
| --- | --- |
| `GET /api/memory` | The shared memory and, under `bots`, each bot's own ([src/memory.ts](../src/memory.ts)). |
| `GET /api/connections` | Checks this computer, the owner's SSH hosts and the Cua Spaces for the Connections tab ([src/connections.ts](../src/connections.ts)). |
| `GET /api/push` | The Web Push public key ([src/push.ts](../src/push.ts)). |
| `POST /api/push` | Saves a browser's `PushSubscription`. |
| `GET /sw.js` | The service worker that shows the pushes ([src/sw.js](../src/sw.js)). |
