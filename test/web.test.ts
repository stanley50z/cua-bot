// The bot's HTTP surface: routines GUI page, /api/routines CRUD + run, /api/preview, and the
// original POST /say. Exercised over real HTTP against createBotServer with a faux model.
// Run from the repo root:  node --test test/web.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { bindRoutines, createRoutinesExtension, syncRoutines, type RoutineView } from "../src/routines.ts";
import { createBotServer } from "../src/web.ts";

const context = BACKGROUND_CONTEXT;
// Tue 2023-11-14T22:13:20Z.
const BASE = 1_700_000_000_000;

function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function scriptedModel() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const reply: FauxResponseStep = (request) => {
		faux.appendResponses([reply]);
		const last = request.messages.findLast((message) => message.role !== "system");
		const text = last === undefined ? "" : messageText(last);
		return fauxAssistantMessage([fauxText(text.startsWith("[routine]") ? "Done." : "ok")]);
	};
	faux.setResponses([reply]);
	return models;
}

type Session = { dir: string; file: string; base: string; harness: Harness; root: Conversation; server: Server };

async function open(): Promise<Session> {
	const dir = await mkdtemp(join(tmpdir(), "grokbot-web-"));
	const file = join(dir, "routines.json");
	const clock = { now: BASE };
	const registry = createRegistry();
	registry.install(createRoutinesExtension());
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: scriptedModel(), registry, now: () => clock.now, setTimer: () => () => {} },
		context,
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	bindRoutines({ harness, root, filePath: file, now: () => clock.now });
	harness.resume();
	await syncRoutines(context);
	const server = createBotServer({ say: async (text) => `echo: ${text}`, context });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return { dir, file, base: `http://127.0.0.1:${address.port}`, harness, root, server };
}

async function close(session: Session): Promise<void> {
	await new Promise<void>((resolve) => session.server.close(() => resolve()));
	await session.harness.close(context);
	await rm(session.dir, { recursive: true, force: true });
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 8_000;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

async function api(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
	const response = await fetch(`${session.base}${path}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
	});
	const text = await response.text();
	return { status: response.status, json: text.length > 0 ? (JSON.parse(text) as unknown) : undefined };
}

test("GET / serves the routines page", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const response = await fetch(`${session.base}/`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/html/);
		const html = await response.text();
		assert.match(html, /cua-bot routines/);
		assert.match(html, /id="routine-form"/);
		assert.match(html, /id="routine-list"/);
		assert.match(html, /\/api\/routines/);
		assert.match(html, /routines\.json/);
	} finally {
		await close(session);
	}
});

test("routines CRUD over HTTP writes the config file and runs on demand", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const created = await api(session, "POST", "/api/routines", {
			title: "Tue Fri",
			prompt: "Standup notes",
			cron: "CRON_TZ=UTC 0 9 * * 2,5",
		});
		assert.equal(created.status, 201);
		const view = created.json as RoutineView;
		assert.ok(view.id.length > 0);
		assert.equal(view.label, "Tuesdays and Fridays 09:00 UTC");
		assert.equal(view.nextFire, "2023-11-17T09:00:00.000Z");

		const saved = JSON.parse(await readFile(session.file, "utf8")) as Array<{ id: string; cron: string }>;
		assert.deepEqual(
			saved.map((def) => def.id),
			[view.id],
		);

		const listed = await api(session, "GET", "/api/routines");
		assert.equal(listed.status, 200);
		const listBody = listed.json as { routines: RoutineView[]; file: string };
		assert.equal(listBody.file, "routines.json");
		assert.deepEqual(
			listBody.routines.map((routine) => routine.id),
			[view.id],
		);

		const updated = await api(session, "PUT", `/api/routines/${view.id}`, {
			title: "Tue Fri",
			prompt: "Standup notes",
			cron: "@every 5m",
		});
		assert.equal(updated.status, 200);
		assert.equal((updated.json as RoutineView).nextFire, new Date(BASE + 300_000).toISOString());

		const ran = await api(session, "POST", `/api/routines/${view.id}/run`);
		assert.equal(ran.status, 200);
		assert.equal((ran.json as RoutineView).lastFiredAt, new Date(BASE).toISOString());
		await eventually(async () => {
			const view2 = await session.root.context(context);
			return view2.messages.some((message) => messageText(message).includes('[routine] "Tue Fri" is due'));
		});

		const removed = await api(session, "DELETE", `/api/routines/${view.id}`);
		assert.equal(removed.status, 204);
		const empty = await api(session, "GET", "/api/routines");
		assert.deepEqual((empty.json as { routines: RoutineView[] }).routines, []);
		assert.deepEqual(JSON.parse(await readFile(session.file, "utf8")), []);
	} finally {
		await close(session);
	}
});

test("validation and not-found failures are JSON errors with status codes", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const badCron = await api(session, "POST", "/api/routines", { title: "x", prompt: "y", cron: "banana" });
		assert.equal(badCron.status, 400);
		assert.match((badCron.json as { error: string }).error, /Invalid cron/);

		const emptyTitle = await api(session, "POST", "/api/routines", { title: " ", prompt: "y", cron: "@daily" });
		assert.equal(emptyTitle.status, 400);
		assert.match((emptyTitle.json as { error: string }).error, /title/);

		const malformed = await api(session, "POST", "/api/routines", "not json{");
		assert.equal(malformed.status, 400);

		const missing = await api(session, "PUT", "/api/routines/nope", { title: "x", prompt: "y", cron: "@daily" });
		assert.equal(missing.status, 404);
		assert.match((missing.json as { error: string }).error, /No routine/);
		assert.equal((await api(session, "DELETE", "/api/routines/nope")).status, 404);
		assert.equal((await api(session, "POST", "/api/routines/nope/run")).status, 404);
		assert.equal((await fetch(`${session.base}/nope`)).status, 404);
	} finally {
		await close(session);
	}
});

test("preview computes the next three fires", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const good = await api(session, "GET", `/api/preview?cron=${encodeURIComponent("CRON_TZ=UTC 0 9 * * 2,5")}`);
		assert.equal(good.status, 200);
		assert.deepEqual(good.json, {
			label: "Tuesdays and Fridays 09:00 UTC",
			next: ["2023-11-17T09:00:00.000Z", "2023-11-21T09:00:00.000Z", "2023-11-24T09:00:00.000Z"],
		});
		const bad = await api(session, "GET", `/api/preview?cron=${encodeURIComponent("banana")}`);
		assert.equal(bad.status, 400);
		assert.match((bad.json as { error: string }).error, /Invalid cron/);
	} finally {
		await close(session);
	}
});

test("POST /say still answers plain text", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const response = await fetch(`${session.base}/say`, { method: "POST", body: "hi there" });
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "echo: hi there");
	} finally {
		await close(session);
	}
});
