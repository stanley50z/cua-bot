// Every turn that reaches a bot goes through deliver() here: owner messages (the portal and /say), the owner's
// reactions, messages from other bots (message_bot), routine firings, and approval outcomes. For each kind of turn
// this module decides whether memory is searched first (owner and bot messages only), whether the note lands right
// before the message, what the turn does while the bot is busy, its request id, and the entry kind the chat reads it
// back by (src/chat.ts). The texts the model reads are the callers', except a bot message's and a reaction's, which
// are built here from the data their entries keep.
// main.ts calls createTurns(memoryNote) once and hands the result to createBotsExtension, bindRoutines, and
// createBots (which gives it to each bot's Chat), and routes approval outcomes through approval().
import type { Context } from "@earendil-works/chord";
import type { ConversationHandle, Harness, InputSubmissionDraft, Submission, UserInput } from "@earendil-works/pi-durable";
import type { BotLookup } from "./bots.ts";
import { APPROVAL_OUTCOME, BOT_MESSAGE, type BotMessage, MEMORY_NOTE, REACTION, type Reaction, reactionText, ROUTINE_FIRING, textOf, type WhenBusy } from "./chat.ts";

/** What the memory search reads the bot list through: the Harness, or a tool's or task's own reader. */
export type Reader = Pick<Harness, "snapshot">;

/**
 * What memory holds for `message` to bot `bot`, as a note for the bot to read just before it; undefined when it
 * brings up nothing. main.ts searches with messageNote (src/memory.ts) over the bot list `read` gives.
 */
export type MemoryNote = (bot: number, message: string, read: Reader, context: Context) => Promise<string | undefined>;

export type Turn =
	/** A message from the owner. Without `whenBusy` it takes the Harness's default, as /say does. */
	| { kind: "owner"; content: UserInput; whenBusy?: WhenBusy }
	/** The owner's reaction to the reply whose text is `reply`, or its take-back. */
	| { kind: "reaction"; reaction: Reaction; reply: string }
	/** A message from another bot, sent by message_bot's tool task `task`. */
	| { kind: "bot"; from: { id: number; name: string }; text: string; task: number }
	/** A firing of the routine whose sleeper is `task`: at its slot `at`, or, `manual`, run now at `at`. */
	| { kind: "routine"; text: string; task: number; at: number; manual: boolean }
	/** The owner's decision on an approval card. */
	| { kind: "approval"; text: string };

/** The turn a message from another bot starts. The chat shows the BotMessage data instead. */
function inboundText(from: { id: number; name: string }, text: string): string {
	return `[bot] Message from ${from.name} (id ${from.id}), another of the owner's bots:\n${text}`;
}

// The submission a turn becomes, and the text memory is searched for first, for the kinds that search.
function draftOf(turn: Turn): { search?: string; draft: InputSubmissionDraft } {
	switch (turn.kind) {
		case "owner":
			return { search: textOf(turn.content), draft: { type: "input", content: turn.content, ...(turn.whenBusy === undefined ? {} : { whenBusy: turn.whenBusy }) } };
		case "reaction": {
			const { emoji, on } = turn.reaction;
			return { draft: { type: "input", content: reactionText(emoji, on, turn.reply), whenBusy: "followUp", entry: { kind: REACTION, data: turn.reaction } } };
		}
		case "bot": {
			const data: BotMessage = { from: turn.from.id, name: turn.from.name, text: turn.text };
			return {
				search: turn.text,
				draft: { type: "input", content: inboundText(turn.from, turn.text), whenBusy: "followUp", requestId: `bot:${turn.task}`, entry: { kind: BOT_MESSAGE, data } },
			};
		}
		case "routine":
			return {
				draft: {
					type: "input",
					content: turn.text,
					whenBusy: "followUp",
					requestId: turn.manual ? `${turn.task}:manual:${turn.at}` : `${turn.task}:${turn.at}`,
					entry: { kind: ROUTINE_FIRING },
				},
			};
		case "approval":
			return { draft: { type: "input", content: turn.text, whenBusy: "followUp", entry: { kind: APPROVAL_OUTCOME } } };
	}
}

export type Turns = ReturnType<typeof createTurns>;

/** The one way a turn reaches a bot. `memoryNote` searches memory for owner and bot messages. */
export function createTurns(memoryNote: MemoryNote) {
	/**
	 * Submit `turn` to the bot whose conversation `to` is, after the memory note its kind calls for. `read` reads the
	 * bot list for that search. Returns the submission; wait on it for the answer.
	 */
	async function deliver(to: ConversationHandle, turn: Turn, read: Reader, context: Context): Promise<Submission> {
		const { search, draft } = draftOf(turn);
		if (search !== undefined) {
			const note = await memoryNote(Number(to.id), search, read, context);
			// A write without a run, so it lands in the transcript right before the message.
			if (note !== undefined) await to.submit({ type: "write", entry: { kind: MEMORY_NOTE, model: [{ role: "user", content: note, timestamp: Date.now() }] } }, context);
		}
		return to.submit(draft, context);
	}

	return {
		deliver,
		/**
		 * Tell a bot the owner's decision on an approval card: the bot that filed it (`filedBy`), or the main bot when the
		 * card names none (cards from before multi-bot support) or that bot was deleted.
		 */
		async approval(bots: Pick<BotLookup, "list" | "conversation">, filedBy: number | undefined, text: string, read: Reader, context: Context): Promise<Submission> {
			const known = filedBy !== undefined && (await bots.list(context)).some((bot) => bot.id === filedBy);
			const to = await bots.conversation(known ? filedBy : undefined, context);
			if (to === undefined) throw new Error(`Bot ${filedBy} is listed but has no conversation.`);
			return deliver(to, { kind: "approval", text }, read, context);
		},
	};
}
