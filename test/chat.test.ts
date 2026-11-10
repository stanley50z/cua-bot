// The web chat API: POST /api/chat (with pasted images, served back by /api/chat/image), the /api/chat/events stream, GET /api/chat history paging,
// emoji reactions, stop, and /shots/ file serving. Exercised over real HTTP against createBotServer with a faux model.
// A reply shows only what the bot sent with send_message; its own text stays private.
// Run from the repo root:  node --test test/chat.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseFactory, type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineExtension, defineTool, type Extension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { botLookup, createBots, createBotsExtension } from "../src/bots.ts";
import { BOT_MESSAGE, type ChatEvent, type ChatItem, REACTION, reactionText, SEND_MESSAGE, toChatItem, toChatLive } from "../src/chat.ts";
import { createMemory, messageNote } from "../src/memory.ts";
import { createPcExtensions } from "../src/pc.ts";
import { createScreenControl, type ScreenControl } from "../src/screen-control.ts";
import { createBotServer } from "../src/web.ts";

const context = BACKGROUND_CONTEXT;

const lookTool = defineTool({
	name: "look",
	description: "Take a screenshot.",
	parameters: Type.Object({}),
	execute: async () => ({ output: [{ type: "text" as const, text: "Saw the desktop. Screenshot: data/shots/2026-10-31T10-00-00.png" }] }),
});

const MODEL = { provider: "faux", modelId: "faux-1" };
// The bot tells the owner something, and the turn ends with private notes the chat never shows.
const send = (text: string) => fauxAssistantMessage([fauxToolCall(SEND_MESSAGE, { text })], { stopReason: "toolUse" });
const end = fauxAssistantMessage([fauxText("Told the owner.")]);

const SCRIPT: FauxResponseStep[] = [
	send("Hello there."),
	end,
	fauxAssistantMessage([fauxToolCall("look", {}, { id: "call-1" })], { stopReason: "toolUse" }),
	send("Your desktop is tidy."),
	end,
];

async function open(responses = SCRIPT, images?: ImageProcessor, memoryNote?: (bot: number, message: string) => Promise<string | undefined>, options: { extensions?: Extension[]; sent?: (text: string) => void; control?: ScreenControl } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-chat-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test", tools: [lookTool] }));
	for (const extension of options.extensions ?? []) registry.install(extension);
	registry.install(createBotsExtension({ agent: () => ({ model: MODEL }), dir: join(dir, "bots") }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	harness.resume();
	const bots = await createBots({ harness, lookup: botLookup(harness, root, join(dir, "bots")), context, agent: () => ({ model: MODEL }), memory: createMemory({ dir: join(dir, "memory") }), onError: (error) => assert.fail(String(error)), ...(memoryNote === undefined ? {} : { memoryNote }), sent: (_bot, text) => options.sent?.(text) });
	const server = createBotServer({ say: async (text) => text, bots, context, shotsDir: dir, ...(images === undefined ? {} : { images }), ...(options.control === undefined ? {} : { control: options.control }) });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	return {
		dir,
		base,
		faux,
		harness,
		root,
		bots,
		async close() {
			await bots.close();
			await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
			await harness.close(context);
			await rm(dir, { recursive: true, force: true });
		},
	};
}

// Collects SSE events from /api/chat/events until `done` returns true for the collected list.
async function collect(base: string, done: (events: ChatEvent[]) => boolean, action: () => Promise<void>) {
	const abort = new AbortController();
	const response = await fetch(`${base}/api/chat/events`, { signal: abort.signal });
	assert.equal(response.headers.get("content-type"), "text/event-stream");
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	const events: ChatEvent[] = [];
	let buffer = "";
	let acted = false;
	const deadline = Date.now() + 10_000;
	while (!done(events)) {
		assert.ok(Date.now() < deadline, `timed out; got ${JSON.stringify(events)}`);
		const { value, done: ended } = await reader.read();
		assert.ok(!ended, "stream ended early");
		buffer += value;
		let split: number;
		while ((split = buffer.indexOf("\n\n")) >= 0) {
			const frame = buffer.slice(0, split);
			buffer = buffer.slice(split + 2);
			if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as ChatEvent);
		}
		if (!acted && events.length > 0) {
			acted = true;
			await action();
		}
	}
	abort.abort();
	return events;
}

test("the event stream says when a task runs on the live screen, and a failed task stops counting", { timeout: 30_000 }, async () => {
	const control = createScreenControl();
	const bot = await open(SCRIPT, undefined, undefined, { control });
	const driving = (events: unknown[]) => (events as { type: string; driving?: boolean }[]).filter((event) => event.type === "control").map((event) => event.driving);
	try {
		const events = await collect(bot.base, (seen) => driving(seen).length === 3, async () => {
			await assert.rejects(control.drive(async () => { throw new Error("task failed"); }), /task failed/);
		});
		assert.deepEqual(driving(events), [false, true, false]);
		assert.equal(control.driving, false);
	} finally {
		await bot.close();
	}
});

test("send_message called from a codemode script shows in the chat once, notifies the owner, and takes reactions", { timeout: 60_000 }, async () => {
	const pushed: string[] = [];
	const code = `try { await tools.send_message({ text: "   " }); } catch {} await tools.send_message({ text: "From a script." });`;
	const bot = await open([fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "c1" })], { stopReason: "toolUse" }), end, end], undefined, undefined, {
		extensions: createPcExtensions(),
		sent: (text) => pushed.push(text),
	});
	const history = async () => (await (await fetch(`${bot.base}/api/chat`)).json()).items as ChatItem[];
	try {
		await post(bot.base, "/api/chat", { text: "send from a script" });
		const deadline = Date.now() + 30_000;
		while (bot.faux.state.callCount < 2 || !(await history()).some((item) => item.kind === "tool" && item.name === "codemode")) {
			assert.ok(Date.now() < deadline, "timed out waiting for the script to finish");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const chat = await history();
		const sent = chat.filter((item) => item.kind === "assistant" && item.text !== "");
		assert.deepEqual(sent.map((item) => item.kind === "assistant" && item.text), ["From a script."]);
		assert.ok(chat.some((item) => item.kind === "tool" && item.name === "codemode"), "the script still shows as a tool");
		assert.deepEqual(pushed, ["From a script."]);
		assert.equal((await post(bot.base, "/api/chat/react", { entryId: sent[0]?.id, emoji: "👍", on: true })).status, 202);
	} finally {
		await bot.close();
	}
});

test("an owner message that matches memory reaches the bot with the search result just before it, and the chat doesn't show the result", async () => {
	const store = await mkdtemp(join(tmpdir(), "cua-bot-chat-memory-"));
	const memory = createMemory({ dir: store });
	await memory.remember("Plumber comes Tuesday", "log", ["every-bot"]);
	// Thirty newer log facts fill the bot's memory section, so the plumber is left to the search.
	for (let i = 1; i <= 30; i++) await memory.remember(`Newer event ${i}`, "log", ["every-bot"]);
	const requests: string[][] = [];
	const record = (step: FauxResponseStep): FauxResponseFactory => (request, ...rest) => {
		requests.push(request.messages.flatMap((message) => (message.role === "user" && typeof message.content === "string" ? [message.content] : [])));
		return typeof step === "function" ? step(request, ...rest) : step;
	};
	const bot = await open([record(send("Tuesday.")), record(end), record(send("Hello.")), record(end)], undefined, (id, message) => messageNote(memory, message, id, [{ id, name: "cua-bot" }]));
	try {
		const events = await collect(bot.base, settled(["user", "assistant"]), async () => {
			await post(bot.base, "/api/chat", { text: "when is the plumber coming" });
		});
		assert.deepEqual(items(events).map((item) => item.kind), ["user", "assistant"]);
		assert.equal(requests[0]?.length, 2);
		assert.match(requests[0]?.[0] ?? "", /^\[search_memory\] .*\(plumber\):\n- \(\d{4}-\d{2}-\d{2}\) Plumber comes Tuesday \[every-bot\] \(log\)$/);
		assert.equal(requests[0]?.[1], "when is the plumber coming");

		await collect(bot.base, settled(["user", "assistant"]), async () => {
			await post(bot.base, "/api/chat", { text: "hi" });
		});
		assert.deepEqual(requests[2]?.slice(1), ["when is the plumber coming", "hi"], "a message that finds nothing adds no note");
		const history = (await (await fetch(`${bot.base}/api/chat`)).json()).items as ChatItem[];
		assert.ok(!JSON.stringify(history).includes("search_memory"), "the chat never shows the note");
	} finally {
		await bot.close();
		await rm(store, { recursive: true, force: true });
	}
});

const items = (events: ChatEvent[]) => events.flatMap((event) => (event.type === "items" ? event.items : []));
const settled = (kinds: ChatItem["kind"][]) => (events: ChatEvent[]) => {
	const last = events.at(-1);
	return items(events).map((item) => item.kind).join() === kinds.join() && last?.type === "live" && !last.live.busy;
};

const post = (base: string, path: string, body?: unknown) =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

test("a sent message streams back as user and assistant items, then history pages them", async () => {
	const bot = await open();
	try {
		const empty = await (await fetch(`${bot.base}/api/chat`)).json();
		assert.deepEqual(empty.items, []);
		assert.equal(empty.before, null);

		const events = await collect(bot.base, settled(["user", "assistant"]), async () => {
			const response = await post(bot.base, "/api/chat", { text: "hi" });
			assert.equal(response.status, 202);
		});
		assert.equal(events[0]?.type, "live");
		assert.ok(events.some((event) => event.type === "live" && event.live.busy), "saw the bot busy");
		const [user, reply] = items(events);
		assert.equal(user?.kind === "user" && user.text, "hi");
		assert.equal(reply?.kind === "assistant" && reply.text, "Hello there.");

		const events2 = await collect(bot.base, settled(["user", "assistant", "tool", "assistant"]), async () => {
			await post(bot.base, "/api/chat", { text: "look at my screen" });
		});
		const [, call, result, final] = items(events2);
		assert.deepEqual(call?.kind === "assistant" && call.tools.map((tool) => tool.name), ["look"]);
		assert.ok(result?.kind === "tool");
		assert.equal(result.name, "look");
		assert.deepEqual(result.shots, ["2026-10-31T10-00-00.png"]);
		assert.equal(final?.kind === "assistant" && final.text, "Your desktop is tidy.");

		// The newest five entries: hidden notes, send_message's hidden result, the sent reply, look's result, and its call.
		const page1 = await (await fetch(`${bot.base}/api/chat?limit=5`)).json();
		assert.deepEqual(
			page1.items.map((item: ChatItem) => item.kind),
			["assistant", "tool", "assistant"],
			"newest page, oldest first",
		);
		assert.equal(typeof page1.before, "string");
		const page2 = await (await fetch(`${bot.base}/api/chat?limit=50&before=${page1.before}`)).json();
		assert.deepEqual(
			page2.items.map((item: ChatItem) => (item.kind === "user" || item.kind === "assistant" ? item.text : item.kind)),
			["hi", "Hello there.", "look at my screen"],
		);
	} finally {
		await bot.close();
	}
});

test("bad chat input is rejected without reaching the bot", async () => {
	const bot = await open();
	try {
		assert.equal((await post(bot.base, "/api/chat", { text: "  " })).status, 400);
		assert.equal((await post(bot.base, "/api/chat", { message: "hi" })).status, 400);
		assert.equal((await fetch(`${bot.base}/api/chat?before=not-a-cursor`)).status, 400);
		assert.equal((await post(bot.base, "/api/chat/stop")).status, 204);
		assert.deepEqual((await (await fetch(`${bot.base}/api/chat`)).json()).items, []);
	} finally {
		await bot.close();
	}
});

test("screenshots are served by name only", async () => {
	const bot = await open();
	try {
		await writeFile(join(bot.dir, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const shot = await fetch(`${bot.base}/shots/a.png`);
		assert.equal(shot.status, 200);
		assert.equal(shot.headers.get("content-type"), "image/png");
		assert.equal((await fetch(`${bot.base}/shots/missing.png`)).status, 404);
		assert.equal((await fetch(`${bot.base}/shots/..%2Fsecret.png`)).status, 404);
		assert.equal((await fetch(`${bot.base}/shots/a.txt`)).status, 404);
	} finally {
		await bot.close();
	}
});

test("routine firings and context markers are labeled for the chat", () => {
	const base = { conversationId: 0 as never };
	const routine = toChatItem({
		...base,
		id: 1 as never,
		kind: "pi.user",
		model: [{ role: "user", content: '[routine] "Morning agenda": email me', timestamp: 5 }],
	});
	assert.equal(routine?.kind, "routine");
	const compaction = toChatItem({ ...base, id: 2 as never, kind: "pi.compaction", data: { reason: "threshold" } });
	assert.equal(compaction?.kind, "marker");
	assert.equal(toChatItem({ ...base, id: 3 as never, kind: "pi.system" }), undefined);
	const message = toChatItem({
		...base,
		id: 4 as never,
		kind: BOT_MESSAGE,
		data: { from: 7, name: "Job Search", text: "Found 3 roles." },
		model: [{ role: "user", content: "[bot] Message from Job Search (id 7)…", timestamp: 9 }],
	});
	assert.deepEqual(message, { id: 4, kind: "bot", from: 7, name: "Job Search", text: "Found 3 roles.", at: 9 });
});

test("a reply shows only what it sent; one with only private notes is hidden; one from before send_message shows its text", () => {
	const reply = (timestamp: number, content: unknown[]) =>
		toChatItem({ conversationId: 0 as never, id: 1 as never, kind: "pi.assistant", model: [{ role: "assistant", content, timestamp, stopReason: "toolUse" } as never] });
	const notes = { type: "text", text: "Checking the inbox first." };
	const sent = { type: "toolCall", id: "s", name: SEND_MESSAGE, arguments: { text: "Two mails need you." } };
	const now = Date.now();
	assert.deepEqual(reply(now, [notes, sent]), { id: 1, kind: "assistant", text: "Two mails need you.", at: now, tools: [], aborted: false });
	assert.equal(reply(now, [notes]), undefined);
	const legacy = reply(Date.parse("2026-11-01T00:00:00Z"), [notes]);
	assert.equal(legacy?.kind === "assistant" && legacy.text, "Checking the inbox first.");
});

// The text of each user message the model was given.
const told = (context: Parameters<FauxResponseFactory>[0]) =>
	context.messages.flatMap((message) =>
		message.role === "user" ? [typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : [],
	);
const notes = fauxAssistantMessage([fauxText("Nothing to do.")]);
const reactions = async (base: string) =>
	((await (await fetch(`${base}/api/chat`)).json()).items as ChatItem[]).flatMap((item) => (item.kind === "reaction" ? [[item.target, item.emoji, item.on]] : []));

// Done once the bot has worked and gone idle, having shown exactly these items.
const woke = (kinds: ChatItem["kind"][]) => (events: ChatEvent[]) => events.some((event) => event.type === "live" && event.live.busy) && settled(kinds)(events);

test("a reaction and taking it back each wake the bot, and a turn with nothing to do sends nothing", async () => {
	const BOOKED = "Booked the 9:00 train.\nSeat 14A.";
	let seen: string[] = [];
	const bot = await open([
		send(BOOKED),
		end,
		(context) => {
			seen = told(context);
			return notes;
		},
		(context) => {
			seen = told(context);
			return notes;
		},
		(context) => {
			seen = told(context);
			return send("Glad it works.");
		},
		end,
	]);
	try {
		const first = await collect(bot.base, settled(["user", "assistant"]), async () => {
			await post(bot.base, "/api/chat", { text: "book it" });
		});
		const [user, reply] = items(first);
		assert.ok(user !== undefined && reply?.kind === "assistant");

		const reacted = await collect(bot.base, woke(["reaction"]), async () => {
			const response = await post(bot.base, "/api/chat/react", { entryId: reply.id, emoji: "👍", on: true });
			assert.equal(response.status, 202);
		});
		const reaction = items(reacted).find((item) => item.kind === "reaction");
		assert.deepEqual(reaction && { ...reaction, id: 0, at: 0 }, { id: 0, kind: "reaction", target: reply.id, emoji: "👍", on: true, at: 0 });
		assert.equal(bot.faux.state.callCount, 3, "the reaction started one model call");
		assert.deepEqual(seen, ["book it", reactionText("👍", true, BOOKED)]);

		await collect(bot.base, woke(["reaction"]), async () => {
			assert.equal((await post(bot.base, "/api/chat/react", { entryId: reply.id, emoji: "👍", on: false })).status, 202);
		});
		assert.equal(bot.faux.state.callCount, 4, "taking it back started one model call");
		assert.deepEqual(seen, ["book it", reactionText("👍", true, BOOKED), reactionText("👍", false, BOOKED)]);
		assert.deepEqual(
			await reactions(bot.base),
			[
				[reply.id, "👍", true],
				[reply.id, "👍", false],
			],
			"taking it back is a second entry, newest wins",
		);

		await collect(bot.base, settled(["user", "assistant"]), async () => {
			await post(bot.base, "/api/chat", { text: "thanks" });
		});
		assert.equal(bot.faux.state.callCount, 6, "each reaction change was one turn");
		assert.deepEqual(seen, [
			"book it",
			reactionText("👍", true, BOOKED),
			reactionText("👍", false, BOOKED),
			"thanks",
		]);
		assert.match(seen[1] ?? "", /^\[The owner reacted 👍 to your message: "Booked the 9:00 train\. Seat 14A\."\./);

		assert.equal((await post(bot.base, "/api/chat/react", { entryId: user.id, emoji: "👍", on: true })).status, 404, "only replies take reactions");
		assert.equal((await post(bot.base, "/api/chat/react", { entryId: reply.id, emoji: "ok", on: true })).status, 400);
		assert.equal((await post(bot.base, "/api/chat/react", { entryId: reply.id, emoji: "❤️" })).status, 400);
		assert.equal((await post(bot.base, "/api/chat/react", { entryId: "1", emoji: "❤️", on: true })).status, 400);
	} finally {
		await bot.close();
	}
});

const wentIdle = (events: ChatEvent[]) => {
	const last = events.at(-1);
	return events.some((event) => event.type === "live" && event.live.busy) && last?.type === "live" && !last.live.busy;
};

test("a message sent while the bot works reaches it after the current tool round, in the same turn, right after its memory note", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let seen: string[] = [];
	const bot = await open(
		[
			async () => {
				started.resolve();
				await finish.promise;
				return fauxAssistantMessage([fauxToolCall("look", {}, { id: "call-1" })], { stopReason: "toolUse" });
			},
			(context) => {
				seen = told(context);
				return send("Using pnpm.");
			},
			end,
			notes,
		],
		undefined,
		async (_bot, message) => (message === "use pnpm" ? "[search_memory] pnpm is the project's package manager" : undefined),
	);
	try {
		const events = await collect(bot.base, wentIdle, async () => {
			await post(bot.base, "/api/chat", { text: "run the build" });
			await started.promise;
			assert.equal((await post(bot.base, "/api/chat", { text: "use pnpm" })).status, 202);
			finish.resolve();
		});
		assert.deepEqual(seen, ["run the build", "[search_memory] pnpm is the project's package manager", "use pnpm"]);
		assert.deepEqual(items(events).map((item) => item.kind), ["user", "assistant", "tool", "user", "assistant"]);
		assert.equal(bot.faux.state.callCount, 3, "the message joined the running turn instead of starting another");
	} finally {
		finish.resolve();
		await bot.close();
	}
});

// Shaped like computer_use in src/computer.ts: the bot waits on a child conversation that does the work. `onChild` runs
// once the child exists; `idle` leaves it without a run, as when another task still holds the Space.
const delegateExtension = (onChild: () => Promise<void>, idle = false) =>
	defineExtension({
		name: "delegate",
		tools: [
			defineTool({
				name: "computer_use",
				description: "Delegate an on-screen task.",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const { id } = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, id, { model: MODEL, tools: [lookTool], modelTools: [lookTool] });
						return id;
					}, callContext);
					await api.details({ conversationId: child }, callContext);
					await onChild();
					if (!idle) await (await (await api.conversation(child, callContext))!.submit({ type: "input", content: "click it" }, callContext)).wait(callContext);
					return { output: [{ type: "text" as const, text: "Clicked." }], details: { conversationId: child } };
				},
			}),
		],
	});
const delegate = fauxAssistantMessage([fauxToolCall("computer_use", {}, { id: "call-1" })], { stopReason: "toolUse" });

test("the live state says which Space a running computer_use call is on", () => {
	const tool = (details: unknown) => toChatLive({ tools: [{ callId: "a", name: "computer_use", status: "running", details }] } as never).tools[0];
	assert.deepEqual(tool({ conversationId: 7, space: "Windows PC" }), { callId: "a", name: "computer_use", status: "running", child: 7, space: "Windows PC" });
	assert.deepEqual(tool(null), { callId: "a", name: "computer_use", status: "running" }, "no Space until the call has picked one");
});

test("a steer reaches the running computer_use child at its next step, and the bot when that call returns", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let childSaw: string[] = [];
	let botSaw: string[] = [];
	const bot = await open(
		[
			delegate,
			async () => {
				started.resolve();
				await finish.promise;
				return fauxAssistantMessage([fauxToolCall("look", {}, { id: "child-1" })], { stopReason: "toolUse" });
			},
			(context) => {
				childSaw = told(context);
				return fauxAssistantMessage([fauxText("Clicked the other window.")]);
			},
			(context) => {
				botSaw = told(context);
				return send("Done.");
			},
			end,
		],
		undefined,
		undefined,
		{ extensions: [delegateExtension(async () => {})] },
	);
	try {
		await collect(bot.base, wentIdle, async () => {
			await post(bot.base, "/api/chat", { text: "do it" });
			await started.promise;
			assert.equal((await post(bot.base, "/api/chat", { text: "use the other window" })).status, 202);
			finish.resolve();
		});
		assert.equal(childSaw[0], "click it");
		assert.equal(childSaw.length, 2);
		assert.match(childSaw[1]!, /use the other window$/);
		assert.deepEqual(botSaw, ["do it", "use the other window"]);
	} finally {
		finish.resolve();
		await bot.close();
	}
});

test("a followUp leaves the running computer_use child alone", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let childSaw: string[] = [];
	const bot = await open(
		[
			delegate,
			async () => {
				started.resolve();
				await finish.promise;
				return fauxAssistantMessage([fauxToolCall("look", {}, { id: "child-1" })], { stopReason: "toolUse" });
			},
			(context) => {
				childSaw = told(context);
				return fauxAssistantMessage([fauxText("Clicked.")]);
			},
			send("Done."),
			end,
			send("Noted."),
			end,
		],
		undefined,
		undefined,
		{ extensions: [delegateExtension(async () => {})] },
	);
	try {
		await collect(bot.base, wentIdle, async () => {
			await post(bot.base, "/api/chat", { text: "do it" });
			await started.promise;
			await post(bot.base, "/api/chat", { text: "and then tidy up", whenBusy: "followUp" });
			finish.resolve();
		});
		assert.deepEqual(childSaw, ["click it"]);
	} finally {
		finish.resolve();
		await bot.close();
	}
});

test("a steer while the computer_use child has no run still reaches the bot", async () => {
	const waiting = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let botSaw: string[] = [];
	const bot = await open(
		[
			delegate,
			(context) => {
				botSaw = told(context);
				return send("Done.");
			},
			end,
		],
		undefined,
		undefined,
		{
			extensions: [
				delegateExtension(async () => {
					waiting.resolve();
					await finish.promise;
				}, true),
			],
		},
	);
	try {
		await collect(bot.base, wentIdle, async () => {
			await post(bot.base, "/api/chat", { text: "do it" });
			await waiting.promise;
			assert.equal((await post(bot.base, "/api/chat", { text: "use the other window" })).status, 202);
			finish.resolve();
		});
		assert.deepEqual(botSaw, ["do it", "use the other window"]);
	} finally {
		finish.resolve();
		await bot.close();
	}
});

test("a message sent with whenBusy followUp waits for the turn to end and gets its own", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let during: string[] = [];
	let after: string[] = [];
	const bot = await open([
		async () => {
			started.resolve();
			await finish.promise;
			return fauxAssistantMessage([fauxToolCall("look", {}, { id: "call-1" })], { stopReason: "toolUse" });
		},
		(context) => {
			during = told(context);
			return send("Built.");
		},
		end,
		(context) => {
			after = told(context);
			return send("Using pnpm next time.");
		},
		end,
	]);
	try {
		const events = await collect(bot.base, wentIdle, async () => {
			await post(bot.base, "/api/chat", { text: "run the build" });
			await started.promise;
			assert.equal((await post(bot.base, "/api/chat", { text: "use pnpm", whenBusy: "followUp" })).status, 202);
			finish.resolve();
		});
		assert.deepEqual(during, ["run the build"]);
		assert.deepEqual(after, ["run the build", "use pnpm"]);
		assert.deepEqual(items(events).map((item) => item.kind), ["user", "assistant", "tool", "assistant", "user", "assistant"]);
	} finally {
		finish.resolve();
		await bot.close();
	}
});

test("a message with an unknown whenBusy is rejected without reaching the bot", async () => {
	const bot = await open();
	try {
		const response = await post(bot.base, "/api/chat", { text: "hi", whenBusy: "later" });
		assert.equal(response.status, 400);
		assert.equal(bot.faux.state.callCount, 0);
	} finally {
		await bot.close();
	}
});

test("a message sent during the bot's last reply still gets a turn", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let seen: string[] = [];
	const bot = await open([
		send("Booked."),
		async () => {
			started.resolve();
			await finish.promise;
			return end;
		},
		(context) => {
			seen = told(context);
			return send("On it.");
		},
		end,
	]);
	try {
		const events = await collect(bot.base, wentIdle, async () => {
			await post(bot.base, "/api/chat", { text: "book it" });
			await started.promise;
			await post(bot.base, "/api/chat", { text: "now the hotel", whenBusy: "steer" });
			finish.resolve();
		});
		assert.deepEqual(seen, ["book it", "now the hotel"]);
		assert.deepEqual(items(events).map((item) => item.kind), ["user", "assistant", "user", "assistant"]);
	} finally {
		finish.resolve();
		await bot.close();
	}
});

test("a reaction to a busy bot waits for the turn to end, and taking it back in time withdraws it", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let seen: string[] = [];
	const bot = await open([
		send("Booked."),
		end,
		async () => {
			started.resolve();
			await finish.promise;
			return send("Still on it.");
		},
		end,
		(context) => {
			seen = told(context);
			return notes;
		},
	]);
	try {
		const first = await collect(bot.base, settled(["user", "assistant"]), async () => {
			await post(bot.base, "/api/chat", { text: "book it" });
		});
		const reply = items(first).at(-1);
		assert.ok(reply?.kind === "assistant");

		await post(bot.base, "/api/chat", { text: "now the hotel" });
		await started.promise;
		for (const [emoji, on] of [["👍", true], ["❤️", true], ["❤️", false]] as const) {
			assert.equal((await post(bot.base, "/api/chat/react", { entryId: reply.id, emoji, on })).status, 202);
		}
		assert.deepEqual(await reactions(bot.base), [], "both wait behind the turn");

		const ended = settled(["assistant", "reaction"]);
		await collect(bot.base, ended, async () => finish.resolve());
		assert.equal(bot.faux.state.callCount, 5, "the turn, then one more for the reaction still queued");
		assert.deepEqual(seen, ["book it", "now the hotel", reactionText("👍", true, "Booked.")]);
		assert.deepEqual(await reactions(bot.base), [[reply.id, "👍", true]], "the withdrawn reaction leaves no entry");
	} finally {
		finish.resolve();
		await bot.close();
	}
});

test("reacting again withdraws a take-back still queued behind a turn", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const bot = await open([
		send("Booked."),
		end,
		notes,
		async () => {
			started.resolve();
			await finish.promise;
			return send("Still on it.");
		},
		end,
	]);
	try {
		const first = await collect(bot.base, settled(["user", "assistant"]), async () => {
			await post(bot.base, "/api/chat", { text: "book it" });
		});
		const reply = items(first).at(-1);
		assert.ok(reply?.kind === "assistant");
		await collect(bot.base, woke(["reaction"]), async () => {
			await post(bot.base, "/api/chat/react", { entryId: reply.id, emoji: "👍", on: true });
		});

		await post(bot.base, "/api/chat", { text: "now the hotel" });
		await started.promise;
		for (const on of [false, true]) assert.equal((await post(bot.base, "/api/chat/react", { entryId: reply.id, emoji: "👍", on })).status, 202);

		await collect(bot.base, woke(["assistant"]), async () => finish.resolve());
		assert.equal(bot.faux.state.callCount, 5, "no turn followed the one in progress");
		assert.deepEqual(await reactions(bot.base), [[reply.id, "👍", true]], "the withdrawn take-back leaves no entry");
	} finally {
		finish.resolve();
		await bot.close();
	}
});

test("reaction entries become reaction items, and a long reply is quoted short", () => {
	const item = toChatItem({
		conversationId: 0 as never,
		id: 12 as never,
		kind: REACTION,
		data: { target: 10, emoji: "🎉", on: false },
		model: [{ role: "user", content: "[The owner took back their 🎉 reaction…]", timestamp: 7 }],
	});
	assert.deepEqual(item, { id: 12, kind: "reaction", target: 10, emoji: "🎉", on: false, at: 7 });
	const note = reactionText("😂", true, "word ".repeat(40));
	assert.match(note, /: "(word ){15}word…"\. You don't need to reply/);
	assert.ok(note.includes(SEND_MESSAGE), "a turn with nothing to do knows to send nothing");
	assert.ok(reactionText("😂", false, "hi").includes(SEND_MESSAGE), "so does a take-back's");
});

// A 1x1 PNG, as the browser sends a pasted screenshot: base64 without the data: URL prefix.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a pasted image reaches the bot after the text, shows as a count, and is served back", async () => {
	let seen: unknown;
	const bot = await open([
		(context) => {
			seen = context.messages.at(-1);
			return send("Nice chart.");
		},
		end,
		send("Got it."),
		end,
	]);
	try {
		const events = await collect(bot.base, settled(["user", "assistant"]), async () => {
			const response = await post(bot.base, "/api/chat", { text: "what is this?", images: [{ data: PIXEL, mimeType: "image/png" }] });
			assert.equal(response.status, 202);
		});
		const [user] = items(events);
		assert.ok(user?.kind === "user");
		assert.equal(user.text, "what is this?");
		assert.equal(user.images, 1);
		assert.deepEqual((seen as { content: unknown }).content, [
			{ type: "text", text: "what is this?" },
			{ type: "image", data: PIXEL, mimeType: "image/png" },
		]);

		const image = await fetch(`${bot.base}/api/chat/image?entry=${user.id}&index=0`);
		assert.equal(image.status, 200);
		assert.equal(image.headers.get("content-type"), "image/png");
		assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(PIXEL, "base64"));
		assert.equal((await fetch(`${bot.base}/api/chat/image?entry=${user.id}&index=1`)).status, 404);
		assert.equal((await fetch(`${bot.base}/api/chat/image?entry=nope`)).status, 400);

		// An image alone is a message too: no empty text part goes to the model.
		const alone = await collect(bot.base, settled(["user", "assistant"]), async () => {
			await post(bot.base, "/api/chat", { text: "", images: [{ data: PIXEL, mimeType: "image/png" }] });
		});
		const [only] = items(alone);
		assert.ok(only?.kind === "user");
		assert.deepEqual([only.text, only.images], ["", 1]);
	} finally {
		await bot.close();
	}
});

test("bad image input is rejected without reaching the bot", async () => {
	const bot = await open();
	try {
		assert.equal((await post(bot.base, "/api/chat", { text: "", images: [] })).status, 400);
		assert.equal((await post(bot.base, "/api/chat", { text: "hi", images: [{ data: PIXEL, mimeType: "text/plain" }] })).status, 400);
		assert.equal((await post(bot.base, "/api/chat", { text: "hi", images: [{ data: "", mimeType: "image/png" }] })).status, 400);
		assert.equal((await post(bot.base, "/api/chat", { text: "hi", images: "nope" })).status, 400);
		assert.equal((await post(bot.base, "/api/chat", { images: [{ data: PIXEL, mimeType: "image/bmp" }] })).status, 400, "no processor to convert BMP");
		assert.deepEqual((await (await fetch(`${bot.base}/api/chat`)).json()).items, []);
	} finally {
		await bot.close();
	}
});

test("with an image processor, pasted images are stored as it prepared them", async () => {
	const prepared: string[] = [];
	const images: ImageProcessor = {
		prepare: async (bytes, mimeType) => {
			prepared.push(`${mimeType}:${bytes.length}`);
			return mimeType === "image/bmp" ? { data: PIXEL, mimeType: "image/png", convertedFrom: "image/bmp" } : undefined;
		},
	};
	const bot = await open(SCRIPT, images);
	try {
		const events = await collect(bot.base, settled(["user", "assistant"]), async () => {
			assert.equal((await post(bot.base, "/api/chat", { images: [{ data: "Qk0=", mimeType: "image/bmp" }] })).status, 202);
		});
		const [user] = items(events);
		assert.ok(user?.kind === "user");
		assert.equal((await fetch(`${bot.base}/api/chat/image?entry=${user.id}&index=0`)).headers.get("content-type"), "image/png");
		assert.equal((await post(bot.base, "/api/chat", { images: [{ data: PIXEL, mimeType: "image/tiff" }] })).status, 400, "unreadable image");
		assert.deepEqual(prepared, ["image/bmp:2", `image/tiff:${Buffer.from(PIXEL, "base64").length}`]);
	} finally {
		await bot.close();
	}
});

// main.ts uses Photon in a worker thread, which needs the image bytes in a buffer of their own.
test("the Photon processor main.ts uses takes a pasted image", async () => {
	const bot = await open(SCRIPT, await createNodePhotonImages({ idleMs: 50 }));
	try {
		const events = await collect(bot.base, settled(["user", "assistant"]), async () => {
			const response = await post(bot.base, "/api/chat", { images: [{ data: PIXEL, mimeType: "image/png" }] });
			assert.equal(response.status, 202, await response.clone().text());
		});
		const [user] = items(events);
		assert.ok(user?.kind === "user" && user.images === 1);
	} finally {
		await bot.close();
	}
});
