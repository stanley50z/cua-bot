// The bot's HTTP surface on 127.0.0.1: the web app at GET / with its service worker at /sw.js, its JSON
// API under /api/ (the bot list and its edits, routines CRUD, each bot's chat history/send/stop, a server-sent
// event stream of one bot's live chat state, Web Push subscriptions, and the Mac's live screen), screenshots under /shots/, and the original POST /say. Loopback only, no auth, same trust as /say always had.
// Mutations go through the routines manager and the chat module, so every surface agrees.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Cursor } from "@earendil-works/pi-durable";
import { ApprovalError, type Approvals, type EmailEdit } from "./approvals.ts";
import { BotError, type BotInput, type Bots } from "./bots.ts";
import type { Chat } from "./chat.ts";
import { type Memory, MemoryError } from "./memory.ts";
import { DATA_DIR } from "./log.ts";
import type { LiveScreen } from "./live-screen.ts";
import { isSubscription, type Push } from "./push.ts";
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

async function readBody(req: IncomingMessage): Promise<string> {
	req.setEncoding("utf8");
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > MAX_BODY_BYTES) throw new HttpError(413, "request body is too large");
	}
	return body;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const body = await readBody(req);
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
	/** A bot's own memory, for /api/memory with a bot; undefined for an unknown bot. */
	botMemory?: (id: number) => Memory | undefined;
	/** Enables /api/approvals* and approval events on the chat stream. Absent when Executor is not configured. */
	approvals?: Approvals;
	/** Shown in the chat header, e.g. "grok-4.7". */
	model?: string;
	shotsDir?: string;
	/** Enables POST /api/computer/control: mints a link to the Mac's live viewer for the owner. */
	viewer?: () => Promise<{ url: string; expiresAt: string }>;
	/** Enables GET /api/computer/live: the Mac's screen as a stream of H.264 access units. */
	live?: LiveScreen;
	/** Enables GET/POST /api/push: the VAPID public key, and a browser's push subscription. */
	push?: Push;
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

function chatText(body: unknown): string {
	const text = body !== null && typeof body === "object" && "text" in body ? body.text : undefined;
	if (typeof text !== "string" || text.trim() === "") throw new HttpError(400, "text must be a non-empty string");
	return text;
}

// One SSE client of one bot's chat: a `live` snapshot right away, then every chat event, the full
// approvals list whenever it changes, and the bot list whenever it changes, until the socket closes.
function streamChat(req: IncomingMessage, res: ServerResponse, chat: Chat, bots: Bots, approvals: Approvals | undefined): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
	const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
	send({ type: "live", live: chat.live });
	const unsubscribe = chat.subscribe(send);
	const unwatch = approvals?.subscribe((list) => send({ type: "approvals", approvals: list }));
	const unwatchBots = bots.subscribe((list) => send({ type: "bots", bots: list }));
	const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
	req.on("close", () => {
		clearInterval(ping);
		unsubscribe();
		unwatch?.();
		unwatchBots();
	});
}

// One pane's live screen: each access unit as a 1-byte flag (1 = keyframe), a 4-byte big-endian length,
// then the Annex-B bytes. The response ends when the stream does, and the page reconnects.
function streamLive(res: ServerResponse, live: LiveScreen, log: BotServerDeps["log"]): void {
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
	res.on("close", unsubscribe);
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

// The bot list: every bot with its newest message, and adding, editing, or deleting one.
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

/** Build the bot's HTTP server. The caller listens on 127.0.0.1 and owns shutdown. */
export function createBotServer(deps: BotServerDeps): Server {
	return createServer(async (req, res) => {
		try {
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
	if (method === "POST" && url.pathname === "/api/computer/control") {
		if (deps.viewer === undefined) throw new HttpError(404, "not found");
		const link = await deps.viewer();
		deps.log?.("owner (web): took control of the computer");
		sendJson(res, 200, link);
		return;
	}
	if (method === "GET" && url.pathname === "/api/computer/live") {
		if (deps.live === undefined) throw new HttpError(404, "not found");
		streamLive(res, deps.live, deps.log);
		return;
	}
	if (url.pathname === "/api/push") return routePush(req, res, deps, method);
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

function factInput(body: unknown): { fact: string; tier: "profile" | "log"; bot?: number } {
	const record = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	if (typeof record.fact !== "string") throw new HttpError(400, "fact must be a string");
	const tier = record.tier ?? "profile";
	if (tier !== "profile" && tier !== "log") throw new HttpError(400, "tier must be profile or log");
	if (record.bot !== undefined && record.bot !== null && !Number.isInteger(record.bot)) throw new HttpError(400, "bot must be a bot id");
	return { fact: record.fact, tier, ...(typeof record.bot === "number" ? { bot: record.bot } : {}) };
}

// The Memory view: list every fact (log newest first) of the shared memory and, with a bot, that bot's
// own; add one, or forget one by its text. A POST with `bot` goes to that bot's memory, else the shared one.
async function routeMemory(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, url: URL, method: string) {
	const shared = deps.memory;
	if (shared === undefined) throw new HttpError(404, "not found");
	const ownOf = (bot: number) => {
		const own = deps.botMemory?.(bot);
		if (own === undefined) throw new HttpError(404, "No such bot.");
		return own;
	};
	const listing = async (memory: Memory) => {
		const { profile, log } = await memory.all();
		return { profile, log: log.toReversed(), dir: memory.dir };
	};
	try {
		if (method === "GET" && url.pathname === "/api/memory") {
			const bot = url.searchParams.get("bot");
			const own = bot === null || bot === "" ? undefined : ownOf(Number(bot));
			sendJson(res, 200, { ...(await listing(shared)), ...(own === undefined ? {} : { own: await listing(own) }) });
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
		sendJson(res, 200, { items: page.items, before: encodeCursor(page.before), live: chat.live, model: deps.model ?? null });
		return;
	}
	if (method === "POST" && url.pathname === "/api/chat") {
		const body = await readJson(req);
		const text = chatText(body);
		const which = (body as { bot?: unknown }).bot ?? bot;
		const chat = await chatFor(bots, which);
		deps.log?.(`owner (web${which === null || which === undefined ? "" : `, bot ${String(which)}`}):`, text);
		sendJson(res, 202, await chat.send(text));
		return;
	}
	if (method === "POST" && url.pathname === "/api/chat/stop") {
		await (await chatFor(bots, bot)).stop();
		res.writeHead(204).end();
		return;
	}
	if (method === "GET" && url.pathname === "/api/chat/events") return streamChat(req, res, await chatFor(bots, bot), bots, deps.approvals);
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
