// Owner chat over one bot's conversation, for the web app in src/web.ts.
// src/bots.ts calls createChat({ harness, conversation, context, computer }) once per bot. The server uses history() for
// pages of past messages, send()/stop() for input (send() also takes pasted images, which image() reads back), react() for the owner's emoji reactions (REACTION entries),
// computer() for the computer pane, and subscribe()
// for live updates: the streaming partial reply, running tool calls, every new transcript entry, and
// computer pane snapshots while computer_use runs. Entries are normalized to ChatItem so the browser
// never sees provider message shapes.
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	CompactionEntry,
	type Conversation,
	type ConversationId,
	type Cursor,
	type EntryId,
	type EntryRecord,
	type Harness,
	InboxDoc,
	LiveDoc,
	type LiveState,
	ResetEntry,
	ToolResultEntry,
	UserEntry,
	type UserInput,
} from "@earendil-works/pi-durable";
import type { ComputerSnapshot, ComputerView } from "./computer-view.ts";

const TOOL_TEXT_LIMIT = 4000;
const COMPUTER_POLL_MS = 1500;
const SHOT_PATTERN = /shots[\\/]([\w.-]+\.png)/g;

/**
 * The bots' tool for talking to the owner (src/bots.ts). Its `text` is all the chat shows of a reply; the model's own
 * text is private notes. Replies from before the tool existed (SENT_SINCE) show their own text as they always did.
 */
export const SEND_MESSAGE = "send_message";
const SENT_SINCE = Date.parse("2026-11-03T04:05:00Z");

/** What a reply sent the owner through send_message, joined; empty when it sent nothing. */
function sentText(content: readonly { type: string; name?: string; arguments?: Record<string, unknown> }[]): string {
	return content
		.flatMap((part) => (part.type === "toolCall" && part.name === SEND_MESSAGE && typeof part.arguments?.text === "string" ? [part.arguments.text] : []))
		.join("\n\n");
}

/** Entry kind of a send_message called from inside another tool, such as a codemode script, which leaves no call of its own in the transcript. Its data is a SentMessage. */
export const SENT_MESSAGE = "cua-bot.sent-message";
export type SentMessage = { text: string; at: number };

/** Entry kind of a message from another bot (src/bots.ts); its data is a BotMessage. */
export const BOT_MESSAGE = "cua-bot.bot-message";
export type BotMessage = { from: number; name: string; text: string };

/**
 * Entry kind of the owner's emoji reaction to a reply; its data is a Reaction. Taking one back is another entry with
 * `on: false`, so the newest entry for a reply and emoji wins. Each carries a user message telling the bot and starts a turn with it.
 */
export const REACTION = "cua-bot.reaction";
export type Reaction = { target: number; emoji: string; on: boolean };
const QUOTE_MAX = 80;

/** Entry kind of what a memory search found for a message from the owner or another bot (src/memory.ts). The bot reads it just before that message; the chat doesn't show it. */
export const MEMORY_NOTE = "cua-bot.memory-note";

/** Put a message's memory search result in the conversation without starting a turn. Call right before submitting the message. */
export async function writeMemoryNote(conversation: Pick<Conversation, "submit">, note: string | undefined, context: Context) {
	if (note === undefined) return;
	await conversation.submit({ type: "write", entry: { kind: MEMORY_NOTE, model: [{ role: "user", content: note, timestamp: Date.now() }] } }, context);
}

export type ChatTool = { id: string; name: string; args: Record<string, unknown> };
/** An image in an owner message: base64 data in a format the model takes. */
export type ChatImage = { data: string; mimeType: string };
/** What an owner message does while the bot is busy: join the current turn after the running tool round, or wait for the turn to end. */
export type WhenBusy = "steer" | "followUp";

export type ChatItem =
	| { id: number; kind: "user"; text: string; at: number; images: number }
	| { id: number; kind: "routine"; text: string; at: number }
	/** The owner's decision on an approval card, as told to the bot. The card itself shows it. */
	| { id: number; kind: "approval"; text: string; at: number }
	/** A message another bot sent this one, shown as "Message from <name>". */
	| { id: number; kind: "bot"; from: number; name: string; text: string; at: number }
	/** The owner's reaction to the reply `target`. The app folds these onto their reply instead of showing them. */
	| { id: number; kind: "reaction"; target: number; emoji: string; on: boolean; at: number }
	| { id: number; kind: "assistant"; text: string; at: number; tools: ChatTool[]; error?: string; aborted: boolean }
	| { id: number; kind: "tool"; callId: string; name: string; text: string; isError: boolean; shots: string[]; images: number }
	| { id: number; kind: "marker"; text: string };

export type ChatLive = {
	busy: boolean;
	/** What the in-flight reply has sent the owner so far, as send_message's text streams in. */
	partial: string;
	/** `child` is the conversation a running computer_use call drives the Space from. */
	tools: { callId: string; name: string; status: "pending" | "running" | "done"; output?: string; child?: number }[];
	retry?: { at: number; error: string };
};

export type ChatEvent =
	| { type: "live"; live: ChatLive }
	| { type: "items"; items: ChatItem[] }
	| { type: "computer"; computer: ComputerSnapshot };

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
}

function imageCount(content: string | readonly { type: string }[]): number {
	return typeof content === "string" ? 0 : content.filter((part) => part.type === "image").length;
}

/** Convert one transcript entry to what the chat shows; bookkeeping entries return undefined. */
export function toChatItem(entry: EntryRecord): ChatItem | undefined {
	const id = entry.id as number;
	const message = entry.model?.[0];
	if (entry.kind === SENT_MESSAGE) {
		const data = entry.data as SentMessage;
		return { id, kind: "assistant", text: data.text, at: data.at, tools: [], aborted: false };
	}
	if (entry.kind === BOT_MESSAGE && message?.role === "user") {
		const data = (entry.data ?? {}) as Partial<BotMessage>;
		return { id, kind: "bot", from: Number(data.from), name: String(data.name ?? "A bot"), text: String(data.text ?? ""), at: message.timestamp };
	}
	if (entry.kind === REACTION) {
		const data = (entry.data ?? {}) as Partial<Reaction>;
		return { id, kind: "reaction", target: Number(data.target), emoji: String(data.emoji ?? ""), on: data.on !== false, at: message?.timestamp ?? 0 };
	}
	if (UserEntry.is(entry) && message?.role === "user") {
		const user = message as UserMessage;
		const text = textOf(user.content);
		if (text.startsWith("[routine]")) return { id, kind: "routine", text, at: user.timestamp };
		if (text.startsWith("[approval]")) return { id, kind: "approval", text, at: user.timestamp };
		return { id, kind: "user", text, at: user.timestamp, images: imageCount(user.content) };
	}
	if (AssistantEntry.is(entry) && message?.role === "assistant") {
		const reply = message as AssistantMessage;
		const tools = reply.content.flatMap((part) =>
			part.type === "toolCall" && part.name !== SEND_MESSAGE ? [{ id: part.id, name: part.name, args: part.arguments as Record<string, unknown> }] : [],
		);
		const text = reply.timestamp < SENT_SINCE ? textOf(reply.content) : sentText(reply.content);
		const aborted = reply.stopReason === "aborted";
		// A reply that only wrote private notes shows nothing.
		if (text === "" && tools.length === 0 && !aborted && reply.stopReason !== "error") return undefined;
		return {
			id,
			kind: "assistant",
			text,
			at: reply.timestamp,
			tools,
			aborted,
			...(reply.stopReason === "error" ? { error: reply.errorMessage ?? "The model returned an error." } : {}),
		};
	}
	if (ToolResultEntry.is(entry) && message?.role === "toolResult") {
		const result = message as ToolResultMessage;
		if (result.toolName === SEND_MESSAGE) return undefined;
		const full = textOf(result.content);
		return {
			id,
			kind: "tool",
			callId: result.toolCallId,
			name: result.toolName,
			text: full.length > TOOL_TEXT_LIMIT ? `${full.slice(0, TOOL_TEXT_LIMIT)}…` : full,
			isError: result.isError,
			shots: [...new Set([...full.matchAll(SHOT_PATTERN)].map((match) => match[1] as string))],
			images: imageCount(result.content),
		};
	}
	if (CompactionEntry.is(entry)) return { id, kind: "marker", text: "Earlier messages were summarized." };
	if (ResetEntry.is(entry)) return { id, kind: "marker", text: "Started a fresh context." };
	return undefined;
}

/** The turn a reaction or its take-back starts, quoting the start of the reply it was on. */
export function reactionText(emoji: string, on: boolean, reply: string): string {
	const flat = reply.replace(/\s+/g, " ").trim();
	const quote = flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1)}…` : flat;
	return on
		? `[The owner reacted ${emoji} to your message: "${quote}". You don't need to reply. Act on it if your instructions or the message call for that; otherwise end your turn without calling ${SEND_MESSAGE}.]`
		: `[The owner took back their ${emoji} reaction to your message: "${quote}". You don't need to reply. If you acted on that reaction and it needs correcting, correct it; otherwise end your turn without calling ${SEND_MESSAGE}.]`;
}

/** Reduce the conversation's live document to what the chat shows while the bot works. */
export function toChatLive(live: Readonly<LiveState> | null): ChatLive {
	const partial = live?.generation?.message;
	return {
		busy: live?.run !== undefined,
		partial: partial === undefined ? "" : sentText(partial.content as readonly { type: string }[]),
		tools: (live?.tools ?? []).filter((slot) => slot.name !== SEND_MESSAGE).map((slot) => {
			const details = slot.details;
			const child =
				details !== null && typeof details === "object" && !Array.isArray(details) && typeof details.conversationId === "number"
					? details.conversationId
					: undefined;
			return {
				callId: slot.callId,
				name: slot.name,
				status: slot.status,
				...(slot.output === undefined ? {} : { output: slot.output.slice(-TOOL_TEXT_LIMIT) }),
				...(child === undefined ? {} : { child }),
			};
		}),
		...(live?.generation?.retry === undefined ? {} : { retry: { ...live.generation.retry } }),
	};
}

export type Chat = ReturnType<typeof createChat>;

/** Bind the chat to one bot's conversation. Call close() on shutdown. */
export function createChat(deps: { harness: Harness; conversation: Conversation; context: Context; computer?: ComputerView; memoryNote?: (message: string) => Promise<string | undefined> }) {
	const { harness, conversation, context, computer } = deps;
	const listeners = new Set<(event: ChatEvent) => void>();
	// Listeners that show the computer pane; only they make the chat read computer snapshots.
	let computerListeners = 0;
	let lastSeen: EntryId | undefined;
	let live = toChatLive(null);
	let watching: Promise<void> | undefined;
	let stopWatch: (() => Promise<unknown>) | undefined;
	let pump = Promise.resolve();
	let poll: ReturnType<typeof setInterval> | undefined;
	let lastComputer = "";

	const emit = (event: ChatEvent) => {
		for (const listener of listeners) listener(event);
	};

	const runningComputer = () => live.tools.find((tool) => tool.name === "computer_use" && tool.status !== "done");

	// Push a computer snapshot when it changed. Errors are dropped: the pane keeps its last state.
	async function pushComputer(): Promise<void> {
		if (computer === undefined || computerListeners === 0) return;
		const snapshot = await computer.snapshot(runningComputer()?.child as ConversationId | undefined).catch(() => undefined);
		if (snapshot === undefined) return;
		const text = JSON.stringify(snapshot);
		if (text === lastComputer) return;
		lastComputer = text;
		emit({ type: "computer", computer: snapshot });
	}

	// computer_use's driver steps land in a child conversation, so poll while it runs and refresh once when it stops.
	function trackComputer(): void {
		const driving = runningComputer() !== undefined;
		if (driving && poll === undefined) poll = setInterval(() => void pushComputer(), COMPUTER_POLL_MS);
		if (!driving && poll !== undefined) {
			clearInterval(poll);
			poll = undefined;
		}
		void pushComputer();
	}

	// Entries newer than lastSeen, oldest first. The query's minEntryId is inclusive.
	async function newEntries(ctx: Context): Promise<ChatItem[]> {
		const items: ChatItem[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries(
				{ order: "ascending", ...(lastSeen === undefined ? {} : { minEntryId: lastSeen }) },
				200,
				cursor,
				ctx,
			);
			for (const entry of page.items) {
				if (lastSeen !== undefined && entry.id <= lastSeen) continue;
				lastSeen = entry.id;
				const item = toChatItem(entry);
				if (item !== undefined) items.push(item);
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return items;
	}

	// Withdraws the change a new reaction undoes, if it is still queued behind a turn: the two cancel out. Returns its submission, or undefined when none is left to withdraw.
	async function withdrawOpposite({ target, emoji, on }: Reaction) {
		const queued = (await harness.snapshot(InboxDoc, conversation.id, context))?.items.find((item) => {
			if (item.mode === "write" || item.entry?.kind !== REACTION) return false;
			const data = item.entry.data as Reaction;
			return data.target === target && data.emoji === emoji && data.on !== on;
		});
		if (queued === undefined || (await harness.abortSubmission(queued.id, context, conversation.id)) !== "aborted") return undefined;
		return queued.id as number;
	}

	async function startWatch(): Promise<void> {
		const newest = await conversation.entries({ order: "descending" }, 1, undefined, context);
		lastSeen = newest.items[0]?.id;
		const watch = await harness.watchDoc(LiveDoc, conversation.id, context);
		if (watch === undefined) return;
		live = toChatLive(watch.value);
		stopWatch = () => watch.stop();
		// A failed call is skipped: the next value follows once the doc recovers.
		watch.start(async (call, ctx) => {
			if (call.kind !== "value") return;
			live = toChatLive(call.value);
			// Serialize so overlapping callbacks never emit entries twice or out of order.
			pump = pump.then(async () => {
				const items = await newEntries(ctx);
				if (items.length > 0) emit({ type: "items", items });
				emit({ type: "live", live });
				trackComputer();
			});
			await pump;
		});
	}

	return {
		/** A page of past messages, oldest first. Pass the returned `before` to get the page before it. */
		async history(limit: number, before?: Cursor) {
			const page = await conversation.entries({ order: "descending" }, limit, before, context);
			const items = page.items.flatMap((entry) => toChatItem(entry) ?? []).reverse();
			return { items, before: page.next ?? null };
		},
		/**
		 * Submit an owner message, with any pasted images after its text. `whenBusy` says what it does if the bot is busy.
		 * Does not wait for the answer.
		 */
		async send(text: string, images: readonly ChatImage[] = [], whenBusy: WhenBusy = "steer") {
			const content: UserInput =
				images.length === 0
					? text
					: [...(text === "" ? [] : [{ type: "text" as const, text }]), ...images.map((image) => ({ type: "image" as const, ...image }))];
			await writeMemoryNote(conversation, await deps.memoryNote?.(text), context);
			const submission = await conversation.submit({ type: "input", content, whenBusy }, context);
			return { submissionId: submission.id as number };
		},
		/** Image `index` of the owner's message `entryId`, or undefined when there is no such image. */
		async image(entryId: number, index: number): Promise<ChatImage | undefined> {
			const id = entryId as EntryId;
			const message = (await conversation.entries({ order: "ascending", minEntryId: id, maxEntryId: id }, 1, undefined, context)).items[0]?.model?.[0];
			if (message?.role !== "user" || typeof message.content === "string") return undefined;
			const image = message.content.filter((part) => part.type === "image")[index];
			return image === undefined ? undefined : { data: image.data, mimeType: image.mimeType };
		},
		/**
		 * Record the owner's reaction to the reply entry `target`, or take it back with `on: false`. Either starts a turn,
		 * or queues behind the current one when the bot is busy. A change that undoes one still queued withdraws it instead,
		 * so the bot sees neither. Returns undefined when `target` is not a reply with text in this chat.
		 */
		async react(target: number, emoji: string, on: boolean) {
			const id = target as EntryId;
			const entry = (await conversation.entries({ order: "ascending", minEntryId: id, maxEntryId: id }, 1, undefined, context)).items[0];
			const reply = entry === undefined ? undefined : toChatItem(entry);
			if (reply?.kind !== "assistant" || reply.text.trim() === "") return undefined;
			const data: Reaction = { target, emoji, on };
			const withdrawn = await withdrawOpposite(data);
			if (withdrawn !== undefined) return { submissionId: withdrawn };
			const submission = await conversation.submit(
				{ type: "input", content: reactionText(emoji, on, reply.text), whenBusy: "followUp", entry: { kind: REACTION, data } },
				context,
			);
			return { submissionId: submission.id as number };
		},
		/** Stop the current turn and drop queued messages and reactions. Routines keep their schedules. */
		async stop() {
			await conversation.abort(context);
		},
		get live() {
			return live;
		},
		/** The computer pane's current state, or undefined when the bot has no computer view. */
		computer: () => computer?.snapshot(runningComputer()?.child as ConversationId | undefined),
		/** Receive live events until the returned function is called. `computer: false` skips computer pane snapshots. */
		subscribe(listener: (event: ChatEvent) => void, options: { computer?: boolean } = {}) {
			const wantsComputer = options.computer !== false;
			listeners.add(listener);
			if (wantsComputer) computerListeners++;
			watching ??= startWatch();
			return () => {
				if (listeners.delete(listener) && wantsComputer) computerListeners--;
			};
		},
		/** Resolves once live updates are flowing; used by tests. */
		ready: () => (watching ??= startWatch()),
		async close() {
			if (poll !== undefined) clearInterval(poll);
			listeners.clear();
			await stopWatch?.();
		},
	};
}
