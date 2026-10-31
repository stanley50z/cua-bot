// Owner chat over the root conversation, for the web app in src/web.ts.
// main.ts calls createChat({ harness, root, context, computer }) once. The server uses history() for
// pages of past messages, send()/stop() for input, computer() for the computer pane, and subscribe()
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
	LiveDoc,
	type LiveState,
	ResetEntry,
	ToolResultEntry,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { ComputerSnapshot, ComputerView } from "./computer-view.ts";

const TOOL_TEXT_LIMIT = 4000;
const COMPUTER_POLL_MS = 1500;
const SHOT_PATTERN = /shots[\\/]([\w.-]+\.png)/g;

export type ChatTool = { id: string; name: string; args: Record<string, unknown> };

export type ChatItem =
	| { id: number; kind: "user"; text: string; at: number; images: number }
	| { id: number; kind: "routine"; text: string; at: number }
	| { id: number; kind: "assistant"; text: string; at: number; tools: ChatTool[]; error?: string; aborted: boolean }
	| { id: number; kind: "tool"; callId: string; name: string; text: string; isError: boolean; shots: string[]; images: number }
	| { id: number; kind: "marker"; text: string };

export type ChatLive = {
	busy: boolean;
	/** Text of the in-flight reply so far. */
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
	if (UserEntry.is(entry) && message?.role === "user") {
		const user = message as UserMessage;
		const text = textOf(user.content);
		if (text.startsWith("[routine]")) return { id, kind: "routine", text, at: user.timestamp };
		return { id, kind: "user", text, at: user.timestamp, images: imageCount(user.content) };
	}
	if (AssistantEntry.is(entry) && message?.role === "assistant") {
		const reply = message as AssistantMessage;
		const tools = reply.content.flatMap((part) =>
			part.type === "toolCall" ? [{ id: part.id, name: part.name, args: part.arguments as Record<string, unknown> }] : [],
		);
		return {
			id,
			kind: "assistant",
			text: textOf(reply.content),
			at: reply.timestamp,
			tools,
			aborted: reply.stopReason === "aborted",
			...(reply.stopReason === "error" ? { error: reply.errorMessage ?? "The model returned an error." } : {}),
		};
	}
	if (ToolResultEntry.is(entry) && message?.role === "toolResult") {
		const result = message as ToolResultMessage;
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

/** Reduce the conversation's live document to what the chat shows while the bot works. */
export function toChatLive(live: Readonly<LiveState> | null): ChatLive {
	const partial = live?.generation?.message;
	return {
		busy: live?.run !== undefined,
		partial: partial === undefined ? "" : textOf(partial.content as readonly { type: string; text?: string }[]),
		tools: (live?.tools ?? []).map((slot) => {
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

/** Bind the chat to the bot's root conversation. Call close() on shutdown. */
export function createChat(deps: { harness: Harness; root: Conversation; context: Context; computer?: ComputerView }) {
	const { harness, root, context, computer } = deps;
	const listeners = new Set<(event: ChatEvent) => void>();
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
		if (computer === undefined || listeners.size === 0) return;
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
			const page = await root.entries(
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

	async function startWatch(): Promise<void> {
		const newest = await root.entries({ order: "descending" }, 1, undefined, context);
		lastSeen = newest.items[0]?.id;
		const watch = await harness.watchDoc(LiveDoc, root.id, context);
		if (watch === undefined) return;
		live = toChatLive(watch.value);
		stopWatch = () => watch.stop();
		watch.start(async (value, _ops, ctx) => {
			live = toChatLive(value);
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
			const page = await root.entries({ order: "descending" }, limit, before, context);
			const items = page.items.flatMap((entry) => toChatItem(entry) ?? []).reverse();
			return { items, before: page.next ?? null };
		},
		/** Queue an owner message. It runs after the current turn when the bot is busy. Does not wait for the answer. */
		async send(text: string) {
			const submission = await root.submit({ type: "input", content: text, whenBusy: "followUp" }, context);
			return { submissionId: submission.id as number };
		},
		/** Stop the current turn and drop queued messages. Routines keep their schedules. */
		async stop() {
			await root.abort(context);
		},
		get live() {
			return live;
		},
		/** The computer pane's current state, or undefined when the bot has no computer view. */
		computer: () => computer?.snapshot(runningComputer()?.child as ConversationId | undefined),
		/** Receive live events until the returned function is called. */
		subscribe(listener: (event: ChatEvent) => void) {
			listeners.add(listener);
			watching ??= startWatch();
			return () => listeners.delete(listener);
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
