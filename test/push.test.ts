// Web Push (src/push.ts): keys persist across restarts, one subscription per browser endpoint, a message
// reaches every subscription, and one the push service reports gone is dropped. Plus the web app's
// /api/push and /sw.js routes. Run from the repo root:  node --test test/push.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createPush } from "../src/push.ts";
import { createBotServer } from "../src/web.ts";

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

test("the web app serves the push key and service worker and saves a browser's subscription", () =>
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
