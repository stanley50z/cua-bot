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
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { botMemories, type BotView, createBots, createBotsExtension, defaultAvatar, readBots } from "../src/bots.ts";
import type { ChatItem } from "../src/chat.ts";
import { bindRoutines, createRoutinesExtension, deleteRoutine, removeBotRoutines, type RoutineView, syncRoutines } from "../src/routines.ts";
import { createBotServer } from "../src/web.ts";

const context = BACKGROUND_CONTEXT;
const MODEL = { provider: "faux", modelId: "faux-1" };

const lastUserText = (messages: Message[]) => {
	const user = messages.findLast((m) => m.role === "user");
	return typeof user?.content === "string" ? user.content : (user?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "");
};

// The faux model answers by what it is asked, since two bots' requests can interleave in any order.
// Every request's full prompt is kept in `prompts`.
async function open() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const prompts: string[] = [];
	const answer = (context: { messages: Message[] }) => {
		prompts.push(JSON.stringify(context));
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("Asked Scout.")]);
		const text = lastUserText(context.messages);
		if (text.startsWith("[bot]")) return fauxAssistantMessage([fauxText("On it.")]);
		if (text === "ask scout") return fauxAssistantMessage([fauxToolCall("message_bot", { to: "scout", text: "Find flights to Tokyo." }, { id: "m1" })], { stopReason: "toolUse" });
		return fauxAssistantMessage([fauxText("Hello.")]);
	};
	faux.setResponses(Array.from({ length: 40 }, () => answer));
	const temp = await mkdtemp(join(tmpdir(), "cua-bot-bots-"));
	const dir = join(temp, "bots");
	const registry = createRegistry();
	registry.install(createBotsExtension({ agent: () => ({ model: MODEL }), dir }));
	registry.install(createRoutinesExtension());
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	const legacyFile = join(temp, "routines.json");
	await writeFile(legacyFile, JSON.stringify([{ id: "old", title: "Old agenda", prompt: "Brief me", cron: "@daily" }]));
	bindRoutines({ harness, root, dir, legacyFile });
	harness.resume();
	const bots = await createBots({
		harness,
		root,
		context,
		agent: { model: MODEL },
		dir,
		renamed: () => syncRoutines(context),
		removing: (id) => removeBotRoutines(id, context),
	});
	await syncRoutines(context);
	const server = createBotServer({ say: async (text) => text, bots, context });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		base: `http://127.0.0.1:${address.port}`,
		bots,
		harness,
		prompts,
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
	} finally {
		await bot.close();
	}
});

test("each bot has its own routines and routine file, which follow it through a rename and a delete", { timeout: 20_000 }, async () => {
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

		await send(bot.base, "PUT", `/api/bots/${scout.id}`, { name: "Travel", instructions: "" });
		assert.equal(existsSync(join(bot.dir, "scout", "routines.json")), false);
		assert.ok(existsSync(join(bot.dir, "travel", "routines.json")), "the file follows the rename");
		const listed = (await (await fetch(`${bot.base}/api/routines`)).json()).routines as RoutineView[];
		assert.deepEqual(listed.map((view) => [view.title, view.botName]).sort(), [
			["Fares", "Travel"],
			["Old agenda", "cua-bot"],
		]);

		assert.equal((await send(bot.base, "DELETE", `/api/bots/${scout.id}`)).status, 204);
		assert.equal(existsSync(join(bot.dir, "travel", "routines.json")), false, "a deleted bot's routines go with it");
		const task = (await bot.harness.inspect(context)).tasks.filter((t) => t.record.kind === "cua-bot.routine");
		assert.equal(task.length, 1, "only the main bot's sleeper is left");
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
	} finally {
		await bot.close();
	}
});

test("each bot's folder holds its agent file and memory, and follows it through hand edits, a rename, and a delete", { timeout: 20_000 }, async () => {
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

		const memories = botMemories(bot.dir);
		await memories.of(scout).remember("Prefers window seats", "profile");
		assert.ok(existsSync(join(bot.dir, "scout", "memory", "profile.md")));

		await mkdir(join(bot.dir, "taken"));
		assert.equal((await send(bot.base, "PUT", `/api/bots/${scout.id}`, { name: "Taken", instructions: "" })).status, 400, "a rename never lands on a folder already there");
		await send(bot.base, "PUT", `/api/bots/${scout.id}`, { name: "Travel", instructions: "Plan trips." });
		assert.equal(existsSync(join(bot.dir, "scout")), false);
		assert.equal(await readFile(join(bot.dir, "travel", "agent.md"), "utf8"), "Plan trips.\n", "the folder follows the rename");
		const travel = { id: scout.id, name: "Travel" };
		assert.deepEqual(
			(await memories.of(travel).all()).profile.map((fact) => fact.text),
			["Prefers window seats"],
			"with the bot's memory",
		);

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
