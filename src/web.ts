// The bot's HTTP surface on 127.0.0.1: the web app at GET / with its service worker at /sw.js, its JSON
// API under /api/ (the bot list and its edits, routines CRUD, each bot's chat history/send/react/stop and the owner's pasted images, a server-sent
// event stream of one bot's live chat state, Web Push subscriptions, the Connections tab's check, start at sign-in, the bots' model and reasoning effort, and the default Space's live screen with the owner's control of it), screenshots under /shots/, and the original POST /say. Loopback only, no auth; isOwnRequest refuses
// requests other sites make through the owner's browser.
// Mutations go through the routines manager and the chat module, so every surface agrees.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Cursor } from "@earendil-works/pi-durable";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { ApprovalError, type Approvals, type EmailEdit } from "./approvals.ts";
import type { Autostart } from "./autostart.ts";
import { BotError, type BotInput, type Bots } from "./bots.ts";
import type { Chat, ChatImage } from "./chat.ts";
import type { Connections } from "./connections.ts";
import { type Memory, MemoryError } from "./memory.ts";
import { DATA_DIR } from "./log.ts";
import type { InputEvent, LiveScreen } from "./live-screen.ts";
import type { ModelSettings } from "./model-settings.ts";
import { ModelsConfigError } from "./models.ts";
import { isSubscription, type Push } from "./push.ts";
import type { ScreenControl } from "./screen-control.ts";
import {
	addRoutine,
	deleteRoutine,
	listRoutineViews,
	previewCron,
	routineDir,
	RoutineLimitError,
	RoutineNotFoundError,
	RoutineValidationError,
	runRoutineNow,
	updateRoutine,
} from "./routines.ts";
import { PAGE, SERVICE_WORKER } from "./web-page.ts";

const MAX_BODY_BYTES = 64 * 1024;
// POST /api/chat carries pasted images as base64, so it takes far more than the other JSON bodies.
const CHAT_BODY_BYTES = 64 * 1024 * 1024;
// What the model takes inline without a processor to convert other formats.
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function statusFor(error: unknown): number {
	if (error instanceof HttpError || error instanceof BotError) return error.status;
	if (error instanceof RoutineNotFoundError) return 404;
	if (error instanceof RoutineValidationError) return 400;
	if (error instanceof RoutineLimitError) return 409;
	return 500;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

function sendError(res: ServerResponse, error: unknown): void {
	if (res.headersSent) return void res.end();
	sendJson(res, statusFor(error), { error: messageOf(error) });
}

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
	req.setEncoding("utf8");
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > limit) throw new HttpError(413, "request body is too large");
	}
	return body;
}

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
	const body = await readBody(req, limit);
	if (body.trim() === "") return undefined;
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new HttpError(400, "request body is not valid JSON");
	}
}

// `bot` picks the bot a new routine runs in (the main bot when absent); editing never moves a routine.
function routineInput(body: unknown): { title: string; prompt: string; cron: string; bot?: number } {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "expected a JSON object with title, prompt, and cron");
	}
	const record = body as Record<string, unknown>;
	if (typeof record.title !== "string" || typeof record.prompt !== "string" || typeof record.cron !== "string") {
		throw new HttpError(400, "title, prompt, and cron must be strings");
	}
	if (record.bot !== undefined && record.bot !== null && !Number.isInteger(record.bot)) throw new HttpError(400, "bot must be a bot id");
	return { title: record.title, prompt: record.prompt, cron: record.cron, ...(typeof record.bot === "number" ? { bot: record.bot } : {}) };
}

export type BotServerDeps = {
	say: (text: string) => Promise<string>;
	context: Context;
	/** Enables /api/bots* and /api/chat*. Absent in tests that only exercise routines. */
	bots?: Bots;
	/** Enables /api/memory*: the shared memory. */
	memory?: Memory;
	/** Every bot's own memory, for /api/memory: GET lists them all, and a POST with a bot goes to that bot's. */
	botMemories?: () => { id: number; memory: Memory }[];
	/** Enables /api/approvals* and approval events on the chat stream. Absent when Executor is not configured. */
	approvals?: Approvals;
	/** Fits pasted chat images to the model's limits, converting formats it does not take. Without it, images pass as they are. */
	images?: ImageProcessor;
	/** Shown in the chat header, e.g. "grok-4.7". A function, because Settings > Model changes it while running. */
	model?: () => string;
	shotsDir?: string;
	/** Enables GET /api/computer/live: the default Space's screen as a stream of H.264 access units. */
	live?: LiveScreen;
	/** With `live`, enables POST /api/computer/control and /api/computer/input: the owner driving that Space. */
	control?: ScreenControl;
	/** Enables GET/POST /api/push: the VAPID public key, and a browser's push subscription. */
	push?: Push;
	/** Enables GET /api/connections: this computer, the owner's SSH machines, and the Cua Spaces, checked on each call. */
	connections?: Connections;
	/** Enables GET/PUT /api/autostart: whether start.py runs when the owner signs in to this computer. */
	autostart?: Autostart;
	/** Enables GET/PUT /api/model: the bots' model and reasoning effort. */
	modelSettings?: ModelSettings;
	log?: (...parts: unknown[]) => void;
};

const SHOT_NAME = /^[\w.-]+\.png$/;
// A pane whose socket holds this much unsent video skips to the next keyframe.
const LIVE_BACKLOG_BYTES = 1024 * 1024;
const HISTORY_LIMIT = 50;

// History cursors travel as base64url JSON so the browser treats them as opaque strings.
const encodeCursor = (cursor: Cursor | null) => (cursor === null ? null : Buffer.from(JSON.stringify(cursor)).toString("base64url"));
function decodeCursor(text: string | null): Cursor | undefined {
	if (text === null || text === "") return undefined;
	try {
		return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Cursor;
	} catch {
		throw new HttpError(400, "before is not a valid history cursor");
	}
}

// POST /api/chat's body: { text, images? }, where each image is { data (base64), mimeType }; it needs text or an image.
function chatInput(body: unknown): { text: string; images: ChatImage[] } {
	const record = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const { text = "", images = [] } = record;
	if (typeof text !== "string") throw new HttpError(400, "text must be a string");
	if (!Array.isArray(images)) throw new HttpError(400, "images must be a list");
	const parsed = images.map((image: unknown) => {
		const { data, mimeType } = (image ?? {}) as Record<string, unknown>;
		if (typeof data !== "string" || data === "" || typeof mimeType !== "string" || !mimeType.startsWith("image/")) {
			throw new HttpError(400, "each image must be { data, mimeType } with base64 data and an image/* type");
		}
		return { data, mimeType };
	});
	if (text.trim() === "" && parsed.length === 0) throw new HttpError(400, "text must be a non-empty string, or send an image");
	return { text: text.trim() === "" ? "" : text, images: parsed };
}

// Each pasted image as the model can take it: through the processor when there is one, else only formats taken inline.
async function prepareImages(images: ChatImage[], processor: ImageProcessor | undefined): Promise<ChatImage[]> {
	return Promise.all(
		images.map(async ({ data, mimeType }) => {
			if (processor === undefined) {
				if (!INLINE_IMAGE_TYPES.has(mimeType)) throw new HttpError(400, `${mimeType} images are not supported; paste a PNG, JPEG, GIF, or WebP`);
				return { data, mimeType };
			}
			// A plain Uint8Array: a Buffer can sit in Node's shared pool, which the processor's worker cannot be handed.
			const prepared = await processor.prepare(new Uint8Array(Buffer.from(data, "base64")), mimeType, DEFAULT_IMAGE_LIMITS);
			if (prepared === undefined) throw new HttpError(400, "An image could not be read or made small enough for the model.");
			return { data: prepared.data, mimeType: prepared.mimeType };
		}),
	);
}

// One emoji (with any skin tone, variation selector, or joined parts), as the app's reaction picker sends it.
const EMOJI = /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]*$/u;

// POST /api/chat/react's body: { entryId, emoji, on }, plus the optional `bot` routeChat reads.
function reactionInput(body: unknown): { entryId: number; emoji: string; on: boolean } {
	const record = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const { entryId, emoji, on } = record;
	if (typeof entryId !== "number" || !Number.isInteger(entryId)) throw new HttpError(400, "entryId must be a reply's entry id");
	if (typeof emoji !== "string" || emoji.length > 16 || !EMOJI.test(emoji)) throw new HttpError(400, "emoji must be one emoji");
	if (typeof on !== "boolean") throw new HttpError(400, "on must be true or false");
	return { entryId, emoji, on };
}

// One SSE client of one bot's chat: a `live` snapshot right away, then every chat event, the full
// approvals list whenever it changes, the bot list whenever it changes, and who drives the default Space (a `control`
// event right away and on every change), until the socket closes.
function streamChat(req: IncomingMessage, res: ServerResponse, chat: Chat, bots: Bots, deps: BotServerDeps): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
	const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
	send({ type: "live", live: chat.live });
	if (deps.control !== undefined) send({ type: "control", owner: deps.control.owner });
	const unsubscribe = chat.subscribe(send);
	const unwatch = deps.approvals?.subscribe((list) => send({ type: "approvals", approvals: list }));
	const unwatchBots = bots.subscribe((list) => send({ type: "bots", bots: list }));
	const unwatchControl = deps.control?.subscribe((owner) => send({ type: "control", owner }));
	const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
	req.on("close", () => {
		clearInterval(ping);
		unsubscribe();
		unwatch?.();
		unwatchBots();
		unwatchControl?.();
	});
}

// One pane's live screen: each access unit as a 1-byte flag (1 = keyframe), a 4-byte big-endian length,
// then the Annex-B bytes. The response ends when the stream does, and the page reconnects. Once no pane
// watches, nobody can see the screen to drive it, so control goes back to the bots.
function streamLive(res: ServerResponse, live: LiveScreen, control: ScreenControl | undefined, log: BotServerDeps["log"]): void {
	res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
	const unsubscribe = live.subscribe(
		(frame) => {
			const head = Buffer.alloc(5);
			head.writeUInt8(frame.keyframe ? 1 : 0, 0);
			head.writeUInt32BE(frame.data.byteLength, 1);
			res.write(head);
			res.write(frame.data);
			return res.writableLength < LIVE_BACKLOG_BYTES;
		},
		(reason) => {
			log?.(`live screen ended: ${reason}`);
			res.end();
		},
	);
	res.on("close", () => {
		unsubscribe();
		if (live.watching() === 0 && control?.owner) {
			control.set(false);
			log?.("owner (web): left the live screen, so the bots have the computer again");
		}
	});
}

// The owner driving the default Space from the expanded live view. POST /api/computer/control with `{ owner }` takes
// control (the bots' on-screen steps wait) or hands it back; POST /api/computer/input with `{ events }`
// performs the owner's mouse and keyboard on the Space, in order, and is refused while the bots have control.
async function routeControl(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, url: URL, method: string) {
	const { live, control } = deps;
	if (live === undefined || control === undefined || method !== "POST") throw new HttpError(404, "not found");
	if (url.pathname === "/api/computer/control") {
		const { owner } = ((await readJson(req)) ?? {}) as { owner?: unknown };
		if (typeof owner !== "boolean") throw new HttpError(400, "owner must be true or false");
		if (owner !== control.owner) deps.log?.(owner ? "owner (web): took control of the computer" : "owner (web): handed the computer back to the bots");
		control.set(owner);
		return sendJson(res, 200, { owner });
	}
	if (url.pathname === "/api/computer/input") {
		const events = inputEvents(await readJson(req));
		if (!control.owner) throw new HttpError(409, "take control of the computer first");
		if (!live.input(events)) throw new HttpError(503, "the live screen is not connected yet");
		res.writeHead(204).end();
		return;
	}
	throw new HttpError(404, "not found");
}

const INPUT_KINDS = new Set(["text_commit", "key", "pointer", "scroll"]);

// POST /api/computer/input's body. cua-spacesd checks each event's fields; this keeps out anything but events.
function inputEvents(body: unknown): InputEvent[] {
	const events = body !== null && typeof body === "object" && "events" in body ? body.events : undefined;
	const valid =
		Array.isArray(events) &&
		events.every((event: unknown) => event !== null && typeof event === "object" && "kind" in event && INPUT_KINDS.has(String(event.kind)));
	if (!valid) throw new HttpError(400, "events must be a list of input events");
	return events as InputEvent[];
}

function botInput(body: unknown): BotInput {
	const record = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const instructions = record.instructions ?? "";
	if (typeof record.name !== "string" || typeof instructions !== "string") throw new HttpError(400, "name and instructions must be strings");
	// The ids themselves are checked by bots.ts against its lists.
	const avatar = record.avatar;
	if (avatar === undefined || avatar === null) return { name: record.name, instructions, ...(avatar === null ? { avatar } : {}) };
	const { shape, color } = typeof avatar === "object" ? (avatar as Record<string, unknown>) : {};
	if (typeof shape !== "string" || typeof color !== "string") throw new HttpError(400, "avatar must be {shape, color} or null");
	return { name: record.name, instructions, avatar: { shape, color } };
}

// The bot list: every bot with its newest message, and adding, editing, pinning, or deleting one.
async function routeBots(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, url: URL, method: string) {
	const bots = deps.bots;
	if (bots === undefined) throw new HttpError(404, "not found");
	if (method === "GET" && url.pathname === "/api/bots") return sendJson(res, 200, { bots: bots.list() });
	if (method === "POST" && url.pathname === "/api/bots") {
		const bot = await bots.create(botInput(await readJson(req)));
		deps.log?.(`owner (web): created bot ${bot.name} (${bot.id})`);
		return sendJson(res, 201, bot);
	}
	const id = Number(url.pathname.match(/^\/api\/bots\/(\d+)$/)?.[1]);
	if (Number.isInteger(id) && method === "PUT") {
		const bot = await bots.update(id, botInput(await readJson(req)));
		deps.log?.(`owner (web): edited bot ${bot.name} (${bot.id})`);
		return sendJson(res, 200, bot);
	}
	if (Number.isInteger(id) && method === "DELETE") {
		await bots.remove(id);
		deps.log?.(`owner (web): deleted bot ${id}`);
		return void res.writeHead(204).end();
	}
	const pin = Number(url.pathname.match(/^\/api\/bots\/(\d+)\/pin$/)?.[1]);
	if (Number.isInteger(pin) && method === "PUT") {
		const { pinned } = ((await readJson(req)) ?? {}) as { pinned?: unknown };
		if (typeof pinned !== "boolean") throw new HttpError(400, "pinned must be true or false");
		await bots.pin(pin, pinned);
		deps.log?.(`owner (web): ${pinned ? "pinned" : "unpinned"} bot ${pin}`);
		return void res.writeHead(204).end();
	}
	throw new HttpError(404, "not found");
}

// `bot` (a query parameter, or a field of a JSON body) picks the chat; without it, the main bot's.
async function chatFor(bots: Bots, bot: unknown): Promise<Chat> {
	const id = bot === undefined || bot === null || bot === "" ? undefined : Number(bot);
	if (id !== undefined && !Number.isInteger(id)) throw new HttpError(400, "bot must be a bot id");
	const chat = await bots.chat(id);
	if (chat === undefined) throw new HttpError(404, "No such bot.");
	return chat;
}

function emailEdit(body: unknown): EmailEdit | undefined {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
	const { to, subject, body: text } = body as Record<string, unknown>;
	if (to === undefined && subject === undefined && text === undefined) return undefined;
	if (typeof to !== "string" || typeof subject !== "string" || typeof text !== "string") throw new HttpError(400, "to, subject, and body must be strings");
	return { to, subject, body: text };
}

// Approval cards: list them, and run or drop one. Running happens here, on the owner's click.
async function routeApprovals(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, url: URL, method: string) {
	const approvals = deps.approvals;
	if (approvals === undefined) throw new HttpError(404, "not found");
	if (method === "GET" && url.pathname === "/api/approvals") {
		sendJson(res, 200, { approvals: await approvals.list() });
		return;
	}
	const match = url.pathname.match(/^\/api\/approvals\/([\w-]+)\/(approve|discard)$/);
	if (method === "POST" && match?.[1] !== undefined) {
		const id = match[1];
		try {
			if (match[2] === "approve") {
				const settled = await approvals.approve(id, emailEdit(await readJson(req)));
				deps.log?.(`approval (web): approved ${id}${settled.edited === true ? " with the owner's edits" : ""}: ${settled.status}`);
				sendJson(res, 200, settled);
			} else {
				deps.log?.(`approval (web): discard ${id}`);
				sendJson(res, 200, await approvals.discard(id));
			}
		} catch (error) {
			if (error instanceof ApprovalError) throw new HttpError(409, error.message);
			throw error;
		}
		return;
	}
	throw new HttpError(404, "not found");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a request came from the web app or a local client such as say.py, rather than from another site
 * open in the owner's browser. Any page can send a simple POST to 127.0.0.1, and DNS rebinding can point a
 * page's own name there, so a non-loopback Host or a foreign Origin is refused. Browsers set both headers,
 * and pages cannot forge them.
 */
function isOwnRequest(req: IncomingMessage): boolean {
	if (req.headers.host === undefined || !URL.canParse(`http://${req.headers.host}`)) return false;
	const host = new URL(`http://${req.headers.host}`);
	return LOOPBACK_HOSTS.has(host.hostname) && (req.headers.origin === undefined || req.headers.origin === host.origin);
}

/** Build the bot's HTTP server. The caller listens on 127.0.0.1 and owns shutdown. */
export function createBotServer(deps: BotServerDeps): Server {
	return createServer(async (req, res) => {
		try {
			if (!isOwnRequest(req)) throw new HttpError(403, "cross-site request refused");
			await route(req, res, deps);
		} catch (error) {
			sendError(res, error);
		}
	});
}

async function route(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const method = req.method ?? "GET";

	if (method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
		return;
	}
	if (method === "GET" && url.pathname === "/sw.js") {
		res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }).end(SERVICE_WORKER);
		return;
	}
	if (method === "POST" && url.pathname === "/say") {
		const body = await readBody(req);
		deps.log?.("owner:", body);
		try {
			const answer = await deps.say(body);
			deps.log?.("bot:", answer);
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(answer);
		} catch (error) {
			deps.log?.("say failed:", String(error));
			res.writeHead(500).end(String(error));
		}
		return;
	}
	if (method === "GET" && url.pathname.startsWith("/shots/")) {
		const name = decodeURIComponent(url.pathname.slice("/shots/".length));
		if (!SHOT_NAME.test(name)) throw new HttpError(404, "not found");
		const file = await readFile(join(deps.shotsDir ?? join(DATA_DIR, "shots"), name)).catch(() => undefined);
		if (file === undefined) throw new HttpError(404, "not found");
		res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=31536000, immutable" }).end(file);
		return;
	}
	if (method === "GET" && url.pathname === "/api/computer/live") {
		if (deps.live === undefined) throw new HttpError(404, "not found");
		streamLive(res, deps.live, deps.control, deps.log);
		return;
	}
	if (url.pathname.startsWith("/api/computer/")) return routeControl(req, res, deps, url, method);
	if (url.pathname === "/api/push") return routePush(req, res, deps, method);
	if (url.pathname === "/api/autostart") return routeAutostart(req, res, deps, method);
	if (url.pathname === "/api/model") return routeModel(req, res, deps, method);
	if (method === "GET" && url.pathname === "/api/connections") {
		if (deps.connections === undefined) throw new HttpError(404, "not found");
		return sendJson(res, 200, await deps.connections());
	}
	if (url.pathname.startsWith("/api/bots")) return routeBots(req, res, deps, url, method);
	if (url.pathname.startsWith("/api/chat")) return routeChat(req, res, deps, url, method);
	if (url.pathname.startsWith("/api/memory")) return routeMemory(req, res, deps, url, method);
	if (url.pathname.startsWith("/api/approvals")) return routeApprovals(req, res, deps, url, method);
	if (url.pathname.startsWith("/api/")) return routeApi(req, res, deps, url, method);
	throw new HttpError(404, "not found");
}

// Web Push: the page reads the key to subscribe, then posts the browser's subscription.
async function routePush(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, method: string) {
	const push = deps.push;
	if (push === undefined) throw new HttpError(404, "not found");
	if (method === "GET") return sendJson(res, 200, { publicKey: push.publicKey });
	if (method !== "POST") throw new HttpError(404, "not found");
	const subscription = await readJson(req);
	if (!isSubscription(subscription)) throw new HttpError(400, "body must be a PushSubscription with an https endpoint and keys");
	push.subscribe(subscription);
	deps.log?.(`owner (web): turned on notifications for ${new URL(subscription.endpoint).host}`);
	res.writeHead(204).end();
}

// Settings > Startup: GET reads whether start.py runs at sign-in; PUT {"enabled"} turns it on or off.
async function routeAutostart(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, method: string) {
	const autostart = deps.autostart;
	if (autostart === undefined) throw new HttpError(404, "not found");
	if (method === "GET") return sendJson(res, 200, await autostart.state());
	if (method !== "PUT") throw new HttpError(404, "not found");
	const { enabled } = ((await readJson(req)) ?? {}) as { enabled?: unknown };
	if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
	if (!(await autostart.state()).supported) throw new HttpError(400, "starting at sign-in isn't supported on this OS");
	const state = await autostart.set(enabled);
	deps.log?.(`owner (web): turned ${enabled ? "on" : "off"} start at sign-in (${state.where})`);
	sendJson(res, 200, state);
}

// Settings > Model: GET reads the bots' model and reasoning effort; PUT {"model", "thinkingLevel"} changes them.
async function routeModel(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, method: string) {
	const settings = deps.modelSettings;
	if (settings === undefined) throw new HttpError(404, "not found");
	if (method === "GET") return sendJson(res, 200, await settings.state());
	if (method !== "PUT") throw new HttpError(404, "not found");
	const { model, thinkingLevel } = ((await readJson(req)) ?? {}) as { model?: unknown; thinkingLevel?: unknown };
	if (typeof model !== "string" || typeof thinkingLevel !== "string") throw new HttpError(400, "model and thinkingLevel must be strings");
	try {
		const state = await settings.set(model, thinkingLevel);
		deps.log?.(`owner (web): set the bots to ${state.model}, reasoning ${state.thinkingLevel}`);
		sendJson(res, 200, state);
	} catch (error) {
		if (error instanceof ModelsConfigError) throw new HttpError(400, error.message);
		throw error;
	}
}

function factInput(body: unknown): { fact: string; tier: "profile" | "log"; bot?: number } {
	const record = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	if (typeof record.fact !== "string") throw new HttpError(400, "fact must be a string");
	const tier = record.tier ?? "profile";
	if (tier !== "profile" && tier !== "log") throw new HttpError(400, "tier must be profile or log");
	if (record.bot !== undefined && record.bot !== null && !Number.isInteger(record.bot)) throw new HttpError(400, "bot must be a bot id");
	return { fact: record.fact, tier, ...(typeof record.bot === "number" ? { bot: record.bot } : {}) };
}

// The Memory view: list every fact (log newest first) of the shared memory and of each bot's own, under
// `bots`; add one, or forget one by its text. A POST with `bot` goes to that bot's memory, else the shared one.
async function routeMemory(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, url: URL, method: string) {
	const shared = deps.memory;
	if (shared === undefined) throw new HttpError(404, "not found");
	const ownOf = (bot: number) => {
		const own = deps.botMemories?.().find((entry) => entry.id === bot)?.memory;
		if (own === undefined) throw new HttpError(404, "No such bot.");
		return own;
	};
	const listing = async (memory: Memory) => {
		const { profile, log } = await memory.all();
		return { profile, log: log.toReversed(), dir: memory.dir };
	};
	try {
		if (method === "GET" && url.pathname === "/api/memory") {
			const bots = await Promise.all((deps.botMemories?.() ?? []).map(async ({ id, memory }) => ({ id, ...(await listing(memory)) })));
			sendJson(res, 200, { ...(await listing(shared)), bots });
			return;
		}
		if (method === "POST" && url.pathname === "/api/memory") {
			const { fact, tier, bot } = factInput(await readJson(req));
			const saved = await (bot === undefined ? shared : ownOf(bot)).remember(fact, tier);
			deps.log?.(`memory (web): ${saved.added ? "added" : "already had"} ${bot === undefined ? "shared" : `bot ${bot}`} ${tier}: ${saved.fact.text}`);
			sendJson(res, saved.added ? 201 : 200, saved);
			return;
		}
		if (method === "POST" && url.pathname === "/api/memory/forget") {
			const { fact, bot } = factInput(await readJson(req));
			const removed = await (bot === undefined ? shared : ownOf(bot)).forget(fact);
			if (removed.length === 0) throw new HttpError(404, "no saved fact matches that text");
			deps.log?.(`memory (web): forgot ${removed.length}${bot === undefined ? "" : ` from bot ${bot}`}: ${fact}`);
			sendJson(res, 200, { removed });
			return;
		}
	} catch (error) {
		if (error instanceof MemoryError) throw new HttpError(400, error.message);
		throw error;
	}
	throw new HttpError(404, "not found");
}

async function routeChat(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, url: URL, method: string) {
	const bots = deps.bots;
	if (bots === undefined) throw new HttpError(404, "not found");
	const bot = url.searchParams.get("bot");
	if (method === "GET" && url.pathname === "/api/chat") {
		const chat = await chatFor(bots, bot);
		const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || HISTORY_LIMIT, 1), 200);
		const page = await chat.history(limit, decodeCursor(url.searchParams.get("before")));
		sendJson(res, 200, { items: page.items, before: encodeCursor(page.before), live: chat.live, model: deps.model?.() ?? null });
		return;
	}
	if (method === "POST" && url.pathname === "/api/chat") {
		const body = await readJson(req, CHAT_BODY_BYTES);
		const input = chatInput(body);
		const which = (body as { bot?: unknown }).bot ?? bot;
		const chat = await chatFor(bots, which);
		const images = await prepareImages(input.images, deps.images);
		deps.log?.(
			`owner (web${which === null || which === undefined ? "" : `, bot ${String(which)}`}):`,
			input.text,
			...(images.length === 0 ? [] : [`[${images.length} image${images.length === 1 ? "" : "s"}]`]),
		);
		sendJson(res, 202, await chat.send(input.text, images));
		return;
	}
	// An image the owner pasted: ?entry=<user item id>&index=<n>. Entries never change, so it caches for good.
	if (method === "GET" && url.pathname === "/api/chat/image") {
		const entry = Number(url.searchParams.get("entry"));
		const index = Number(url.searchParams.get("index") ?? 0);
		if (!Number.isInteger(entry) || !Number.isInteger(index) || index < 0) throw new HttpError(400, "entry and index must be integers");
		const image = await (await chatFor(bots, bot)).image(entry, index);
		if (image === undefined) throw new HttpError(404, "not found");
		res.writeHead(200, { "content-type": image.mimeType, "cache-control": "max-age=31536000, immutable" }).end(Buffer.from(image.data, "base64"));
		return;
	}
	if (method === "POST" && url.pathname === "/api/chat/react") {
		const body = await readJson(req);
		const { entryId, emoji, on } = reactionInput(body);
		const which = (body as { bot?: unknown }).bot ?? bot;
		const done = await (await chatFor(bots, which)).react(entryId, emoji, on);
		if (done === undefined) throw new HttpError(404, "No reply with text has that entryId in this chat.");
		deps.log?.(`owner (web${which === null || which === undefined ? "" : `, bot ${String(which)}`}): ${on ? "reacted" : "took back"} ${emoji} on entry ${entryId}`);
		sendJson(res, 202, done);
		return;
	}
	if (method === "POST" && url.pathname === "/api/chat/stop") {
		await (await chatFor(bots, bot)).stop();
		res.writeHead(204).end();
		return;
	}
	if (method === "GET" && url.pathname === "/api/chat/events") return streamChat(req, res, await chatFor(bots, bot), bots, deps);
	if (method === "GET" && url.pathname === "/api/chat/computer") {
		sendJson(res, 200, (await (await chatFor(bots, bot)).computer()) ?? { steps: [] });
		return;
	}
	throw new HttpError(404, "not found");
}

async function routeApi(
	req: IncomingMessage,
	res: ServerResponse,
	deps: BotServerDeps,
	url: URL,
	method: string,
): Promise<void> {
	const ctx = deps.context;
	if (method === "GET" && url.pathname === "/api/routines") {
		sendJson(res, 200, { routines: await listRoutineViews(ctx), dir: basename(routineDir()) });
		return;
	}
	if (method === "POST" && url.pathname === "/api/routines") {
		sendJson(res, 201, await addRoutine(routineInput(await readJson(req)), ctx));
		return;
	}
	if (method === "GET" && url.pathname === "/api/preview") {
		const cron = url.searchParams.get("cron") ?? "";
		try {
			sendJson(res, 200, previewCron(cron));
		} catch (error) {
			sendJson(res, 400, { error: messageOf(error) });
		}
		return;
	}
	const match = url.pathname.match(/^\/api\/routines\/([^/]+)(\/run)?$/);
	if (match?.[1] !== undefined) {
		const id = decodeURIComponent(match[1]);
		if (match[2] === "/run" && method === "POST") {
			sendJson(res, 200, await runRoutineNow(id, ctx));
			return;
		}
		if (match[2] === undefined && method === "PUT") {
			sendJson(res, 200, await updateRoutine(id, routineInput(await readJson(req)), ctx));
			return;
		}
		if (match[2] === undefined && method === "DELETE") {
			await deleteRoutine(id, ctx);
			res.writeHead(204).end();
			return;
		}
	}
	throw new HttpError(404, "not found");
}
