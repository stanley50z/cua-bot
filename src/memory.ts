// Long-term memory about the owner, as plain markdown the owner can read and edit.
// main.ts builds one store with createMemory({ dir: data/memory }), installs createMemoryExtension(store)
// so the bot gets remember / forget / recall and sees its memory in every request, and hands the
// store to the web app (GET/POST /api/memory). Layout, after Grok Bot's memory:
//   profile.md          enduring facts about the owner ("About the owner")
//   log/YYYY-MM.md      dated facts, one file per month
// Each fact is one line: `- (YYYY-MM-DD) fact`. Other lines are left alone. The files are the source of
// truth and are re-read on every call, so hand edits apply at once.
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";

export type Tier = "profile" | "log";
export type Fact = { text: string; date: string; tier: Tier; file: string };

const MAX_FACT = 500;
const PROFILE_LIMIT = 100;
const RECENT_LIMIT = 30;
const SECTION_BUDGET = 4000;
const RECALL_LIMIT = 20;
const FACT_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/;
const PROFILE_HEADER = "# About the owner\n";

export class MemoryError extends Error {}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
const same = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();
// Words of three or more letters, so "is" and "to" never decide a recall ranking.
const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

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

function factsIn(text: string | undefined, tier: Tier, file: string): Fact[] {
	return (text ?? "").split(/\r?\n/).flatMap((line) => {
		const match = FACT_LINE.exec(line);
		return match === null ? [] : [{ date: match[1] as string, text: match[2] as string, tier, file }];
	});
}

export type Memory = ReturnType<typeof createMemory>;

export function createMemory(options: { dir: string; now?: () => Date }) {
	const { dir } = options;
	const now = options.now ?? (() => new Date());
	const logDir = join(dir, "log");
	const profileFile = join(dir, "profile.md");
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

	return {
		dir,
		all,

		/** Save a fact. Returns the stored fact, or the existing one when the same text is already in that tier. */
		remember: (text: string, tier: Tier) =>
			serial(async () => {
				const fact = normalize(text);
				if (fact === "") throw new MemoryError("A fact cannot be empty.");
				if (fact.length > MAX_FACT) throw new MemoryError(`A fact is at most ${MAX_FACT} characters; this one is ${fact.length}.`);
				const existing = (await all())[tier].find((known) => same(known.text, fact));
				if (existing !== undefined) return { fact: existing, added: false };
				const date = localDate(now());
				const name = tier === "profile" ? "profile.md" : `log/${date.slice(0, 7)}.md`;
				const file = join(dir, name);
				await mkdir(tier === "profile" ? dir : logDir, { recursive: true });
				const before = (await readText(file)) ?? (tier === "profile" ? PROFILE_HEADER : `# ${date.slice(0, 7)}\n`);
				await writeText(file, `${before}${before.endsWith("\n") ? "" : "\n"}- (${date}) ${fact}\n`);
				return { fact: { text: fact, date, tier, file: name } satisfies Fact, added: true };
			}),

		/** Remove every fact whose text matches, ignoring case and spacing. Returns the removed facts. */
		forget: (text: string) =>
			serial(async () => {
				const files = ["profile.md", ...(await logFiles()).map((name) => `log/${name}`)];
				const removed: Fact[] = [];
				for (const name of files) {
					const file = join(dir, name);
					const before = await readText(file);
					if (before === undefined) continue;
					const lines = before.split(/\r?\n/);
					const kept = lines.filter((line) => {
						const match = FACT_LINE.exec(line);
						if (match === null || !same(match[2] as string, text)) return true;
						removed.push({ date: match[1] as string, text: match[2] as string, tier: name === "profile.md" ? "profile" : "log", file: name });
						return false;
					});
					if (kept.length !== lines.length) await writeText(file, kept.join("\n"));
				}
				return removed;
			}),

		/** Facts sharing the most words with the query, best first. */
		async recall(query: string): Promise<Fact[]> {
			const wanted = words(query);
			const { profile, log } = await all();
			return [...profile, ...log]
				.map((fact) => ({ fact, score: [...words(fact.text)].filter((word) => wanted.has(word)).length }))
				.filter((hit) => hit.score > 0)
				.sort((a, b) => b.score - a.score || b.fact.date.localeCompare(a.fact.date))
				.slice(0, RECALL_LIMIT)
				.map((hit) => hit.fact);
		},

		/** The memory section of the system prompt. Changes only when the files change, so the prompt cache holds. */
		async render(): Promise<string> {
			const { profile, log } = await all();
			const lines = [
				"Memory: durable facts about the owner, kept across every conversation. Rely on them instead of asking again.",
				"When you learn something lasting about the owner (preferences, people, places, routines, accounts), save it with remember: tier profile for enduring facts, tier log for dated events and plans. Just do it and mention it in passing; don't ask permission. Use forget with the exact text when a fact is wrong or outdated, and recall to search older facts.",
			];
			if (profile.length + log.length === 0) return [...lines, "Nothing saved yet."].join("\n");
			let budget = SECTION_BUDGET;
			const take = (facts: Fact[]) => {
				const shown: string[] = [];
				for (const fact of facts) {
					const line = `- (${fact.date}) ${fact.text}`;
					if (line.length + 1 > budget) break;
					budget -= line.length + 1;
					shown.push(line);
				}
				return shown;
			};
			const aboutOwner = take(profile.slice(0, PROFILE_LIMIT));
			const recent = take(log.slice(-RECENT_LIMIT).reverse()).reverse();
			if (aboutOwner.length > 0) lines.push("About the owner:", ...aboutOwner);
			if (recent.length > 0) lines.push("Recently:", ...recent);
			const hidden = profile.length - aboutOwner.length + (log.length - recent.length);
			if (hidden > 0) lines.push(`(${hidden} older ${hidden === 1 ? "fact is" : "facts are"} not shown; use recall to search them.)`);
			return lines.join("\n");
		},
	};
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ output: [{ type: "text" as const, text: value }], isError: true as const });
const listed = (facts: Fact[]) => facts.map((fact) => `- (${fact.date}) ${fact.text} [${fact.tier}]`).join("\n");

/** The bot's memory tools and prompt section over one store. Installed by src/main.ts. */
export function createMemoryExtension(memory: Memory): Extension {
	const remember = defineTool({
		name: "remember",
		description:
			"Save a lasting fact about the owner to long-term memory. One short sentence per fact. tier profile: enduring facts (preferences, people, accounts, where things live). tier log: dated events and plans.",
		parameters: Type.Object({
			fact: Type.String({ description: "The fact, as one short sentence" }),
			tier: Type.Union([Type.Literal("profile"), Type.Literal("log")], { description: "profile or log" }),
		}),
		execute: async (args) => {
			try {
				const { fact, added } = await memory.remember(args.fact, args.tier);
				return text(added ? `remembered (${fact.tier}): ${fact.text}` : `already remembered: ${fact.text}`);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
		},
	});
	const forget = defineTool({
		name: "forget",
		description: "Remove a fact from long-term memory. Pass the fact's exact text as shown in memory.",
		parameters: Type.Object({ fact: Type.String({ description: "Exact text of the fact to remove" }) }),
		execute: async (args) => {
			const removed = await memory.forget(args.fact);
			return removed.length > 0 ? text(`forgot:\n${listed(removed)}`) : failure(`No saved fact matches "${normalize(args.fact)}".`);
		},
	});
	const recall = defineTool({
		name: "recall",
		description: "Search long-term memory, including older facts that are not shown in the prompt.",
		parameters: Type.Object({ query: Type.String({ description: "Words to look for" }) }),
		execute: async (args) => {
			const hits = await memory.recall(args.query);
			return text(hits.length > 0 ? listed(hits) : "No saved facts match.");
		},
	});
	return defineExtension({
		name: "memory",
		tools: [remember, forget, recall],
		sections: [section("memory", () => memory.render())],
	});
}
