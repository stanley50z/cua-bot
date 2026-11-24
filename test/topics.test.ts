// Topics: side threads split out of a bot's chat. A topic forks the bot's chat, so it knows the main chat's history, but
// nothing said in it reaches the main chat until it closes and its outcome line lands there. The owner opens, fills,
// renames, and closes topics through /api/topics; the bot does the same with manage_topic.
// Run from the repo root:  node --test test/topics.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { botLookup, createBots, createBotsExtension, readBots, type TopicView } from "../src/bots.ts";
import { type ChatItem, SEND_MESSAGE } from "../src/chat.ts";
import { createMemory } from "../src/memory.ts";
import { bindRoutines, createRoutinesExtension } from "../src/routines.ts";
import { createTopicsExtension } from "../src/topics.ts";
import { createTurns } from "../src/turns.ts";
import { createBotServer } from "../src/web.ts";

const context = BACKGROUND_CONTEXT;
const MODEL = { provider: "faux", modelId: "faux-1" };

const textOf = (message: Message | undefined) =>
	message === undefined || message.role === "toolResult" || message.role === "assistant"
		? ""
		: typeof message.content === "string"
			? message.content
			: message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

const sendOwner = (text: string) => fauxAssistantMessage([fauxToolCall(SEND_MESSAGE, { text })], { stopReason: "toolUse" });
const manage = (args: Record<string, string>) => fauxAssistantMessage([fauxToolCall("manage_topic", args)], { stopReason: "toolUse" });

// The faux model answers by the last message it is asked about; every request's prompt is kept in `prompts`.
async function open() {
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const prompts: string[] = [];
	const answer = (request: { messages: Message[] }) => {
		prompts.push(JSON.stringify(request));
		const last = request.messages.findLast((message) => message.role !== "system");
		if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("Done.")]);
		// A changed prompt section arrives as a system message after the newest user message.
		const text = textOf(request.messages.findLast((message) => message.role === "user"));
		if (text.startsWith("[topic] The owner closed")) return manage({ action: "close", outcome: "Dev found the Douyin login wall." });
		if (text === "t3 investigate") return sendOwner("Investigating.");
		if (text === "open a topic") return manage({ action: "create", name: "API credits", text: "Your Claude API access is off." });
		if (text === "file the kanban note") return manage({ action: "assign", topic: "API credits", message: "kanban appears stalled" });
		if (text === "rename it") return manage({ action: "edit", name: "Anthropic billing" });
		if (text === "wrap it up") return manage({ action: "close", outcome: "Credits refresh Dec 3." });
		if (text === "hello") return sendOwner("Social Media Kanban appears stalled.");
		return sendOwner(`Heard: ${text}`);
	};
	faux.setResponses(Array.from({ length: 80 }, () => answer));
	const temp = await mkdtemp(join(tmpdir(), "cua-bot-topics-"));
	const dir = join(temp, "bots");
	const registry = createRegistry();
	const turns = createTurns(async () => undefined);
	registry.install(createBotsExtension({ agent: () => ({ model: MODEL }), turns, dir }));
	registry.install(createTopicsExtension({ bots: readBots }));
	registry.install(createRoutinesExtension());
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	const lookup = botLookup(harness, root, dir);
	bindRoutines({ harness, bots: lookup, turns, legacyFile: join(temp, "routines.json"), onError: () => {} });
	harness.resume();
	const memory = createMemory({ dir: join(temp, "memory"), botsDir: dir });
	const pushed: [string, string, string | undefined][] = [];
	const bots = await createBots({ harness, lookup, context, agent: () => ({ model: MODEL }), memory, onError: () => {}, sent: (bot, text, topic) => pushed.push([bot.name, text, topic?.name]), turns });
	const server = createBotServer({ say: async (text) => text, bots, context });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const call = (method: string, path: string, body?: unknown) =>
		fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return {
		call,
		bots,
		prompts,
		pushed,
		main: Number(root.id),
		chat: async (query = "") => (await (await call("GET", `/api/chat${query}`)).json()) as { items: ChatItem[]; messages?: ChatItem[] },
		async close() {
			await bots.close();
			await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
			await harness.close(context);
			await rm(temp, { recursive: true, force: true });
		},
	};
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		assert.ok(Date.now() < deadline, `timed out; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

const said = (items: ChatItem[], text: string) => items.some((item) => (item.kind === "assistant" || item.kind === "user") && item.text === text);
const idle = (bots: { list: () => { busy: boolean }[]; topics: () => TopicView[] }) => bots.list().every((b) => !b.busy) && bots.topics().every((t) => !t.busy);

test("a topic forks the main chat, keeps its thread out of it, and posts its outcome when the owner closes it", { timeout: 30_000 }, async () => {
	const bot = await open();
	try {
		await bot.call("POST", "/api/chat", { text: "hello" });
		const notice = (await until(() => bot.chat(), (chat) => said(chat.items, "Social Media Kanban appears stalled."))).items.find((item) => item.kind === "assistant" && item.text !== "");
		await until(async () => bot.bots, idle);

		const made = await bot.call("POST", "/api/topics", { bot: bot.main, name: "Kanban stall", entry: notice?.id });
		assert.equal(made.status, 201);
		const { topic } = (await made.json()) as { topic: TopicView };
		assert.deepEqual([topic.name, topic.by, topic.messages], ["Kanban stall", "owner", [notice?.id]]);

		const first = await bot.chat(`?topic=${topic.id}`);
		assert.deepEqual(first.items, [], "a new topic's thread is empty: the main chat it forked from doesn't show in it");
		assert.deepEqual(first.messages?.map((item) => item.id), [notice?.id], "its first page carries the message put in it");

		await bot.call("POST", "/api/chat", { topic: topic.id, text: "t3 investigate" });
		const thread = await until(() => bot.chat(`?topic=${topic.id}`), (chat) => said(chat.items, "Investigating."));
		assert.ok(said(thread.items, "t3 investigate"));
		const asked = bot.prompts.find((prompt) => prompt.includes("t3 investigate"));
		assert.ok(asked?.includes("hello"), "the topic sees the main chat's history");
		assert.ok(asked?.includes(`This conversation is the topic \\"Kanban stall\\" (id ${topic.id})`), "its prompt says which topic it is");
		assert.ok(asked?.includes("Your name is cua-bot."), "and it acts as its bot");
		assert.deepEqual(bot.pushed.at(-1), ["cua-bot", "Investigating.", "Kanban stall"], "what it sends the owner is pushed, titled with the topic");

		const main = await bot.chat();
		assert.ok(!said(main.items, "t3 investigate") && !said(main.items, "Investigating."), "the main chat never shows the topic's thread");
		await until(async () => bot.bots.topics().find((t) => t.id === topic.id), (view) => view?.replies === 2 && view.last?.text === "Investigating." && !view.busy);

		// The outcome line is written outside any run of the main chat, so this checks the live stream gets it, not only a reload.
		const streamed: ChatItem[] = [];
		const stop = (await bot.bots.chat())?.subscribe((event) => void (event.type === "items" && streamed.push(...event.items)), { computer: false });
		assert.equal((await bot.call("POST", `/api/topics/${topic.id}/close`)).status, 200);
		await until(async () => streamed, (items) => items.some((item) => item.kind === "topic-closed"));
		stop?.();
		const closed = await until(() => bot.chat(), (chat) => chat.items.some((item) => item.kind === "topic-closed"));
		const line = closed.items.find((item) => item.kind === "topic-closed");
		assert.deepEqual(line?.kind === "topic-closed" && [line.topic, line.name, line.by, line.outcome], [topic.id, "Kanban stall", "owner", "Dev found the Douyin login wall."]);
		await until(async () => bot.bots.topics().find((t) => t.id === topic.id)?.closed, (closed) => closed?.outcome === "Dev found the Douyin login wall." && closed.by === "owner");

		await until(async () => bot.bots, idle);
		await bot.call("POST", "/api/chat", { text: "status?" });
		await until(() => bot.chat(), (chat) => said(chat.items, "Heard: status?"));
		const next = bot.prompts.find((prompt) => prompt.includes("status?"));
		assert.ok(next?.includes('[topic] The owner closed the topic \\"Kanban stall\\"'), "the main bot reads the outcome line");
		assert.ok(!next?.includes("t3 investigate"), "and none of the topic's thread");
	} finally {
		await bot.close();
	}
});

test("the bot opens, fills, renames, and closes a topic with manage_topic", { timeout: 30_000 }, async () => {
	const bot = await open();
	try {
		await bot.call("POST", "/api/chat", { text: "hello" });
		await until(() => bot.chat(), (chat) => said(chat.items, "Social Media Kanban appears stalled."));
		await until(async () => bot.bots, idle);

		await bot.call("POST", "/api/chat", { text: "open a topic" });
		const opened = await until(async () => bot.bots.topics(), (list) => list.length === 1 && list[0]?.messages.length === 1);
		const topic = opened[0] as TopicView;
		assert.deepEqual([topic.name, topic.by], ["API credits", "bot"]);
		const main = await until(() => bot.chat(), (chat) => said(chat.items, "Your Claude API access is off."));
		const first = main.items.find((item) => item.kind === "assistant" && item.text === "Your Claude API access is off.");
		assert.deepEqual(topic.messages, [first?.id], "the message it opened with is the topic's");
		await until(async () => bot.bots, idle);

		await bot.call("POST", "/api/chat", { text: "file the kanban note" });
		const filled = await until(async () => bot.bots.topics()[0], (view) => view?.messages.length === 2);
		const kanban = main.items.find((item) => item.kind === "assistant" && item.text === "Social Media Kanban appears stalled.");
		assert.deepEqual(filled?.messages, [first?.id, kanban?.id]);
		await until(async () => bot.bots, idle);

		await bot.call("POST", "/api/chat", { topic: topic.id, text: "rename it" });
		await until(async () => bot.bots.topics()[0], (view) => view?.name === "Anthropic billing");
		const thread = await until(() => bot.chat(`?topic=${topic.id}`), (chat) => chat.items.some((item) => item.kind === "topic-renamed"));
		const renamed = thread.items.find((item) => item.kind === "topic-renamed");
		assert.deepEqual(renamed?.kind === "topic-renamed" && [renamed.from, renamed.to, renamed.by], ["API credits", "Anthropic billing", "bot"]);
		await until(async () => bot.bots, idle);

		await bot.call("POST", "/api/chat", { topic: topic.id, text: "wrap it up" });
		const closed = await until(() => bot.chat(), (chat) => chat.items.some((item) => item.kind === "topic-closed"));
		const line = closed.items.find((item) => item.kind === "topic-closed");
		assert.deepEqual(line?.kind === "topic-closed" && [line.name, line.by, line.outcome], ["Anthropic billing", "bot", "Credits refresh Dec 3."]);
	} finally {
		await bot.close();
	}
});

test("a message newer than the fork is copied into the topic, and a message sits in one topic at a time", { timeout: 30_000 }, async () => {
	const bot = await open();
	try {
		await bot.call("POST", "/api/chat", { text: "hello" });
		await until(() => bot.chat(), (chat) => said(chat.items, "Social Media Kanban appears stalled."));
		await until(async () => bot.bots, idle);
		const a = ((await (await bot.call("POST", "/api/topics", { bot: bot.main, name: "First" })).json()) as { topic: TopicView }).topic;
		const b = ((await (await bot.call("POST", "/api/topics", { bot: bot.main, name: "Second" })).json()) as { topic: TopicView }).topic;
		assert.equal((await bot.call("POST", "/api/topics", { bot: bot.main, name: "  " })).status, 400, "a topic needs a name");

		await bot.call("POST", "/api/chat", { text: "the CMU waitlist" });
		const later = (await until(() => bot.chat(), (chat) => said(chat.items, "Heard: the CMU waitlist"))).items.find((item) => item.kind === "user" && item.text === "the CMU waitlist");
		await until(async () => bot.bots, idle);

		assert.equal((await bot.call("POST", `/api/topics/${a.id}/assign`, { entry: later?.id })).status, 200);
		assert.equal((await bot.call("POST", `/api/topics/${b.id}/assign`, { entry: later?.id })).status, 200);
		const [first, second] = bot.bots.topics();
		assert.deepEqual([first?.messages, second?.messages], [[], [later?.id]], "assigning it to Second took it out of First");

		await bot.call("POST", "/api/chat", { topic: b.id, text: "what about it?" });
		await until(() => bot.chat(`?topic=${b.id}`), (chat) => said(chat.items, "Heard: what about it?"));
		const asked = bot.prompts.find((prompt) => prompt.includes("what about it?"));
		assert.ok(asked?.includes("[topic] The owner put this message from your main chat in this topic. The owner wrote:\\nthe CMU waitlist"), "the copy reaches the topic's bot");

		assert.equal((await bot.call("POST", `/api/topics/${b.id}/assign`, { entry: 999_999 })).status, 404);
		assert.equal((await bot.call("POST", `/api/topics/${b.id}/close`)).status, 200);
		assert.equal((await bot.call("POST", `/api/topics/${b.id}/assign`, { entry: later?.id })).status, 400, "a closed topic takes no messages");
		assert.equal((await bot.call("POST", `/api/topics/${b.id}/reopen`)).status, 200);
		assert.equal(bot.bots.topics().find((t) => t.id === b.id)?.closed, undefined);
		// The bot was already answering the close; its late close is refused, so the reopened topic stays open.
		await until(async () => bot.bots, idle);
		assert.equal(bot.bots.topics().find((t) => t.id === b.id)?.closed, undefined, "the reopened topic stays open");
		assert.ok(!(await bot.chat()).items.some((item) => item.kind === "topic-closed"), "and no outcome line lands");
		assert.equal((await bot.call("POST", `/api/topics/${b.id}/close`)).status, 200);
		await until(async () => bot.bots.topics().find((t) => t.id === b.id)?.closed, (closed) => closed?.outcome !== undefined && closed.by === "owner");
	} finally {
		await bot.close();
	}
});
