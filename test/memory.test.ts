// Long-term memory: the tagged markdown store, the bot's tools feeding the next prompt, the web portal's
// /api/memory routes, and the one-time move to tags. Run from the repo root:  node --test test/memory.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type JsonObject, MemoryStorage } from "@earendil-works/pi-durable";
import { createMemory, createMemoryExtension, type Fact, type Memory, MemoryError, migrateMemory, messageNote, type TagView } from "../src/memory.ts";
import { createBotServer } from "../src/web.ts";

const context = BACKGROUND_CONTEXT;

async function withDir(run: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-memory-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const clockAt = (iso: string) => {
	const clock = { now: new Date(iso) };
	return { clock, now: () => clock.now };
};

const everyBot = ["every-bot"];
const sees = (...tags: string[]) => new Set(tags);

test("facts land in profile.md and monthly log files, one dated and tagged line each", () =>
	withDir(async (dir) => {
		const { clock, now } = clockAt("2026-10-31T09:00:00");
		const memory = createMemory({ dir, now });
		assert.equal((await memory.remember("  Partner is   Dana ", "profile", ["every-bot", "job-bots"])).added, true);
		await memory.remember("Plumber visit Tuesday 9 to 12", "log", ["@dev"]);
		clock.now = new Date("2026-11-02T08:00:00");
		await memory.remember("Plumber came; sink fixed", "log", everyBot);

		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), "# About the owner\n- (2026-10-31) [every-bot, job-bots] Partner is Dana\n");
		assert.equal(await readFile(join(dir, "log", "2026-10.md"), "utf8"), "# 2026-10\n- (2026-10-31) [@dev] Plumber visit Tuesday 9 to 12\n");
		assert.equal(await readFile(join(dir, "log", "2026-11.md"), "utf8"), "# 2026-11\n- (2026-11-02) [every-bot] Plumber came; sink fixed\n");
		const { profile, log } = await memory.all();
		assert.deepEqual(profile.map((fact) => [fact.text, fact.tags]), [["Partner is Dana", ["every-bot", "job-bots"]]]);
		assert.deepEqual(log.map((fact) => [fact.date, fact.file]), [
			["2026-10-31", "log/2026-10.md"],
			["2026-11-02", "log/2026-11.md"],
		]);
	}));

test("saving a fact that exists adds the new tags to it, so the second bot can see it", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("TikTok limit reached", "profile", ["@job-search"]);
		const again = await memory.remember("tiktok LIMIT reached", "profile", ["@job-application"]);
		assert.equal(again.added, false);
		assert.deepEqual(again.fact.tags, ["@job-search", "@job-application"]);
		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), "# About the owner\n- (2026-10-31) [@job-search, @job-application] TikTok limit reached\n");
		await memory.remember("TikTok limit reached", "profile", ["@job-search"]);
		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), "# About the owner\n- (2026-10-31) [@job-search, @job-application] TikTok limit reached\n", "tags it already has change nothing");
		await assert.rejects(memory.remember("No audience", "profile", []), MemoryError);
		assert.deepEqual((await memory.remember("Twice", "profile", ["@dev", "@dev"])).fact.tags, ["@dev"], "a tag named twice counts once");
		assert.deepEqual((await memory.retag("Twice", "profile", ["job-bots", "job-bots"]))?.tags, ["job-bots"]);
	}));

test("hand-written lines are read as-is: no tag means no bot, a byte-order mark and CRLF are fine", () =>
	withDir(async (dir) => {
		await mkdir(join(dir, "log"), { recursive: true });
		await writeFile(join(dir, "profile.md"), "﻿# About the owner\r\nSome notes I wrote.\r\n- (2026-10-01) Lives in Seattle\r\n- (2026-10-02) [job-bots, @dev] Has a license\r\n- (2026-10-03) [Draft: long] note\r\n");
		await writeFile(join(dir, "log", "notes.md"), "- (2026-10-01) ignored: not a month file\n");
		const memory = createMemory({ dir });
		const { profile, log } = await memory.all();
		assert.deepEqual(profile.map((fact) => [fact.text, fact.tags]), [
			["Lives in Seattle", []],
			["Has a license", ["job-bots", "@dev"]],
			["[Draft: long] note", []],
		]);
		assert.deepEqual(log, []);
		assert.equal(await memory.render(sees("every-bot")), "Nothing saved yet.", "an untagged fact reaches no bot");
		await memory.forget("Lives in Seattle");
		assert.match(await readFile(join(dir, "profile.md"), "utf8"), /Some notes I wrote\./, "non-fact lines survive");
	}));

test("edit rewords one fact on its own line and keeps its date, tags, and everything around it", () =>
	withDir(async (dir) => {
		await mkdir(join(dir, "log"), { recursive: true });
		await writeFile(join(dir, "profile.md"), "# About the owner\nSome notes I wrote.\n- (2026-10-01) [job-bots] Lives in Seattle\n- (2026-10-02) [every-bot] Timezone is Pacific\n");
		await writeFile(join(dir, "log", "2026-09.md"), "# 2026-09\n- (2026-09-14) [@dev] Lives in Seattle\n");
		const memory = createMemory({ dir, now: () => new Date("2026-11-08T09:00:00") });
		const edited = await memory.edit("lives in SEATTLE", "  Lives in   Pittsburgh ", "profile");
		assert.deepEqual(edited, { text: "Lives in Pittsburgh", date: "2026-10-01", tier: "profile", file: "profile.md", tags: ["job-bots"] });
		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), "# About the owner\nSome notes I wrote.\n- (2026-10-01) [job-bots] Lives in Pittsburgh\n- (2026-10-02) [every-bot] Timezone is Pacific\n");
		assert.equal(await readFile(join(dir, "log", "2026-09.md"), "utf8"), "# 2026-09\n- (2026-09-14) [@dev] Lives in Seattle\n", "the same words in the other tier stay");
	}));

test("edit fails on a missing fact, on bad text, and on text another fact already has, but allows changing only the case", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("Prefers short answers", "profile", everyBot);
		await memory.remember("Timezone is Pacific", "profile", everyBot);
		assert.equal(await memory.edit("never saved", "Anything", "profile"), undefined);
		assert.equal(await memory.edit("never saved", "Timezone is Pacific", "profile"), undefined, "a missing fact is missing even if the new words are taken");
		assert.equal(await memory.edit("Prefers short answers", "Anything", "log"), undefined, "looks only in the given tier");
		await assert.rejects(memory.edit("Prefers short answers", "   ", "profile"), /cannot be empty/);
		assert.equal((await memory.edit("Prefers short answers", "y".repeat(500), "profile"))?.text, "y".repeat(500));
		await assert.rejects(memory.edit("y".repeat(500), "y".repeat(501), "profile"), /at most 500 characters/);
		await assert.rejects(memory.edit("y".repeat(500), "timezone is PACIFIC", "profile"), /already saved/);
		assert.equal((await memory.edit("Timezone is Pacific", "timezone is PACIFIC", "profile"))?.text, "timezone is PACIFIC");
	}));

test("retag replaces a fact's tags in one tier, and no tags leaves it untagged", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("Has a license", "profile", everyBot);
		await memory.remember("Has a license", "log", ["@dev"]);
		assert.deepEqual((await memory.retag("has a LICENSE", "profile", ["job-bots", "@alfred"]))?.tags, ["job-bots", "@alfred"]);
		assert.match(await readFile(join(dir, "profile.md"), "utf8"), /- \(2026-10-31\) \[job-bots, @alfred\] Has a license\n/);
		assert.deepEqual((await memory.all()).log[0]?.tags, ["@dev"], "the other tier stays");
		assert.deepEqual((await memory.retag("Has a license", "profile", []))?.tags, []);
		assert.match(await readFile(join(dir, "profile.md"), "utf8"), /- \(2026-10-31\) Has a license\n/);
		assert.equal(await memory.retag("never saved", "profile", everyBot), undefined);
		assert.deepEqual((await memory.retag("Has a license", "log", ["@alfred"]))?.tier, "log");
		assert.deepEqual((await memory.all()).profile[0]?.tags, [], "the tier named is the only one that changes");
	}));

test("two identical hand-written lines in a tier: a change touches only the first", () =>
	withDir(async (dir) => {
		await writeFile(join(dir, "profile.md"), "- (2026-10-01) [@dev] Same words\n- (2026-10-02) [@dev] Same words\n");
		const memory = createMemory({ dir });
		await memory.retag("Same words", "profile", ["@alfred"]);
		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), "- (2026-10-01) [@alfred] Same words\n- (2026-10-02) [@dev] Same words\n");
	}));

test("forget removes matching facts from any file, or only those a bot can see", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("Prefers short answers", "profile", everyBot);
		await memory.remember("Timezone is Pacific", "profile", everyBot);
		await memory.remember("Prefers short answers", "log", ["@dev"]);
		assert.deepEqual(await memory.forget("Prefers short answers", sees("@alfred")), [], "a bot can't forget what it can't see");
		const removed = await memory.forget("Prefers short answers", sees("@dev"));
		assert.deepEqual(removed.map((fact) => fact.tier), ["log"]);
		assert.deepEqual((await memory.forget("prefers SHORT answers")).map((fact) => fact.tier), ["profile"], "the owner can forget anything");
		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), "# About the owner\n- (2026-10-31) [every-bot] Timezone is Pacific\n");
		assert.deepEqual(await memory.forget("never saved"), []);
	}));

test("a bot's prompt holds only facts with a tag it has, its newest 30 log facts, and points at search_memory for the rest", () =>
	withDir(async (dir) => {
		const { clock, now } = clockAt("2026-01-01T09:00:00");
		const memory = createMemory({ dir, now });
		assert.equal(await memory.render(sees("job-bots")), "Nothing saved yet.");
		await memory.remember("Timezone is Pacific", "profile", everyBot);
		await memory.remember("On F-1 OPT", "profile", ["job-bots"]);
		for (let day = 1; day <= 31; day++) {
			clock.now = new Date(2026, 0, day, 9);
			await memory.remember(`Job event ${day}`, "log", ["job-bots"]);
			await memory.remember(`Dev event ${day}`, "log", ["@dev"]);
		}
		const job = await memory.render(sees("every-bot", "job-bots"));
		assert.match(job, /About the owner:\n- \(2026-01-01\) Timezone is Pacific \[every-bot\]\n- \(2026-01-01\) On F-1 OPT \[job-bots\]/);
		assert.match(job, /Recently:\n- \(2026-01-02\) Job event 2 \[job-bots\]/, "the 30 newest it can see, whatever other bots saved in between");
		assert.doesNotMatch(job, /Job event 1 /);
		assert.doesNotMatch(job, /Dev event/);
		assert.match(job, /\(1 older fact is not shown; use search_memory to search them\.\)/);
		assert.equal(await memory.render(sees("every-bot", "job-bots")), job, "stable while nothing changes, so the prompt cache holds");
		const everyOnly = await memory.render(sees("every-bot"));
		assert.doesNotMatch(everyOnly, /OPT/);
		assert.doesNotMatch(everyOnly, /Recently/);

		await memory.remember("One more dev", "log", ["@alfred"]);
		for (let i = 0; i < 200; i++) await memory.remember(`${"x".repeat(400)} ${i}`, "profile", everyBot);
		assert.match(await memory.render(sees("every-bot")), /x 199 \[every-bot\]\n?/, "no length budget hides profile facts");
	}));

test("exactly 30 visible log facts leave nothing hidden, 31 hide one", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-01-01T09:00:00") });
		for (let i = 1; i <= 30; i++) await memory.remember(`Event ${i}`, "log", everyBot);
		assert.doesNotMatch(await memory.render(sees("every-bot")), /not shown/);
		await memory.remember("Event 31", "log", everyBot);
		assert.match(await memory.render(sees("every-bot")), /\(1 older fact is not shown/);
	}));

test("search ranks by keywords matched, only among facts the bot can see; remember rejects empty and oversized facts", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("Landlord is Mr. Okafor", "profile", everyBot);
		await memory.remember("Plumber visit Tuesday, landlord arranged it", "log", everyBot);
		await memory.remember("Landlord plumber secret", "log", ["@dev"]);
		await memory.remember("Climbing with Dana on Sundays", "log", everyBot);
		const hits = await memory.search(["plumber", "landlord"], sees("every-bot"));
		assert.deepEqual(hits.map((fact) => fact.text), ["Plumber visit Tuesday, landlord arranged it", "Landlord is Mr. Okafor"]);
		assert.deepEqual((await memory.search(["climbing"], sees("every-bot"))).map((fact) => fact.text), ["Climbing with Dana on Sundays"], "one keyword is enough");
		await assert.rejects(memory.remember("   ", "profile", everyBot), MemoryError);
		await memory.remember("y".repeat(500), "profile", everyBot);
		await assert.rejects(memory.remember("y".repeat(501), "profile", everyBot), /at most 500 characters/);
	}));

test("a keyword matches the start of a word, a phrase, or inside Chinese text", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("Submitted the Techstars office hours form", "log", everyBot);
		await memory.remember("Red Robot night is Friday", "log", everyBot);
		await memory.remember("Offered a ride to Dana", "log", everyBot);
		await memory.remember("申请了电机驱动器实习", "log", everyBot);
		const found = async (...keywords: string[]) => (await memory.search(keywords, sees("every-bot"))).map((fact) => fact.text);
		assert.deepEqual(await found("SUBMIT"), ["Submitted the Techstars office hours form"]);
		assert.deepEqual(await found("red"), ["Red Robot night is Friday"], "not the \"red\" inside Offered");
		assert.deepEqual(await found("office   hours"), ["Submitted the Techstars office hours form"]);
		assert.deepEqual(await found("电机驱动"), ["申请了电机驱动器实习"]);
		assert.deepEqual(await found("  "), []);
		assert.deepEqual(await found("c++("), [], "a keyword is text, not a pattern");
	}));

const scout = { id: 3, name: "Scout" };
const dev = { id: 5, name: "Dev" };

test("a message searches memory for its keywords, skipping words too common among the bot's facts", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		for (let i = 1; i <= 15; i++) await memory.remember(`Filler ${i}`, "log", everyBot);
		// 20 facts this bot can see, so a word may be in 2 of them.
		await memory.remember("Plumber comes Tuesday", "log", everyBot);
		await memory.remember("Plumber invoice paid", "log", ["@scout"]);
		for (const n of ["one", "two", "three"]) await memory.remember(`Weekly chore ${n}`, "log", everyBot);
		await memory.remember("Plumber secret", "log", ["@dev"]);

		const note = await messageNote(memory, "Any weekly plumber news?", scout.id, [scout, dev]);
		assert.match(note ?? "", /keywords in the next message \(plumber\)/);
		assert.match(note ?? "", /Plumber comes Tuesday \[every-bot\] \(log\)/);
		assert.match(note ?? "", /Plumber invoice paid \[@scout\] \(log\)/);
		assert.doesNotMatch(note ?? "", /Weekly chore/, "a word in 3 of 20 facts is not a keyword");
		assert.doesNotMatch(note ?? "", /Plumber secret/, "another bot's fact stays hidden");
		assert.equal(await messageNote(memory, "zebra", scout.id, [scout, dev]), undefined, "no matching fact, no note");
		assert.equal(await messageNote(memory, "", scout.id, [scout, dev]), undefined);
	}));

test("message keywords are words of three letters or more, or two characters of Chinese", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("SMS login only", "profile", everyBot);
		await memory.remember("Go to bed early", "profile", everyBot);
		await memory.remember("申请了电机驱动器实习", "log", everyBot);
		await memory.remember("👍 means yes", "profile", everyBot);
		for (let i = 1; i <= 6; i++) await memory.remember(`Filler ${i}`, "log", everyBot);
		assert.equal(await messageNote(memory, "👍", scout.id, [scout]), undefined, "an emoji is not a word");
		assert.match((await messageNote(memory, "sms", scout.id, [scout])) ?? "", /SMS login only/);
		assert.equal(await messageNote(memory, "go", scout.id, [scout]), undefined);
		assert.match((await messageNote(memory, "帮我看看驱动器的事", scout.id, [scout])) ?? "", /申请了电机驱动器实习/);
		assert.match((await messageNote(memory, "实习", scout.id, [scout])) ?? "", /申请了电机驱动器实习/);
		assert.equal(await messageNote(memory, "了", scout.id, [scout]), undefined, "one Chinese character is too short");
	}));

test("every tag: the built-in one, those the owner made, and one per bot, each with who holds it", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir });
		assert.deepEqual(await memory.tagViews([scout, dev]), [
			{ slug: "every-bot", name: "Every bot", kind: "every", bots: [3, 5] },
			{ slug: "@scout", name: "Scout", kind: "bot", bots: [3] },
			{ slug: "@dev", name: "Dev", kind: "bot", bots: [5] },
		]);
		assert.deepEqual(await memory.createTag("  Job   bots ", [3, 9]), { slug: "job-bots", name: "Job bots", kind: "custom", bots: [3, 9] });
		assert.deepEqual(JSON.parse(await readFile(join(dir, "tags.json"), "utf8")), { "job-bots": { name: "Job bots", bots: [3, 9] } });
		assert.deepEqual((await memory.tagViews([scout, dev]))[1], { slug: "job-bots", name: "Job bots", kind: "custom", bots: [3] }, "a bot that's gone isn't listed");
	}));

test("a new tag needs a name that isn't taken, a built-in tag included", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir });
		await memory.createTag("Job bots", []);
		await assert.rejects(memory.createTag("job BOTS", []), /already a tag/);
		await assert.rejects(memory.createTag("Every bot", []), /already a tag/);
		await assert.rejects(memory.createTag(" !! ", []), /letter or number/);
		assert.deepEqual((await memory.createTag("研究", [])).slug, "研究");
	}));

test("renaming a tag rewrites its facts, changing members leaves them, and deleting it leaves facts on their other tags or none", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.createTag("Job bots", [3]);
		await memory.createTag("School", [5]);
		await memory.remember("On F-1 OPT", "profile", ["job-bots"]);
		await memory.remember("Has a license", "log", ["job-bots", "@dev"]);

		assert.deepEqual(await memory.updateTag("job-bots", { name: "Job bots", bots: [3, 5] }), { slug: "job-bots", name: "Job bots", kind: "custom", bots: [3, 5] });
		assert.deepEqual((await memory.all()).profile[0]?.tags, ["job-bots"]);

		assert.equal((await memory.updateTag("job-bots", { name: "Careers", bots: [3, 5] }))?.slug, "careers");
		assert.deepEqual((await memory.all()).profile[0]?.tags, ["careers"]);
		assert.deepEqual((await memory.all()).log[0]?.tags, ["careers", "@dev"]);
		await assert.rejects(memory.updateTag("careers", { name: "School", bots: [] }), /already a tag/);
		assert.equal(await memory.updateTag("nope", { name: "X", bots: [] }), undefined);

		assert.equal(await memory.deleteTag("careers"), true);
		assert.equal(await memory.deleteTag("careers"), false);
		assert.deepEqual((await memory.all()).profile[0]?.tags, [], "with no other tag it is untagged, not lost");
		assert.deepEqual((await memory.all()).log[0]?.tags, ["@dev"]);
		assert.match(await readFile(join(dir, "profile.md"), "utf8"), /- \(2026-10-31\) On F-1 OPT\n/);
	}));

test("a bot's tag follows a rename, and a deleted bot leaves its tag and every member list", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.createTag("Job bots", [3, 5]);
		await memory.remember("Prefers window seats", "profile", ["@scout", "every-bot"]);
		await memory.remember("Only for scout", "log", ["@scout"]);

		await memory.botRenamed(scout, { id: 3, name: "Travel Desk" });
		assert.deepEqual((await memory.all()).profile[0]?.tags, ["@travel-desk", "every-bot"]);
		assert.deepEqual((await memory.tagViews([{ id: 3, name: "Travel Desk" }, dev]))[1]?.bots, [3, 5], "membership is by id, so a rename leaves it");

		await memory.botRemoved({ id: 3, name: "Travel Desk" });
		assert.deepEqual((await memory.all()).profile[0]?.tags, ["every-bot"]);
		assert.deepEqual((await memory.all()).log[0]?.tags, []);
		assert.deepEqual(JSON.parse(await readFile(join(dir, "tags.json"), "utf8")), { "job-bots": { name: "Job bots", bots: [5] } });
	}));

test("a broken tags.json says so instead of quietly dropping the owner's tags", () =>
	withDir(async (dir) => {
		await writeFile(join(dir, "tags.json"), "{ not json");
		const memory = createMemory({ dir });
		await assert.rejects(memory.tagViews([scout]), /tags\.json/);
	}));

// Runs one turn of a bot that makes `calls`, returning the memory section of each request and what the tools answered.
async function turn(memory: Memory, botsOf: (rootId: number) => { id: number; name: string }[], calls: { name: string; args: JsonObject }[], before?: (rootId: number) => Promise<unknown>) {
	const prompts: string[] = [];
	let results = "";
	let rootId = 0;
	const memorySection = (messages: readonly Message[]) =>
		messages.reduce((latest, message) => (message.role === "system" && typeof message.sections?.memory === "string" ? message.sections.memory : latest), "");
	const record = (step: () => AssistantMessage): FauxResponseFactory => (request) => {
		prompts.push(memorySection(request.messages));
		results = JSON.stringify(request.messages.filter((message) => message.role === "toolResult"));
		return step();
	};
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		record(() => fauxAssistantMessage(calls.map((call, index) => fauxToolCall(call.name, call.args, { id: `m${index}` })), { stopReason: "toolUse" })),
		record(() => fauxAssistantMessage([fauxText("Noted.")])),
	]);
	const registry = createRegistry();
	registry.install(createMemoryExtension({ memory, bots: async () => botsOf(rootId) }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		rootId = Number(root.id);
		await before?.(rootId);
		const settled = await (await root.submit({ type: "input", content: "Go." }, context)).wait(context);
		assert.equal(settled.status, "done");
	} finally {
		await harness.close(context);
	}
	return { prompts, results };
}

test("a bot sees, saves, finds, and forgets facts through its tags, and nothing else", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("Dev secret rule", "profile", ["@dev"]);
		await memory.remember("Job rule", "profile", ["job-bots"]);
		const { prompts, results } = await turn(
			memory,
			(id) => [{ id, name: "Scout" }, { id: 99, name: "Dev" }],
			[
				{ name: "remember", args: { fact: "Partner is Dana", tags: ["every-bot"], tier: "profile" } },
				{ name: "remember", args: { fact: "Dana likes orchids", tags: ["@scout"], tier: "profile" } },
				{ name: "remember", args: { fact: "Lost fact", tags: ["nope"], tier: "profile" } },
				{ name: "search_memory", args: { keywords: ["secret", "rule"] } },
				{ name: "forget", args: { fact: "Dev secret rule" } },
			],
			(id) => memory.createTag("Job bots", [id]),
		);
		assert.match(prompts[0] ?? "", /Tags you can use: every-bot \(every bot\), job-bots \(Scout\), @scout \(you\), @dev \(Dev\)/);
		assert.match(prompts[0] ?? "", /About the owner:\n- \(2026-10-31\) Job rule \[job-bots\]/);
		assert.doesNotMatch(prompts[0] ?? "", /Dev secret/);
		assert.match(prompts[1] ?? "", /Partner is Dana \[every-bot\]/);
		assert.match(prompts[1] ?? "", /Dana likes orchids \[@scout\]/);

		assert.match(results, /No tag is named nope/);
		assert.match(results, /Job rule \[job-bots\] \(profile\)/, "search_memory lists what it can see");
		assert.doesNotMatch(results, /Dev secret rule \[/, "search_memory skips another bot's fact");
		assert.match(results, /No saved fact matches/);
		const saved = await readFile(join(dir, "profile.md"), "utf8");
		assert.match(saved, /Dev secret rule/, "a bot can't forget another bot's fact");
		assert.doesNotMatch(saved, /Lost fact/);
	}));

test("a conversation that isn't a bot gets only the facts every bot gets", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("For everyone", "profile", everyBot);
		await memory.remember("Job rule", "profile", ["job-bots"]);
		const { prompts } = await turn(memory, () => [{ id: 99, name: "Dev" }], [{ name: "search_memory", args: { keywords: ["nothing"] } }]);
		assert.match(prompts[0] ?? "", /For everyone/);
		assert.doesNotMatch(prompts[0] ?? "", /Job rule/);
	}));

// The web portal's memory routes over `memory`, with two bots to tag.
async function withServer(memory: Memory, run: (call: (method: string, path: string, body?: unknown) => Promise<Response>) => Promise<void>) {
	const server: Server = createBotServer({ say: async (text) => text, memory, memoryBots: () => [scout, dev], context });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	try {
		await run((method, path, body) => fetch(`http://127.0.0.1:${address.port}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

test("the web portal lists, adds, edits, retags, and forgets tagged facts", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await withServer(memory, async (call) => {
			assert.equal((await call("POST", "/api/memory", { fact: "Timezone is Pacific", tier: "profile", tags: everyBot })).status, 201);
			assert.equal((await call("POST", "/api/memory", { fact: "timezone is pacific", tags: ["@dev"] })).status, 200, "a duplicate adds its tags");
			assert.equal((await call("POST", "/api/memory", { fact: "Dinner Friday", tier: "log", tags: ["@scout"] })).status, 201);
			assert.equal((await call("POST", "/api/memory", { fact: "x", tier: "profile" })).status, 400, "tags are required");
			assert.equal((await call("POST", "/api/memory", { fact: "x", tier: "profile", tags: [] })).status, 400);
			assert.equal((await call("POST", "/api/memory", { fact: "x", tier: "profile", tags: ["nope"] })).status, 400, "only tags that exist");
			assert.equal((await call("POST", "/api/memory", { fact: "x", tier: "secret", tags: everyBot })).status, 400);
			assert.equal((await call("POST", "/api/memory", { fact: "", tier: "profile", tags: everyBot })).status, 400);

			const listing = await (await call("GET", "/api/memory")).json();
			assert.deepEqual(listing.profile.map((fact: Fact) => [fact.text, fact.tags]), [["Timezone is Pacific", ["every-bot", "@dev"]]]);
			assert.deepEqual(listing.log.map((fact: Fact) => fact.text), ["Dinner Friday"]);
			assert.deepEqual(listing.tags.map((tag: TagView) => [tag.slug, tag.kind, tag.bots]), [["every-bot", "every", [3, 5]], ["@scout", "bot", [3]], ["@dev", "bot", [5]]]);

			const edited = await call("POST", "/api/memory/edit", { fact: "Timezone is Pacific", to: "Timezone is Eastern", tier: "profile" });
			assert.equal(edited.status, 200);
			assert.deepEqual(await edited.json(), { fact: { text: "Timezone is Eastern", date: "2026-10-31", tier: "profile", file: "profile.md", tags: ["every-bot", "@dev"] } });
			assert.equal((await call("POST", "/api/memory/edit", { fact: "Never saved", to: "Anything", tier: "profile" })).status, 404);
			assert.equal((await call("POST", "/api/memory/edit", { fact: "Timezone is Eastern", to: "   ", tier: "profile" })).status, 400);
			assert.equal((await call("POST", "/api/memory/edit", { fact: "Timezone is Eastern", tier: "profile" })).status, 400, "the new text is required");

			assert.equal((await call("POST", "/api/memory/retag", { fact: "Timezone is Eastern", tier: "profile", tags: ["@scout"] })).status, 200);
			assert.deepEqual((await memory.all()).profile[0]?.tags, ["@scout"]);
			assert.equal((await call("POST", "/api/memory/retag", { fact: "Timezone is Eastern", tier: "profile", tags: [] })).status, 200, "untagging is allowed");
			assert.deepEqual((await memory.all()).profile[0]?.tags, []);
			assert.equal((await call("POST", "/api/memory/retag", { fact: "Timezone is Eastern", tier: "profile", tags: ["nope"] })).status, 400);
			assert.equal((await call("POST", "/api/memory/retag", { fact: "Never saved", tier: "profile", tags: everyBot })).status, 404);

			assert.equal((await call("POST", "/api/memory/forget", { fact: "Dinner Friday" })).status, 200);
			assert.equal((await call("POST", "/api/memory/forget", { fact: "Dinner Friday" })).status, 404);
		});
	}));

test("the web portal makes, changes, and deletes the owner's tags", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await withServer(memory, async (call) => {
			const made = await call("POST", "/api/memory/tags", { name: "Job bots", bots: [3] });
			assert.equal(made.status, 201);
			assert.deepEqual(await made.json(), { tag: { slug: "job-bots", name: "Job bots", kind: "custom", bots: [3] } });
			assert.equal((await call("POST", "/api/memory/tags", { name: "job BOTS", bots: [] })).status, 400);
			assert.equal((await call("POST", "/api/memory/tags", { name: "Other" })).status, 400, "bots are required");
			assert.equal((await call("POST", "/api/memory/tags", { bots: [] })).status, 400, "a name is required");
			assert.equal((await call("POST", "/api/memory/tags", { name: "Other", bots: ["three"] })).status, 400);
			await call("POST", "/api/memory", { fact: "On OPT", tier: "profile", tags: ["job-bots"] });

			const changed = await call("PUT", "/api/memory/tags/job-bots", { name: "Careers", bots: [3, 5] });
			assert.deepEqual(await changed.json(), { tag: { slug: "careers", name: "Careers", kind: "custom", bots: [3, 5] } });
			assert.deepEqual((await memory.all()).profile[0]?.tags, ["careers"]);
			assert.equal((await call("PUT", "/api/memory/tags/nope", { name: "X", bots: [] })).status, 404);

			assert.equal((await call("DELETE", "/api/memory/tags/careers")).status, 204);
			assert.equal((await call("DELETE", "/api/memory/tags/careers")).status, 404);
			assert.deepEqual((await memory.all()).profile[0]?.tags, []);
		});
	}));

test("the move to tags tags shared facts for every bot, folds each bot's facts in, merges duplicates, and backs everything up", () =>
	withDir(async (root) => {
		const dir = join(root, "data", "memory");
		const botsDir = join(root, "bots");
		const backupDir = join(root, "data", "backup");
		await mkdir(join(dir, "log"), { recursive: true });
		await mkdir(join(botsDir, "job-search", "memory"), { recursive: true });
		await mkdir(join(botsDir, "job-application", "memory", "log"), { recursive: true });
		await mkdir(join(botsDir, "alfred"), { recursive: true });
		const sharedProfile = "# About the owner\nMy note.\n- (2026-10-01) Lives in Pittsburgh\n";
		const searchProfile = "﻿# About the owner\r\n- (2026-10-13) TikTok limit\r\n- (2026-10-05) [Bracket] first\r\n";
		await writeFile(join(dir, "profile.md"), sharedProfile);
		await writeFile(join(dir, "log", "2026-11.md"), "# 2026-11\n- (2026-11-02) Shared event\n");
		await writeFile(join(botsDir, "job-search", "memory", "profile.md"), searchProfile);
		await writeFile(join(botsDir, "job-application", "memory", "profile.md"), "\n- (2026-10-20) tiktok LIMIT\n- (2026-10-21) Lives in Pittsburgh\n- (2026-10-22) TikTok limit\n");
		await writeFile(join(botsDir, "job-application", "memory", "log", "2026-11.md"), "# 2026-11\n- (2026-11-01) Applied to Apple\n- (2026-11-03) Applied to Razer\n");
		await writeFile(join(botsDir, "alfred", "agent.md"), "Keep me.\n");

		assert.equal(await migrateMemory({ dir, botsDir, backupDir }), true);

		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), "# About the owner\nMy note.\n- (2026-10-01) [every-bot, @job-application] Lives in Pittsburgh\n- (2026-10-05) [@job-search] [Bracket] first\n- (2026-10-13) [@job-application, @job-search] TikTok limit\n");
		assert.equal(await readFile(join(dir, "log", "2026-11.md"), "utf8"), "# 2026-11\n- (2026-11-01) [@job-application] Applied to Apple\n- (2026-11-02) [every-bot] Shared event\n- (2026-11-03) [@job-application] Applied to Razer\n", "newest last, so the prompt's latest 30 are right");
		assert.equal(await readFile(join(dir, "tags.json"), "utf8"), "{}\n");
		assert.deepEqual((await createMemory({ dir }).all()).profile[1]?.text, "[Bracket] first");

		assert.equal(await readFile(join(backupDir, "memory", "profile.md"), "utf8"), sharedProfile);
		assert.equal(await readFile(join(backupDir, "bots", "job-search", "memory", "profile.md"), "utf8"), searchProfile);
		assert.equal(existsSync(join(botsDir, "job-search", "memory")), false);
		assert.equal(existsSync(join(botsDir, "job-application", "memory")), false);
		assert.equal(await readFile(join(botsDir, "alfred", "agent.md"), "utf8"), "Keep me.\n", "only memory folders go");

		const after = await readFile(join(dir, "profile.md"), "utf8");
		assert.equal(await migrateMemory({ dir, botsDir, backupDir }), false, "runs once");
		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), after);
	}));

test("a fresh install has nothing to move and never backs up", () =>
	withDir(async (root) => {
		const dir = join(root, "data", "memory");
		const backupDir = join(root, "data", "backup");
		assert.equal(await migrateMemory({ dir, botsDir: join(root, "bots"), backupDir }), false);
		assert.equal(existsSync(backupDir), false);
		assert.equal(await readFile(join(dir, "tags.json"), "utf8"), "{}\n");
	}));
