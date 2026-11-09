// Web Push for the web portal: a browser that turned notifications on in the web portal gets them even with every
// cua-bot tab closed, as long as the browser runs. main.ts builds one with createPush() and calls send()
// for every message a bot sends the owner with send_message (src/bots.ts) and every approval card; web.ts
// serves the public key and takes subscriptions. The VAPID keys and the subscriptions live in data/push.json,
// so they survive a restart. A subscription the push service reports gone (404/410) is dropped.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import webpush, { type PushSubscription } from "web-push";

// The contact the push service sees in the VAPID token.
const SUBJECT = "https://github.com/stanley50z/cua-bot";
const TTL_SECONDS = 24 * 60 * 60;
// Push services cap the payload near 4 KB; a notification shows only the first lines anyway.
const BODY_MAX = 500;

/** What the service worker (src/sw.js) shows. The same tag replaces an earlier notification; a click opens the chat of `bot`. */
export type PushMessage = { title: string; body?: string; tag?: string; bot?: number };

type Keys = { publicKey: string; privateKey: string };
type Saved = Keys & { subscriptions: PushSubscription[] };
type Deliver = (subscription: PushSubscription, payload: string, keys: Keys) => Promise<unknown>;

const webPush: Deliver = (subscription, payload, keys) =>
	webpush.sendNotification(subscription, payload, { vapidDetails: { subject: SUBJECT, ...keys }, TTL: TTL_SECONDS });

export type Push = ReturnType<typeof createPush>;

/** `deliver` is for tests; it defaults to sending through the browser's push service. */
export function createPush(options: { file: string; deliver?: Deliver; log?: (...parts: unknown[]) => void }) {
	const deliver = options.deliver ?? webPush;
	const saved = load(options.file);
	const save = () => {
		writeFileSync(`${options.file}.tmp`, JSON.stringify(saved, null, "\t"), "utf8");
		renameSync(`${options.file}.tmp`, options.file);
	};
	save();

	return {
		publicKey: saved.publicKey,

		/** Keeps one subscription per endpoint; a browser re-subscribing replaces its old keys. */
		subscribe(subscription: PushSubscription) {
			saved.subscriptions = [...saved.subscriptions.filter((s) => s.endpoint !== subscription.endpoint), subscription];
			save();
		},

		/** Sends to every subscribed browser. Never throws: a notification that can't go out is logged. */
		async send(message: PushMessage) {
			const body = message.body !== undefined && message.body.length > BODY_MAX ? `${message.body.slice(0, BODY_MAX - 1)}…` : message.body;
			const payload = JSON.stringify({ ...message, ...(body === undefined ? {} : { body }) });
			const gone = new Set<string>();
			await Promise.all(
				saved.subscriptions.map(async (subscription) => {
					try {
						await deliver(subscription, payload, saved);
					} catch (error) {
						const status = (error as { statusCode?: number }).statusCode;
						if (status === 404 || status === 410) gone.add(subscription.endpoint);
						else options.log?.(`push: ${new URL(subscription.endpoint).host} failed:`, error instanceof Error ? error.message : String(error));
					}
				}),
			);
			if (gone.size === 0) return;
			saved.subscriptions = saved.subscriptions.filter((s) => !gone.has(s.endpoint));
			save();
		},
	};
}

function load(file: string): Saved {
	try {
		const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
		if (typeof saved.publicKey === "string" && typeof saved.privateKey === "string") {
			return { publicKey: saved.publicKey, privateKey: saved.privateKey, subscriptions: saved.subscriptions ?? [] };
		}
	} catch {
		// First run, or an unreadable file: start over with new keys. Browsers re-subscribe on their next visit.
	}
	return { ...webpush.generateVAPIDKeys(), subscriptions: [] };
}

/** Checks the body of POST /api/push: the browser's PushSubscription as JSON. */
export function isSubscription(value: unknown): value is PushSubscription {
	if (value === null || typeof value !== "object" || !("endpoint" in value) || !("keys" in value)) return false;
	const { endpoint, keys } = value;
	if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) return false;
	return keys !== null && typeof keys === "object" && "p256dh" in keys && "auth" in keys && typeof keys.p256dh === "string" && typeof keys.auth === "string";
}
