// The bot's HTTP surface on 127.0.0.1: the routines GUI at GET /, its JSON API under /api/,
// and the original POST /say chat endpoint. Loopback only, no auth, same trust as /say always had.
// Mutations go through the routines manager, so the GUI, chat tools, and routines.json agree.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename } from "node:path";
import type { Context } from "@earendil-works/chord";
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
	log?: (...parts: unknown[]) => void;
};

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
	if (url.pathname.startsWith("/api/")) return routeApi(req, res, deps, url, method);
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
