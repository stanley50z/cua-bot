// Long-term memory: the markdown store, the bot's remember tool feeding the next prompt, and the
// web app's /api/memory routes. Run from the repo root:  node --test test/memory.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createMemory, createMemoryExtension, MemoryError } from "../src/memory.ts";
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

test("facts land in profile.md and monthly log files in the Grok Bot line format", () =>
	withDir(async (dir) => {
		const { clock, now } = clockAt("2026-10-31T09:00:00");
		const memory = createMemory({ dir, now });
		assert.equal((await memory.remember("  Partner is   Dana ", "profile")).added, true);
		assert.equal((await memory.remember("partner is dana", "profile")).added, false, "same text, any case or spacing");
		await memory.remember("Plumber visit Tuesday 9 to 12", "log");
		clock.now = new Date("2026-11-02T08:00:00");
		await memory.remember("Plumber came; sink fixed", "log");

		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), "# About the owner\n- (2026-10-31) Partner is Dana\n");
		assert.equal(await readFile(join(dir, "log", "2026-10.md"), "utf8"), "# 2026-10\n- (2026-10-31) Plumber visit Tuesday 9 to 12\n");
		assert.equal(await readFile(join(dir, "log", "2026-11.md"), "utf8"), "# 2026-11\n- (2026-11-02) Plumber came; sink fixed\n");
		const { profile, log } = await memory.all();
		assert.deepEqual(profile.map((fact) => fact.text), ["Partner is Dana"]);
		assert.deepEqual(log.map((fact) => [fact.date, fact.file]), [
			["2026-10-31", "log/2026-10.md"],
			["2026-11-02", "log/2026-11.md"],
		]);
	}));

test("forget removes matching facts from any file and leaves everything else", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("Prefers short answers", "profile");
		await memory.remember("Timezone is Pacific", "profile");
		await memory.remember("Prefers short answers", "log");
		const removed = await memory.forget("prefers SHORT answers");
		assert.deepEqual(removed.map((fact) => fact.tier).sort(), ["log", "profile"]);
		assert.equal(await readFile(join(dir, "profile.md"), "utf8"), "# About the owner\n- (2026-10-31) Timezone is Pacific\n");
		assert.deepEqual(await memory.forget("never saved"), []);
	}));

test("hand edits are read as-is, including a byte-order mark from a Windows editor", () =>
	withDir(async (dir) => {
		await mkdir(join(dir, "log"), { recursive: true });
		await writeFile(join(dir, "profile.md"), "﻿# About the owner\r\nSome notes I wrote.\r\n- (2026-10-01) Lives in Seattle\r\n");
		await writeFile(join(dir, "log", "notes.md"), "- (2026-10-01) ignored: not a month file\n");
		const memory = createMemory({ dir });
		const { profile, log } = await memory.all();
		assert.deepEqual(profile.map((fact) => fact.text), ["Lives in Seattle"]);
		assert.deepEqual(log, []);
		await memory.forget("Lives in Seattle");
		assert.match(await readFile(join(dir, "profile.md"), "utf8"), /Some notes I wrote\./, "non-fact lines survive");
	}));

test("the prompt section shows profile and recent facts within budget and points at recall for the rest", () =>
	withDir(async (dir) => {
		const { clock, now } = clockAt("2026-01-01T09:00:00");
		const memory = createMemory({ dir, now });
		assert.match(await memory.render(), /Nothing saved yet\./);
		await memory.remember("Timezone is Pacific", "profile");
		for (let day = 1; day <= 40; day++) {
			clock.now = new Date(2026, 0, day, 9);
			await memory.remember(`Event number ${day}`, "log");
		}
		const text = await memory.render();
		assert.match(text, /About the owner:\n- \(2026-01-01\) Timezone is Pacific/);
		assert.match(text, /Recently:/);
		assert.match(text, /Event number 40\n/, "newest log fact is shown");
		assert.doesNotMatch(text, /Event number 10\n/, "only the 30 most recent log facts");
		assert.match(text, /\(10 older facts are not shown; use recall to search them\.\)/);
		assert.equal(await memory.render(), text, "stable while nothing changes, so the prompt cache holds");

		for (let i = 0; i < 20; i++) await memory.remember(`${"x".repeat(400)} ${i}`, "profile");
		assert.ok((await memory.render()).length < 4000 + 600, "budget caps the listed facts");
	}));

test("recall ranks by shared words and remember rejects empty and oversized facts", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		await memory.remember("Landlord is Mr. Okafor", "profile");
		await memory.remember("Plumber visit Tuesday, landlord arranged it", "log");
		await memory.remember("Climbing with Dana on Sundays", "log");
		const hits = await memory.recall("when is the plumber coming, ask the landlord");
		assert.deepEqual(hits.map((fact) => fact.text), ["Plumber visit Tuesday, landlord arranged it", "Landlord is Mr. Okafor"]);
		await assert.rejects(memory.remember("   ", "profile"), MemoryError);
		await assert.rejects(memory.remember("y".repeat(501), "profile"), /at most 500 characters/);
	}));

test("a fact the bot remembers is in its prompt on the next request", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		const prompts: string[] = [];
		// System messages declare named sections; later ones replace a section by name. Keep the latest memory text.
		const memorySection = (messages: readonly Message[]) =>
			messages.reduce((latest, message) => (message.role === "system" && typeof message.sections?.memory === "string" ? message.sections.memory : latest), "");
		const record = (step: () => AssistantMessage): FauxResponseFactory => (request) => {
			prompts.push(memorySection(request.messages));
			return step();
		};
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			record(() => fauxAssistantMessage([fauxToolCall("remember", { fact: "Partner is Dana", tier: "profile" }, { id: "m1" })], { stopReason: "toolUse" })),
			record(() => fauxAssistantMessage([fauxText("Noted.")])),
		]);
		const registry = createRegistry();
		registry.install(createMemoryExtension(memory));
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		try {
			const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const settled = await (await root.submit({ type: "input", content: "My partner is Dana." }, context)).wait(context);
			assert.equal(settled.status, "done");
			assert.equal(prompts.length, 2);
			assert.match(prompts[0] ?? "", /Nothing saved yet/);
			assert.match(prompts[1] ?? "", /Partner is Dana/);
		} finally {
			await harness.close(context);
		}
	}));

test("the web app lists, adds, and forgets facts", () =>
	withDir(async (dir) => {
		const memory = createMemory({ dir, now: () => new Date("2026-10-31T09:00:00") });
		const server: Server = createBotServer({ say: async (text) => text, memory, context });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");
		const base = `http://127.0.0.1:${address.port}`;
		const post = (path: string, body: unknown) =>
			fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		try {
			assert.equal((await post("/api/memory", { fact: "Timezone is Pacific", tier: "profile" })).status, 201);
			assert.equal((await post("/api/memory", { fact: "timezone is pacific" })).status, 200, "duplicate is not an error");
			assert.equal((await post("/api/memory", { fact: "Dinner Friday", tier: "log" })).status, 201);
			assert.equal((await post("/api/memory", { fact: "", tier: "profile" })).status, 400);
			assert.equal((await post("/api/memory", { fact: "x", tier: "secret" })).status, 400);
			const listing = await (await fetch(`${base}/api/memory`)).json();
			assert.deepEqual(listing.profile.map((fact: { text: string }) => fact.text), ["Timezone is Pacific"]);
			assert.deepEqual(listing.log.map((fact: { text: string }) => fact.text), ["Dinner Friday"]);
			assert.equal((await post("/api/memory/forget", { fact: "Dinner Friday" })).status, 200);
			assert.equal((await post("/api/memory/forget", { fact: "Dinner Friday" })).status, 404);
			assert.deepEqual((await (await fetch(`${base}/api/memory`)).json()).log, []);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}));
