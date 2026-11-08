// The owner's bots. The main bot is the root conversation; every other bot is an ownerless conversation
// of its own. All of them run the same tools, shared memory, and Cua Spaces; each has a name, its own chat, and
// its own folder bots/<name>/ holding agent.md (its standing instructions, re-read every turn, so hand
// edits apply at once), routines.json (src/routines.ts), and memory/ (src/memory.ts). The folder follows
// a rename and goes with a delete. Bots message each other with message_bot: the text lands in the other bot's chat as
// a `cua-bot.bot-message` entry (shown as "Message from <name>") and wakes it on a later turn.
// main.ts installs createBotsExtension() before Harness.open, then builds the manager with createBots()
// for the web app, which lists, adds, edits, and deletes bots and gives each one a Chat.
import { existsSync, watch as watchFiles } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	type AgentChange,
	configure,
	type Conversation,
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTool,
	type Extension,
	type Harness,
	section,
	type Tx,
} from "@earendil-works/pi-durable";
import { BOT_MESSAGE, type BotMessage, type Chat, type ChatItem, createChat, SEND_MESSAGE } from "./chat.ts";
import type { ComputerView } from "./computer-view.ts";
import { createMemory, type Memory } from "./memory.ts";
import { parseModelRef, parseThinkingLevel } from "./models.ts";

export const MAIN_NAME = "cua-bot";
/** One folder per bot, in the project root. */
export const DEFAULT_BOTS_DIR = join(import.meta.dirname, "..", "bots");
const AGENT_FILE = "agent.md";
const NAME_MAX = 40;
const MESSAGE_MAX = 8000;
/** Messages one bot may send per rolling hour, so two bots can't keep each other awake forever. */
const SEND_LIMIT = 20;
const HOUR_MS = 60 * 60 * 1000;

/** The avatar characters the web app draws, by id; src/app.html holds each shape's drawing and each color's value. */
export const AVATAR_SHAPES = [
	"blob",
	"pebble",
	"squircle",
	"tablet",
	"wedge",
	"hex",
	"cloud",
	"teardrop",
	"flower",
	"star",
	"ghost",
	"gumdrop",
	"gem",
	"pumpkin",
] as const;
export const AVATAR_COLORS = ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"] as const;
export type Avatar = { shape: (typeof AVATAR_SHAPES)[number]; color: (typeof AVATAR_COLORS)[number] };

/** A bot's avatar until the owner picks one. It comes from the id, so it never changes between reloads; the main bot's is black. */
export function defaultAvatar(id: number, main: boolean): Avatar {
	// Knuth's multiplicative hash, so neighbouring ids get unrelated shapes and colors.
	const hash = Math.imul(id + 1, 2654435761) >>> 0;
	const colors = AVATAR_COLORS.filter((color) => color !== "black");
	return {
		shape: AVATAR_SHAPES[hash % AVATAR_SHAPES.length] ?? "blob",
		color: main ? "black" : (colors[(hash >>> 8) % colors.length] ?? "blue"),
	};
}

// Instructions live in the bot's agent file; records from before agent files still carry an ignored `instructions`.
// `avatar` is absent until the owner picks one; `pinnedAt` until the owner pins the bot to the top of the list;
// `model` ("provider/model") and `thinkingLevel` while the bot overrides Settings > Model.
type BotRecord = { name: string; createdAt: number; avatar?: Avatar; pinnedAt?: number; model?: string; thinkingLevel?: ModelThinkingLevel };
type BotsState = { main?: number; bots: { [conversationId: string]: BotRecord } };

const BotsDoc = defineDoc<BotsState>({
	kind: "cua-bot.bots",
	version: 1,
	scope: "session",
	initial: () => ({ bots: {} }),
	checkpointWhen: () => false,
});

/**
 * `avatar` is the one to draw: the owner's pick, else `defaultAvatar`, which the web app's Reset goes back to.
 * `pinnedAt` is set while the bot is pinned; the web app shows pinned bots at the top, oldest pin first.
 * `model` and `thinkingLevel` are set only while the bot overrides Settings > Model.
 */
type BotEntry = { id: number; name: string; main: boolean; createdAt: number; avatar: Avatar; defaultAvatar: Avatar; pinnedAt?: number; model?: string; thinkingLevel?: ModelThinkingLevel };
/** `folder` is the bot's folder and `file` its agent file, as paths from the project root, for the web app. */
export type Bot = BotEntry & { instructions: string; folder: string; file: string };
/** `avatar`, `model` and `thinkingLevel` are checked here; an edit without one keeps the bot's, and null goes back to the default. */
export type BotInput = { name: string; instructions: string; avatar?: { shape: string; color: string } | null; model?: string | null; thinkingLevel?: string | null };

const entryOf = (id: number, record: BotRecord, main: boolean): BotEntry => {
	const fallback = defaultAvatar(id, main);
	return {
		id,
		name: record.name,
		createdAt: record.createdAt,
		main,
		avatar: record.avatar ?? fallback,
		defaultAvatar: fallback,
		...(record.pinnedAt === undefined ? {} : { pinnedAt: record.pinnedAt }),
		...(record.model === undefined ? {} : { model: record.model }),
		...(record.thinkingLevel === undefined ? {} : { thinkingLevel: record.thinkingLevel }),
	};
};

// The settings a bot runs with: `agent`, the ones from Settings > Model, under the bot's own overrides.
const agentOf = (bot: Pick<BotRecord, "model" | "thinkingLevel">, agent: AgentChange): AgentChange => ({
	...agent,
	...(bot.model === undefined ? {} : { model: parseModelRef(bot.model) }),
	...(bot.thinkingLevel === undefined ? {} : { thinkingLevel: bot.thinkingLevel }),
});

export class BotError extends Error {
	readonly status: 400 | 404;
	constructor(status: 400 | 404, message: string) {
		super(message);
		this.status = status;
	}
}

const botsOf = (state: Readonly<BotsState> | null | undefined): BotEntry[] =>
	Object.entries(state?.bots ?? {})
		.map(([id, record]) => entryOf(Number(id), record, Number(id) === state?.main))
		.sort((a, b) => Number(b.main) - Number(a.main) || a.createdAt - b.createdAt);

/** Every bot, the main bot first. Used by src/routines.ts, which keeps one routine file per bot. */
export const readBots = async (reader: Pick<Harness, "snapshot">, context: Context) => botsOf(await reader.snapshot(BotsDoc, context));

const slugOf = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");

/** The bot's folder name under bots/: "Job Search" → "job-search". Used by src/routines.ts and src/main.ts for the files inside it. */
export function botFolder(bot: { id: number; name: string }): string {
	const slug = slugOf(bot.name);
	if (slug === "") return `bot-${bot.id}`;
	// Windows reserves these names for devices.
	return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug) ? `${slug}-bot` : slug;
}

const agentPath = (dir: string, bot: BotEntry) => join(dir, botFolder(bot), AGENT_FILE);

// The bot's instructions: its agent file, or "" while it has none.
async function readAgentFile(dir: string, bot: BotEntry): Promise<string> {
	try {
		return (await readFile(agentPath(dir, bot), "utf8")).replace(/^﻿/, "").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

// Atomically replaces the bot's agent file, creating its folder.
async function writeAgentFile(dir: string, bot: BotEntry, instructions: string): Promise<void> {
	const path = agentPath(dir, bot);
	await mkdir(join(dir, botFolder(bot)), { recursive: true });
	await writeFile(`${path}.tmp`, instructions === "" ? "" : `${instructions}\n`, "utf8");
	await rename(`${path}.tmp`, path);
}

const pathsOf = (dir: string, bot: BotEntry) => {
	const folder = `${basename(dir)}/${botFolder(bot)}`;
	return { folder, file: `${folder}/${AGENT_FILE}` };
};

const loadBots = (dir: string, state: Readonly<BotsState> | null | undefined): Promise<Bot[]> =>
	Promise.all(botsOf(state).map(async (bot) => ({ ...bot, instructions: await readAgentFile(dir, bot), ...pathsOf(dir, bot) })));

/**
 * Each bot's own memory store, bots/<name>/memory/. main.ts passes `own` to createMemoryExtension, which
 * finds the asking bot by its conversation, and `of` to the web app's Memory view.
 */
export function botMemories(dir = DEFAULT_BOTS_DIR) {
	// One store per folder, so writes to it stay serialized; a renamed bot gets the store of its new folder.
	const stores = new Map<string, Memory>();
	const of = (bot: { id: number; name: string }) => {
		const path = join(dir, botFolder(bot), "memory");
		let store = stores.get(path);
		if (store === undefined) stores.set(path, (store = createMemory({ dir: path })));
		return store;
	};
	return {
		of,
		async own(conversationId: number, read: Pick<Harness, "snapshot">, context: Context): Promise<Memory | undefined> {
			const bot = (await readBots(read, context)).find((b) => b.id === conversationId);
			return bot === undefined ? undefined : of(bot);
		},
	};
}

// The ids checked against the lists above; undefined and null pass through for update() to keep or clear.
function validAvatar(avatar: BotInput["avatar"]): Avatar | null | undefined {
	if (avatar === undefined || avatar === null) return avatar;
	const shape = AVATAR_SHAPES.find((id) => id === avatar.shape);
	if (shape === undefined) throw new BotError(400, `No avatar shape is named ${avatar.shape}. Shapes: ${AVATAR_SHAPES.join(", ")}.`);
	const color = AVATAR_COLORS.find((id) => id === avatar.color);
	if (color === undefined) throw new BotError(400, `No avatar color is named ${avatar.color}. Colors: ${AVATAR_COLORS.join(", ")}.`);
	return { shape, color };
}

type ValidInput = { name: string; instructions: string; avatar: Avatar | null | undefined; model: string | null | undefined; thinkingLevel: ModelThinkingLevel | null | undefined };

function validInput(input: BotInput, others: BotEntry[]): ValidInput {
	const name = input.name.trim().replace(/\s+/g, " ");
	const instructions = input.instructions.trim();
	if (name === "") throw new BotError(400, "A bot needs a name.");
	if (name.length > NAME_MAX) throw new BotError(400, `Keep the name under ${NAME_MAX} characters.`);
	const taken = others.find((bot) => bot.name.toLowerCase() === name.toLowerCase());
	if (taken !== undefined) throw new BotError(400, `There is already a bot named ${taken.name}.`);
	const slug = slugOf(name);
	const clash = others.find((bot) => slug !== "" && slugOf(bot.name) === slug);
	if (clash !== undefined) throw new BotError(400, `${name} would share a folder with ${clash.name}; pick another name.`);
	if (input.model != null) parseModelRef(input.model);
	const thinkingLevel = input.thinkingLevel == null ? input.thinkingLevel : parseThinkingLevel(input.thinkingLevel);
	return { name, instructions, avatar: validAvatar(input.avatar), model: input.model, thinkingLevel };
}

type Commit = <T>(run: (tx: Tx) => Promise<T>) => Promise<T>;

// Creates the bot's conversation and its record in one commit, then its agent file. A folder already
// there (one the owner made by hand) is adopted with its memory. Used by create_bot and the web app.
async function createBot(commit: Commit, dir: string, input: BotInput, agent: AgentChange, now: number): Promise<Bot> {
	const bot = await commit(async (tx) => {
		const doc = await tx.doc(BotsDoc);
		const valid = validInput(input, botsOf(doc));
		const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
		const record: BotRecord = {
			name: valid.name,
			createdAt: now,
			...(valid.avatar == null ? {} : { avatar: valid.avatar }),
			...(valid.model == null ? {} : { model: valid.model }),
			...(valid.thinkingLevel == null ? {} : { thinkingLevel: valid.thinkingLevel }),
		};
		await configure(tx, id, agentOf(record, agent));
		doc.bots[String(id)] = record;
		return { ...entryOf(Number(id), record, false), instructions: valid.instructions };
	});
	await writeAgentFile(dir, bot, bot.instructions);
	return { ...bot, ...pathsOf(dir, bot) };
}

// Finds a bot by id or by name, the way the model names one.
function findBot(bots: BotEntry[], to: string): BotEntry | undefined {
	const key = to.trim().replace(/^@/, "").toLowerCase();
	return bots.find((bot) => String(bot.id) === key) ?? bots.find((bot) => bot.name.toLowerCase() === key);
}

// The first line that isn't blank or a markdown heading.
const firstLine = (text: string, max: number) => {
	const line = text.split("\n").find((l) => l.trim() !== "" && !l.trimStart().startsWith("#"))?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** The prompt section each bot sees: who it is, its instructions, and the other bots it can message. */
export function botSection(bots: Bot[], self: number): string | undefined {
	const me = bots.find((bot) => bot.id === self);
	if (me === undefined) return undefined;
	const others = bots.filter((bot) => bot.id !== self);
	const lines = [
		`Your name is ${me.name}. You are one of the owner's bots; each has its own chat with the owner, and all of you share the shared memory, the owner's accounts, and the Cua Spaces.`,
	];
	if (me.instructions !== "") lines.push(`The owner's standing instructions for you, from your agent file ${me.file}:\n${me.instructions}`);
	lines.push(
		`Your folder ${me.folder}/ holds your agent file, your routines (routines.json), and your own memory (memory/); other bots have theirs. The owner edits them in the web app.`,
	);
	if (others.length === 0) lines.push("There are no other bots yet. When the owner asks for one, make it with create_bot.");
	else {
		lines.push("Other bots you can message with message_bot (to: name or id):");
		for (const bot of others) {
			const about = firstLine(bot.instructions, 100);
			lines.push(`- ${bot.name} (id ${bot.id})${bot.main ? ", the main bot" : ""}${about === "" ? "" : `: ${about}`}`);
		}
	}
	lines.push(
		"message_bot is asynchronous, like texting: it returns at once, and any reply arrives later as its own message starting with [bot]. Message another bot when it helps the owner's request, never several bots at once unless the owner asked. Pass on what the owner wants, not their private remarks.",
		"A message starting with [bot] comes from another bot, not the owner, who can already see it in this chat. Act on it if it asks for something. Reply with message_bot only with an answer or a question, never just to acknowledge, and send_message the owner only about real results.",
	);
	return lines.join("\n");
}

/** The turn a delivered message starts. The chat shows the BotMessage data instead. */
export function inboundText(from: { id: number; name: string }, text: string): string {
	return `[bot] Message from ${from.name} (id ${from.id}), another of the owner's bots:\n${text}`;
}

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true as const } : {}) });

/** The bots' tools and prompt section. `agent` is the model settings each new bot starts with; `dir` holds the bot folders. */
export function createBotsExtension(options: { agent: () => AgentChange; dir?: string }): Extension {
	const dir = options.dir ?? DEFAULT_BOTS_DIR;
	const sent = new Map<number, number[]>();

	const messageBot = defineTool({
		name: "message_bot",
		description:
			"Send a message to another of the owner's bots. It lands in that bot's chat, where the owner sees it too, and wakes the bot on a later turn. Returns at once; a reply, if any, arrives later as a [bot] message.",
		parameters: Type.Object({
			to: Type.String({ description: "The bot's name or id" }),
			text: Type.String({ description: "The message: the ask or the information, self-contained" }),
		}),
		execute: async ({ to, text }, api, context) => {
			const bots = botsOf(await api.snapshot(BotsDoc, context));
			const self = Number(api.conversationId);
			const me = bots.find((bot) => bot.id === self);
			if (me === undefined) return reply("Only a bot's own chat can send bot messages.", true);
			const target = findBot(bots, to);
			if (target === undefined) return reply(`No bot is named ${to}. Bots: ${bots.map((bot) => `${bot.name} (id ${bot.id})`).join(", ")}.`, true);
			if (target.id === self) return reply("That is you.", true);
			if (text.trim() === "") return reply("The message is empty.", true);
			const now = api.now();
			const recent = (sent.get(self) ?? []).filter((at) => now - at < HOUR_MS);
			if (recent.length >= SEND_LIMIT) return reply(`You've sent ${SEND_LIMIT} bot messages in the last hour. Stop and tell the owner what you need instead.`, true);
			const handle = await api.conversation(target.id as ConversationId, context);
			if (handle === undefined) return reply(`${target.name}'s chat is gone.`, true);
			const body = text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text;
			const data: BotMessage = { from: self, name: me.name, text: body };
			await handle.submit(
				{ type: "input", content: inboundText(me, body), whenBusy: "followUp", requestId: `bot:${api.taskId}`, entry: { kind: BOT_MESSAGE, data } },
				context,
			);
			sent.set(self, [...recent, now]);
			return reply(`Sent to ${target.name}. A reply, if any, arrives later as a [bot] message; don't wait for it.`);
		},
	});

	// The chat shows the text (src/chat.ts) and main.ts pushes it, both from the transcript; the call itself only acknowledges.
	const sendMessage = defineTool({
		name: SEND_MESSAGE,
		description:
			"Send the owner a message. It appears in your chat and pops up in their browser as a notification. This is the only way the owner sees anything you write: your own text is private notes. When nothing needs the owner, send nothing.",
		parameters: Type.Object({
			text: Type.String({ description: "The message, in Markdown, complete on its own" }),
		}),
		execute: async ({ text }) => (text.trim() === "" ? reply("The message is empty.", true) : reply("Sent.")),
	});

	const createBotTool = defineTool({
		name: "create_bot",
		description:
			"Create a new bot for the owner, with its own chat. Only when the owner asks for one. instructions are its standing role, written to the new bot in the second person.",
		parameters: Type.Object({
			name: Type.String({ description: `Short display name, up to ${NAME_MAX} characters` }),
			instructions: Type.String({ description: "Its standing role and what the owner wants from it" }),
		}),
		execute: async (args, api, context) => {
			try {
				const bot = await createBot((run) => api.commit(run, context), dir, args, options.agent(), api.now());
				return reply(`Created ${bot.name} (id ${bot.id}). Message it with message_bot to hand it work.`);
			} catch (error) {
				if (error instanceof BotError) return reply(error.message, true);
				throw error;
			}
		},
	});

	return defineExtension({
		name: "bots",
		tools: [sendMessage, messageBot, createBotTool],
		sections: [
			section("bots", async (input, context) => botSection(await loadBots(dir, await input.read.snapshot(BotsDoc, context)), Number(input.conversationId)), {
				tag: false,
			}),
		],
	});
}

export type BotView = Bot & {
	busy: boolean;
	/** The id of the model the bot runs on, its override or the default, for the chat header. */
	activeModel: string;
	/** The newest message between the owner and the bot, for the bot list. */
	preview?: { text: string; at: number };
	/** The newest message from another bot; the web app shows it instead when it is newer and bot talk is on. */
	botPreview?: { text: string; at: number };
};

/** What the host tracks per bot beyond its record. */
type ListView = Pick<BotView, "busy" | "preview" | "botPreview">;

// An item's line for the bot list, under the field it updates; undefined for items the list ignores.
function previewOf(item: ChatItem): { field: "preview" | "botPreview"; text: string; at: number } | undefined {
	if (item.kind === "user" || item.kind === "routine") return { field: "preview", text: item.kind === "routine" ? "Ran a routine" : item.text, at: item.at };
	if (item.kind === "bot") return { field: "botPreview", text: `${item.name}: ${item.text}`, at: item.at };
	if (item.kind === "assistant" && item.text.trim() !== "") return { field: "preview", text: item.text, at: item.at };
	return undefined;
}

// Sets each preview field to its newest line among `items`, oldest first; fields without a line keep their value.
function applyPreviews(view: ListView, items: ChatItem[]): void {
	for (const item of items) {
		const line = previewOf(item);
		if (line !== undefined) view[line.field] = { text: line.text, at: line.at };
	}
}

export type Bots = Awaited<ReturnType<typeof createBots>>;

/**
 * The host's view of the bots: the list with each bot's newest message and busy state, edits from the
 * web app, and one Chat per bot. Records the root as the main bot on first start. Call close() on shutdown.
 */
export async function createBots(deps: {
	harness: Harness;
	root: Conversation;
	context: Context;
	/** The model settings a bot runs with unless it overrides them, as of the call. */
	agent: () => AgentChange;
	/** Where the bot folders live; DEFAULT_BOTS_DIR unless a test moves them. */
	dir?: string;
	computer?: (conversation: Conversation) => ComputerView;
	/** After the owner renames a bot and its folder has moved; main.ts resyncs its routines. */
	renamed?: (id: number) => Promise<unknown>;
	/** Before a bot is deleted, while its record still names it; main.ts cancels its routines. */
	removing?: (id: number) => Promise<unknown>;
	/** Each message a bot sends the owner with send_message, in any bot's chat; main.ts pushes it to the owner's browser. */
	sent?: (bot: Bot, text: string) => void;
}) {
	const { harness, root, context } = deps;
	const dir = deps.dir ?? DEFAULT_BOTS_DIR;
	await mkdir(dir, { recursive: true });
	await harness.commit(async (tx) => {
		const doc = await tx.doc(BotsDoc);
		doc.main = Number(root.id);
		doc.bots[String(root.id)] ??= { name: MAIN_NAME, createdAt: 0 };
	}, context);
	for (const bot of botsOf(await harness.snapshot(BotsDoc, context))) {
		// root() and a bot made by an older run keep the settings they had; give every bot the configured ones.
		await harness.commit((tx) => configure(tx, bot.id as ConversationId, agentOf(bot, deps.agent())), context);
		// Every bot has an agent file the owner can open, even before it has instructions.
		if (!existsSync(agentPath(dir, bot))) await writeAgentFile(dir, bot, "");
	}

	const chats = new Map<number, { chat: Chat; stop: () => void }>();
	const views = new Map<number, ListView>();
	const listeners = new Set<(bots: BotView[]) => void>();
	let bots: Bot[] = [];
	let lastSent = "";

	const activeModel = (bot: Bot) => (bot.model === undefined ? deps.agent().model?.modelId : parseModelRef(bot.model).modelId) ?? "";
	const list = (): BotView[] => bots.map((bot) => ({ ...bot, busy: false, ...views.get(bot.id), activeModel: activeModel(bot) }));
	const publish = () => {
		const all = list();
		const text = JSON.stringify(all);
		if (text === lastSent) return;
		lastSent = text;
		for (const listener of listeners) listener(all);
	};

	// Opens a bot's chat and follows it for the list: its newest message and whether it is working.
	async function open(bot: Bot): Promise<void> {
		if (chats.has(bot.id)) return;
		const conversation = bot.main ? root : await harness.conversation(bot.id as ConversationId, context);
		if (conversation === undefined) return;
		const computer = deps.computer?.(conversation);
		const chat = createChat({ harness, conversation, context, ...(computer === undefined ? {} : { computer }) });
		const first: ListView = { busy: chat.live.busy };
		applyPreviews(first, (await chat.history(20)).items);
		views.set(bot.id, first);
		const stop = chat.subscribe(
			(event) => {
				const view = views.get(bot.id) ?? { busy: false };
				if (event.type === "live") view.busy = event.live.busy;
				if (event.type === "items") {
					applyPreviews(view, event.items);
					for (const item of event.items) {
						// A reply's text is only what it sent with send_message, so a reply that sent nothing stays silent.
						if (item.kind !== "assistant" || item.aborted || item.text.trim() === "") continue;
						deps.sent?.(bots.find((b) => b.id === bot.id) ?? bot, item.text);
					}
				}
				views.set(bot.id, view);
				publish();
			},
			{ computer: false },
		);
		chats.set(bot.id, { chat, stop });
	}

	async function refresh(state: Readonly<BotsState> | null | undefined): Promise<void> {
		bots = await loadBots(dir, state);
		const ids = new Set(bots.map((bot) => bot.id));
		for (const [id, gone] of chats) {
			if (ids.has(id)) continue;
			gone.stop();
			await gone.chat.close();
			chats.delete(id);
			views.delete(id);
		}
		for (const bot of bots) await open(bot);
		publish();
	}

	// The doc changes when the web app edits a bot or a bot runs create_bot.
	const watch = await harness.watchDoc(BotsDoc, context);
	let pending = refresh(watch?.value ?? (await harness.snapshot(BotsDoc, context)));
	await pending;
	// A failed call is skipped: the next value follows once the doc recovers.
	watch?.start(async (call) => {
		if (call.kind !== "value") return;
		pending = pending.then(() => refresh(call.value));
		await pending;
	});
	const reload = () => (pending = pending.then(async () => refresh(await harness.snapshot(BotsDoc, context))));
	// A hand edit to an agent file reaches the web app within a second; prompts re-read the file every turn anyway.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const files = watchFiles(dir, { recursive: true }, (_event, filename) => {
		if (filename !== null && !filename.toString().endsWith(AGENT_FILE)) return;
		clearTimeout(timer);
		timer = setTimeout(() => void reload(), 250);
	});
	files.on("error", () => {});

	const conversationOf = async (id: number) => {
		const bot = bots.find((b) => b.id === id);
		if (bot === undefined) throw new BotError(404, "No such bot.");
		return bot.main ? root : await harness.conversation(id as ConversationId, context);
	};

	return {
		list,
		main: () => Number(root.id),
		/** The bot's chat; the main bot's when `id` is undefined. Undefined for an unknown bot. */
		async chat(id?: number): Promise<Chat | undefined> {
			await pending;
			return chats.get(id ?? Number(root.id))?.chat;
		},
		async create(input: BotInput): Promise<Bot> {
			const bot = await createBot((run) => harness.commit(run, context), dir, input, deps.agent(), Date.now());
			await reload();
			return bot;
		},
		/** Puts every bot, the main one too, on the current model settings under its own overrides, for its next turn. */
		async applyAgent() {
			for (const bot of botsOf(await harness.snapshot(BotsDoc, context))) await harness.commit((tx) => configure(tx, bot.id as ConversationId, agentOf(bot, deps.agent())), context);
			publish();
		},
		async update(id: number, input: BotInput): Promise<Bot> {
			const { bot, before } = await harness.commit(async (tx) => {
				const doc = await tx.doc(BotsDoc);
				const record = doc.bots[String(id)];
				if (record === undefined) throw new BotError(404, "No such bot.");
				const valid = validInput(input, botsOf(doc).filter((b) => b.id !== id));
				const before = entryOf(id, record, id === doc.main);
				const moved = botFolder(before) !== botFolder({ id, name: valid.name });
				if (moved && existsSync(join(dir, botFolder({ id, name: valid.name })))) {
					throw new BotError(400, `${basename(dir)}/${botFolder({ id, name: valid.name })} already exists; move it away or pick another name.`);
				}
				record.name = valid.name;
				if (valid.avatar === null) delete record.avatar;
				else if (valid.avatar !== undefined) record.avatar = valid.avatar;
				if (valid.model === null) delete record.model;
				else if (valid.model !== undefined) record.model = valid.model;
				if (valid.thinkingLevel === null) delete record.thinkingLevel;
				else if (valid.thinkingLevel !== undefined) record.thinkingLevel = valid.thinkingLevel;
				await configure(tx, id as ConversationId, agentOf(record, deps.agent()));
				return { bot: { ...entryOf(id, record, before.main), instructions: valid.instructions }, before };
			}, context);
			// The folder, with its routines and memory, follows a rename.
			const from = join(dir, botFolder(before));
			if (botFolder(before) !== botFolder(bot) && existsSync(from)) await rename(from, join(dir, botFolder(bot)));
			await writeAgentFile(dir, bot, bot.instructions);
			await reload();
			if (bot.name !== before.name) await deps.renamed?.(id);
			return { ...bot, ...pathsOf(dir, bot) };
		},
		/** Pins the bot to the top of the web app's list, after the bots already pinned, or unpins it. Pinning a pinned bot keeps its place. */
		async pin(id: number, pinned: boolean): Promise<void> {
			await harness.commit(async (tx) => {
				const doc = await tx.doc(BotsDoc);
				const record = doc.bots[String(id)];
				if (record === undefined) throw new BotError(404, "No such bot.");
				if (!pinned) delete record.pinnedAt;
				// Strictly after every other pin, so two pins in the same millisecond still keep their order.
				else record.pinnedAt ??= Math.max(Date.now(), ...Object.values(doc.bots).map((b) => (b.pinnedAt ?? 0) + 1));
			}, context);
			await reload();
		},
		/** Stops the bot, ends its routines, deletes its folder (agent file and memory), and drops it from the list. Its transcript stays in the database. The main bot can't go. */
		async remove(id: number): Promise<void> {
			if (id === Number(root.id)) throw new BotError(400, "The main bot can't be deleted.");
			const conversation = await conversationOf(id);
			const bot = bots.find((b) => b.id === id);
			await deps.removing?.(id);
			await conversation?.abort(context, { background: true });
			await harness.commit(async (tx) => {
				delete (await tx.doc(BotsDoc)).bots[String(id)];
			}, context);
			if (bot !== undefined) await rm(join(dir, botFolder(bot)), { recursive: true, force: true });
			await reload();
		},
		/** Receive the list whenever a bot is added, edited, removed, starts or stops work, or gets a message. */
		subscribe(listener: (bots: BotView[]) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async close() {
			listeners.clear();
			clearTimeout(timer);
			files.close();
			await watch?.stop();
			for (const entry of chats.values()) {
				entry.stop();
				await entry.chat.close();
			}
			chats.clear();
		},
	};
}
