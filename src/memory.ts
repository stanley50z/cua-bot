// Long-term memory about the owner, as plain markdown the owner can read and edit: one store, data/memory/,
// where each fact's tags say which bots get it. main.ts runs migrateMemory, installs createMemoryExtension
// so every bot gets remember / forget / search_memory and sees its facts in every request, and hands the store to
// the web app (GET/POST /api/memory). Layout of the store:
//   profile.md          enduring facts about the owner ("About the owner")
//   log/YYYY-MM.md      dated facts, one file per month
//   tags.json           the owner's tags and the bots in each, by id
// Each fact is one line: `- (YYYY-MM-DD) [tag, tag] fact`. A fact with no tags reaches no bot. Other lines
// are left alone. Tags are every-bot, @<bot folder> for one bot (always there), or a key of tags.json. The
// files are the source of truth and are re-read on every call, so hand edits apply at once.
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineExtension, defineTool, type Extension, type Harness, section } from "@earendil-works/pi-durable";
import { botFolder, slugOf } from "./bots.ts";

export type Tier = "profile" | "log";
export type Fact = { text: string; date: string; tier: Tier; file: string; tags: string[] };
/** A tag and the bots that get its facts. */
export type TagView = { slug: string; name: string; kind: "every" | "custom" | "bot"; bots: number[] };
type BotRef = { id: number; name: string };
type CustomTags = Record<string, { name: string; bots: number[] }>;

/** The tag every bot has, including ones made later. */
export const EVERY_BOT = "every-bot";
/** The tag only this bot has. A bot's rename or delete reaches it through botRenamed and botRemoved. */
export const botTag = (bot: BotRef) => `@${botFolder(bot)}`;

const MAX_FACT = 500;
const RECENT_LIMIT = 30;
const SEARCH_LIMIT = 20;
/** A word in an incoming message is a keyword when at most one in this many of the bot's facts has it, so "the" and "owner" don't count. */
const KEYWORD_RARITY = 10;
const TAG = "@?[\\p{L}\\p{N}-]+";
const FACT_LINE = new RegExp(`^-\\s+\\((\\d{4}-\\d{2}-\\d{2})\\)\\s+(?:\\[(${TAG}(?:,\\s*${TAG})*)\\]\\s+)?(.+?)\\s*$`, "u");
const PROFILE_HEADER = "# About the owner\n";

export class MemoryError extends Error {}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
const same = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();

const wordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
// A message's distinct words of three letters or more, or two characters in scripts like Chinese.
const messageWords = (message: string) => [
	...new Set(
		[...wordSegmenter.segment(message.toLowerCase())]
			.filter(({ segment, isWordLike }) => isWordLike && segment.length >= (/^[\p{ASCII}]+$/u.test(segment) ? 3 : 2))
			.map(({ segment }) => segment),
	),
];

// A keyword matches at the start of a word, so "submit" finds "submitted" and "red" skips "offered". Scripts written
// without spaces, like Chinese, have no word starts to look for, so there it matches anywhere.
const keywordPattern = (keyword: string) => new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${keyword.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}`, "iu");

// The facts matching the most keywords, newest first among equals.
function ranked(facts: Fact[], keywords: string[]): Fact[] {
	const patterns = keywords.map(normalize).filter((keyword) => keyword !== "").map(keywordPattern);
	return facts
		.map((fact) => ({ fact, score: patterns.filter((pattern) => pattern.test(fact.text)).length }))
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || b.fact.date.localeCompare(a.fact.date))
		.slice(0, SEARCH_LIMIT)
		.map((hit) => hit.fact);
}

function localDate(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function readText(file: string): Promise<string | undefined> {
	const text = await readFile(file, "utf8").catch(() => undefined);
	return text?.replace(/^﻿/, "");
}

// Write through a temp file so a crash never leaves half a memory file.
async function writeText(file: string, text: string): Promise<void> {
	await writeFile(`${file}.tmp`, text, "utf8");
	await rename(`${file}.tmp`, file);
}

// The text as a fact stores it, or a MemoryError when a fact cannot hold it.
function factText(text: string): string {
	const fact = normalize(text);
	if (fact === "") throw new MemoryError("A fact cannot be empty.");
	if (fact.length > MAX_FACT) throw new MemoryError(`A fact is at most ${MAX_FACT} characters; this one is ${fact.length}.`);
	return fact;
}

function parseFact(line: string, tier: Tier, file: string): Fact | undefined {
	const match = FACT_LINE.exec(line);
	if (match === null) return undefined;
	return { date: match[1] as string, tags: match[2]?.split(/,\s*/) ?? [], text: match[3] as string, tier, file };
}

const factLine = (fact: Pick<Fact, "date" | "tags" | "text">) => `- (${fact.date}) ${fact.tags.length > 0 ? `[${fact.tags.join(", ")}] ` : ""}${fact.text}`;

const factsIn = (text: string | undefined, tier: Tier, file: string) => (text ?? "").split(/\r?\n/).flatMap((line) => parseFact(line, tier, file) ?? []);

const canSee = (fact: Fact, seen: ReadonlySet<string>) => fact.tags.some((tag) => seen.has(tag));
const customView = (slug: string, tag: CustomTags[string]) => ({ slug, name: tag.name, kind: "custom", bots: tag.bots }) satisfies TagView;

export type Memory = ReturnType<typeof createMemory>;

export function createMemory(options: { dir: string; now?: () => Date }) {
	const { dir } = options;
	const now = options.now ?? (() => new Date());
	const logDir = join(dir, "log");
	const profileFile = join(dir, "profile.md");
	const tagsFile = join(dir, "tags.json");
	// Serialize writes so two tool calls never interleave a read-modify-write.
	let queue = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const run = queue.then(work);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	async function logFiles(): Promise<string[]> {
		const names = await readdir(logDir).catch(() => [] as string[]);
		return names.filter((name) => /^\d{4}-\d{2}\.md$/.test(name)).sort();
	}

	/** Every fact: profile in file order, then log facts oldest first. */
	async function all(): Promise<{ profile: Fact[]; log: Fact[] }> {
		const profile = factsIn(await readText(profileFile), "profile", "profile.md");
		const log: Fact[] = [];
		for (const name of await logFiles()) log.push(...factsIn(await readText(join(logDir, name)), "log", `log/${name}`));
		return { profile, log };
	}

	async function visible(seen: ReadonlySet<string>): Promise<Fact[]> {
		const { profile, log } = await all();
		return [...profile, ...log].filter((fact) => canSee(fact, seen));
	}

	// Runs every fact line through `change`, in place: the same fact keeps its line, another replaces it, null removes it.
	async function rewrite(change: (fact: Fact) => Fact | null): Promise<void> {
		for (const name of ["profile.md", ...(await logFiles()).map((month) => `log/${month}`)]) {
			const file = join(dir, name);
			const before = await readText(file);
			if (before === undefined) continue;
			let changed = false;
			const lines = before.split(/\r?\n/).flatMap((line) => {
				const fact = parseFact(line, name === "profile.md" ? "profile" : "log", name);
				if (fact === undefined) return [line];
				const after = change(fact);
				if (after === fact) return [line];
				changed = true;
				return after === null ? [] : [factLine(after)];
			});
			if (changed) await writeText(file, lines.join("\n"));
		}
	}

	// Changes the tier's first fact whose text matches and returns it, or undefined when none matches.
	async function changeFact(tier: Tier, text: string, change: (fact: Fact) => Fact): Promise<Fact | undefined> {
		let changed: Fact | undefined;
		await rewrite((fact) => (changed !== undefined || fact.tier !== tier || !same(fact.text, text) ? fact : (changed = change(fact))));
		return changed;
	}

	const renameTag = (from: string, to: string) => rewrite((fact) => (fact.tags.includes(from) ? { ...fact, tags: [...new Set(fact.tags.map((tag) => (tag === from ? to : tag)))] } : fact));
	const dropTag = (slug: string) => rewrite((fact) => (fact.tags.includes(slug) ? { ...fact, tags: fact.tags.filter((tag) => tag !== slug) } : fact));

	async function customTags(): Promise<CustomTags> {
		const text = await readText(tagsFile);
		if (text === undefined) return {};
		try {
			return JSON.parse(text) as CustomTags;
		} catch (error) {
			throw new MemoryError(`${tagsFile} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function saveTags(tags: CustomTags): Promise<void> {
		await mkdir(dir, { recursive: true });
		await writeText(tagsFile, `${JSON.stringify(tags, null, "\t")}\n`);
	}

	// The slug a tag with this name gets, or a MemoryError when another tag has it. `current` is the tag being renamed.
	function freeSlug(name: string, tags: CustomTags, current?: string): string {
		const slug = slugOf(name);
		if (slug === "") throw new MemoryError("A tag's name needs a letter or number.");
		if (slug === EVERY_BOT || (slug !== current && Object.hasOwn(tags, slug))) throw new MemoryError(`"${name}" is already a tag.`);
		return slug;
	}

	return {
		dir,
		all,

		/** Save a fact under at least one tag. Returns it, or the existing one with these tags added when the same text is already in that tier. */
		remember: (text: string, tier: Tier, tags: string[]) =>
			serial(async () => {
				const fact = factText(text);
				if (tags.length === 0) throw new MemoryError("A fact needs at least one tag.");
				const existing = (await all())[tier].find((known) => same(known.text, fact));
				if (existing !== undefined) {
					const merged = [...new Set([...existing.tags, ...tags])];
					return { fact: (await changeFact(tier, fact, (known) => ({ ...known, tags: merged }))) as Fact, added: false };
				}
				const date = localDate(now());
				const name = tier === "profile" ? "profile.md" : `log/${date.slice(0, 7)}.md`;
				const file = join(dir, name);
				await mkdir(tier === "profile" ? dir : logDir, { recursive: true });
				const before = (await readText(file)) ?? (tier === "profile" ? PROFILE_HEADER : `# ${date.slice(0, 7)}\n`);
				const saved = { text: fact, date, tier, file: name, tags: [...new Set(tags)] } satisfies Fact;
				await writeText(file, `${before}${before.endsWith("\n") ? "" : "\n"}${factLine(saved)}\n`);
				return { fact: saved, added: true };
			}),

		/** Reword the tier's fact whose text matches, on its own line and keeping its date and tags. Returns it, or undefined when none matches. */
		edit: (before: string, after: string, tier: Tier) =>
			serial(async () => {
				const fact = factText(after);
				const known = (await all())[tier];
				if (!known.some((candidate) => same(candidate.text, before))) return undefined;
				if (known.some((other) => !same(other.text, before) && same(other.text, fact))) throw new MemoryError(`"${fact}" is already saved.`);
				return changeFact(tier, before, (target) => ({ ...target, text: fact }));
			}),

		/** Replace the tags of the tier's fact whose text matches; no tags leaves it for no bot. Returns it, or undefined when none matches. */
		retag: (text: string, tier: Tier, tags: string[]) => serial(() => changeFact(tier, text, (known) => ({ ...known, tags: [...new Set(tags)] }))),

		/** Remove every fact whose text matches, ignoring case and spacing; given `seen`, only facts with one of those tags. Returns the removed facts. */
		forget: (text: string, seen?: ReadonlySet<string>) =>
			serial(async () => {
				const removed: Fact[] = [];
				await rewrite((fact) => {
					if (!same(fact.text, text) || (seen !== undefined && !canSee(fact, seen))) return fact;
					removed.push(fact);
					return null;
				});
				return removed;
			}),

		/** Facts with one of these tags matching the most keywords, best first. */
		search: async (keywords: string[], seen: ReadonlySet<string>) => ranked(await visible(seen), keywords),

		/** The same search with an incoming message as its keywords: its words found in these facts, but not in too many of them. */
		async searchMessage(message: string, seen: ReadonlySet<string>) {
			const facts = await visible(seen);
			const most = Math.ceil(facts.length / KEYWORD_RARITY);
			const keywords = messageWords(message).filter((word) => {
				const pattern = keywordPattern(word);
				const count = facts.filter((fact) => pattern.test(fact.text)).length;
				return count > 0 && count <= most;
			});
			return { keywords, facts: ranked(facts, keywords) };
		},

		/** The facts with one of these tags, for a system prompt. Changes only when the files change, so the prompt cache holds. */
		async render(seen: ReadonlySet<string>): Promise<string> {
			const stored = await all();
			const profile = stored.profile.filter((fact) => canSee(fact, seen));
			const log = stored.log.filter((fact) => canSee(fact, seen));
			if (profile.length + log.length === 0) return "Nothing saved yet.";
			const lines: string[] = [];
			const line = (fact: Fact) => `- (${fact.date}) ${fact.text} [${fact.tags.join(", ")}]`;
			const recent = log.slice(-RECENT_LIMIT);
			if (profile.length > 0) lines.push("About the owner:", ...profile.map(line));
			if (recent.length > 0) lines.push("Recently:", ...recent.map(line));
			const hidden = log.length - recent.length;
			if (hidden > 0) lines.push(`(${hidden} older ${hidden === 1 ? "fact is" : "facts are"} not shown; use search_memory to search them.)`);
			return lines.join("\n");
		},

		/** Every tag and who holds it, among these bots: Every bot, then the owner's, then one per bot. */
		async tagViews(bots: BotRef[]): Promise<TagView[]> {
			const known = new Set(bots.map((bot) => bot.id));
			return [
				{ slug: EVERY_BOT, name: "Every bot", kind: "every", bots: bots.map((bot) => bot.id) },
				...Object.entries(await customTags()).map(([slug, tag]) => customView(slug, { name: tag.name, bots: tag.bots.filter((id) => known.has(id)) })),
				...bots.map((bot) => ({ slug: botTag(bot), name: bot.name, kind: "bot" as const, bots: [bot.id] })),
			];
		},

		/** Make one of the owner's tags. Settings > Memory tags. */
		createTag: (name: string, bots: number[]) =>
			serial(async () => {
				const tags = await customTags();
				const tag = { name: normalize(name), bots };
				const slug = freeSlug(tag.name, tags);
				await saveTags({ ...tags, [slug]: tag });
				return customView(slug, tag);
			}),

		/** Rename one of the owner's tags, which rewrites its facts, and set its bots. Returns it, or undefined when there is no such tag. */
		updateTag: (slug: string, change: { name: string; bots: number[] }) =>
			serial(async () => {
				const tags = await customTags();
				if (!Object.hasOwn(tags, slug)) return undefined;
				const tag = { name: normalize(change.name), bots: change.bots };
				const next = freeSlug(tag.name, tags, slug);
				await saveTags(Object.fromEntries(Object.entries(tags).map(([key, old]) => (key === slug ? [next, tag] : [key, old]))));
				if (next !== slug) await renameTag(slug, next);
				return customView(next, tag);
			}),

		/** Delete one of the owner's tags. Its facts keep any other tags; with none left they reach no bot. Returns false when there is no such tag. */
		deleteTag: (slug: string) =>
			serial(async () => {
				const tags = await customTags();
				if (!Object.hasOwn(tags, slug)) return false;
				await saveTags(Object.fromEntries(Object.entries(tags).filter(([key]) => key !== slug)));
				await dropTag(slug);
				return true;
			}),

		/** Keeps a renamed bot's facts on its tag. Called by createBots through main.ts. */
		botRenamed: (before: BotRef, after: BotRef) => serial(() => renameTag(botTag(before), botTag(after))),

		/** Takes a deleted bot off its facts and out of the owner's tags. Called by createBots through main.ts. */
		botRemoved: (bot: BotRef) =>
			serial(async () => {
				const tags = await customTags();
				await saveTags(Object.fromEntries(Object.entries(tags).map(([key, tag]) => [key, { ...tag, bots: tag.bots.filter((id) => id !== bot.id) }])));
				await dropTag(botTag(bot));
			}),
	};
}

/**
 * Once per install, at startup before any bot runs: moves memory from before tags into the one store. Shared
 * facts get every-bot, each bots/<folder>/memory/ fact gets @<folder>, and the same text in a tier becomes one
 * fact with both tags and the earliest date. Everything is copied to `backupDir` first. tags.json marks it done. Returns whether it moved anything.
 */
export async function migrateMemory(options: { dir: string; botsDir: string; backupDir: string }): Promise<boolean> {
	const { dir, botsDir, backupDir } = options;
	if (existsSync(join(dir, "tags.json"))) return false;
	const folders = await readdir(botsDir).catch(() => [] as string[]);
	const stores = [
		{ tag: EVERY_BOT, path: dir, backup: "memory" },
		...folders.map((folder) => ({ tag: `@${folder}`, path: join(botsDir, folder, "memory"), backup: join("bots", folder, "memory") })),
	].filter((store) => existsSync(store.path));

	type Moved = { date: string; tags: string[]; text: string };
	const files = new Map<string, { notes: string[]; facts: Moved[] }>();
	const byText = new Map<string, Moved>();
	for (const { tag, path } of stores) {
		const months = (await readdir(join(path, "log")).catch(() => [] as string[])).filter((name) => /^\d{4}-\d{2}\.md$/.test(name));
		for (const name of ["profile.md", ...months.map((month) => `log/${month}`)]) {
			const before = await readText(join(path, name));
			if (before === undefined) continue;
			const file = files.get(name) ?? { notes: [], facts: [] };
			files.set(name, file);
			for (const line of before.split(/\r?\n/)) {
				const match = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/.exec(line);
				if (match === null) {
					if (line.trim() !== "" && !file.notes.includes(line)) file.notes.push(line);
					continue;
				}
				const key = `${name === "profile.md" ? "profile" : "log"}:${normalize(match[2] as string).toLowerCase()}`;
				const known = byText.get(key);
				const fact = { date: match[1] as string, tags: [tag], text: match[2] as string };
				if (known !== undefined) {
					if (!known.tags.includes(tag)) known.tags.push(tag);
					if (fact.date < known.date) Object.assign(known, { date: fact.date, text: fact.text });
					continue;
				}
				byText.set(key, fact);
				file.facts.push(fact);
			}
		}
	}
	if (files.size === 0) {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "tags.json"), "{}\n", "utf8");
		return false;
	}

	// Built beside the store and swapped in whole, so a crash here leaves the old files as they were.
	const next = `${dir}.new`;
	await rm(next, { recursive: true, force: true });
	await mkdir(join(next, "log"), { recursive: true });
	for (const [name, file] of files) {
		const lines = [...file.notes, ...file.facts.toSorted((a, b) => a.date.localeCompare(b.date)).map(factLine)];
		await writeFile(join(next, name), `${lines.join("\n")}\n`, "utf8");
	}
	await writeFile(join(next, "tags.json"), "{}\n", "utf8");
	for (const { path, backup } of stores) await cp(path, join(backupDir, backup), { recursive: true });
	await rm(dir, { recursive: true, force: true });
	await rename(next, dir);
	for (const { tag, path } of stores) if (tag !== EVERY_BOT) await rm(path, { recursive: true, force: true });
	return true;
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ output: [{ type: "text" as const, text: value }], isError: true as const });
const listed = (facts: Fact[]) => facts.map((fact) => `- (${fact.date}) ${fact.text} [${fact.tags.join(", ")}] (${fact.tier})`).join("\n");
const seenBy = (me: BotRef | undefined, tags: TagView[]) => new Set(me === undefined ? [EVERY_BOT] : tags.filter((tag) => tag.bots.includes(me.id)).map((tag) => tag.slug));

/** What `search_memory` finds for a message from the owner or another bot to bot `id`, as a note for that bot; undefined when it finds nothing. writeMemoryNote places it before the message. */
export async function messageNote(memory: Memory, message: string, id: number, bots: BotRef[]): Promise<string | undefined> {
	const { keywords, facts } = await memory.searchMessage(message, seenBy(bots.find((bot) => bot.id === id), await memory.tagViews(bots)));
	if (facts.length === 0) return undefined;
	return `[search_memory] Saved facts matching keywords in the next message (${keywords.join(", ")}):\n${listed(facts)}`;
}

/**
 * Every bot's memory tools and prompt section. `bots` lists the bots, to resolve who holds which tag and whose
 * conversation is asking; a conversation that isn't a bot has only every-bot. Installed by src/main.ts.
 */
export function createMemoryExtension(deps: { memory: Memory; bots: (read: Pick<Harness, "snapshot">, context: Context) => Promise<BotRef[]> }): Extension {
	const { memory } = deps;
	const viewer = async (conversationId: ConversationId, read: Pick<Harness, "snapshot">, context: Context) => {
		const bots = await deps.bots(read, context);
		const tags = await memory.tagViews(bots);
		const me = bots.find((bot) => bot.id === Number(conversationId));
		return { bots, tags, me, seen: seenBy(me, tags) };
	};

	const remember = defineTool({
		name: "remember",
		description:
			"Save a lasting fact to long-term memory. One short sentence per fact. tags: which bots get it, from the tags in your memory section, the narrowest that fit; every-bot is for identity, people, accounts, preferences, and rules for all bots. tier profile: enduring facts. tier log: dated events and plans.",
		parameters: Type.Object({
			fact: Type.String({ description: "The fact, as one short sentence" }),
			tags: Type.Array(Type.String(), { description: "Tags of the bots that need it" }),
			tier: Type.Union([Type.Literal("profile"), Type.Literal("log")], { description: "profile or log" }),
		}),
		execute: async (args, api, context) => {
			const { tags } = await viewer(api.conversationId, api, context);
			const missing = args.tags.find((tag) => !tags.some((known) => known.slug === tag));
			if (missing !== undefined) return failure(`No tag is named ${missing}. Tags: ${tags.map((tag) => tag.slug).join(", ")}.`);
			try {
				const { fact, added } = await memory.remember(args.fact, args.tier, args.tags);
				return text(`${added ? "remembered" : "already remembered"} (${fact.tags.join(", ")}, ${fact.tier}): ${fact.text}`);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
		},
	});
	const forget = defineTool({
		name: "forget",
		description: "Remove a fact you can see from long-term memory. Pass the fact's exact text as shown in memory, without its tags or date.",
		parameters: Type.Object({ fact: Type.String({ description: "Exact text of the fact to remove" }) }),
		execute: async (args, api, context) => {
			const removed = await memory.forget(args.fact, (await viewer(api.conversationId, api, context)).seen);
			return removed.length > 0 ? text(`forgot:\n${listed(removed)}`) : failure(`No saved fact matches "${normalize(args.fact)}".`);
		},
	});
	const searchMemory = defineTool({
		name: "search_memory",
		description: "Search the long-term memory you can see by keyword, including older facts that are not shown in the prompt. Facts matching the most keywords come first.",
		parameters: Type.Object({ keywords: Type.Array(Type.String(), { description: "One or more keywords or short phrases, each matched at the start of a word" }) }),
		execute: async (args, api, context) => {
			const hits = await memory.search(args.keywords, (await viewer(api.conversationId, api, context)).seen);
			return text(hits.length > 0 ? listed(hits) : "No saved facts match.");
		},
	});
	return defineExtension({
		name: "memory",
		tools: [remember, forget, searchMemory],
		sections: [
			section("memory", async (input, context) => {
				const { bots, tags, me, seen } = await viewer(input.conversationId, input.read, context);
				const holders = (tag: TagView) => {
					if (tag.kind === "every") return "every bot";
					if (tag.kind === "bot" && tag.bots[0] === me?.id) return "you";
					return bots.filter((bot) => tag.bots.includes(bot.id)).map((bot) => bot.name).join(", ") || "no bots yet";
				};
				return [
					"Memory: durable facts kept across every conversation. Rely on them instead of asking again.",
					"When you learn something lasting, save it with remember: tags for the bots that need it, the narrowest that fit; tier profile for enduring facts, tier log for dated events and plans. Just do it and mention it in passing; don't ask permission. Use forget with the exact text when a fact is wrong or outdated, and search_memory to search older facts by keyword.",
					`Tags you can use: ${tags.map((tag) => `${tag.slug} (${holders(tag)})`).join(", ")}.`,
					"What you know, each fact followed by its tags:",
					await memory.render(seen),
				].join("\n");
			}),
		],
	});
}
