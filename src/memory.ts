// Long-term memory about the owner, as plain markdown the owner can read and edit: one store, data/memory/,
// where each fact's tags say which bots get it. main.ts runs migrateMemory, installs createMemoryExtension
// so every bot gets remember / forget / search_memory and sees its facts in every request, gives the main bot
// list_memory / change_memory over every fact, and hands the store to the web portal
// (GET/POST /api/memory). Layout of the store:
//   profile.md          enduring facts about the owner ("About the owner")
//   log/YYYY-MM.md      dated facts, one file per month
//   tags.json           the owner's tags and the bots in each, by id
// change_memory copies the whole store to data/memory-backups/<date>-<time>/ before it changes anything.
// A bot's records of its own work are not facts and live outside the store, in work-log.md in the bot's folder.
// The memory section sends bots there, and with a relevance judge (src/jev.ts) messageNote brings the lines of
// that file that bear on an incoming message, along with the older facts that do.
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
/** One change to the tier's fact whose text matches: `to` rewords it, `tags` replaces its tags, both do both, and `forget` removes it. */
export type Change = { fact: string; tier: Tier; to?: string; tags?: string[]; forget?: boolean };
/** Judges how likely each of these saved facts or work-log records is to bear on a message: one probability from 0 to 1 per text, in their order. src/jev.ts makes one. */
export type Relevance = (message: string, facts: string[]) => Promise<number[]>;
/** The file in a bot's folder for the records of its own work, one per line starting with a dash. The memory section sends bots there. */
export const WORK_LOG = "work-log.md";
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
/** A word is a keyword when at most one in this many of the facts it is judged against has it, so "the" and "owner" don't count. */
const KEYWORD_RARITY = 10;
/** Two facts are similar when they share at least this share of the keywords of the one with fewer; `similarity` has the whole rule. */
const SIMILAR_SHARE = 0.6;
/** A relevance judge's probability from which a fact goes in a message's note. TypeSafe's suggested starting point for a yes. */
const RELEVANT_AT = 0.7;
const TAG = "@?[\\p{L}\\p{N}-]+";
const FACT_LINE = new RegExp(`^-\\s+\\((\\d{4}-\\d{2}-\\d{2})\\)\\s+(?:\\[(${TAG}(?:,\\s*${TAG})*)\\]\\s+)?(.+?)\\s*$`, "u");
const PROFILE_HEADER = "# About the owner\n";

export class MemoryError extends Error {}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
const same = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();

const wordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
// A text's distinct words of three letters or more, or two characters in scripts like Chinese.
const wordsOf = (text: string) => [
	...new Set(
		[...wordSegmenter.segment(text.toLowerCase())]
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

// Tells whether two of these facts, by index, are similar: likely the same fact twice, or two that conflict. They
// are when they share at least SIMILAR_SHARE of the keywords of the one with fewer, and at least two. A fact's
// keywords are its words that at most one in KEYWORD_RARITY of these facts has, as for a message, so among ten
// facts or fewer none are similar.
function similarity(facts: Fact[]): (a: number, b: number) => boolean {
	const most = Math.ceil(facts.length / KEYWORD_RARITY);
	const words = facts.map((fact) => wordsOf(fact.text));
	const count = new Map<string, number>();
	for (const word of words.flat()) count.set(word, (count.get(word) ?? 0) + 1);
	const keywords = words.map((list) => new Set(list.filter((word) => (count.get(word) as number) <= most)));
	return (a, b) => {
		const [one, other] = [keywords[a] as Set<string>, keywords[b] as Set<string>];
		const shared = [...one].filter((word) => other.has(word)).length;
		return shared >= 2 && shared / Math.min(one.size, other.size) >= SIMILAR_SHARE;
	};
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

/**
 * The store in `dir`. With `relevance`, that judge picks the older facts a message brings up, in place of keyword
 * search, and with `botsDir`, the folder of bot folders, it also picks from the receiving bot's work log there;
 * `log` gets a line when it fails.
 */
export function createMemory(options: { dir: string; now?: () => Date; relevance?: Relevance; botsDir?: string; log?: (line: string) => void }) {
	const { dir, relevance } = options;
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

	// The facts with one of these tags, split the way a bot gets them: its memory section shows `profile` and
	// `recent`, the newest RECENT_LIMIT log facts, and leaves `older` to search. render and searchMessage both
	// read this, so an automatic note never repeats the section.
	async function recall(seen: ReadonlySet<string>): Promise<{ profile: Fact[]; recent: Fact[]; older: Fact[] }> {
		const stored = await all();
		const log = stored.log.filter((fact) => canSee(fact, seen));
		const recent = log.slice(-RECENT_LIMIT);
		return { profile: stored.profile.filter((fact) => canSee(fact, seen)), recent, older: log.slice(0, log.length - recent.length) };
	}

	// The records in this bot's work log, without their dash: each line of <botsDir>/<bot folder>/work-log.md that starts with one.
	async function workLog(bot: BotRef | undefined): Promise<string[]> {
		if (options.botsDir === undefined || bot === undefined) return [];
		const text = await readText(join(options.botsDir, botFolder(bot), WORK_LOG));
		return (text ?? "").split(/\r?\n/).flatMap((line) => /^-\s+(\S.*?)\s*$/.exec(line)?.[1] ?? []);
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

	// edit, retag and forget without the write queue, for change, which is already in it.
	async function editFact(before: string, after: string, tier: Tier): Promise<Fact | undefined> {
		const fact = factText(after);
		const known = (await all())[tier];
		if (!known.some((candidate) => same(candidate.text, before))) return undefined;
		if (known.some((other) => !same(other.text, before) && same(other.text, fact))) throw new MemoryError(`"${fact}" is already saved.`);
		return changeFact(tier, before, (target) => ({ ...target, text: fact }));
	}

	const retagFact = (text: string, tier: Tier, tags: string[]) => changeFact(tier, text, (known) => ({ ...known, tags: [...new Set(tags)] }));

	async function forgetFacts(text: string, seen?: ReadonlySet<string>, tier?: Tier): Promise<Fact[]> {
		const removed: Fact[] = [];
		await rewrite((fact) => {
			if (!same(fact.text, text) || (seen !== undefined && !canSee(fact, seen)) || (tier !== undefined && fact.tier !== tier)) return fact;
			removed.push(fact);
			return null;
		});
		return removed;
	}

	// One change of a batch. Returns the fact as it now is, or as it was when forgotten; a MemoryError says why it couldn't.
	async function applyChange(change: Change): Promise<Fact> {
		const rewrites = change.to !== undefined || change.tags !== undefined;
		if ((change.forget === true) === rewrites) throw new MemoryError(`"${normalize(change.fact)}" needs forget, or to, tags, or both.`);
		const edited = change.to === undefined ? undefined : await editFact(change.fact, change.to, change.tier);
		const fact =
			change.forget === true
				? (await forgetFacts(change.fact, undefined, change.tier))[0]
				: change.tags === undefined
					? edited
					: await retagFact(edited?.text ?? change.fact, change.tier, change.tags);
		if (fact === undefined) throw new MemoryError(`No saved ${change.tier} fact matches "${normalize(change.fact)}".`);
		return fact;
	}

	// Copies the store to a new folder beside it, <dir>-backups/<date>-<time>, and returns that folder. It never writes into a backup that exists.
	async function backUp(): Promise<string> {
		const at = now();
		const pad = (n: number, width = 2) => String(n).padStart(width, "0");
		const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}`;
		const target = join(`${dir}-backups`, `${localDate(at)}-${time}`);
		await cp(dir, target, { recursive: true, errorOnExist: true, force: false });
		return target;
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
		edit: (before: string, after: string, tier: Tier) => serial(() => editFact(before, after, tier)),

		/** Replace the tags of the tier's fact whose text matches; no tags leaves it for no bot. Returns it, or undefined when none matches. */
		retag: (text: string, tier: Tier, tags: string[]) => serial(() => retagFact(text, tier, tags)),

		/** Remove every fact whose text matches, ignoring case and spacing; given `seen`, only facts with one of those tags, and given `tier`, only that tier. Returns the removed facts. */
		forget: (text: string, seen?: ReadonlySet<string>, tier?: Tier) => serial(() => forgetFacts(text, seen, tier)),

		/**
		 * Apply a batch of changes in order, after copying the store to a new folder in `<dir>-backups`; when that
		 * copy fails, nothing changes. Returns the backup folder and, for each change, the fact as it now is (as it
		 * was, for a forget) or why the change didn't apply.
		 */
		change: (changes: Change[]) =>
			serial(async () => {
				const backup = await backUp();
				const results: ({ fact: Fact } | { error: string })[] = [];
				for (const change of changes) {
					try {
						results.push({ fact: await applyChange(change) });
					} catch (error) {
						if (!(error instanceof MemoryError)) throw error;
						results.push({ error: error.message });
					}
				}
				return { backup, results };
			}),

		/** The saved facts similar to this one, among those with one of these tags or, without `seen`, among all of them. */
		async similar(fact: Pick<Fact, "text" | "tier">, seen?: ReadonlySet<string>): Promise<Fact[]> {
			const { profile, log } = await all();
			const isIt = (other: Fact) => other.tier === fact.tier && same(other.text, fact.text);
			const facts = [...profile, ...log].filter((other) => seen === undefined || canSee(other, seen) || isIt(other));
			const at = facts.findIndex(isIt);
			if (at === -1) return [];
			const similar = similarity(facts);
			return facts.filter((_, index) => index !== at && similar(at, index));
		},

		/** Every group of two or more facts where each is similar to another in it, in file order: what a clean-up should look at first. */
		async similarGroups(): Promise<Fact[][]> {
			const { profile, log } = await all();
			const facts = [...profile, ...log];
			const similar = similarity(facts);
			const group = facts.map((_, index) => index);
			const root = (index: number): number => (group[index] === index ? index : root(group[index] as number));
			facts.forEach((_, a) => {
				for (let b = 0; b < a; b++) if (similar(a, b)) group[root(a)] = root(b);
			});
			const members = new Map<number, Fact[]>();
			facts.forEach((fact, index) => members.set(root(index), [...(members.get(root(index)) ?? []), fact]));
			return [...members.values()].filter((facts) => facts.length > 1);
		},

		/** Facts with one of these tags matching the most keywords, best first. */
		async search(keywords: string[], seen: ReadonlySet<string>) {
			const { profile, recent, older } = await recall(seen);
			return ranked([...profile, ...older, ...recent], keywords);
		},

		/**
		 * What an incoming message to `bot` brings up that the bot's memory section doesn't already show. With a
		 * relevance judge: the older log facts and the records of the bot's work log that it scores RELEVANT_AT or
		 * higher, each best first and at most SEARCH_LIMIT, and no `keywords`; when the judge fails, none, and the log says why. Without one: the
		 * older log facts matching the message's keywords, which are its words found in those facts but in at most one
		 * in KEYWORD_RARITY of all the bot's facts, and no records.
		 */
		async searchMessage(message: string, seen: ReadonlySet<string>, bot?: BotRef): Promise<{ facts: Fact[]; records: string[]; keywords?: string[] }> {
			const { profile, recent, older } = await recall(seen);
			if (relevance !== undefined) {
				const records = await workLog(bot);
				if (older.length + records.length === 0 || normalize(message) === "") return { facts: [], records: [] };
				let scores: number[];
				try {
					// One request: the facts' scores come back first, then the records'.
					scores = await relevance(message, [...older.map((fact) => fact.text), ...records]);
				} catch (error) {
					options.log?.(`memory: no note for this message, the relevance check failed: ${error instanceof Error ? error.message : String(error)}`);
					return { facts: [], records: [] };
				}
				const picked = <T>(items: T[], from: number) =>
					items
						.map((item, index) => ({ item, score: scores[from + index] as number }))
						.filter((hit) => hit.score >= RELEVANT_AT)
						.sort((a, b) => b.score - a.score)
						.slice(0, SEARCH_LIMIT)
						.map((hit) => hit.item);
				return { facts: picked(older, 0), records: picked(records, older.length) };
			}
			const facts = [...profile, ...recent, ...older];
			const most = Math.ceil(facts.length / KEYWORD_RARITY);
			const keywords = wordsOf(message).filter((word) => {
				const pattern = keywordPattern(word);
				return older.some((fact) => pattern.test(fact.text)) && facts.filter((fact) => pattern.test(fact.text)).length <= most;
			});
			return { keywords, facts: ranked(older, keywords), records: [] };
		},

		/** The facts with one of these tags, for a system prompt. Changes only when the files change, so the prompt cache holds. */
		async render(seen: ReadonlySet<string>): Promise<string> {
			const { profile, recent, older } = await recall(seen);
			if (profile.length + recent.length === 0) return "Nothing saved yet.";
			const lines: string[] = [];
			const line = (fact: Fact) => `- (${fact.date}) ${fact.text} [${fact.tags.join(", ")}]`;
			if (profile.length > 0) lines.push("About the owner:", ...profile.map(line));
			if (recent.length > 0) lines.push("Recently:", ...recent.map(line));
			const hidden = older.length;
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
const tierParameter = Type.Union([Type.Literal("profile"), Type.Literal("log")], { description: "profile or log" });
const notMainBot = failure("Only the main bot manages all memory.");
const unknownTag = (names: string[], tags: TagView[]) => {
	const missing = names.find((name) => !tags.some((known) => known.slug === name));
	return missing === undefined ? undefined : failure(`No tag is named ${missing}. Tags: ${tags.map((tag) => tag.slug).join(", ")}.`);
};

/**
 * What a message from the owner or another bot to bot `id` brings up beyond that bot's memory section, as a note
 * for the bot; undefined when it brings up nothing. writeMemoryNote places it before the message.
 */
export async function messageNote(memory: Memory, message: string, id: number, bots: BotRef[]): Promise<string | undefined> {
	const me = bots.find((bot) => bot.id === id);
	const { keywords, facts, records } = await memory.searchMessage(message, seenBy(me, await memory.tagViews(bots)), me);
	if (facts.length + records.length === 0) return undefined;
	const how = keywords === undefined ? "that bear on the next message" : `matching keywords in the next message (${keywords.join(", ")})`;
	const parts = [
		...(facts.length === 0 ? [] : [`Older saved facts, not in your memory section, ${how}:\n${listed(facts)}`]),
		...(records.length === 0 ? [] : [`Lines of your work log, ${WORK_LOG} in your folder, that bear on the next message:\n${records.map((record) => `- ${record}`).join("\n")}`]),
	];
	return `[search_memory] ${parts.join("\n")}`;
}

/**
 * Every bot's memory tools and prompt section. `bots` lists the bots, to resolve who holds which tag and whose
 * conversation is asking; a conversation that isn't a bot has only every-bot. The main bot's tools reach every
 * fact, for its nightly memory routine, but its prompt and automatic searches stay limited to its tags, so
 * managing a fact doesn't put it in every request. `log` gets a line for the backup and each change of a
 * change_memory call. Installed by src/main.ts.
 */
export function createMemoryExtension(deps: {
	memory: Memory;
	bots: (read: Pick<Harness, "snapshot">, context: Context) => Promise<(BotRef & { main?: boolean })[]>;
	log?: (line: string) => void;
}): Extension {
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
			"Save a lasting fact about the owner, or a standing instruction from them, to long-term memory. One short sentence per fact. tags: which bots get it, from the tags in your memory section, the narrowest that fit; every-bot is for identity, people, accounts, preferences, and rules for all bots. tier profile: enduring facts. tier log: dated events and plans in the owner's life, not a record of your own work.",
		parameters: Type.Object({
			fact: Type.String({ description: "The fact, as one short sentence" }),
			tags: Type.Array(Type.String(), { description: "Tags of the bots that need it" }),
			tier: tierParameter,
		}),
		execute: async (args, api, context) => {
			const { tags, me, seen } = await viewer(api.conversationId, api, context);
			const unknown = unknownTag(args.tags, tags);
			if (unknown !== undefined) return unknown;
			try {
				const { fact, added } = await memory.remember(args.fact, args.tier, args.tags);
				const saved = `${added ? "remembered" : "already remembered"} (${fact.tags.join(", ")}, ${fact.tier}): ${fact.text}`;
				// Shown at the moment of writing, when merging costs the bot one more call.
				const similar = await memory.similar(fact, me?.main === true ? undefined : seen);
				if (similar.length === 0) return text(saved);
				return text(`${saved}\nSimilar facts already saved; when one says the same thing or is now wrong, forget the one that should go:\n${listed(similar)}`);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
		},
	});
	const forget = defineTool({
		name: "forget",
		description: "Remove a fact you can see from long-term memory; the main bot can remove any fact. Pass the fact's exact text as shown in memory, without its tags or date. With tier, it goes from that tier only; without, from both.",
		parameters: Type.Object({ fact: Type.String({ description: "Exact text of the fact to remove" }), tier: Type.Optional(tierParameter) }),
		execute: async (args, api, context) => {
			const { me, seen } = await viewer(api.conversationId, api, context);
			const removed = await memory.forget(args.fact, me?.main === true ? undefined : seen, args.tier);
			return removed.length > 0 ? text(`forgot:\n${listed(removed)}`) : failure(`No saved fact matches "${normalize(args.fact)}".`);
		},
	});
	const listMemory = defineTool({
		name: "list_memory",
		description: "Main bot only: list every saved fact, whichever bots it is for, with its tags and tier. Groups of similar facts, likely duplicates or conflicts, follow the list.",
		parameters: Type.Object({}),
		// A clean-up pass has to see every fact, and the store soon outgrows the default 50 KB.
		outputLimits: { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 },
		execute: async (_args, api, context) => {
			if ((await viewer(api.conversationId, api, context)).me?.main !== true) return notMainBot;
			const { profile, log } = await memory.all();
			if (profile.length + log.length === 0) return text("Nothing saved yet.");
			const groups = await memory.similarGroups();
			const similar = groups.length === 0 ? [] : [`Similar facts, likely the same fact twice or two that conflict:\n${groups.map(listed).join("\n\n")}`];
			return text([listed([...profile, ...log]), ...similar].join("\n\n"));
		},
	});
	const changeMemory = defineTool({
		name: "change_memory",
		description:
			"Main bot only: change any saved facts in one call, whichever bots they are for. The store is backed up first. Each change names a fact by its exact text and tier and gives one of: to, new wording that keeps its date and tags; tags, which replace its tags and so set the bots that get it (none leaves it for no bot); both; or forget: true, which removes it. Changes apply in order, and the result says what happened to each.",
		parameters: Type.Object({
			changes: Type.Array(
				Type.Object({
					fact: Type.String({ description: "Exact text of the fact to change" }),
					tier: tierParameter,
					to: Type.Optional(Type.String({ description: "The new text, as one short sentence" })),
					tags: Type.Optional(Type.Array(Type.String(), { description: "The fact's new tags" })),
					forget: Type.Optional(Type.Boolean({ description: "true removes the fact" })),
				}),
				{ minItems: 1 },
			),
		}),
		execute: async (args, api, context) => {
			const { me, tags } = await viewer(api.conversationId, api, context);
			if (me?.main !== true) return notMainBot;
			// Checked before anything is written, so a mistyped tag can't leave a batch half done.
			const unknown = unknownTag(args.changes.flatMap((change) => change.tags ?? []), tags);
			if (unknown !== undefined) return unknown;
			const { backup, results } = await memory.change(args.changes);
			const lines = [
				`Backed up to ${backup}.`,
				...results.map((result, index) => {
					if ("error" in result) return `not changed: ${result.error}`;
					return `${args.changes[index]?.forget === true ? "forgot" : "changed"} (${result.fact.tier}): ${result.fact.text} [${result.fact.tags.join(", ")}]`;
				}),
			];
			for (const line of lines) deps.log?.(`memory (${me.name}): ${line}`);
			return text(lines.join("\n"));
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
		tools: [remember, forget, searchMemory, listMemory, changeMemory],
		sections: [
			section("memory", async (input, context) => {
				const { bots, tags, me, seen } = await viewer(input.conversationId, input.read, context);
				const holders = (tag: TagView) => {
					if (tag.kind === "every") return "every bot";
					if (tag.kind === "bot" && tag.bots[0] === me?.id) return "you";
					return bots.filter((bot) => tag.bots.includes(bot.id)).map((bot) => bot.name).join(", ") || "no bots yet";
				};
				return [
					"Memory: durable facts about the owner and standing instructions from them, kept across every conversation. Rely on them instead of asking again.",
					"When you learn something lasting about the owner, or the owner gives a standing instruction, save it with remember: tags for the bots that need it, the narrowest that fit; tier profile for enduring facts, tier log for dated events and plans in the owner's life. Just do it and mention it in passing; don't ask permission. Use forget with the exact text when a fact is wrong or outdated, and search_memory to search older facts by keyword.",
					`Memory is not a record of your work. What you did, sent, checked, or relayed, the status of something you are tracking, and the owner's decisions on those items go in ${WORK_LOG} in your folder, one line each as \`- (YYYY-MM-DD) what happened\`, newest last. Read it when that work comes up.`,
					`Tags you can use: ${tags.map((tag) => `${tag.slug} (${holders(tag)})`).join(", ")}.`,
					"What you know, each fact followed by its tags:",
					await memory.render(seen),
				].join("\n");
			}),
		],
	});
}
