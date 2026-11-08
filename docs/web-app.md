# Web app

[Back to README](../README.md)

Open `http://127.0.0.1:43142/`. The page is served on loopback only and has no login, the same trust as `/say`.

The layout is three columns: bots on the left, the chat in the middle, the Space's screen on the right. A rail on the far left switches to Routines (clock icon), Memory (page icon) and Settings (gear).

## Links and history

The URL hash keeps your place, so a reload, Back, or a copied link lands in the same spot.

| Key | Values | When absent |
| --- | --- | --- |
| `view` | `routines`, `memory`, `settings` | The chat |
| `tab` | `model`, `connections`, `startup`, `tags` | Settings' Chat tab |
| `tag` | A memory tag, in Memory | Every bot |
| `bot` | A bot id | The main bot |

For example `#view=settings&tab=connections` or `#view=memory&tag=job-bots`. Each new view or tab is a history entry; switching bots replaces the entry. Old links of the form `#bot=<id>` still open that bot's chat.

## Bots

Each bot has a row with its newest message, and a pulsing dot while it works. Click a row to open that bot's chat. The + button adds a bot.

The pencil next to the chat title opens the bot's settings: its agent file (with its path) to read or edit, its name, its avatar, its model and reasoning effort, and Delete. Use default follows Settings > Model. The efforts listed are the ones the picked model supports, and a change reaches the bot on its next turn. Everything the bot does on screen through `computer_use` runs on the same model and effort.

**Avatars.** Each bot shows as a small character that blinks every few seconds and, at the larger sizes, now and then glances aside. Each bot keeps its own rhythm, and the motion stops when the system asks for reduced motion. Click the big avatar in the dialog to pick a shape (hover one for its name) and a color; Reset goes back to the bot's default. The pick applies when you save. A new bot gets a shape and a color no other bot wears yet, while any are left.

**Messages between bots** are hidden unless you turn on Show messages between bots in Settings. With it on, a message shows in the sender's reply as "Message to <name>" and in the recipient's chat as "Message from <name>", and a bot's row can show the newest one. With it off and Show tool steps on, a `message_bot` call shows as a "Messaged <name>" chip.

## Chat

A bot talks to you only through its `send_message` tool ([src/bots.ts](../src/bots.ts)). Its text between tool calls is private working notes and never shows. Replies from before 2026-11-03 04:05 UTC, when that tool arrived, still show their text.

- Messages stream in as the bot writes them, in a grey bubble.
- Each message shows its time under it. Hover for the full date.
- While a reply runs, the chat title says Working or Using the computer.
- Enter sends, Shift+Enter adds a line, the stop button ends the current reply.
- A message sent while the bot is busy waits its turn.

**Tool steps.** With Show tool steps on, each tool the bot used shows as a chip above its reply. Chips from consecutive steps that sent nothing run on in one wrapping row, up to the next message. Click a finished chip for the tool's result; screenshots appear as thumbnails. A turn where nothing needs you shows only its chips. With the setting off (the default), that turn shows nothing.

**Routine runs.** With Show routine runs on, each firing shows as a line in the conversation.

**Approval cards.** When the bot wants to email anyone but you, or delete something, a card appears under its reply. Edit the email if you like, then send or discard it. Nothing goes out until you click. See [How it works](architecture.md#approval-cards).

## Pasted images

Paste an image (a screenshot, or Copy image in a browser) into the message box and it waits there as a thumbnail; its ✕ removes it. Send with or without text, and the bot gets the images after your text.

A paste that also carries plain text, such as spreadsheet cells, pastes the text instead. Your bubble shows the images; click one to open it full size. The box keeps them when you switch bots, but a reload drops them.

## Quotes, quick replies and reactions

Hover a message for its toolbar. Reply quotes the whole message. To quote part of one, select the text and click Add to chat, or press Ctrl+L.

A quote lands in the message box as a chip at your caret, so you can alternate: quote, reply, quote, reply. Backspace or the chip's ✕ removes it, and the box keeps its chips when you switch bots. The bot gets the message in the same order, each quote as markdown `> ` lines with your text between them, separated by blank lines. Your bubble shows the quotes as grey blocks in place.

The bar over selected text has three rows: quick replies (Yes, No, Explain), the quick emoji, then Add to chat. It opens below the selection when there's no room above. A quick reply or emoji works like Add to chat and also types that reply after the quote, so you can edit it before sending.

On a bot reply, the smiley opens the quick emoji (👍 👎 ❤️ 😂 🎉 😮 unless you change them in Settings). Your reactions show as pills under the reply; click one to take it back. A reaction is a `cua-bot.reaction` entry in the bot's transcript (taking it back is another), so it survives a reload and shows in every open tab.

A reaction wakes the bot. It starts a turn with `[The owner reacted 👍 to your message: "…"]`, so standing instructions like "a 👍 means I submitted it" run right away. Taking one back wakes it too, so it can correct anything it did because of the reaction. When there's nothing to do, the bot ends the turn without calling `send_message` and you hear nothing.

If the bot is working, the change waits for that turn to end, and until then only the tab you clicked in shows it. Undoing a change that is still waiting withdraws it, and the bot sees neither. Stop drops waiting changes the same way it drops queued messages, so the pills go back to how they were.

## Computer pane

The right column shows the default Space's screen live, plus each click and keystroke of the most recent computer-use task. When that task ran on another Space, the steps heading names it. The frame turns amber while the bot is driving.

All open panes share one media session: about 15 fps at the display's native resolution, roughly 100 KB/s on a quiet screen and more when it changes a lot, decoded with WebCodecs. A pane streams only while its tab is visible, unless you have control. The session closes when the last pane closes. If the stream is down, or the browser lacks WebCodecs, the pane stays black. The caption says Connecting… while it retries, or that the browser can't play the live screen.

### Expanded screen and Take control

Click the live screen (it shows an Expand badge) to fill the window with it. A bar under it shows what the bot is doing, with a Take control button. The Take control button in the pane's header opens the view already in control.

While you have control, your mouse, wheel and keyboard drive the Space's computer, and the bot's on-screen steps wait until you click I'm done. A running computer task then carries on from where you left the screen. Closing the view with ✕ also hands the screen back, as does closing every cua-bot tab. Escape goes to the Space while you drive, so close with ✕.

## Routines

Lists every bot's routines with the bot, the schedule in words (hover for the cron spec), next run and last run. Add, edit, run now and delete from here, with a live preview of the next runs while you type a cron schedule. Turn on Run only once and the routine fires at its next matching time, then disappears from the list.

A new routine goes to the bot whose chat you had open unless you pick another; an edited routine stays with its bot. Everything saved here lands in that bot's `routines.json`. File rules are in [How it works](architecture.md#routines).

## Memory

The sidebar lists tags with their fact counts: Every bot, the ones you made in [Memory tags](#memory-tags), one per bot, and Untagged while any fact reaches no bot.

The open tag shows its lasting facts, then its dated ones, newest first. Each section ends in an add line that saves under that tag. Under each fact are its other tags and a **+ Tag** button, whose checklist saves each tick at once. The pencil rewords a fact in place and keeps its date and tags: Enter or clicking away saves, Escape cancels. Forget a fact with its ✕. The search box finds facts under every tag at once and shows all their tags.

## Settings

Settings has five tabs in its own sidebar.

### Chat

Saved in this browser's `localStorage` (`cua-bot.settings`), so each browser keeps its own.

| Setting | Default | Effect |
| --- | --- | --- |
| Show messages between bots | off | See [Bots](#bots) |
| Show tool steps | off | See [Chat](#chat) |
| Show routine runs | off | See [Chat](#chat) |
| Quick replies | Yes, No, Explain | One phrase per line |
| Quick emoji | 👍 👎 ❤️ 😂 🎉 😮 | Typed or pasted in any spacing; anything that isn't an emoji is dropped when you leave the field. Clearing it hides the smiley. |

### Model

Picks the default model and reasoning effort for the bots ([src/model-settings.ts](../src/model-settings.ts)). A bot can override either in its edit dialog. The list holds each model with a key in `models.json` or a sign-in from `node src/login.ts`, and the efforts follow the picked model. A change saves `CUABOT_MODEL` and `CUABOT_REASONING` to the computer's `.env` and reaches every bot on its default on its next turn, with no restart.

### Memory tags

Your own tags for sharing facts with a group of bots. **New tag** adds one. Click a bot to add it or take it out, and edit the name in place. Deleting a tag warns you when facts would be left with no tag; those move to Untagged in Memory. Every bot and each bot's own tag are always there and aren't listed.

### Connections

Lists the computers the bot can reach ([src/connections.ts](../src/connections.ts)). Each visit and Check again runs a fresh check (`GET /api/connections`), which takes up to about 3 seconds.

**This computer** comes first. The Harness, every bot and their routines live there. Its row shows the OS, user, process id, start time and database, plus any SSH alias that points at it.

**SSH hosts** come next, one per host in your `~/.ssh/config`, resolved with `ssh -G`. Aliases that reach the same user, address and port share a row. A host shows Online when its SSH port accepts a TCP connection within 3 seconds. That says the machine is up, not that the login works. Online hosts sort first.

**Cua Spaces** sit under the computer that provides them, with OS, phase, spacesd version and id:

- a `direct:<address>:<port>` Space under the host with that address,
- a `local:` Space under this computer,
- a relay Space under the host its `host_name` names,
- anything else, like cloud Spaces, under Other Spaces.

The Default label marks the bots' default Space: `computer_use` and `space_bash` use it when the bot names no Space, and the live screen shows it. The bots can use every Space listed here. The list is Cua's live one (`list_spaces`, through the same `cua mcp` session as the bots' `cua_*` tools). If Cua doesn't answer, the tab shows `~/.cua/spaces.json` without status and says why.

The tab blurs users, SSH addresses, `direct:` Space ids and the database path, so a screenshot doesn't leak them. Click one (or focus it and press Enter) to reveal it until the next check.

### Startup

**Start when I sign in** (off by default) runs `start.py` each time you sign in to the bot's computer, so a restart doesn't leave the bots off until someone starts them. Unlike the Chat tab, it's saved on that computer, not in the browser ([src/autostart.ts](../src/autostart.ts)). None of these entries needs admin rights:

| OS | Entry |
| --- | --- |
| Windows | Value `cua-bot` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, running `start.py` with `pythonw`, so no console window opens |
| macOS | `~/Library/LaunchAgents/cua-bot.plist` |
| Linux | `~/.config/autostart/cua-bot.desktop`, for desktop sessions that follow the XDG autostart spec |

The interpreter is the one `start.py` last ran under (Windows uses `pythonw.exe` from the same folder). On macOS and Linux the entry also carries the bot's `PATH`, so `node` and `pnpm` are found at sign-in. If you move the checkout or change Python, turn the setting off and on again. On other OSes the toggle is disabled.

## Notifications

Click Turn on notifications in the chat header once and allow them. From then on a browser notification pops up for every `send_message` (titled with the bot's name, first 500 characters of the message) and every approval card. It pops up even with every cua-bot tab closed, as long as the browser runs, and even while you look at that chat. Clicking one brings the app to the front.

This is Web Push through the browser's push service (FCM for Chrome), so the bot needs internet access. Cua's own `notify_user` tool is turned off for the bots for now (`DISABLED` in [src/cua-mcp.ts](../src/cua-mcp.ts)).
