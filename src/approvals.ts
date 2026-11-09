// Actions the bot may not take on its own: sending mail, deleting, and calls Executor holds for
// approval. The executor extension files a request with request(); the web portal shows it as a card
// under the bot's reply; the owner's click calls approve() or discard(), which runs (or drops) the
// Executor call from here, never from the model, and then tells the bot the outcome through notify.
// Requests live in data/approvals.json, so a waiting card survives a restart. main.ts builds one store.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { type EmailView, readRaw, writeRaw } from "./mime.ts";
import { ENV_FILE, withEnvValues } from "./model-settings.ts";

const EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_DECIDED = 200;

export type ExecutorCall = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

// Executor's answer as JSON: `approval-required` with a requestId, `unavailable` with a reason, `completed`, and so on.
function statusOf(text: string): { status?: string; requestId?: string; reason?: string } {
	try {
		return (JSON.parse(text) as { status?: string; requestId?: string; reason?: string } | null) ?? {};
	} catch {
		return {};
	}
}

/** The id of the request when this answer says Executor is holding the call for approval; undefined for any other answer. */
export function heldRequest(text: string): string | undefined {
	const { status, requestId } = statusOf(text);
	return status === "approval-required" ? requestId : undefined;
}

/**
 * Accepts Executor's own holds on `result`, up to three in a row, and returns the last answer, which may still be
 * held. Used by approve() after the owner's click, and by executor_call for mail only to the owner.
 */
export async function acceptHolds(call: ExecutorCall, result: CallToolResult) {
	let answer = textOf(result);
	for (let hop = 0; hop < 3; hop++) {
		const held = heldRequest(answer);
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
	/** The bot whose chat shows the card and hears the decision. Absent on cards filed before there were several bots: the main bot. */
	conversationId?: number;
	/** Executor tool path, or for a held call the path Executor paused. */
	path: string;
	input: unknown;
	title: string;
	/** The bot's one-line description, for actions other than email. Optional, so the card can't depend on it; see ApprovalView.details. */
	summary?: string;
	email?: EmailView;
	/** The emails a Gmail thread change touches, in the order of its threadIds. Filled in shortly after filing. */
	threads?: ThreadView[];
	/** Set when Executor itself paused the call; approving resumes it. */
	pausedRequestId?: string;
	status: "waiting" | "running" | "done" | "failed" | "discarded" | "expired";
	createdAt: number;
	decidedAt?: number;
	edited?: boolean;
	/** Executor's answer, or why it failed. */
	outcome?: string;
};

export type ThreadView = { subject: string; from: string };
export type Detail = { label: string; value: string };
/** An approval as the portal receives it: `details` are the rows a card shows for anything other than an email. */
export type ApprovalView = Approval & { details: Detail[] };

export type EmailEdit = { to: string; subject: string; body: string };

export class ApprovalError extends Error {}

// Settings > Approvals; "on" lets a bot change the owner's own Gmail labels without a card. Off when unset.
const AUTO_LABELS = "CUABOT_AUTO_APPROVE_GMAIL_LABELS";
const GMAIL_MODIFY = "tools.google.gmail.modify";
const GMAIL_READ_THREAD = "tools.google.gmail.readThread";
// Which account runs the call, and transport details, say nothing about what it does.
const NOT_SHOWN = new Set(["account", "accountId", "userId", "contentType"]);
// Executor's API tools nest their fields under these; a row reads better without them.
const WRAPPERS = new Set(["input", "path", "query", "body"]);

// A tool's input as label and value rows, e.g. { addLabels: ["Work"] } → "Add labels": "Work". Works for any tool.
function inputDetails(value: unknown, label = ""): Detail[] {
	if (value === null || value === undefined || value === "") return [];
	if (Array.isArray(value)) {
		return value.every((item) => typeof item !== "object") ? inputDetails(value.join(", "), label) : value.flatMap((item) => inputDetails(item, label));
	}
	if (typeof value === "object") {
		return Object.entries(value).flatMap(([key, child]) => {
			if (NOT_SHOWN.has(key)) return [];
			const words = key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
			return inputDetails(child, WRAPPERS.has(key) && typeof child === "object" ? label : `${label} ${words}`.trim());
		});
	}
	return [{ label: label.charAt(0).toUpperCase() + label.slice(1), value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value) }];
}

// The rows on a card, read from the call itself, with thread ids swapped for the emails once they are known.
function detailsOf(approval: Approval): Detail[] {
	if (approval.email !== undefined) return [];
	const { threads } = approval;
	return inputDetails(approval.input).map((detail) =>
		detail.label === "Thread ids" && threads !== undefined ? { label: "Emails", value: threads.map((thread) => `${thread.subject}, from ${thread.from}`).join("\n") } : detail,
	);
}

const view = (approval: Approval): ApprovalView => ({ ...approval, details: detailsOf(approval) });

// Reads a thread's first message through Executor. Throws when the answer has no message.
async function readThread(call: ExecutorCall, account: string | null | undefined, threadId: string): Promise<ThreadView> {
	const result = await call("call", { calls: { path: GMAIL_READ_THREAD, input: { ...(account == null ? {} : { account }), threadId } } });
	const answer = JSON.parse(textOf(result)) as { execution?: { value?: { value?: { messages?: { subject?: string; from?: string }[] } } } };
	const first = answer.execution?.value?.value?.messages?.[0];
	if (first === undefined) throw new Error(`No messages in thread ${threadId}`);
	return { subject: first.subject || "(no subject)", from: first.from || "unknown sender" };
}

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
const failed = (result: CallToolResult, text: string) => result.isError === true || /"ok"\s*:\s*false/.test(text) || statusOf(text).status === "unavailable";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One line for a request, e.g. `Send email to a@b.c: "Lunch"`. Used in messages to the bot and in push notifications. */
export function describeApproval(approval: Approval): string {
	const email = approval.email;
	if (email !== undefined) return `${approval.title} to ${email.to || "the original sender"}: "${email.subject || "Re: the original subject"}"`;
	if (approval.summary !== undefined) return `${approval.title}: ${approval.summary}`;
	// The call only, never approval.threads: this text reaches the bot, and outside parties write email subjects.
	const details = inputDetails(approval.input)
		.map((detail) => `${detail.label}: ${detail.value}`)
		.join("; ");
	return details === "" ? approval.title : `${approval.title}: ${clip(details, 200)}`;
}

export type Approvals = ReturnType<typeof createApprovals>;

/** `filed` hears of each new request after it is saved; main.ts pushes a notification for it. `envFile` is for tests. */
export function createApprovals(options: {
	file: string;
	envFile?: string;
	call: ExecutorCall;
	/** Tells the bot that filed the request; `conversationId` is undefined for the main bot's older cards. */
	notify: (text: string, conversationId: number | undefined) => Promise<unknown>;
	filed?: (approval: Approval) => void;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	const listeners = new Set<(approvals: ApprovalView[]) => void>();
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
			for (const listener of listeners) listener(all.map(view));
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

	const lookedUp = new Set<string>();

	// Names the emails a waiting Gmail thread change touches, once per card and process so a failure isn't retried on
	// every read. It runs beside the card, because the card already shows the thread ids and a slow Executor shouldn't delay it.
	const lookUpThreads = async (approval: Approval) => {
		if (approval.status !== "waiting" || approval.path !== GMAIL_MODIFY || approval.threads !== undefined || lookedUp.has(approval.id)) return;
		lookedUp.add(approval.id);
		try {
			const { account, threadIds } = approval.input as { account?: string | null; threadIds: string[] };
			const threads = await Promise.all(threadIds.map((id) => readThread(options.call, account, id)));
			await change((all) => {
				const current = all.find((a) => a.id === approval.id);
				if (current !== undefined) current.threads = threads;
			});
		} catch {
			// The card keeps its thread ids.
		}
	};

	return {
		/** Whether a bot may change the owner's own Gmail labels without a card. */
		autoLabels: () => process.env[AUTO_LABELS] === "on",

		/** Saves the setting to .env, where a hand edit changes the same line, and applies it to the next call. */
		setAutoLabels(enabled: boolean) {
			const envFile = options.envFile ?? ENV_FILE;
			const value = enabled ? "on" : "off";
			writeFileSync(envFile, withEnvValues(existsSync(envFile) ? readFileSync(envFile, "utf8") : "", { [AUTO_LABELS]: value }));
			process.env[AUTO_LABELS] = value;
		},

		/** Every request, newest last. Waiting ones older than 7 days read as expired. */
		async list(): Promise<ApprovalView[]> {
			const all = await load();
			if (all.some((a) => a.status === "waiting" && now() - a.createdAt > EXPIRES_MS)) await change(expire);
			for (const approval of all) void lookUpThreads(approval);
			return all.map(view);
		},

		/** File a request for the owner. Called by the executor extension instead of running the call. */
		request: (input: { callId: string; conversationId?: number; path: string; input: unknown; summary?: string; pausedRequestId?: string }) =>
			change((all) => {
				const form = emailForm(input.path, input.input);
				const email = form?.view;
				const approval: Approval = {
					id: `ap_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
					callId: input.callId,
					...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
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
			}).then((approval) => {
				options.filed?.(approval);
				void lookUpThreads(approval);
				return approval;
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
				const runCall = () => options.call("call", { calls: { path: started.path, input: started.input } });
				let first = started.pausedRequestId === undefined ? await runCall() : await options.call("resume", { requestId: started.pausedRequestId, response: { action: "accept" } });
				// Executor drops a hold after about 15 minutes, but a card waits 7 days. An expired hold never ran, so run the call again.
				const { status: resumed, reason } = statusOf(textOf(first));
				if (resumed === "unavailable" && reason === "expired") first = await runCall();
				// Executor may hold the call for its own approval. The owner's click is that approval.
				const { result, answer } = await acceptHolds(options.call, first);
				const stillHeld = heldRequest(answer) !== undefined;
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
					? `[approval] The owner approved and it ran: ${describeApproval(settled)}.${sent}\nResult: ${clip(outcome, 600)}`
					: `[approval] The owner approved ${describeApproval(settled)}, but it failed: ${clip(outcome, 600)}`,
				settled.conversationId,
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
			await options.notify(`[approval] The owner discarded: ${describeApproval(settled)}. Don't try it again unless they ask.`, settled.conversationId);
			return settled;
		},

		/** Receive the full list after every change, until the returned function is called. */
		subscribe(listener: (approvals: ApprovalView[]) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
