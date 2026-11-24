// Topics: side threads split out of a bot's chat, so a temporary matter doesn't fill the bot's main conversation. A
// topic is a fork of the bot's conversation (Pi Durable's forkConversation), so it knows everything said in the main chat
// before it opened, and what is said in it stays there. Only its one-line outcome comes back to the main chat, as a
// TOPIC_CLOSED entry, when the owner or the bot closes it.
//
// The topic list lives in one session doc, cua-bot.topics in data/cua-bot.sqlite, keyed by the topic's conversation id.
// Each topic names its bot, the main-chat entry its fork starts from (`forkedAt`), and the main-chat messages put in it
// (`messages`, at most one topic per message). A message newer than the fork is copied into the topic as a TOPIC_MESSAGE
// entry, since the fork can't see it otherwise.
//
// The owner opens, renames, fills, closes, and reopens topics in the web portal (src/web.ts through createBots in
// src/bots.ts); the bot does the same with its one tool, manage_topic. Tools and prompt sections that work per bot read
// the bot a topic's conversation belongs to with botOf(), so a topic acts as its bot: same name, memory, and routines.
import type { Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import {
	AgentDoc,
	AssistantEntry,
	CompactionEntry,
	configure,
	type ConversationHandle,
	type ConversationId,
	type Cursor,
	defineDoc,
	defineExtension,
	defineTool,
	type EntryId,
	type EntryRecord,
	type Extension,
	type Harness,
	ResetEntry,
	section,
	type Tx,
} from "@earendil-works/pi-durable";
import { type ChatItem, SENT_MESSAGE, type SentMessage, TOPIC_CLOSED, TOPIC_MESSAGE, TOPIC_RENAMED, type TopicBy, type TopicClosed, type TopicRenamed, toChatItem } from "./chat.ts";
import type { Turns } from "./turns.ts";

type TopicRecord = {
	bot: number;
	name: string;
	by: TopicBy;
	createdAt: number;
	/** The main-chat entry the fork starts from; absent for a topic opened before the bot's chat had a finished reply. */
	forkedAt?: number;
	/** The main-chat messages in the topic, by entry id, in the order they were put there. */
	messages: number[];
	/** Set once the topic closes; `outcome` is missing while the bot is still writing it for a topic the owner closed. */
	closed?: { by: TopicBy; at: number; outcome?: string };
	/**
	 * Set when the owner reopened the topic while its bot was already answering their close. The bot's next close, that
	 * answer, is refused and clears it.
	 */
	reopened?: true;
};
type TopicsState = { topics: { [conversationId: string]: TopicRecord } };

const TopicsDoc = defineDoc<TopicsState>({
	kind: "cua-bot.topics",
	version: 1,
	scope: "session",
	initial: () => ({ topics: {} }),
	checkpointWhen: () => false,
});

/** A topic and its conversation id. */
export type Topic = TopicRecord & { id: number };

export class TopicError extends Error {
	readonly status: 400 | 404;
	constructor(status: 400 | 404, message: string) {
		super(message);
		this.status = status;
	}
}

type Reader = Pick<Harness, "snapshot">;

// A plain copy of a stored or draft topic: drafts are proxies, which structuredClone refuses.
const copyOf = (record: Readonly<TopicRecord>, id: number): Topic => ({ ...(JSON.parse(JSON.stringify(record)) as TopicRecord), id });

const topicsOf = (state: Readonly<TopicsState> | null | undefined): Topic[] => Object.entries(state?.topics ?? {}).map(([id, record]) => copyOf(record, Number(id)));

/** Every topic, oldest first. */
export async function readTopics(read: Reader, context: Context): Promise<Topic[]> {
	return topicsIn(await read.snapshot(TopicsDoc, context));
}

/**
 * Watches the topic list; src/bots.ts follows it to open each topic's chat. The list is created first, since a watch
 * needs a doc to follow.
 */
export async function watchTopics(harness: Harness, context: Context) {
	await harness.commit(async (tx) => void (await tx.doc(TopicsDoc)), context);
	return harness.watchDoc(TopicsDoc, context);
}

/** The topics in a value of the watch above, oldest first. */
export const topicsIn = (state: Readonly<TopicsState> | null | undefined): Topic[] => topicsOf(state).sort((a, b) => a.createdAt - b.createdAt);

/** The topic whose conversation `conversationId` is, or undefined for any other conversation. */
export async function topicOf(read: Reader, conversationId: number | ConversationId, context: Context): Promise<Topic | undefined> {
	const record = (await read.snapshot(TopicsDoc, context))?.topics[String(conversationId)];
	return record === undefined ? undefined : copyOf(record, Number(conversationId));
}

/**
 * The bot a conversation acts as: a topic's bot, or the conversation itself. Tools and prompt sections that work per bot
 * (its name, memory, routines, bot messages) read the bot through this, so a topic acts as its bot.
 */
export async function botOf(read: Reader, conversationId: number | ConversationId, context: Context): Promise<number> {
	return (await topicOf(read, conversationId, context))?.bot ?? Number(conversationId);
}

/** What the owner and the bots do to topics through: the Harness, or a tool's own api. */
export type TopicHost = {
	commit: <T>(run: (tx: Tx) => Promise<T>) => Promise<T>;
	conversation: (id: ConversationId) => Promise<ConversationHandle | undefined>;
	read: Reader;
	context: Context;
	now: () => number;
};

/** The host for the owner's changes from the web portal. */
export const harnessHost = (harness: Harness, context: Context): TopicHost => ({
	commit: (run) => harness.commit(run, context),
	conversation: (id) => harness.conversation(id, context),
	read: harness,
	context,
	now: Date.now,
});

const nameOf = (name: string) => {
	const clean = name.trim().replace(/\s+/g, " ");
	if (clean === "") throw new TopicError(400, "A topic needs a name.");
	return clean;
};

// Whether a fork at this entry starts from a finished turn: a reply with no tool calls left to answer, or the start of a
// summarized or fresh context. A fork mid-turn would hand the topic a tool call with no result.
function restsAt(entry: EntryRecord): boolean {
	if (CompactionEntry.is(entry) || ResetEntry.is(entry)) return true;
	const message = entry.model?.[0];
	return AssistantEntry.is(entry) && message?.role === "assistant" && !message.content.some((part) => part.type === "toolCall");
}

// The newest entry of the bot's chat a topic can fork from, or undefined when the chat has no finished reply yet.
async function forkPoint(tx: Tx, bot: ConversationId): Promise<EntryId | undefined> {
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanEntries({ conversationId: bot, order: "descending" }, 100, cursor);
		const found = page.items.find(restsAt);
		if (found !== undefined) return found.id;
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

// The kinds of main-chat item a topic can hold: the messages, not tool steps or bookkeeping.
const isMessage = (item: ChatItem | undefined): item is Extract<ChatItem, { kind: "user" | "assistant" | "bot" | "routine" }> =>
	item !== undefined && (item.kind === "user" || item.kind === "bot" || item.kind === "routine" || (item.kind === "assistant" && item.text.trim() !== ""));

// The message `entry` of the bot's main chat, or a TopicError when it is in another chat or isn't a message.
async function messageIn(tx: Tx, bot: number, entry: number) {
	const record = await tx.entry(entry as EntryId);
	if (record === undefined || Number(record.conversationId) !== bot) throw new TopicError(404, "That message isn't in this bot's chat.");
	const item = toChatItem(record);
	if (!isMessage(item)) throw new TopicError(400, "Only a message can go in a topic.");
	return item;
}

// Puts `entry` in topic `id` and takes it out of any other topic. Returns whether it was already there.
function place(doc: TopicsState, id: number, entry: number): boolean {
	const record = doc.topics[String(id)];
	if (record === undefined) return false;
	if (record.messages.includes(entry)) return true;
	for (const other of Object.values(doc.topics)) {
		const at = other.messages.indexOf(entry);
		if (at >= 0) other.messages.splice(at, 1);
	}
	record.messages.push(entry);
	return false;
}

// What the topic's bot reads for a main-chat message copied in, with who wrote it.
function copyText(item: Extract<ChatItem, { kind: "user" | "assistant" | "bot" | "routine" }>, by: TopicBy): string {
	const who = item.kind === "user" ? "The owner" : item.kind === "assistant" ? "You" : item.kind === "bot" ? `${item.name}, another bot,` : "A routine firing";
	const mover = by === "owner" ? "The owner" : "You";
	const images = item.kind === "user" && item.images > 0 ? ` (with ${item.images} image${item.images === 1 ? "" : "s"}, which stay in the main chat)` : "";
	return `[topic] ${mover} put this message from your main chat in this topic. ${who} wrote${images}:\n${item.text}`;
}

// Copies main-chat message `entry` into the topic when the fork can't see it: it came after the fork, or the topic has none.
async function copyIn(host: TopicHost, topic: Topic, entry: number, by: TopicBy): Promise<void> {
	if (topic.forkedAt !== undefined && entry <= topic.forkedAt) return;
	const item = await host.commit((tx) => messageIn(tx, topic.bot, entry));
	const handle = await host.conversation(topic.id as ConversationId);
	if (handle === undefined) return;
	await handle.submit({ type: "write", entry: { kind: TOPIC_MESSAGE, data: { entry }, model: [{ role: "user", content: copyText(item, by), timestamp: host.now() }] } }, host.context);
}

const snapshotOf = (doc: TopicsState, id: number): Topic => copyOf(doc.topics[String(id)] as TopicRecord, id);

/**
 * Opens a topic of bot `bot` named `name`: a fork of the bot's chat at its newest finished reply, or a fresh conversation
 * on the bot's model when it has none. `entry`, a message of the bot's main chat, goes in it first.
 */
export async function openTopic(host: TopicHost, input: { bot: number; name: string; by: TopicBy; entry?: number }): Promise<Topic> {
	const name = nameOf(input.name);
	const topic = await host.commit(async (tx) => {
		if (input.entry !== undefined) await messageIn(tx, input.bot, input.entry);
		const bot = input.bot as ConversationId;
		const at = await forkPoint(tx, bot);
		const ownership = { kind: "ownerless" } as const;
		let id: ConversationId;
		if (at !== undefined) id = (await tx.forkConversation(bot, at, { ownership })).id;
		else {
			id = (await tx.createConversation({ ownership })).id;
			const { model, thinkingLevel } = await tx.doc(AgentDoc, bot);
			await configure(tx, id, { ...(model === undefined ? {} : { model }), ...(thinkingLevel === undefined ? {} : { thinkingLevel }) });
		}
		const doc = await tx.doc(TopicsDoc);
		doc.topics[String(id)] = { bot: input.bot, name, by: input.by, createdAt: host.now(), ...(at === undefined ? {} : { forkedAt: Number(at) }), messages: [] };
		if (input.entry !== undefined) place(doc, Number(id), input.entry);
		return snapshotOf(doc, Number(id));
	});
	if (input.entry !== undefined) await copyIn(host, topic, input.entry, input.by);
	return topic;
}

// The open topic `id`, or a TopicError.
function openRecord(doc: TopicsState, id: number): TopicRecord {
	const record = doc.topics[String(id)];
	if (record === undefined) throw new TopicError(404, "No such topic.");
	if (record.closed !== undefined) throw new TopicError(400, `The topic "${record.name}" is closed. Reopen it first.`);
	return record;
}

/** Puts main-chat message `entry` in topic `id`, taking it out of any other topic. */
export async function assignTopic(host: TopicHost, id: number, entry: number, by: TopicBy): Promise<Topic> {
	const { topic, already } = await host.commit(async (tx) => {
		const doc = await tx.doc(TopicsDoc);
		const record = openRecord(doc, id);
		await messageIn(tx, record.bot, entry);
		const already = place(doc, id, entry);
		return { topic: snapshotOf(doc, id), already };
	});
	if (!already) await copyIn(host, topic, entry, by);
	return topic;
}

/** Renames topic `id`, noting the rename in its thread. */
export async function renameTopic(host: TopicHost, id: number, name: string, by: TopicBy): Promise<Topic> {
	const to = nameOf(name);
	return host.commit(async (tx) => {
		const doc = await tx.doc(TopicsDoc);
		const record = doc.topics[String(id)];
		if (record === undefined) throw new TopicError(404, "No such topic.");
		if (record.name !== to) {
			const data: TopicRenamed = { from: record.name, to, by, at: host.now() };
			record.name = to;
			await tx.appendEntry(id as ConversationId, { kind: TOPIC_RENAMED, data });
		}
		return snapshotOf(doc, id);
	});
}

/**
 * Closes topic `id` with its one-line outcome and posts the outcome line in its bot's main chat. A topic the owner closed
 * (closeByOwner) keeps "closed by the owner" when its bot writes the outcome. Refused once the outcome is written.
 */
export async function closeTopic(host: TopicHost, id: number, outcome: string, by: TopicBy): Promise<Topic> {
	const line = outcome.trim().replace(/\s+/g, " ");
	if (line === "") throw new TopicError(400, "A topic closes with its outcome.");
	const { topic, refused } = await host.commit(async (tx) => {
		const doc = await tx.doc(TopicsDoc);
		const record = doc.topics[String(id)];
		if (record === undefined) throw new TopicError(404, "No such topic.");
		if (record.closed?.outcome !== undefined) throw new TopicError(400, `The topic "${record.name}" is already closed.`);
		// Returned rather than thrown, so the cleared flag is kept.
		if (record.closed === undefined && record.reopened === true) {
			delete record.reopened;
			return { topic: snapshotOf(doc, id), refused: true };
		}
		delete record.reopened;
		record.closed = { by: record.closed?.by ?? by, at: record.closed?.at ?? host.now(), outcome: line };
		return { topic: snapshotOf(doc, id), refused: false };
	});
	if (refused) throw new TopicError(400, `The owner reopened the topic "${topic.name}", so it stays open. Carry on in it.`);
	const main = await host.conversation(topic.bot as ConversationId);
	const closedBy = topic.closed?.by ?? by;
	const data: TopicClosed = { topic: id, name: topic.name, by: closedBy, outcome: line };
	const text = `[topic] ${closedBy === "owner" ? "The owner" : "You"} closed the topic "${topic.name}", a side thread of this chat. Outcome: ${line}`;
	await main?.submit({ type: "write", entry: { kind: TOPIC_CLOSED, data, model: [{ role: "user", content: text, timestamp: host.now() }] } }, host.context);
	return topic;
}

/**
 * The owner's close: the topic leaves the open list at once, and its bot gets a turn asking for the outcome, which
 * closeTopic posts. Closing a closed topic does nothing.
 */
export async function closeByOwner(host: TopicHost, turns: Turns, id: number): Promise<Topic> {
	const { topic, changed } = await host.commit(async (tx) => {
		const doc = await tx.doc(TopicsDoc);
		const record = doc.topics[String(id)];
		if (record === undefined) throw new TopicError(404, "No such topic.");
		const changed = record.closed === undefined;
		if (changed) record.closed = { by: "owner", at: host.now() };
		return { topic: snapshotOf(doc, id), changed };
	});
	const handle = changed ? await host.conversation(id as ConversationId) : undefined;
	if (handle !== undefined) await turns.deliver(handle, { kind: "topic-close", name: topic.name }, host.read, host.context);
	return topic;
}

/**
 * Reopens closed topic `id`. Its outcome line stays in the main chat. `withdrawn` says the owner's close still waiting
 * for its bot was taken back; when the bot is already answering it instead, its close is refused once.
 */
export async function reopenTopic(host: TopicHost, id: number, withdrawn: boolean): Promise<Topic> {
	return host.commit(async (tx) => {
		const doc = await tx.doc(TopicsDoc);
		const record = doc.topics[String(id)];
		if (record === undefined) throw new TopicError(404, "No such topic.");
		if (record.closed !== undefined && record.closed.outcome === undefined && !withdrawn) record.reopened = true;
		delete record.closed;
		return snapshotOf(doc, id);
	});
}

/** Drops every topic of a deleted bot from the list. Their conversations stay in the database, like the bot's. */
export async function removeBotTopics(host: TopicHost, bot: number): Promise<Topic[]> {
	return host.commit(async (tx) => {
		const doc = await tx.doc(TopicsDoc);
		const gone = topicsOf(doc).filter((topic) => topic.bot === bot);
		for (const topic of gone) delete doc.topics[String(topic.id)];
		return gone;
	});
}

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true as const } : {}) });
const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

// The bot's topic named or numbered `ref`, an open one first; `here`, the topic the call runs in, when `ref` is empty.
function findTopic(topics: Topic[], ref: string | undefined, here: Topic | undefined): Topic | undefined {
	const key = flat(ref ?? "");
	if (key === "") return here;
	const named = topics.filter((topic) => String(topic.id) === key || flat(topic.name) === key);
	return named.find((topic) => topic.closed === undefined) ?? named[0];
}

// The newest message of the bot's main chat whose text holds `words`.
async function findMessage(host: TopicHost, bot: number, words: string): Promise<number | undefined> {
	const key = flat(words);
	if (key === "") return undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await host.commit((tx) => tx.scanEntries({ conversationId: bot as ConversationId, order: "descending" }, 200, cursor));
		for (const entry of page.items) {
			const item = toChatItem(entry);
			if (isMessage(item) && flat(item.text).includes(key)) return item.id;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

const listed = (topics: Topic[]) => topics.map((topic) => `- "${topic.name}" (id ${topic.id}), opened by ${topic.by === "owner" ? "the owner" : "you"}`).join("\n");

/**
 * The prompt section: how topics work, with this bot's open topics in its main chat, or the topic the conversation is.
 * Undefined for a conversation that is neither, such as computer_use's.
 */
export function topicSection(topics: Topic[], bots: readonly { id: number }[], conversationId: number): string | undefined {
	const here = topics.find((topic) => topic.id === conversationId);
	if (here === undefined && !bots.some((bot) => bot.id === conversationId)) return undefined;
	if (here !== undefined) {
		return [
			`This conversation is the topic "${here.name}" (id ${here.id}), a side thread the owner or you split out of your main chat with the owner. It started from your main chat's history; what is said here stays in this topic, and the owner reads and answers it in the topic's own view. Answer with send_message as usual.`,
			"When the matter is settled, close the topic with manage_topic (action close) and a one-line outcome; only that line goes back to your main chat. If the subject has shifted, rename the topic with manage_topic (action edit).",
			"A message starting with [topic] comes from cua-bot about this topic: a main-chat message put in it, or the owner closing it.",
		].join("\n");
	}
	const open = topics.filter((topic) => topic.bot === conversationId && topic.closed === undefined);
	return [
		"Topics are side threads of this chat. Each one starts from this chat's history and keeps its own discussion out of this chat; when it closes, its one-line outcome comes back here as a message starting with [topic]. The owner opens and closes topics in the web portal, and you can with manage_topic.",
		"Open a topic (action create, with the message as text) when you raise a separate matter that will take some back-and-forth, such as a notice the owner has to act on. Put an existing message of this chat in a topic with action assign. Don't continue a topic's discussion here.",
		open.length === 0 ? "This chat has no open topics." : `Open topics:\n${listed(open)}`,
	].join("\n");
}

/**
 * Topics' tool, manage_topic, and prompt section, for the bots and their topics. `bots` lists the bots (readBots in
 * src/bots.ts), so a conversation that is neither, such as computer_use's, gets neither. Installed by src/main.ts.
 */
export function createTopicsExtension(deps: { bots: (read: Reader, context: Context) => Promise<readonly { id: number }[]> }): Extension {
	const manageTopic = defineTool({
		name: "manage_topic",
		description:
			"Open, rename, fill, or close a topic: a side thread of your chat with the owner. create opens one, with text as its first message to the owner (only from your main chat); edit renames one whose subject shifted; assign puts a message from your main chat in one; close ends one with a one-line outcome, which is posted to your main chat. Inside a topic, topic defaults to that topic.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("edit"), Type.Literal("assign"), Type.Literal("close")]),
			topic: Type.Optional(Type.String({ description: "edit, assign, close: the topic's name or id" })),
			name: Type.Optional(Type.String({ description: "create, edit: the topic's name, a few words" })),
			text: Type.Optional(Type.String({ description: "create: the message that opens the topic, sent to the owner, in Markdown" })),
			message: Type.Optional(Type.String({ description: "assign: words from the main-chat message to put in the topic, enough to find it" })),
			outcome: Type.Optional(Type.String({ description: "close: the outcome, one line" })),
		}),
		execute: async (args, api, context) => {
			const host: TopicHost = {
				commit: (run) => api.commit(run, context),
				conversation: (id) => api.conversation(id, context),
				read: api,
				context,
				now: () => api.now(),
			};
			const self = Number(api.conversationId);
			const all = await readTopics(api, context);
			const here = all.find((topic) => topic.id === self);
			const bot = here?.bot ?? self;
			if (here === undefined && !(await deps.bots(api, context)).some((b) => b.id === self)) return reply("Only a bot's chat and its topics have topics.", true);
			const mine = all.filter((topic) => topic.bot === bot);
			try {
				if (args.action === "create") {
					if (here !== undefined) return reply(`You're in the topic "${here.name}". Open new topics from your main chat.`, true);
					if (args.name === undefined) return reply("create needs a name.", true);
					let entry: number | undefined;
					if (args.text !== undefined && args.text.trim() !== "") {
						const data: SentMessage = { text: args.text, at: api.now() };
						entry = Number((await api.commit((tx) => tx.appendEntry(api.conversationId, { kind: SENT_MESSAGE, data }), context)).id);
					}
					const topic = await openTopic(host, { bot, name: args.name, by: "bot", ...(entry === undefined ? {} : { entry }) });
					return reply(`Opened the topic "${topic.name}" (id ${topic.id})${entry === undefined ? "" : " and sent its first message to the owner"}. The owner continues it in the topic's view.`);
				}
				const topic = findTopic(mine, args.topic, here);
				if (topic === undefined) {
					return reply(args.topic === undefined ? "Name the topic." : `No topic is named ${args.topic}. Open topics:\n${listed(mine.filter((t) => t.closed === undefined)) || "none"}`, true);
				}
				if (args.action === "edit") {
					if (args.name === undefined) return reply("edit needs the new name.", true);
					const renamed = await renameTopic(host, topic.id, args.name, "bot");
					return reply(`Renamed the topic to "${renamed.name}".`);
				}
				if (args.action === "assign") {
					const entry = await findMessage(host, bot, args.message ?? "");
					if (entry === undefined) return reply("No message in your main chat has those words.", true);
					await assignTopic(host, topic.id, entry, "bot");
					return reply(`Put the message in the topic "${topic.name}".`);
				}
				if (args.outcome === undefined) return reply("close needs the outcome.", true);
				await closeTopic(host, topic.id, args.outcome, "bot");
				return reply(`Closed the topic "${topic.name}"; its outcome is in your main chat.`);
			} catch (error) {
				if (error instanceof TopicError) return reply(error.message, true);
				throw error;
			}
		},
	});

	return defineExtension({
		name: "topics",
		tools: [manageTopic],
		sections: [
			section("topics", async (input, context) => topicSection(await readTopics(input.read, context), await deps.bots(input.read, context), Number(input.conversationId)), {
				tag: false,
			}),
		],
	});
}
