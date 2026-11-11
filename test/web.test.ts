// The bot's HTTP surface: routines GUI page, /api/routines CRUD + run, /api/preview, and the
// original POST /say. Exercised over real HTTP against createBotServer with a faux model.
// Run from the repo root:  node --test test/web.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { AVATAR_COLORS, AVATAR_SHAPES, botLookup } from "../src/bots.ts";
import { bindRoutines, createRoutinesExtension, syncRoutines, type RoutineView } from "../src/routines.ts";
import { createTurns } from "../src/turns.ts";
import { createLiveScreen, type InputEvent } from "../src/live-screen.ts";
import { createScreenControl } from "../src/screen-control.ts";
import type { ConnectionsSnapshot } from "../src/connections.ts";
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
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-web-"));
	const file = join(dir, "cua-bot", "routines.json");
	await mkdir(dirname(file), { recursive: true });
	const clock = { now: BASE };
	const registry = createRegistry();
	registry.install(createRoutinesExtension());
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: scriptedModel(), registry, now: () => clock.now, setTimer: () => () => {} },
		context,
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	bindRoutines({ harness, bots: botLookup(harness, root, dirname(dirname(file))), turns: createTurns(async () => undefined), now: () => clock.now });
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

test("GET / serves the web portal with chat, computer pane, and routines", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const response = await fetch(`${session.base}/`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/html/);
		const html = await response.text();
		assert.match(html, /<title>cua-bot<\/title>/);
		assert.match(html, /id="composer"/);
		assert.match(html, /\/api\/chat\/events/);
		assert.match(html, /id="screen"/);
		assert.match(html, /id="routine-form"/);
		assert.match(html, /id="routine-rows"/);
		assert.match(html, /\/api\/routines/);
		assert.match(html, /id="routine-dir"/);
		assert.match(html, /id="f-bot"/, "a new routine picks its bot");
		assert.match(html, /\/api\/chat\/react/, "reactions are posted");
		assert.match(html, /class="input" id="input" contenteditable="plaintext-only"/, "quotes sit inline in the message box");
		for (const id of [...AVATAR_SHAPES, ...AVATAR_COLORS]) assert.match(html, new RegExp(`^\\s+${id}: `, "m"), `the page draws the avatar ${id} the server accepts`);
		assert.doesNotMatch(html, /innerHTML/, "server text is rendered with DOM nodes only");
	} finally {
		await close(session);
	}
});

test("the page's markdown libraries are served as browser scripts", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const html = await (await fetch(`${session.base}/`)).text();
		const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
		assert.deepEqual(scripts, ["/marked.js", "/purify.js"]);
		assert.doesNotMatch(html, /^\s*(?:function|const|let|var|class)\s+(?:marked|DOMPurify)\b/m, "a page global of the same name would replace the library");
		const responses = await Promise.all(scripts.map((path) => fetch(`${session.base}${path}`)));
		for (const response of responses) {
			assert.equal(response.status, 200);
			assert.match(response.headers.get("content-type") ?? "", /javascript/);
		}
		const browser: { marked?: { parse: (text: string, options: object) => string } } = {};
		runInNewContext(await responses[0].text(), browser);
		const rendered = browser.marked?.parse("> *quote*\n\n| a |\n|---|\n| [**b**](https://e.com) |", { gfm: true, breaks: true }) ?? "";
		assert.match(rendered, /<blockquote>\s*<p><em>quote<\/em><\/p>\s*<\/blockquote>/);
		assert.match(rendered, /<td><a href="https:\/\/e\.com"><strong>b<\/strong><\/a><\/td>/);
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
		const listBody = listed.json as { routines: RoutineView[]; dir: string };
		assert.equal(listBody.dir, basename(session.dir));
		assert.deepEqual(listBody.routines.map((routine) => routine.botName), ["cua-bot"]);
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
		assert.equal(existsSync(session.file), false, "a bot without routines has no file");
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

test("once travels through the routines API and the preview", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const body = { title: "PDMA", prompt: "Remind me", cron: "CRON_TZ=UTC 0 12 9 11 *" };
		const created = await api(session, "POST", "/api/routines", { ...body, once: true });
		assert.equal(created.status, 201);
		const view = created.json as RoutineView;
		assert.equal(view.once, true);
		assert.equal(view.label, "once, Nov 9 12:00 UTC");
		const saved = JSON.parse(await readFile(session.file, "utf8")) as Array<{ once?: boolean }>;
		assert.equal(saved[0]?.once, true);

		const updated = await api(session, "PUT", `/api/routines/${view.id}`, body);
		assert.equal((updated.json as RoutineView).once, undefined);
		assert.equal((updated.json as RoutineView).label, "yearly Nov 9 12:00 UTC");

		const bad = await api(session, "POST", "/api/routines", { ...body, once: "yes" });
		assert.equal(bad.status, 400);
		assert.match((bad.json as { error: string }).error, /once/);

		const preview = await api(session, "GET", `/api/preview?once=1&cron=${encodeURIComponent(body.cron)}`);
		assert.deepEqual(preview.json, { label: "once, Nov 9 12:00 UTC", next: ["2024-11-09T12:00:00.000Z"] });
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

// Send with raw headers, since fetch won't let a caller set Host. Resolves to the status and body.
function rawRequest(base: string, method: string, path: string, headers: Record<string, string>, body = ""): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const req = request(`${base}${path}`, { method, headers }, (res) => {
			let text = "";
			res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
		});
		req.on("error", reject).end(body);
	});
}

test("requests from other sites in the owner's browser are refused before they reach the bot", { timeout: 20_000 }, async () => {
	const said: string[] = [];
	const server = createBotServer({ say: async (text) => (said.push(text), "ok"), context });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const host = `127.0.0.1:${address.port}`;
	try {
		// A page on another site posting a simple text/plain request.
		assert.equal((await rawRequest(base, "POST", "/say", { origin: "https://evil.example" }, "run this")).status, 403);
		assert.equal((await rawRequest(base, "POST", "/say", { origin: "null" }, "run this")).status, 403);
		// DNS rebinding: the page's own name now resolves to 127.0.0.1.
		assert.equal((await rawRequest(base, "GET", "/api/bots", { host: `evil.example:${address.port}` })).status, 403);
		assert.equal((await rawRequest(base, "POST", "/say", { host: `evil.example:${address.port}`, origin: `http://evil.example:${address.port}` }, "run this")).status, 403);
		assert.deepEqual(said, []);

		// The web portal itself, under either loopback name, and local clients that send no Origin.
		assert.equal((await rawRequest(base, "POST", "/say", { origin: `http://${host}` }, "a")).status, 200);
		assert.equal((await rawRequest(base, "POST", "/say", { host: `localhost:${address.port}`, origin: `http://localhost:${address.port}` }, "b")).status, 200);
		assert.equal((await rawRequest(base, "POST", "/say", {}, "c")).status, 200);
		assert.deepEqual(said, ["a", "b", "c"]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("a name in allowedHosts works over an HTTPS proxy, and every other name or origin is still refused", { timeout: 20_000 }, async () => {
	const said: string[] = [];
	const server = createBotServer({ say: async (text) => (said.push(text), "ok"), context, allowedHosts: ["Portal.Example.ts.net"] });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const portal = "portal.example.ts.net";
	try {
		// The phone opening the page, then posting from it, on the default port and on another one.
		assert.equal((await rawRequest(base, "GET", "/", { host: portal })).status, 200);
		assert.equal((await rawRequest(base, "POST", "/say", { host: portal, origin: `https://${portal}` }, "a")).status, 200);
		assert.equal((await rawRequest(base, "POST", "/say", { host: `${portal}:8443`, origin: `https://${portal}:8443` }, "b")).status, 200);
		assert.deepEqual(said, ["a", "b"]);

		// Another site, plain http, and a different port on the same name.
		assert.equal((await rawRequest(base, "POST", "/say", { host: portal, origin: "https://evil.example" }, "x")).status, 403);
		assert.equal((await rawRequest(base, "POST", "/say", { host: portal, origin: `http://${portal}` }, "x")).status, 403);
		assert.equal((await rawRequest(base, "POST", "/say", { host: portal, origin: `https://${portal}:8443` }, "x")).status, 403);
		// A name that isn't listed, and the listed name's page calling the loopback address.
		assert.equal((await rawRequest(base, "GET", "/api/bots", { host: "other.example.ts.net" })).status, 403);
		assert.equal((await rawRequest(base, "POST", "/say", { origin: `https://${portal}` }, "x")).status, 403);
		assert.deepEqual(said, ["a", "b"]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
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

test("the owner takes control, drives the Mac through the live session, and hands it back; 404 without a Space", { timeout: 20_000 }, async () => {
	const sent: InputEvent[][] = [];
	const live = createLiveScreen(async (sink) => {
		setImmediate(() => sink.frame({ keyframe: true, data: new Uint8Array([0, 0, 1, 0x67]) }));
		return { requestKeyframe: () => {}, input: (events) => void sent.push(events), close: async () => {} };
	});
	const control = createScreenControl();
	const server = createBotServer({ say: async () => "", context, live, control });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const post = async (path: string, body: unknown) =>
		(await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
	const click: InputEvent[] = [
		{ kind: "pointer", phase: "down", button: "left", x_normalized: 0.5, y_normalized: 0.25, modifiers: [] },
		{ kind: "pointer", phase: "up", button: "left", x_normalized: 0.5, y_normalized: 0.25, modifiers: [] },
	];
	const watcher = new AbortController();
	try {
		const watching = await fetch(`${base}/api/computer/live`, { signal: watcher.signal });
		assert.equal(watching.status, 200);
		assert.equal(await post("/api/computer/input", { events: click }), 409);

		const taken = await fetch(`${base}/api/computer/control`, { method: "POST", body: JSON.stringify({ owner: true }) });
		assert.deepEqual(await taken.json(), { owner: true });
		let botResumed = false;
		void control.botTurn().then(() => (botResumed = true));
		assert.equal(await post("/api/computer/input", { events: click }), 204);
		assert.deepEqual(sent, [click]);
		assert.equal(await post("/api/computer/input", { events: [{ kind: "launch", app: "Terminal" }] }), 400);
		assert.equal(await post("/api/computer/control", { owner: "yes" }), 400);
		assert.equal(botResumed, false);

		assert.equal(await post("/api/computer/control", { owner: false }), 200);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(botResumed, true);

		// Leaving the live screen while in control hands the Mac back too.
		assert.equal(await post("/api/computer/control", { owner: true }), 200);
		watcher.abort();
		await eventually(async () => !control.owner);
	} finally {
		watcher.abort();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	const session = await open();
	try {
		assert.equal((await api(session, "POST", "/api/computer/control", { owner: true })).status, 404);
		assert.equal((await api(session, "POST", "/api/computer/input", { events: [] })).status, 404);
	} finally {
		await close(session);
	}
});

test("GET /api/computer/live frames each access unit as flag, length, bytes, and 404s without a Space", { timeout: 20_000 }, async () => {
	let unsubscribed = 0;
	const server = createBotServer({
		say: async () => "",
		context,
		live: {
			subscribe: (send, end) => {
				send({ keyframe: true, data: new Uint8Array([0, 0, 1, 0x67]) });
				send({ keyframe: false, data: new Uint8Array([9, 9]) });
				setImmediate(() => end("done"));
				return () => void unsubscribed++;
			},
			watching: () => 0,
			input: () => false,
		},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	try {
		const response = await fetch(`http://127.0.0.1:${address.port}/api/computer/live`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "application/octet-stream");
		assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 0, 0, 0, 4, 0, 0, 1, 0x67, 0, 0, 0, 0, 2, 9, 9]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(unsubscribed, 1);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	const session = await open();
	try {
		assert.equal((await api(session, "GET", "/api/computer/live")).status, 404);
	} finally {
		await close(session);
	}
});

test("GET /api/connections serves a fresh check, and 404s without one", { timeout: 20_000 }, async () => {
	let checks = 0;
	const here = { name: "desk", os: "Windows", user: "me", pid: 1, startedAt: 0, database: "db.sqlite", aliases: [], spaces: [] };
	const server = createBotServer({
		say: async () => "",
		context,
		connections: async (): Promise<ConnectionsSnapshot> => ({ here, machines: [], otherSpaces: [], checkedAt: ++checks }),
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	try {
		const url = `http://127.0.0.1:${address.port}/api/connections`;
		assert.equal((await (await fetch(url)).json()).checkedAt, 1);
		assert.equal((await (await fetch(url)).json()).checkedAt, 2);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	const session = await open();
	try {
		assert.equal((await api(session, "GET", "/api/connections")).status, 404);
	} finally {
		await close(session);
	}
});
