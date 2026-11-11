// Every kind of turn reaching a bot through src/turns.ts, read back the way the chat reads it (src/chat.ts): its chat
// item, the memory note before owner and bot messages, the busy rule, the request id, /say's answer, where an approval
// outcome goes, and message_bot with only the extensions installed. Harness on MemoryStorage, faux model.
// Run from the repo root:  node --test test/turns.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, type ConversationId, createRegistry, defineExtension, defineTool, type EntryRecord, Harness, InboxDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { botLookup, createBots, createBotsExtension, readBots } from "../src/bots.ts";
import { APPROVAL_OUTCOME, BOT_MESSAGE, type ChatItem, createChat, MEMORY_NOTE, REACTION, ROUTINE_FIRING, SEND_MESSAGE, toChatItem } from "../src/chat.ts";
import { createMemory } from "../src/memory.ts";
import { bindRoutines } from "../src/routines.ts";
import { createTurns, type MemoryNote } from "../src/turns.ts";

const context = BACKGROUND_CONTEXT;
const MODEL = { provider: "faux", modelId: "faux-1" };

const textOf = (message: Message | undefined) =>
	message === undefined ? "" : typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const lastUser = (messages: Message[]) => textOf(messages.findLast((message) => message.role === "user"));
const quiet = fauxAssistantMessage([fauxText("Noted.")]);
// A 1x1 PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tell = (text: string) => fauxAssistantMessage([fauxToolCall(SEND_MESSAGE, { text })], { stopReason: "toolUse" });

// A tool that returns at once, for a reply that only runs a tool.
const lookExtension = defineExtension({
	name: "look",
	tools: [defineTool({ name: "look", description: "Look.", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text" as const, text: "Saw it." }] }) })],
});

// A tool that holds its turn until `release`, so the bot is busy while turns are delivered.
function holdExtension() {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const extension = defineExtension({
		name: "hold",
		tools: [
			defineTool({
				name: "hold",
				description: "Wait.",
				parameters: Type.Object({}),
				execute: async () => {
					started.resolve();
					await release.promise;
					return { output: [{ type: "text" as const, text: "Held." }] };
				},
			}),
		],
	});
	return { extension, started: started.promise, release: () => release.resolve() };
}

// The faux model answers by the last user message, since several conversations can ask in any order.
async function open(options: { memoryNote?: MemoryNote; answer?: (messages: Message[]) => AssistantMessage; hold?: ReturnType<typeof holdExtension>; hosted?: boolean; afterTool?: (tool: string) => AssistantMessage | undefined } = {}) {
	const temp = await mkdtemp(join(tmpdir(), "cua-bot-turns-"));
	const dir = join(temp, "bots");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const answer: FauxResponseStep = (request) => {
		faux.appendResponses([answer]);
		const last = request.messages.at(-1);
		if (last?.role === "toolResult") return options.afterTool?.(last.toolName) ?? quiet;
		return options.answer?.(request.messages) ?? quiet;
	};
	faux.setResponses([answer]);
	const turns = createTurns(options.memoryNote ?? (async () => undefined));
	const registry = createRegistry();
	registry.install(createBotsExtension({ agent: () => ({ model: MODEL }), turns, dir }));
	registry.install(lookExtension);
	if (options.hold !== undefined) registry.install(options.hold.extension);
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	const lookup = botLookup(harness, root, dir);
	bindRoutines({ harness, bots: lookup, turns, onError: (error) => assert.fail(String(error)) });
	harness.resume();
	const bots = options.hosted === false ? undefined : await createBots({ harness, lookup, context, agent: () => ({ model: MODEL }), memory: createMemory({ dir: join(temp, "memory"), botsDir: dir }), onError: (error) => assert.fail(String(error)), turns });
	return {
		storage,
		harness,
		root,
		lookup,
		turns,
		bots,
		async close() {
			options.hold?.release();
			await bots?.close();
			await harness.close(context);
			await rm(temp, { recursive: true, force: true });
		},
	};
}

const entries = async (conversation: Pick<Conversation, "entries">) => (await conversation.entries({ order: "ascending" }, 500, undefined, context)).items;
const shown = (list: readonly EntryRecord[]) => list.flatMap((entry) => toChatItem(entry) ?? []).filter((item) => item.kind !== "assistant");

test("each kind of turn shows as its chat item, with a memory note right before owner and bot messages only", { timeout: 20_000 }, async () => {
	const searched: string[] = [];
	const bot = await open({
		memoryNote: async (_bot, message) => {
			searched.push(message);
			return message === "thanks" ? undefined : `[search_memory] about ${message}`;
		},
	});
	try {
		const { turns, root, harness } = bot;
		const deliver = async (turn: Parameters<typeof turns.deliver>[1]) => (await turns.deliver(root, turn, harness, context)).wait(context);
		await deliver({ kind: "owner", content: "plan my week", whenBusy: "steer" });
		await deliver({ kind: "reaction", reaction: { target: 3, emoji: "👍", on: true }, reply: "Booked." });
		await deliver({ kind: "bot", from: { id: 9, name: "Scout" }, text: "Found 3 flights.", task: 41 });
		await deliver({ kind: "routine", text: '[routine] "Sweep" is due (daily). Nobody is waiting.', task: 12, at: 1000, manual: false });
		await deliver({ kind: "routine", text: '[routine] "Sweep" is due (daily). Nobody is waiting.', task: 12, at: 2000, manual: true });
		await deliver({ kind: "approval", text: "[approval] The owner discarded: Send email. Don't try it again unless they ask." });
		await deliver({ kind: "owner", content: [{ type: "text", text: "thanks" }, { type: "image", data: PIXEL, mimeType: "image/png" }] });

		const list = await entries(root);
		const items = shown(list);
		assert.deepEqual(
			items.map((item) => ({ ...item, id: 0, at: 0 })),
			[
				{ id: 0, kind: "user", text: "plan my week", at: 0, images: 0 },
				{ id: 0, kind: "reaction", target: 3, emoji: "👍", on: true, at: 0 },
				{ id: 0, kind: "bot", from: 9, name: "Scout", text: "Found 3 flights.", at: 0 },
				{ id: 0, kind: "routine", text: '[routine] "Sweep" is due (daily). Nobody is waiting.', at: 0 },
				{ id: 0, kind: "routine", text: '[routine] "Sweep" is due (daily). Nobody is waiting.', at: 0 },
				{ id: 0, kind: "approval", text: "[approval] The owner discarded: Send email. Don't try it again unless they ask.", at: 0 },
				{ id: 0, kind: "user", text: "thanks", at: 0, images: 1 },
			],
		);
		assert.deepEqual(
			list.filter((entry) => entry.model?.[0]?.role === "user").map((entry) => entry.kind),
			[MEMORY_NOTE, "pi.user", REACTION, MEMORY_NOTE, BOT_MESSAGE, ROUTINE_FIRING, ROUTINE_FIRING, APPROVAL_OUTCOME, "pi.user"],
			"a note right before the owner's and the bot's message, none before the others, and none when the search finds nothing",
		);
		assert.deepEqual(searched, ["plan my week", "Found 3 flights.", "thanks"], "a bot message is searched without its [bot] header, a message with an image by its text");
		const read = (kind: string) => textOf(list.find((entry) => entry.kind === kind)?.model?.[0]);
		assert.equal(read(BOT_MESSAGE), "[bot] Message from Scout (id 9), another of the owner's bots:\nFound 3 flights.");
		assert.equal(read(MEMORY_NOTE), "[search_memory] about plan my week");
		assert.match(read(REACTION), /^\[The owner reacted 👍 to your message: "Booked\."\./);
	} finally {
		await bot.close();
	}
});

test("while the bot is busy, only an owner message sent with steer joins the turn, and each request id has its format", { timeout: 20_000 }, async () => {
	const hold = holdExtension();
	const bot = await open({ hold, answer: (messages) => (lastUser(messages) === "wait" ? fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }) : quiet) });
	try {
		const { turns, root, harness, storage } = bot;
		await turns.deliver(root, { kind: "owner", content: "wait" }, harness, context);
		await hold.started;
		const deliver = (turn: Parameters<typeof turns.deliver>[1]) => turns.deliver(root, turn, harness, context);
		await deliver({ kind: "owner", content: "steered", whenBusy: "steer" });
		await deliver({ kind: "owner", content: "after", whenBusy: "followUp" });
		await deliver({ kind: "owner", content: "said" });
		await deliver({ kind: "reaction", reaction: { target: 3, emoji: "👍", on: true }, reply: "Booked." });
		const message = await deliver({ kind: "bot", from: { id: 9, name: "Scout" }, text: "hi", task: 41 });
		const fired = await deliver({ kind: "routine", text: "[routine] due", task: 12, at: 1000, manual: false });
		const ran = await deliver({ kind: "routine", text: "[routine] due", task: 12, at: 2000, manual: true });
		await deliver({ kind: "approval", text: "[approval] done" });

		const inbox = (await harness.snapshot(InboxDoc, root.id, context))?.items ?? [];
		assert.deepEqual(
			inbox.map((item) => [item.mode, item.mode === "write" ? "" : typeof item.content === "string" ? item.content.split("\n")[0] : ""]),
			[
				["steer", "steered"],
				["followUp", "after"],
				["followUp", "said"],
				["followUp", '[The owner reacted 👍 to your message: "Booked.". You don\'t need to reply. Act on it if your instructions or the message call for that; otherwise end your turn without calling send_message.]'],
				["followUp", "[bot] Message from Scout (id 9), another of the owner's bots:"],
				["followUp", "[routine] due"],
				["followUp", "[routine] due"],
				["followUp", "[approval] done"],
			],
		);
		const byRequest = async (requestId: string) => (await storage.submissionByRequest(root.id, requestId, context))?.id;
		assert.equal(await byRequest("bot:41"), message.id);
		assert.equal(await byRequest("12:1000"), fired.id);
		assert.equal(await byRequest("12:manual:2000"), ran.id);
		assert.equal((await deliver({ kind: "routine", text: "[routine] due", task: 12, at: 1000, manual: false })).id, fired.id, "a firing lands once");
		assert.equal((await deliver({ kind: "bot", from: { id: 9, name: "Scout" }, text: "hi", task: 41 })).id, message.id, "a bot message lands once");
	} finally {
		await bot.close();
	}
});

test("/say returns what the bot sent the owner, and (unanswered: …) when the turn does not finish", { timeout: 20_000 }, async () => {
	const hold = holdExtension();
	const bot = await open({
		hold,
		afterTool: (tool) => (tool === "look" ? tell("Checked.") : undefined),
		answer: (messages) => {
			const text = lastUser(messages);
			if (text === "hello") return tell("Hi there.");
			if (text === "check") return fauxAssistantMessage([fauxToolCall("look", {})], { stopReason: "toolUse" });
			if (text === "wait") return fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
			return quiet;
		},
	});
	try {
		const chat = createChat({ harness: bot.harness, conversation: bot.root, context, turns: bot.turns });
		assert.equal(await chat.say("hello"), "Hi there.");
		assert.equal(await chat.say("anyone?"), "", "a turn that sent the owner nothing answers nothing");
		assert.equal(await chat.say("check"), "Checked.", "a reply that only ran a tool adds nothing");
		const said = chat.say("wait");
		await hold.started;
		// The hold ignores the abort, so it is released once the stop is asked for.
		const stopped = chat.stop();
		hold.release();
		await stopped;
		assert.equal(await said, "(unanswered: aborted)");
		await chat.close();
	} finally {
		await bot.close();
	}
});

test("an approval outcome goes to the bot that filed the card, and to the main bot when the card names none or the bot is gone", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const { turns, lookup, harness, root } = bot;
		const scout = await bot.bots!.create({ name: "Scout", instructions: "" });
		const scoutChat = (await lookup.conversation(scout.id, context))!;
		const outcomes = async (conversation: Pick<Conversation, "entries">) => shown(await entries(conversation)).flatMap((item) => (item.kind === "approval" ? [item.text] : []));
		const tell = async (filedBy: number | undefined, text: string) => (await turns.approval(lookup, filedBy, text, harness, context)).wait(context);

		await tell(scout.id, "[approval] for Scout");
		await tell(undefined, "[approval] from an older card");
		await bot.bots!.remove(scout.id);
		await tell(scout.id, "[approval] after Scout was deleted");

		assert.deepEqual(await outcomes(scoutChat), ["[approval] for Scout"]);
		assert.deepEqual(await outcomes(root), ["[approval] from an older card", "[approval] after Scout was deleted"]);
	} finally {
		await bot.close();
	}
});

test("message_bot delivers with its memory note when only the extensions are installed, before the host's bot list exists", { timeout: 20_000 }, async () => {
	const searched: [number, string, string[]][] = [];
	const bot = await open({
		hosted: false,
		memoryNote: async (id, message, read, ctx) => {
			searched.push([id, message, (await readBots(read, ctx)).map((entry) => entry.name)]);
			return "[search_memory] Tokyo trip in March";
		},
		answer: (messages) => {
			const text = lastUser(messages);
			if (text === "make bots")
				return fauxAssistantMessage(
					[fauxToolCall("create_bot", { name: "Scout", instructions: "Research." }, { id: "b1" }), fauxToolCall("create_bot", { name: "Pilot", instructions: "Fly." }, { id: "b2" })],
					{ stopReason: "toolUse" },
				);
			if (text === "ask pilot") return fauxAssistantMessage([fauxToolCall("message_bot", { to: "Pilot", text: "Find flights to Tokyo." }, { id: "m1" })], { stopReason: "toolUse" });
			return quiet;
		},
	});
	try {
		const { harness, root } = bot;
		await (await root.submit({ type: "input", content: "make bots" }, context)).wait(context);
		const [scout, pilot] = await readBots(harness, context);
		assert.ok(scout !== undefined && pilot !== undefined);
		const scoutChat = (await harness.conversation(scout.id as ConversationId, context))!;
		await (await scoutChat.submit({ type: "input", content: "ask pilot" }, context)).wait(context);

		const pilotChat = (await harness.conversation(pilot.id as ConversationId, context))!;
		let list: readonly EntryRecord[] = [];
		const deadline = Date.now() + 10_000;
		while (!(list = await entries(pilotChat)).some((entry) => entry.kind === BOT_MESSAGE)) {
			assert.ok(Date.now() < deadline, "the message never landed");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.deepEqual(list.slice(0, 2).map((entry) => entry.kind), [MEMORY_NOTE, BOT_MESSAGE]);
		assert.deepEqual(searched, [[pilot.id, "Find flights to Tokyo.", ["Scout", "Pilot"]]], "searched as Pilot, over the bots the Harness holds");
		const sender = (await bot.storage.scanTasks({ conversationId: scout.id as ConversationId }, 100, undefined, context)).items.find((task) => (task.input as { callId?: string }).callId === "m1");
		assert.equal((await bot.storage.submissionByRequest(pilotChat.id, `bot:${sender?.id}`, context))?.id !== undefined, true, "its request id names message_bot's tool task");
		assert.deepEqual(shown(list), [{ id: list[1]?.id, kind: "bot", from: scout.id, name: "Scout", text: "Find flights to Tokyo.", at: (list[1]?.model?.[0] as { timestamp: number }).timestamp }] satisfies ChatItem[]);
	} finally {
		await bot.close();
	}
});
