# Demo runbook (Windows PC, about 4 minutes)

## Before you present

1. Wake the Mac mini and put something recognizable on its screen, like a browser tab with the hackathon page.
2. In the project folder, run `python stop.py`, then `python demo.py --fresh`. This archives the old conversation, runs the pre-flight check, starts the bot, and opens the layout:
   - Windows Terminal: the live log on the left, your command pane on the right.
   - Cua Spaces app: open the Mac mini so the audience sees its screen.
   - Gmail inbox for the owner address.
3. Arrange the windows so the log, the Mac view, and the inbox are all visible.

If a pre-flight line says FAIL, follow its hint. The usual fixes: `node src/login.ts` for xAI, open the Cua Spaces app for the Space.

## The script

Paste each command in the right-hand pane.

**1. It sees the Mac (about 30 s).**

```
python say.py "What's on my Mac's screen right now? Two sentences."
```

Say: "Grok 4.7 is the main agent. It never clicks itself. It hands screen work to a computer-use subagent, also Grok, that drives the Mac through Cua Spaces." In the log, point at the `bot → computer_use` line and the `child → get_desktop_state` lines under it.

**2. It works on its own (about 1 min).**

```
python say.py "Every minute, take a screenshot of my Mac and email it to me with a one-line description. Call it Mac check."
```

Say: "This is a durable routine, a sleeping task stored in SQLite. Nothing keeps it in memory." Wait for the first email and open it to show the attached screenshot.

**3. Kill it (the Pi Durable moment, about 1.5 min).**

```
python stop.py
```

Say: "That's a hard kill. The process is gone." Run `python say.py "hi"` to show the connection is refused. Let the next minute pass with the bot down, then:

```
python start.py
```

The log shows `grokbot up`, then the routine fires within seconds and the next email arrives. Say: "It picked up the stored deadline and the work it missed. No cron, no queue, just Pi Durable."

**4. Clean up.**

```
python say.py "Cancel Mac check."
```

Close on: "About 1,000 lines of TypeScript glue on top of Pi Durable and Cua. Self-hosted, signed in with a Grok subscription, Grok all the way down."

## If something goes wrong

- **No email yet:** emails take 10–40 s. The log line `bot ← send_email sent to …` proves it was sent, and `data/shots/` has the screenshot.
- **Mac view is blank:** the bot still works; the screenshots in `data/shots/` show what it saw.
- **Bot not answering:** check `data/logs/stdout.log` and `data/crash/`, then `python stop.py` and `python start.py`.
- **Routine still emailing after the demo:** `python say.py "Cancel all routines."`, or `python stop.py`.
