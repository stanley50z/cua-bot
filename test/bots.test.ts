// Several bots and messages between them: message_bot lands in the other bot's chat as "Message from
// <name>" and wakes it, each bot's prompt names it and its teammates, and /api/bots adds, edits, and
// deletes bots. Run from the repo root:  node --test test/bots.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type AgentChange, type ConversationId, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { botLookup, type BotView, createBots, createBotsExtension, defaultAvatar, readBots } from "../src/bots.ts";
import { type ChatItem, SEND_MESSAGE } from "../src/chat.ts";
import { createMemory } from "../src/memory.ts";
import { createModelSettings } from "../src/model-settings.ts";
import { bindRoutines, createRoutinesExtension, deleteRoutine, type RoutineView, syncRoutines } from "../src/routines.ts";
import { createTurns } from "../src/turns.ts";
import { createBotServer } from "../src/web.ts";

const context = BACKGROUND_CONTEXT;
const MODEL = { provider: "faux", modelId: "faux-1" };

const lastUserText = (messages: Message[]) => {
	const user = messages.findLast((m) => m.role === "user");
	return typeof user?.content === "string" ? user.content : (user?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "");
};

const sendOwner = (text: string) => fauxAssistantMessage([fauxToolCall(SEND_MESSAGE, { text })], { stopReason: "toolUse" });

// The faux model answers by what it is asked, since two bots' requests can interleave in any order.
// Every request's full prompt is kept in `prompts`.
async function open() {
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const prompts: string[] = [];
	const replies: [string, string][] = [];
	const answer = (context: { messages: Message[] }) => {
		prompts.push(JSON.stringify(context));
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return last.toolName === SEND_MESSAGE ? fauxAssistantMessage([fauxText("Done.")]) : sendOwner("Asked Scout.");
		const text = lastUserText(context.messages);
		if (text.startsWith("[bot]")) return sendOwner("On it.");
		if (text === "ask scout") return fauxAssistantMessage([fauxToolCall("message_bot", { to: "scout", text: "Find flights to Tokyo." }, { id: "m1" })], { stopReason: "toolUse" });
		return fauxAssistantMessage([fauxText("Hello.")]);
	};
	faux.setResponses(Array.from({ length: 40 }, () => answer));
	const temp = await mkdtemp(join(tmpdir(), "cua-bot-bots-"));
	const dir = join(temp, "bots");
	const registry = createRegistry();
	const turns = createTurns(async () => undefined);
	registry.install(createBotsExtension({ agent: () => ({ model: MODEL }), turns, dir }));
	registry.install(createRoutinesExtension());
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	const legacyFile = join(temp, "routines.json");
	await writeFile(legacyFile, JSON.stringify([{ id: "old", title: "Old agenda", prompt: "Brief me", cron: "@daily" }]));
	// The order main.ts starts in: routines bound to the bots, work resumed, the bots, then the first routine sync.
	const memory = createMemory({ dir: join(temp, "memory"), botsDir: dir });
	const syncErrors: unknown[] = [];
	const lookup = botLookup(harness, root, dir);
	bindRoutines({ harness, bots: lookup, turns, legacyFile, onError: (error) => syncErrors.push(error) });
	harness.resume();
	const agent: AgentChange = { model: MODEL };
	const bots = await createBots({ harness, lookup, context, agent: () => agent, memory, onError: (error) => syncErrors.push(error), sent: (bot, text) => replies.push([bot.name, text]), turns });
	await syncRoutines(context);
	const modelSettings = createModelSettings({ models, apply: bots.applyAgent, envFile: join(temp, ".env") });
	const server = createBotServer({ say: async (text) => text, bots, context, modelSettings });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		base: `http://127.0.0.1:${address.port}`,
		agent,
		bots,
		harness,
		root,
		lookup,
		memory,
		syncErrors,
		prompts,
		replies,
		dir,
		legacyFile,
		async close() {
			await bots.close();
			await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
			await harness.close(context);
			await rm(temp, { recursive: true, force: true });
		},
	};
}

const send = (base: string, method: string, path: string, body?: unknown) =>
	fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		assert.ok(Date.now() < deadline, `timed out; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test("applyAgent moves every bot to the current settings, and a new bot starts on them", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		await send(bot.base, "POST", "/api/bots", { name: "Scout", instructions: "" });
		Object.assign(bot.agent, { thinkingLevel: "high" });
		await bot.bots.applyAgent();
		await send(bot.base, "POST", "/api/bots", { name: "Later", instructions: "" });
		const levels = await Promise.all(
			(await until(async () => bot.bots.list(), (list) => list.length === 3)).map(async ({ id }) => (await (await bot.harness.conversation(id as ConversationId, context))?.agent(context))?.thinkingLevel),
		);
		assert.deepEqual(levels, ["high", "high", "high"]);
	} finally {
		await bot.close();
	}
});

test("a bot's own model and effort override the default, survive a default change, and clear with null", { timeout: 20_000 }, async () => {
	const bot = await open();
	const running = async (id: number) => {
		const agent = await (await bot.harness.conversation(id as ConversationId, context))?.agent(context);
		return [agent?.model?.modelId, agent?.thinkingLevel];
	};
	const edit = (id: number, body: object) => send(bot.base, "PUT", `/api/bots/${id}`, { name: "Dev", instructions: "", ...body });
	try {
		const made = await send(bot.base, "POST", "/api/bots", { name: "Dev", instructions: "", model: "faux/faux-2", thinkingLevel: "high" });
		assert.equal(made.status, 201);
		const { id } = (await made.json()) as BotView;
		assert.deepEqual(await running(id), ["faux-2", "high"]);

		Object.assign(bot.agent, { thinkingLevel: "low" });
		await bot.bots.applyAgent();
		assert.deepEqual(await running(id), ["faux-2", "high"], "a new default leaves the override alone");
		assert.equal((await until(async () => bot.bots.list(), (list) => list.length === 2)).find((b) => b.id === id)?.activeModel, "faux-2");

		assert.equal((await edit(id, {})).status, 200);
		assert.deepEqual(await running(id), ["faux-2", "high"], "an edit that doesn't name them keeps them");
		assert.equal((await edit(id, { thinkingLevel: "extreme" })).status, 400);
		assert.equal((await edit(id, { model: "not-a-ref" })).status, 400);
		assert.equal((await edit(id, { model: "nope/x" })).status, 400, "no key or sign-in");

		assert.equal((await edit(id, { model: null, thinkingLevel: null })).status, 200);
		assert.deepEqual(await running(id), ["faux-1", "low"], "null follows the default again");
		assert.equal(bot.bots.list().find((b) => b.id === id)?.activeModel, "faux-1");
	} finally {
		await bot.close();
	}
});

test("a bot's message lands in the other bot's chat and wakes it", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const created = await send(bot.base, "POST", "/api/bots", { name: "Scout", instructions: "Research travel.\nKeep it short." });
		assert.equal(created.status, 201);
		const scout = (await created.json()) as BotView;
		const listed = await until(
			async () => (await (await fetch(`${bot.base}/api/bots`)).json()).bots as BotView[],
			(list) => list.length === 2,
		);
		assert.deepEqual(
			listed.map((b) => [b.name, b.main]),
			[
				["cua-bot", true],
				["Scout", false],
			],
		);

		assert.equal((await send(bot.base, "POST", "/api/chat", { text: "ask scout" })).status, 202);
		const scoutChat = async () => (await (await fetch(`${bot.base}/api/chat?bot=${scout.id}`)).json()).items as ChatItem[];
		const items = await until(scoutChat, (list) => list.some((item) => item.kind === "assistant" && item.text === "On it."));
		const message = items.find((item) => item.kind === "bot");
		assert.deepEqual(message?.kind === "bot" && [message.name, message.text], ["cua-bot", "Find flights to Tokyo."]);

		const mainChat = (await (await fetch(`${bot.base}/api/chat`)).json()).items as ChatItem[];
		const result = mainChat.find((item) => item.kind === "tool");
		assert.match(result?.kind === "tool" ? result.text : "", /^Sent to Scout\./);
		assert.ok(!mainChat.some((item) => item.kind === "bot"), "the sender's chat has no incoming message");

		const scoutPrompt = bot.prompts.find((prompt) => prompt.includes("[bot] Message from cua-bot"));
		assert.ok(scoutPrompt?.includes("Your name is Scout."), "Scout's prompt names it");
		assert.ok(scoutPrompt?.includes("Research travel."), "and carries its instructions");
		assert.ok(scoutPrompt?.includes("cua-bot (id"), "and lists the main bot as a teammate");

		const preview = await until(
			async () => bot.bots.list().find((b) => b.id === scout.id),
			(view) => view?.preview?.text === "On it." && !view.busy,
		);
		assert.equal(preview?.name, "Scout");
		// The message from cua-bot stays out of the owner's preview, so the list can hide bot talk.
		assert.equal(preview?.botPreview?.text, "cua-bot: Find flights to Tokyo.");

		// What each bot sent with send_message is reported for a push; its private "Done." is not.
		await until(async () => bot.replies.length, (n) => n >= 2);
		assert.deepEqual(bot.replies.toSorted(), [
			["Scout", "On it."],
			["cua-bot", "Asked Scout."],
		]);
	} finally {
		await bot.close();
	}
});

test("the lookup turns a bot id into its conversation, and no id into the main bot's", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const scout = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout" })).json()) as BotView;
		const { lookup } = bot;
		assert.equal((await lookup.conversation(undefined, context))?.id, bot.root.id);
		assert.equal(Number((await lookup.conversation(scout.id, context))?.id), scout.id);
		assert.equal(await lookup.conversation(9999, context), undefined, "no conversation has that id");
	} finally {
		await bot.close();
	}
});

test("each bot has its own routines and routine file, and they fire in its own chat", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		assert.equal(existsSync(bot.legacyFile), false, "the old routines.json moved");
		const mainFile = join(bot.dir, "cua-bot", "routines.json");
		assert.deepEqual(
			JSON.parse(await readFile(mainFile, "utf8")).map((def: { id: string }) => def.id),
			["old"],
		);
		const scout = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout" })).json()) as BotView;
		assert.equal(existsSync(join(bot.dir, "scout", "routines.json")), false, "a bot without routines has no file");

		const added = await send(bot.base, "POST", "/api/routines", { title: "Fares", prompt: "Check fares to Tokyo", cron: "@daily", bot: scout.id });
		assert.equal(added.status, 201);
		const routine = (await added.json()) as RoutineView;
		assert.deepEqual([routine.bot, routine.botName], [scout.id, "Scout"]);
		assert.deepEqual(
			JSON.parse(await readFile(join(bot.dir, "scout", "routines.json"), "utf8")).map((def: { title: string }) => def.title),
			["Fares"],
		);
		await assert.rejects(deleteRoutine(routine.id, context, bot.bots.main()), /No routine/, "another bot's tools can't touch it");

		assert.equal((await send(bot.base, "POST", `/api/routines/${routine.id}/run`)).status, 200);
		const scoutChat = async () => (await (await fetch(`${bot.base}/api/chat?bot=${scout.id}`)).json()).items as ChatItem[];
		await until(scoutChat, (items) => items.some((item) => item.kind === "routine" && item.text.includes('"Fares"')));
		const mainChat = (await (await fetch(`${bot.base}/api/chat`)).json()).items as ChatItem[];
		assert.ok(!mainChat.some((item) => item.kind === "routine"), "it fires in Scout's chat only");
	} finally {
		await bot.close();
	}
});

const routineTasks = async (harness: Harness) => (await harness.inspect(context)).tasks.filter((task) => task.record.kind === "cua-bot.routine" && task.record.state.status !== "terminal");

test("renaming a bot moves its folder with its routine, which keeps firing in its chat, and moves its memory tag", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const scout = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout" })).json()) as BotView;
		await writeFile(join(bot.dir, "scout", "work-log.md"), "- (2026-11-10) checked fares\n");
		await bot.memory.remember("Prefers window seats", "profile", ["@scout"]);
		const routine = (await (await send(bot.base, "POST", "/api/routines", { title: "Fares", prompt: "Check fares", cron: "@every 1s", bot: scout.id })).json()) as RoutineView;
		const before = (await routineTasks(bot.harness)).map((task) => task.record.id);

		assert.equal((await send(bot.base, "PUT", `/api/bots/${scout.id}`, { name: "Travel", instructions: "" })).status, 200);
		const renamedAt = Date.now();
		assert.equal(existsSync(join(bot.dir, "scout")), false, "the old folder is gone");
		assert.deepEqual(
			JSON.parse(await readFile(join(bot.dir, "travel", "routines.json"), "utf8")).map((def: { id: string }) => def.id),
			[routine.id],
			"the routine file moved with the folder",
		);
		assert.equal(await readFile(join(bot.dir, "travel", "work-log.md"), "utf8"), "- (2026-11-10) checked fares\n", "so did the work log");
		assert.deepEqual((await bot.memory.all()).profile.map((fact) => [fact.text, fact.tags]), [["Prefers window seats", ["@travel"]]], "the fact moved to the new tag");

		assert.deepEqual((await routineTasks(bot.harness)).map((task) => task.record.id), before, "the same sleepers run");
		await until(
			async () => (await (await fetch(`${bot.base}/api/chat?bot=${scout.id}`)).json()).items as ChatItem[],
			(items) => items.some((item) => item.kind === "routine" && item.at > renamedAt && item.text.includes('"Fares"')),
		);
		const listed = (await (await fetch(`${bot.base}/api/routines`)).json()).routines as RoutineView[];
		assert.deepEqual(listed.find((view) => view.id === routine.id)?.botName, "Travel");
		assert.deepEqual(bot.syncErrors, []);
	} finally {
		await bot.close();
	}
});

test("a rename resyncs the bot's routines, so a routines.json deleted by hand comes back in the new folder", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const scout = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout" })).json()) as BotView;
		const routine = (await (await send(bot.base, "POST", "/api/routines", { title: "Fares", prompt: "Check fares", cron: "@daily", bot: scout.id })).json()) as RoutineView;
		await bot.bots.close(); // no watch, so only the rename can sync
		await rm(join(bot.dir, "scout", "routines.json"));
		await bot.bots.update(scout.id, { name: "Travel", instructions: "" });
		assert.deepEqual(
			JSON.parse(await readFile(join(bot.dir, "travel", "routines.json"), "utf8")).map((def: { id: string }) => def.id),
			[routine.id],
			"adopted from what runs",
		);
	} finally {
		await bot.close();
	}
});

test("deleting a bot cancels its routines, takes its tag off its facts and the owner's tags, and deletes its folder", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const scout = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout" })).json()) as BotView;
		await bot.memory.remember("Prefers window seats", "profile", ["@scout", "every-bot"]);
		await bot.memory.createTag("Travel bots", [scout.id, bot.bots.main()]);
		await send(bot.base, "POST", "/api/routines", { title: "Fares", prompt: "Check fares", cron: "@daily", bot: scout.id });
		assert.equal((await routineTasks(bot.harness)).length, 2, "the main bot's routine and Scout's");

		assert.equal((await send(bot.base, "DELETE", `/api/bots/${scout.id}`)).status, 204);
		const left = await routineTasks(bot.harness);
		assert.deepEqual(left.map((task) => Number(task.record.conversationId)), [bot.bots.main()], "only the main bot's sleeper is left");
		assert.equal(existsSync(join(bot.dir, "scout")), false, "the folder and its routine file are gone");
		assert.deepEqual((await bot.memory.all()).profile.map((fact) => [fact.text, fact.tags]), [["Prefers window seats", ["every-bot"]]]);
		assert.deepEqual((await bot.memory.tagViews(bot.bots.list())).find((tag) => tag.slug === "travel-bots")?.bots, [bot.bots.main()]);
		const listed = (await (await fetch(`${bot.base}/api/routines`)).json()).routines as RoutineView[];
		assert.deepEqual(listed.map((view) => view.botName), ["cua-bot"]);
	} finally {
		await bot.close();
	}
});

test("a hand edit to a bot's routines.json is synced into running routines", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const scout = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout" })).json()) as BotView;
		await writeFile(join(bot.dir, "scout", "routines.json"), JSON.stringify([{ id: "by-hand", title: "Visa check", prompt: "Check the visa rules", cron: "@daily" }]));
		const listed = await until(
			async () => (await (await fetch(`${bot.base}/api/routines`)).json()).routines as RoutineView[],
			(views) => views.some((view) => view.id === "by-hand"),
		);
		assert.deepEqual(listed.find((view) => view.id === "by-hand")?.botName, "Scout");
		assert.equal((await routineTasks(bot.harness)).filter((task) => Number(task.record.conversationId) === scout.id).length, 1, "it has a sleeper in Scout's conversation");
		assert.deepEqual(bot.syncErrors, []);
	} finally {
		await bot.close();
	}
});

test("bots are added, renamed, and deleted over HTTP; the main bot stays", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const scout = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout" })).json()) as BotView;
		assert.equal((await send(bot.base, "POST", "/api/bots", { name: "scout" })).status, 400, "names are unique, ignoring case");
		assert.equal((await send(bot.base, "POST", "/api/bots", { name: "  " })).status, 400);
		const renamed = await send(bot.base, "PUT", `/api/bots/${scout.id}`, { name: "Travel", instructions: "Plan trips." });
		assert.equal(renamed.status, 200);
		assert.deepEqual(
			bot.bots.list().map((b) => b.name),
			["cua-bot", "Travel"],
		);
		const main = bot.bots.main();
		assert.equal((await send(bot.base, "DELETE", `/api/bots/${main}`)).status, 400);
		assert.equal((await send(bot.base, "DELETE", `/api/bots/${scout.id}`)).status, 204);
		assert.deepEqual(
			bot.bots.list().map((b) => b.name),
			["cua-bot"],
		);
		assert.equal((await fetch(`${bot.base}/api/chat?bot=${scout.id}`)).status, 404);
		assert.equal((await send(bot.base, "PUT", `/api/bots/${scout.id}`, { name: "Gone" })).status, 404);
		assert.equal((await send(bot.base, "DELETE", `/api/bots/${scout.id}`)).status, 404, "a bot is deleted once");
	} finally {
		await bot.close();
	}
});

test("each bot's folder holds its agent file and follows it through hand edits, a rename, and a delete", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		assert.equal(await readFile(join(bot.dir, "cua-bot", "agent.md"), "utf8"), "", "the main bot gets an empty agent file");
		const scout = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout", instructions: "# Scout\nResearch travel." })).json()) as BotView;
		assert.deepEqual([scout.folder, scout.file], ["bots/scout", "bots/scout/agent.md"]);
		assert.equal(await readFile(join(bot.dir, "scout", "agent.md"), "utf8"), "# Scout\nResearch travel.\n");

		await writeFile(join(bot.dir, "scout", "agent.md"), "# Scout\nBook trains, not flights.\n");
		await until(
			async () => bot.bots.list().find((b) => b.id === scout.id)?.instructions,
			(text) => text === "# Scout\nBook trains, not flights.",
		);
		assert.equal((await send(bot.base, "POST", "/api/chat", { text: "ask scout" })).status, 202);
		const scoutPrompt = await until(
			async () => bot.prompts.find((prompt) => prompt.includes("[bot] Message from cua-bot")),
			(prompt) => prompt !== undefined,
		);
		assert.ok(scoutPrompt?.includes("Book trains, not flights."), "the prompt carries the hand edit");
		const mainPrompt = bot.prompts.find((prompt) => prompt.includes("ask scout")) ?? "";
		assert.ok(mainPrompt.includes(`Scout (id ${scout.id}): Book trains`), "teammates are described by their first line that isn't a heading");

		await mkdir(join(bot.dir, "taken"));
		assert.equal((await send(bot.base, "PUT", `/api/bots/${scout.id}`, { name: "Taken", instructions: "" })).status, 400, "a rename never lands on a folder already there");
		await send(bot.base, "PUT", `/api/bots/${scout.id}`, { name: "Travel", instructions: "Plan trips." });
		assert.equal(existsSync(join(bot.dir, "scout")), false);
		assert.equal(await readFile(join(bot.dir, "travel", "agent.md"), "utf8"), "Plan trips.\n", "the folder follows the rename");

		assert.equal((await send(bot.base, "DELETE", `/api/bots/${scout.id}`)).status, 204);
		assert.equal(existsSync(join(bot.dir, "travel")), false, "a deleted bot's folder goes with it");
	} finally {
		await bot.close();
	}
});

test("each bot has an avatar: a default from its id until the owner picks one, validated and kept in the bot list", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const listed = async () => (await (await fetch(`${bot.base}/api/bots`)).json()).bots as BotView[];
		const [main] = await listed();
		assert.deepEqual(main?.avatar, defaultAvatar(bot.bots.main(), true));
		assert.equal(main?.avatar.color, "black", "the main bot is black by default");
		for (let id = 0; id < 40; id++) {
			assert.deepEqual(defaultAvatar(id, false), defaultAvatar(id, false), "the default never changes between reloads");
			assert.notEqual(defaultAvatar(id, false).color, "black", "black stays the main bot's");
		}

		const plain = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout" })).json()) as BotView;
		assert.deepEqual(plain.avatar, defaultAvatar(plain.id, false), "a bot made without one gets the default");
		assert.deepEqual(plain.defaultAvatar, plain.avatar);

		const picked = await send(bot.base, "POST", "/api/bots", { name: "Travel", avatar: { shape: "cloud", color: "green" } });
		assert.equal(picked.status, 201);
		const travel = (await picked.json()) as BotView;
		assert.deepEqual(travel.avatar, { shape: "cloud", color: "green" });

		const badShape = await send(bot.base, "POST", "/api/bots", { name: "Odd", avatar: { shape: "<svg>", color: "green" } });
		assert.equal(badShape.status, 400);
		assert.match((await badShape.json()).error, /No avatar shape is named <svg>/);
		assert.equal((await send(bot.base, "PUT", `/api/bots/${travel.id}`, { name: "Travel", avatar: { shape: "cloud", color: "#00ff00" } })).status, 400);
		assert.equal((await send(bot.base, "PUT", `/api/bots/${travel.id}`, { name: "Travel", avatar: "cloud" })).status, 400);
		assert.ok(!(await listed()).some((b) => b.name === "Odd"), "a bad avatar adds no bot");

		assert.equal((await send(bot.base, "PUT", `/api/bots/${travel.id}`, { name: "Travel", avatar: { shape: "pumpkin", color: "orange" } })).status, 200);
		assert.deepEqual(
			(await readBots(bot.harness, context)).find((b) => b.id === travel.id)?.avatar,
			{ shape: "pumpkin", color: "orange" },
			"the pick is saved in the bot list doc",
		);
		await send(bot.base, "PUT", `/api/bots/${travel.id}`, { name: "Trips", instructions: "Plan trips." });
		assert.deepEqual((await listed()).find((b) => b.id === travel.id)?.avatar, { shape: "pumpkin", color: "orange" }, "an edit without an avatar keeps it");

		const reset = await send(bot.base, "PUT", `/api/bots/${travel.id}`, { name: "Trips", avatar: null });
		assert.deepEqual(((await reset.json()) as BotView).avatar, defaultAvatar(travel.id, false), "null goes back to the default");
		assert.deepEqual((await listed()).find((b) => b.id === travel.id)?.avatar, defaultAvatar(travel.id, false));
	} finally {
		await bot.close();
	}
});

test("the owner pins and unpins bots, the main bot too; a pin survives a rename", { timeout: 20_000 }, async () => {
	const bot = await open();
	try {
		const pinned = () => bot.bots.list().filter((b) => b.pinnedAt !== undefined).sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0)).map((b) => b.name);
		const scout = (await (await send(bot.base, "POST", "/api/bots", { name: "Scout" })).json()) as BotView;
		assert.deepEqual(pinned(), [], "bots start unpinned");
		assert.equal((await send(bot.base, "PUT", `/api/bots/${scout.id}/pin`, { pinned: true })).status, 204);
		assert.equal((await send(bot.base, "PUT", `/api/bots/${bot.bots.main()}/pin`, { pinned: true })).status, 204);
		assert.deepEqual(pinned(), ["Scout", "cua-bot"], "pins keep the order they were made in");
		assert.equal((await send(bot.base, "PUT", `/api/bots/${scout.id}/pin`, { pinned: true })).status, 204);
		assert.deepEqual(pinned(), ["Scout", "cua-bot"], "pinning again keeps the place");

		await send(bot.base, "PUT", `/api/bots/${scout.id}`, { name: "Travel" });
		assert.deepEqual(pinned(), ["Travel", "cua-bot"]);

		assert.equal((await send(bot.base, "PUT", `/api/bots/${scout.id}/pin`, { pinned: false })).status, 204);
		assert.deepEqual(pinned(), ["cua-bot"]);
		assert.equal((await send(bot.base, "PUT", `/api/bots/${scout.id}/pin`, { pinned: "yes" })).status, 400);
		assert.equal((await send(bot.base, "PUT", "/api/bots/9999/pin", { pinned: true })).status, 404);
	} finally {
		await bot.close();
	}
});
