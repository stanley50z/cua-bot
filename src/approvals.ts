// Actions the bot may not take on its own: sending mail, deleting, and calls Executor holds for
// approval. The executor extension files a request with request(); the web app shows it as a card
// under the bot's reply; the owner's click calls approve() or discard(), which runs (or drops) the
// Executor call from here, never from the model, and then tells the bot the outcome through notify.
// Requests live in data/approvals.json, so a waiting card survives a restart. main.ts builds one store.
import { readFile, rename, writeFile } from "node:fs/promises";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { type EmailView, readRaw, writeRaw } from "./mime.ts";

const EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
/** Executor's id for a call it holds until someone approves it. */
export const PAUSED = /\bapr_[A-Za-z0-9_-]+/;
const KEEP_DECIDED = 200;

export type ExecutorCall = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * Accepts Executor's own holds on `result`, up to three in a row, and returns the last answer, which may still be
 * held. Used by approve() after the owner's click, and by executor_call for mail only to the owner.
 */
export async function acceptHolds(call: ExecutorCall, result: CallToolResult) {
	let answer = textOf(result);
	for (let hop = 0; hop < 3; hop++) {
		const held = PAUSED.exec(answer)?.[0];
		if (held === undefined) break;
		result = await call("resume", { requestId: held, response: { action: "accept" } });
		answer = textOf(result);
	}
	return { result, answer };
}

export type Approval = {
	id: string;
	/** The bot's tool call that asked; the card renders under the reply that made it. */
	callId: string;
	/** Executor tool path, or for a held call the path Executor paused. */
	path: string;
	input: unknown;
	title: string;
	/** The bot's one-line description, for actions other than email. */
	summary?: string;
	email?: EmailView;
	/** Set when Executor itself paused the call; approving resumes it. */
	pausedRequestId?: string;
	status: "waiting" | "running" | "done" | "failed" | "discarded" | "expired";
	createdAt: number;
	decidedAt?: number;
	edited?: boolean;
	/** Executor's answer, or why it failed. */
	outcome?: string;
};

export type EmailEdit = { to: string; subject: string; body: string };

export class ApprovalError extends Error {}

// gmailUsersMessagesTrash → "Trash gmail messages", calendar.events.delete → "Delete calendar events".
export function titleFor(path: string): string {
	const op = path.split(".").at(-1) ?? path;
	if (/MessagesSend$/.test(op)) return "Send email";
	if (/DraftsSend$/.test(op)) return "Send draft";
	const words = op.split(/(?=[A-Z])/).filter((word) => word !== "Users");
	const verb = words.pop() ?? op;
	const rest = words.length > 0 ? words : (path.split(".").slice(-2, -1) as string[]);
	return [verb.charAt(0).toUpperCase() + verb.slice(1), ...rest.map((word) => word.toLowerCase())].join(" ");
}

// Executor's Gmail helper (tools.google.gmail.send) takes the message as fields.
type FieldsSend = { to?: string[] | null; cc?: string[] | null; subject?: string | null; body: string; html?: boolean | null; replyToMessageId?: string | null };

const addresses = (text: string) =>
	text
		.split(/[,;]/)
		.map((part) => part.trim())
		.filter((part) => part !== "");

/** A send as the card shows it, and how the owner's edit changes the call. Undefined when it isn't mail. */
function emailForm(path: string, input: unknown): { input: unknown; view?: EmailView; apply?: (edit: EmailEdit) => unknown } | undefined {
	if (/MessagesSend$/.test(path)) {
		const upload = asUpload(input);
		if (upload === undefined) return undefined;
		let view: EmailView | undefined;
		try {
			view = readRaw(upload.input.body);
		} catch {
			view = undefined;
		}
		return { input: upload, ...(view === undefined ? {} : { view }), apply: (edit) => ({ ...upload, input: { ...upload.input, body: writeRaw(upload.input.body, edit) } }) };
	}
	const fields = input as FieldsSend | undefined;
	if (!/\.send$/.test(path) || typeof fields?.body !== "string") return undefined;
	const reply = typeof fields.replyToMessageId === "string" && fields.replyToMessageId !== "";
	const view: EmailView = {
		to: (fields.to ?? []).join(", "),
		...(fields.cc?.length ? { cc: fields.cc.join(", ") } : {}),
		subject: fields.subject ?? "",
		body: fields.body,
		editable: fields.html !== true,
		...(reply ? { reply: true } : {}),
	};
	return {
		input,
		view,
		// A reply left without To or Subject keeps Gmail's defaults: the original sender, "Re: …".
		apply: (edit) => ({
			...fields,
			to: addresses(edit.to).length > 0 ? addresses(edit.to) : (fields.to ?? null),
			subject: edit.subject !== "" ? edit.subject : (fields.subject ?? null),
			body: edit.body,
		}),
	};
}

type SendInput = { input: { contentType: "message/rfc822"; body: string; [key: string]: unknown }; [key: string]: unknown };

// Executor's Gmail send is an upload: { contentType: 'message/rfc822', body: <the message's bytes as
// base64> }. The bot may also pass Gmail's own { body: { raw } } or the message as plain text; convert
// every form to the upload so the card can decode it and Executor accepts it.
function asUpload(input: unknown): SendInput | undefined {
	const call = input as { input?: Record<string, unknown> } | undefined;
	const inner = call?.input;
	if (inner === undefined) return undefined;
	const body = inner.body as unknown;
	const given = typeof body === "string" ? body : (body as { raw?: unknown } | undefined)?.raw;
	if (typeof given !== "string") return undefined;
	const text = given.trim();
	const encoded = /^[A-Za-z0-9+/_=\s-]+$/.test(text) ? text.replace(/\s+/g, "") : Buffer.from(given, "utf8").toString("base64");
	return { ...call, input: { ...inner, contentType: "message/rfc822", body: Buffer.from(encoded, "base64").toString("base64") } };
}

// The first `message` in Executor's JSON error, which says what went wrong; otherwise the text as is.
function readable(text: string): string {
	const find = (value: unknown): string | undefined => {
		if (value === null || typeof value !== "object") return undefined;
		const record = value as Record<string, unknown>;
		if (typeof record.message === "string") return record.message;
		for (const child of Object.values(record)) {
			const found = find(child);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	try {
		return find(JSON.parse(text)) ?? text;
	} catch {
		return text;
	}
}

const textOf = (result: CallToolResult) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
const failed = (result: CallToolResult, text: string) => result.isError === true || /"ok"\s*:\s*false/.test(text);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export type Approvals = ReturnType<typeof createApprovals>;

export function createApprovals(options: { file: string; call: ExecutorCall; notify: (text: string) => Promise<unknown>; now?: () => number }) {
	const now = options.now ?? Date.now;
	const listeners = new Set<(approvals: Approval[]) => void>();
	let loaded: Promise<Approval[]> | undefined;
	let queue = Promise.resolve();

	const load = () =>
		(loaded ??= readFile(options.file, "utf8").then(
			(text) => JSON.parse(text.replace(/^﻿/, "")) as Approval[],
			() => [] as Approval[],
		));

	// Serialize every change so two clicks never both run one action.
	const change = <T>(work: (all: Approval[]) => Promise<T> | T): Promise<T> => {
		const run = queue.then(async () => {
			const all = await load();
			const result = await work(all);
			const decided = all.filter((a) => a.status !== "waiting" && a.status !== "running");
			const keep = new Set(decided.slice(-KEEP_DECIDED));
			const kept = all.filter((a) => a.status === "waiting" || a.status === "running" || keep.has(a));
			all.splice(0, all.length, ...kept);
			await writeFile(`${options.file}.tmp`, JSON.stringify(all, null, "\t"), "utf8");
			await rename(`${options.file}.tmp`, options.file);
			for (const listener of listeners) listener(all.map((a) => ({ ...a })));
			return result;
		});
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const expire = (all: Approval[]) => {
		for (const approval of all) {
			if (approval.status === "waiting" && now() - approval.createdAt > EXPIRES_MS) approval.status = "expired";
		}
	};

	const find = (all: Approval[], id: string) => {
		expire(all);
		const approval = all.find((a) => a.id === id);
		if (approval === undefined) throw new ApprovalError("No such approval.");
		if (approval.status !== "waiting") throw new ApprovalError(`This request is already ${approval.status}.`);
		return approval;
	};

	function describe(approval: Approval): string {
		const email = approval.email;
		if (email !== undefined) return `${approval.title} to ${email.to || "the original sender"}: "${email.subject || "Re: the original subject"}"`;
		return approval.summary === undefined ? approval.title : `${approval.title}: ${approval.summary}`;
	}

	return {
		/** Every request, newest last. Waiting ones older than 7 days read as expired. */
		async list(): Promise<Approval[]> {
			const all = await load();
			if (all.some((a) => a.status === "waiting" && now() - a.createdAt > EXPIRES_MS)) await change(expire);
			return all.map((a) => ({ ...a }));
		},

		/** File a request for the owner. Called by the executor extension instead of running the call. */
		request: (input: { callId: string; path: string; input: unknown; summary?: string; pausedRequestId?: string }) =>
			change((all) => {
				const form = emailForm(input.path, input.input);
				const email = form?.view;
				const approval: Approval = {
					id: `ap_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
					callId: input.callId,
					path: input.path,
					input: form?.input ?? input.input,
					title: email === undefined ? titleFor(input.path) : email.reply ? "Send reply" : "Send email",
					...(input.summary === undefined || input.summary.trim() === "" ? {} : { summary: input.summary.trim() }),
					...(email === undefined ? {} : { email }),
					...(input.pausedRequestId === undefined ? {} : { pausedRequestId: input.pausedRequestId }),
					status: "waiting",
					createdAt: now(),
				};
				all.push(approval);
				return { ...approval };
			}),

		/** Run the request as approved, with the owner's edits for an editable email, then tell the bot. */
		async approve(id: string, edit?: EmailEdit): Promise<Approval> {
			const started = await change((all) => {
				const approval = find(all, id);
				// Also converts a send filed by an older version in another form.
				const form = emailForm(approval.path, approval.input);
				if (form !== undefined) approval.input = form.input;
				if (edit !== undefined) {
					if (form?.apply === undefined || approval.email?.editable !== true) throw new ApprovalError("This request can't be edited.");
					if (edit.to.trim() === "" && approval.email.reply !== true) throw new ApprovalError("To can't be empty.");
					const changed = edit.to !== approval.email.to || edit.subject !== approval.email.subject || edit.body !== approval.email.body;
					if (changed) {
						approval.input = form.apply(edit);
						approval.email = { ...approval.email, to: edit.to, subject: edit.subject, body: edit.body };
						approval.edited = true;
					}
				}
				approval.status = "running";
				return { ...approval };
			});
			let status: Approval["status"];
			let outcome: string;
			try {
				// Executor may hold the call for its own approval. The owner's click is that approval.
				const { result, answer } = await acceptHolds(
					options.call,
					started.pausedRequestId === undefined
						? await options.call("call", { calls: { path: started.path, input: started.input } })
						: await options.call("resume", { requestId: started.pausedRequestId, response: { action: "accept" } }),
				);
				const stillHeld = PAUSED.test(answer);
				status = stillHeld || failed(result, answer) ? "failed" : "done";
				outcome = stillHeld ? "Executor is still holding it for approval; finish it at executor.sh." : status === "failed" ? readable(answer) : answer;
			} catch (error) {
				outcome = error instanceof Error ? error.message : String(error);
				status = "failed";
			}
			const settled = await change((all) => {
				const approval = all.find((a) => a.id === id);
				if (approval === undefined) throw new ApprovalError("No such approval.");
				Object.assign(approval, { status, outcome: clip(outcome, 2000), decidedAt: now() });
				return { ...approval };
			});
			const sent = settled.email !== undefined && settled.edited === true ? `\nThe owner edited it first. What was sent:\nTo: ${settled.email.to}\nSubject: ${settled.email.subject}\n\n${settled.email.body}` : "";
			await options.notify(
				status === "done"
					? `[approval] The owner approved and it ran: ${describe(settled)}.${sent}\nResult: ${clip(outcome, 600)}`
					: `[approval] The owner approved ${describe(settled)}, but it failed: ${clip(outcome, 600)}`,
			);
			return settled;
		},

		/** Drop the request and tell the bot. */
		async discard(id: string): Promise<Approval> {
			const settled = await change((all) => {
				const approval = find(all, id);
				Object.assign(approval, { status: "discarded", decidedAt: now() });
				return { ...approval };
			});
			if (settled.pausedRequestId !== undefined) {
				await options.call("resume", { requestId: settled.pausedRequestId, response: { action: "decline" } }).catch(() => undefined);
			}
			await options.notify(`[approval] The owner discarded: ${describe(settled)}. Don't try it again unless they ask.`);
			return settled;
		},

		/** Receive the full list after every change, until the returned function is called. */
		subscribe(listener: (approvals: Approval[]) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
