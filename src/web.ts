// The bot's HTTP surface on 127.0.0.1: the web app at GET /, its JSON API under /api/ (routines
// CRUD, chat history/send/stop, and a server-sent event stream of live chat state), screenshots
// under /shots/, and the original POST /say. Loopback only, no auth, same trust as /say always had.
// Mutations go through the routines manager and the chat module, so every surface agrees.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Cursor } from "@earendil-works/pi-durable";
import { ApprovalError, type Approvals, type EmailEdit } from "./approvals.ts";
import type { Chat } from "./chat.ts";
import { type Memory, MemoryError } from "./memory.ts";
import { DATA_DIR } from "./log.ts";
import {
	addRoutine,
	deleteRoutine,
	listRoutineViews,
	previewCron,
	routineFilePath,
	RoutineLimitError,
	RoutineNotFoundError,
	RoutineValidationError,
	runRoutineNow,
	updateRoutine,
} from "./routines.ts";
import { PAGE } from "./web-page.ts";

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
	if (error instanceof HttpError) return error.status;
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

function routineInput(body: unknown): { title: string; prompt: string; cron: string } {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "expected a JSON object with title, prompt, and cron");
	}
	const record = body as Record<string, unknown>;
	if (typeof record.title !== "string" || typeof record.prompt !== "string" || typeof record.cron !== "string") {
		throw new HttpError(400, "title, prompt, and cron must be strings");
	}
	return { title: record.title, prompt: record.prompt, cron: record.cron };
}

export type BotServerDeps = {
	say: (text: string) => Promise<string>;
	context: Context;
	/** Enables /api/chat*. Absent in tests that only exercise routines. */
	chat?: Chat;
	/** Enables /api/memory*. */
	memory?: Memory;
	/** Enables /api/approvals* and approval events on the chat stream. Absent when Executor is not configured. */
	approvals?: Approvals;
	/** Shown in the chat header, e.g. "grok-4.7". */
	model?: string;
	shotsDir?: string;
	log?: (...parts: unknown[]) => void;
};

const SHOT_NAME = /^[\w.-]+\.png$/;
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

// One SSE client: a `live` snapshot right away, then every chat event, and the full approvals list
// whenever it changes, until the socket closes.
function streamChat(req: IncomingMessage, res: ServerResponse, chat: Chat, approvals: Approvals | undefined): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
	const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
	send({ type: "live", live: chat.live });
	const unsubscribe = chat.subscribe(send);
	const unwatch = approvals?.subscribe((list) => send({ type: "approvals", approvals: list }));
	const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
	req.on("close", () => {
		clearInterval(ping);
		unsubscribe();
		unwatch?.();
	});
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
	if (url.pathname.startsWith("/api/chat")) return routeChat(req, res, deps, url, method);
	if (url.pathname.startsWith("/api/memory")) return routeMemory(req, res, deps, url, method);
	if (url.pathname.startsWith("/api/approvals")) return routeApprovals(req, res, deps, url, method);
	if (url.pathname.startsWith("/api/")) return routeApi(req, res, deps, url, method);
	throw new HttpError(404, "not found");
}

function factInput(body: unknown): { fact: string; tier: "profile" | "log" } {
	const record = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	if (typeof record.fact !== "string") throw new HttpError(400, "fact must be a string");
	const tier = record.tier ?? "profile";
	if (tier !== "profile" && tier !== "log") throw new HttpError(400, "tier must be profile or log");
	return { fact: record.fact, tier };
}

// The Memory view: list every fact (log newest first), add one, or forget one by its text.
async function routeMemory(req: IncomingMessage, res: ServerResponse, deps: BotServerDeps, url: URL, method: string) {
	const memory = deps.memory;
	if (memory === undefined) throw new HttpError(404, "not found");
	try {
		if (method === "GET" && url.pathname === "/api/memory") {
			const { profile, log } = await memory.all();
			sendJson(res, 200, { profile, log: log.toReversed(), dir: memory.dir });
			return;
		}
		if (method === "POST" && url.pathname === "/api/memory") {
			const { fact, tier } = factInput(await readJson(req));
			const saved = await memory.remember(fact, tier);
			deps.log?.(`memory (web): ${saved.added ? "added" : "already had"} ${tier}: ${saved.fact.text}`);
			sendJson(res, saved.added ? 201 : 200, saved);
			return;
		}
		if (method === "POST" && url.pathname === "/api/memory/forget") {
			const { fact } = factInput(await readJson(req));
			const removed = await memory.forget(fact);
			if (removed.length === 0) throw new HttpError(404, "no saved fact matches that text");
			deps.log?.(`memory (web): forgot ${removed.length}: ${fact}`);
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
	const chat = deps.chat;
	if (chat === undefined) throw new HttpError(404, "not found");
	if (method === "GET" && url.pathname === "/api/chat") {
		const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || HISTORY_LIMIT, 1), 200);
		const page = await chat.history(limit, decodeCursor(url.searchParams.get("before")));
		sendJson(res, 200, { items: page.items, before: encodeCursor(page.before), live: chat.live, model: deps.model ?? null });
		return;
	}
	if (method === "POST" && url.pathname === "/api/chat") {
		const text = chatText(await readJson(req));
		deps.log?.("owner (web):", text);
		sendJson(res, 202, await chat.send(text));
		return;
	}
	if (method === "POST" && url.pathname === "/api/chat/stop") {
		await chat.stop();
		res.writeHead(204).end();
		return;
	}
	if (method === "GET" && url.pathname === "/api/chat/events") return streamChat(req, res, chat, deps.approvals);
	if (method === "GET" && url.pathname === "/api/chat/computer") {
		sendJson(res, 200, (await chat.computer()) ?? { steps: [] });
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
		sendJson(res, 200, { routines: await listRoutineViews(ctx), file: basename(routineFilePath()) });
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
