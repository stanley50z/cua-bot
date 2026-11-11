// The owner's bots. The main bot is the root conversation; every other bot is an ownerless conversation
// of its own. All of them run the same tools and Cua Spaces and share memory through tags (src/memory.ts); each has a name, its own chat, and
// its own folder bots/<name>/ holding agent.md (its standing instructions, re-read every turn, so hand
// edits apply at once), routines.json (src/routines.ts), and work-log.md (src/memory.ts). This module is the one
// that knows that layout (botFile) and turns a bot id into its conversation (botLookup). The folder follows
// a rename and goes with a delete, and createBots carries both through to the bot's memory tag and routines.
// Bots message each other with message_bot: the text lands in the other bot's chat as
// a `cua-bot.bot-message` entry (shown as "Message from <name>") and wakes it on a later turn.
// main.ts installs createBotsExtension() before Harness.open, makes one botLookup() after it for bindRoutines and
// createBots, then builds the manager with createBots() for the web portal, which lists, adds, edits, and deletes bots
// and gives each one a Chat.
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
import { type Chat, type ChatItem, createChat, SEND_MESSAGE, SENT_MESSAGE, type SentMessage } from "./chat.ts";
import type { ComputerView } from "./computer-view.ts";
import type { Memory } from "./memory.ts";
import { parseModelRef, parseThinkingLevel } from "./models.ts";
import { removeBotRoutines, syncRoutines } from "./routines.ts";
import type { Turns } from "./turns.ts";

export const MAIN_NAME = "cua-bot";
/** One folder per bot, in the project root. */
export const DEFAULT_BOTS_DIR = join(import.meta.dirname, "..", "bots");
const AGENT_FILE = "agent.md";
const ROUTINES_FILE = "routines.json";
const NAME_MAX = 40;
const MESSAGE_MAX = 8000;
/** Messages one bot may send per rolling hour, so two bots can't keep each other awake forever. */
const SEND_LIMIT = 20;
const HOUR_MS = 60 * 60 * 1000;

/** The avatar characters the web portal draws, by id; src/app.html holds each shape's drawing and each color's value. */
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
 * `avatar` is the one to draw: the owner's pick, else `defaultAvatar`, which the web portal's Reset goes back to.
 * `pinnedAt` is set while the bot is pinned; the web portal shows pinned bots at the top, oldest pin first.
 * `model` and `thinkingLevel` are set only while the bot overrides Settings > Model.
 */
type BotEntry = { id: number; name: string; main: boolean; createdAt: number; avatar: Avatar; defaultAvatar: Avatar; pinnedAt?: number; model?: string; thinkingLevel?: ModelThinkingLevel };
/** `folder` is the bot's folder and `file` its agent file, as paths from the project root, for the web portal. */
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

/**
 * Every bot, the main bot first, read from the bots doc alone. The memory extension and the memory note in main.ts use
 * it, because main.ts makes both before Harness.open; code that runs after it lists bots through botLookup's list().
 */
export const readBots = async (reader: Pick<Harness, "snapshot">, context: Context) => botsOf(await reader.snapshot(BotsDoc, context));

/** A name as a file name or memory tag: "Job Search" → "job-search". */
export const slugOf = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");

/** What names a bot's folder: its id and name. */
type BotRef = Pick<BotEntry, "id" | "name">;

/** The bot's folder name under bots/: "Job Search" → "job-search". src/memory.ts derives the bot's `@<folder>` tag from it. */
export function botFolder(bot: BotRef): string {
	const slug = slugOf(bot.name);
	if (slug === "") return `bot-${bot.id}`;
	// Windows reserves these names for devices.
	return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug) ? `${slug}-bot` : slug;
}

/** The files a bot's folder holds: its instructions, its routines (src/routines.ts), and the records of its own work (src/memory.ts). */
export type BotFile = typeof AGENT_FILE | typeof ROUTINES_FILE | "work-log.md";

// The bot's folder in `dir`. Every path under a bot's folder is joined here or in botFile.
const folderPath = (dir: string, bot: BotRef) => join(dir, botFolder(bot));

/** Where one of the bot's files lives in `dir`, the folder of bot folders. src/memory.ts reads the work log through it. */
export const botFile = (dir: string, bot: BotRef, file: BotFile) => join(folderPath(dir, bot), file);

export type BotLookup = ReturnType<typeof botLookup>;

/**
 * Finds the bots and what is theirs: every bot, a bot's conversation, and the files in its folder. main.ts makes the
 * one lookup right after Harness.open and hands it to bindRoutines and then createBots; the approval cards find the
 * bot that asked through it.
 */
export function botLookup(harness: Pick<Harness, "snapshot" | "conversation">, root: Conversation, dir = DEFAULT_BOTS_DIR) {
	return {
		/** The main bot's conversation. */
		root,
		/** The folder of bot folders. */
		dir,
		/** Every bot, the main bot first. Until createBots first records the root as the main bot, the root is listed as it. */
		async list(context: Context): Promise<BotEntry[]> {
			const bots = botsOf(await harness.snapshot(BotsDoc, context));
			return bots.some((bot) => bot.main) ? bots : [entryOf(Number(root.id), { name: MAIN_NAME, createdAt: 0 }, true), ...bots];
		},
		/**
		 * The conversation of the bot with this id; the main bot's when `id` is undefined. Undefined when no conversation
		 * has the id. A deleted bot's conversation stays in the database, so this still finds it.
		 */
		conversation: async (id: number | undefined, context: Context): Promise<Conversation | undefined> =>
			id === undefined ? root : harness.conversation(id as ConversationId, context),
		/** Where one of the bot's files lives. */
		file: (bot: BotRef, file: BotFile) => botFile(dir, bot, file),
	};
}

const agentPath = (dir: string, bot: BotEntry) => botFile(dir, bot, AGENT_FILE);

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
	await mkdir(folderPath(dir, bot), { recursive: true });
	await writeFile(`${path}.tmp`, instructions === "" ? "" : `${instructions}\n`, "utf8");
	await rename(`${path}.tmp`, path);
}

const pathsOf = (dir: string, bot: BotEntry) => {
	const folder = `${basename(dir)}/${botFolder(bot)}`;
	return { folder, file: `${folder}/${AGENT_FILE}` };
};

const loadBots = (dir: string, state: Readonly<BotsState> | null | undefined): Promise<Bot[]> =>
	Promise.all(botsOf(state).map(async (bot) => ({ ...bot, instructions: await readAgentFile(dir, bot), ...pathsOf(dir, bot) })));

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
// there (one the owner made by hand) is adopted. Used by create_bot and the web portal.
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
		`Your name is ${me.name}. You are one of the owner's bots; each has its own chat with the owner, and all of you share the owner's accounts, the Cua Spaces, and memory, by tag.`,
	];
	if (me.instructions !== "") lines.push(`The owner's standing instructions for you, from your agent file ${me.file}:\n${me.instructions}`);
	lines.push(
		`Your folder ${me.folder}/ holds your agent file and your routines (routines.json), which the owner edits in the web portal, and the files you keep for your own work; other bots have theirs.`,
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

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true as const } : {}) });

/**
 * The bots' tools and prompt section. `agent` is the model settings each new bot starts with; message_bot delivers
 * through `turns`; `dir` holds the bot folders.
 */
export function createBotsExtension(options: { agent: () => AgentChange; turns: Turns; dir?: string }): Extension {
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
			await options.turns.deliver(handle, { kind: "bot", from: me, text: body, task: Number(api.taskId) }, api, context);
			sent.set(self, [...recent, now]);
			return reply(`Sent to ${target.name}. A reply, if any, arrives later as a [bot] message; don't wait for it.`);
		},
	});

	// The chat shows the text (src/chat.ts) and main.ts pushes it, both from the transcript. A call the model makes is already
	// there; one made inside another tool, such as a codemode script, isn't (its ID is <parent>/<key>), so it writes an entry.
	const sendMessage = defineTool({
		name: SEND_MESSAGE,
		description:
			"Send the owner a message. It appears in your chat and pops up in their browser as a notification. This is the only way the owner sees anything you write: your own text is private notes. When nothing needs the owner, send nothing.",
		parameters: Type.Object({
			text: Type.String({ description: "The message, in Markdown, complete on its own" }),
		}),
		execute: async ({ text }, api, context) => {
			if (text.trim() === "") return reply("The message is empty.", true);
			if (api.callId.includes("/")) {
				const data: SentMessage = { text, at: api.now() };
				await api.commit((tx) => tx.appendEntry(api.conversationId, { kind: SENT_MESSAGE, data }), context);
			}
			return reply("Sent.");
		},
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
	/** The newest message from another bot; the web portal shows it instead when it is newer and bot talk is on. */
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
 * web portal, and one Chat per bot. Records the root as the main bot on first start. A rename or delete
 * carries through to the bot's folder, its memory tag, and its routines, which must be bound
 * (bindRoutines in src/routines.ts) first. One watch on the bot folders sends hand edits to an agent file to
 * the web portal and hand edits to a routines.json to syncRoutines. Call close() on shutdown.
 */
export async function createBots(deps: {
	harness: Harness;
	/** The lookup over `harness` that routines were bound with: the main bot's conversation and the folder of bot folders. */
	lookup: BotLookup;
	context: Context;
	/** The model settings a bot runs with unless it overrides them, as of the call. */
	agent: () => AgentChange;
	/** The owner's memory, whose tag for a bot follows its rename and comes off its facts when it is deleted. */
	memory: Pick<Memory, "botRenamed" | "botRemoved">;
	/** Told when a sync after a hand edit to a routines.json fails, or the watch on the bot folders does. */
	onError: (error: unknown) => void;
	computer?: (conversation: Conversation) => ComputerView;
	/** Each message a bot sends the owner with send_message, in any bot's chat; main.ts pushes it to the owner's browser. */
	sent?: (bot: Bot, text: string) => void;
	/** How each bot's chat delivers the owner's messages and reactions. */
	turns: Turns;
}) {
	const { harness, lookup, context, memory, onError } = deps;
	const { root, dir } = lookup;
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
		const conversation = await lookup.conversation(bot.id, context);
		if (conversation === undefined) return;
		const computer = deps.computer?.(conversation);
		const chat = createChat({ harness, conversation, context, turns: deps.turns, ...(computer === undefined ? {} : { computer }) });
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

	// The doc changes when the web portal edits a bot or a bot runs create_bot.
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
	// The one watch on the bot folders. A hand edit to an agent file reaches the web portal within a second (prompts
	// re-read the file every turn anyway), and one to a routines.json syncs that bot's routines within a second or two.
	// Each waits for 250 ms of quiet, since an editor's save is several events.
	let agentTimer: ReturnType<typeof setTimeout> | undefined;
	let routinesTimer: ReturnType<typeof setTimeout> | undefined;
	const files = watchFiles(dir, { recursive: true }, (_event, filename) => {
		const name = filename?.toString();
		if (name === undefined || name.endsWith(AGENT_FILE)) {
			clearTimeout(agentTimer);
			agentTimer = setTimeout(() => void reload(), 250);
		}
		if (name === undefined || name.endsWith(ROUTINES_FILE)) {
			clearTimeout(routinesTimer);
			routinesTimer = setTimeout(() => void syncRoutines(context).catch(onError), 250);
		}
	});
	files.on("error", onError);

	return {
		list,
		main: () => Number(root.id),
		/** The bot's chat; the main bot's when `id` is undefined. Undefined for an unknown bot. */
		async chat(id?: number): Promise<Chat | undefined> {
			await pending;
			const conversation = await lookup.conversation(id, context);
			return conversation === undefined ? undefined : chats.get(Number(conversation.id))?.chat;
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
				const after = { id, name: valid.name };
				if (botFolder(before) !== botFolder(after) && existsSync(folderPath(dir, after))) {
					throw new BotError(400, `${basename(dir)}/${botFolder(after)} already exists; move it away or pick another name.`);
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
			// The folder follows a rename, with everything in it; this is the only move of a bot's files. Then the bot's
			// memory tag follows, and its routines resync, finding their file in the new folder.
			const from = folderPath(dir, before);
			if (botFolder(before) !== botFolder(bot) && existsSync(from)) await rename(from, folderPath(dir, bot));
			await writeAgentFile(dir, bot, bot.instructions);
			await reload();
			if (bot.name !== before.name) {
				await memory.botRenamed(before, bot);
				await syncRoutines(context);
			}
			return { ...bot, ...pathsOf(dir, bot) };
		},
		/** Pins the bot to the top of the web portal's list, after the bots already pinned, or unpins it. Pinning a pinned bot keeps its place. */
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
		/**
		 * Deletes the bot: while its record still names it, takes its tag off its facts and the owner's tags and ends its
		 * routines; then stops its turn, drops it from the list, and deletes its folder. Its transcript stays in the database.
		 * The main bot can't go.
		 */
		async remove(id: number): Promise<void> {
			if (id === Number(root.id)) throw new BotError(400, "The main bot can't be deleted.");
			const bot = bots.find((b) => b.id === id);
			if (bot === undefined) throw new BotError(404, "No such bot.");
			const conversation = await lookup.conversation(id, context);
			await memory.botRemoved(bot);
			await removeBotRoutines(id, context);
			await conversation?.abort(context, { background: true });
			await harness.commit(async (tx) => {
				delete (await tx.doc(BotsDoc)).bots[String(id)];
			}, context);
			await rm(folderPath(dir, bot), { recursive: true, force: true });
			await reload();
		},
		/** Receive the list whenever a bot is added, edited, removed, starts or stops work, or gets a message. */
		subscribe(listener: (bots: BotView[]) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async close() {
			listeners.clear();
			clearTimeout(agentTimer);
			clearTimeout(routinesTimer);
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
