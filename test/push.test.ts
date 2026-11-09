// Web Push (src/push.ts): keys persist across restarts, one subscription per browser endpoint, a message
// reaches every subscription, and one the push service reports gone is dropped. Plus the web portal's
// /api/push and /sw.js routes, and a body cut to fit a push. Run from the repo root:  node --test test/push.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createPush, type PushMessage } from "../src/push.ts";
import { createBotServer } from "../src/web.ts";
import { SERVICE_WORKER } from "../src/web-page.ts";

const subscription = (endpoint: string) => ({ endpoint, keys: { p256dh: "BPk", auth: "au" } });

async function inTempDir(run: (file: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-push-"));
	try {
		await run(join(dir, "push.json"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("a message reaches every subscribed browser, and a gone one is dropped", () =>
	inTempDir(async (file) => {
		const sent: { endpoint: string; payload: string }[] = [];
		const logged: unknown[][] = [];
		const deliver = async (to: { endpoint: string }, payload: string) => {
			sent.push({ endpoint: to.endpoint, payload });
			if (to.endpoint.endsWith("/gone")) throw Object.assign(new Error("Received unexpected response code"), { statusCode: 410 });
			if (to.endpoint.endsWith("/flaky")) throw Object.assign(new Error("socket hang up"), { statusCode: 502 });
		};
		const push = createPush({ file, deliver, log: (...parts) => logged.push(parts) });
		push.subscribe(subscription("https://fcm.googleapis.com/fcm/send/chrome"));
		push.subscribe(subscription("https://fcm.googleapis.com/fcm/send/gone"));
		push.subscribe(subscription("https://fcm.googleapis.com/fcm/send/flaky"));
		push.subscribe({ ...subscription("https://fcm.googleapis.com/fcm/send/chrome"), keys: { p256dh: "BNew", auth: "au2" } });

		await push.send({ title: "Your research is ready", body: "3 sources" });
		assert.deepEqual(sent.map((s) => s.endpoint).sort(), ["chrome", "flaky", "gone"].map((n) => `https://fcm.googleapis.com/fcm/send/${n}`));
		assert.deepEqual(JSON.parse(sent[0]?.payload ?? ""), { title: "Your research is ready", body: "3 sources" });
		assert.equal(logged.length, 1, "a failure other than 404/410 is logged, not thrown");

		const restarted = createPush({ file, deliver });
		assert.equal(restarted.publicKey, push.publicKey, "the VAPID key survives a restart, so subscriptions stay valid");
		const saved = JSON.parse(await readFile(file, "utf8")) as { subscriptions: { endpoint: string; keys: { p256dh: string } }[] };
		assert.deepEqual(
			saved.subscriptions.map((s) => [s.endpoint.split("/").at(-1), s.keys.p256dh]),
			[["flaky", "BPk"], ["chrome", "BNew"]],
		);
	}));

test("the web portal serves the push key and service worker and saves a browser's subscription", () =>
	inTempDir(async (file) => {
		const push = createPush({ file, deliver: async () => undefined });
		const server = createBotServer({ say: async () => "", context: BACKGROUND_CONTEXT, push });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");
		const base = `http://127.0.0.1:${address.port}`;
		try {
			assert.deepEqual(await (await fetch(`${base}/api/push`)).json(), { publicKey: push.publicKey });
			const worker = await fetch(`${base}/sw.js`);
			assert.match(worker.headers.get("content-type") ?? "", /javascript/);
			assert.match(await worker.text(), /addEventListener\("push"/);

			const post = (body: unknown) => fetch(`${base}/api/push`, { method: "POST", body: JSON.stringify(body) });
			assert.equal((await post({ endpoint: "http://insecure.example/x", keys: { p256dh: "a", auth: "b" } })).status, 400);
			assert.equal((await post(subscription("https://fcm.googleapis.com/fcm/send/abc"))).status, 204);
			const saved = JSON.parse(await readFile(file, "utf8")) as { subscriptions: unknown[] };
			assert.deepEqual(saved.subscriptions, [subscription("https://fcm.googleapis.com/fcm/send/abc")]);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}));

// Runs src/sw.js against a fake browser with a tab open at each of `urls`.
function runWorker(urls: string[]) {
	const handlers: Record<string, (event: object) => void> = {};
	const shown: { data?: unknown }[] = [];
	const opened: string[] = [];
	const tabs = urls.map((url) => ({
		url,
		focused: false,
		messages: [] as unknown[],
		async focus() {
			this.focused = true;
		},
		postMessage(message: unknown) {
			this.messages.push(message);
		},
	}));
	new Function("self", SERVICE_WORKER)({
		addEventListener: (type: string, handler: (event: object) => void) => {
			handlers[type] = handler;
		},
		skipWaiting: async () => undefined,
		registration: { showNotification: async (_title: string, options: { data?: unknown }) => void shown.push(options) },
		clients: { matchAll: async () => tabs, openWindow: async (url: string) => void opened.push(url) },
	});
	const fire = async (type: string, event: object) => {
		let done: Promise<unknown> | undefined;
		handlers[type]?.({ ...event, waitUntil: (work: Promise<unknown>) => (done = work) });
		await done;
	};
	return { tabs, opened, shown, fire };
}

// Sends `message` through push.send() and the worker's push event, then clicks the notification it showed.
const clickPushed = (message: PushMessage, urls: string[]) =>
	inTempDir(async (file) => {
		const payloads: string[] = [];
		const push = createPush({ file, deliver: async (_to, payload) => void payloads.push(payload) });
		push.subscribe(subscription("https://fcm.googleapis.com/fcm/send/chrome"));
		await push.send(message);
		const worker = runWorker(urls);
		await worker.fire("push", { data: { json: () => JSON.parse(payloads[0] ?? "") } });
		await worker.fire("notificationclick", { notification: { close() {}, data: worker.shown[0]?.data } });
		result = worker;
	}).then(() => result);
let result: ReturnType<typeof runWorker>;

test("clicking a bot's notification with the web portal open focuses that tab and tells it which bot", async () => {
	const { tabs, opened } = await clickPushed({ title: "Alfred", body: "done", bot: 7 }, ["http://127.0.0.1:3000/other", "http://127.0.0.1:3000/#view=routines"]);
	assert.deepEqual(opened, []);
	assert.deepEqual(tabs.map((t) => [t.focused, t.messages]), [[false, []], [true, [{ bot: 7 }]]]);
});

test("clicking a bot's notification with no tab open opens that bot's chat", async () => {
	const { opened } = await clickPushed({ title: "Alfred", bot: 7 }, []);
	assert.deepEqual(opened, ["/#bot=7"]);
});

test("clicking a notification from no particular bot only brings the web portal up", async () => {
	const open = await clickPushed({ title: "Approval needed" }, ["http://127.0.0.1:3000/"]);
	assert.deepEqual(open.tabs.map((t) => [t.focused, t.messages]), [[true, []]]);
	const closed = await clickPushed({ title: "Approval needed" }, []);
	assert.deepEqual(closed.opened, ["/"]);
});

test("a long body is cut to fit a push", () =>
	inTempDir(async (file) => {
		const sent: { title: string; body?: string }[] = [];
		const push = createPush({ file, deliver: async (_to, payload) => void sent.push(JSON.parse(payload)) });
		push.subscribe(subscription("https://fcm.googleapis.com/fcm/send/chrome"));

		await push.send({ title: "Alfred", body: "x".repeat(5000) });
		assert.equal(sent[0]?.body?.length, 500);
		assert.ok(sent[0]?.body?.endsWith("…"));
	}));
