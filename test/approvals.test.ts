// Approval cards: Gmail raw messages decode for the card and re-encode with the owner's edits; approving
// runs the exact Executor call once and tells the bot; discarding runs nothing; requests survive a
// restart and expire after 7 days; the web app's routes. Run from the repo root:  node --test test/approvals.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { ApprovalError, createApprovals, titleFor } from "../src/approvals.ts";
import { readRaw, writeRaw } from "../src/mime.ts";
import { createBotServer } from "../src/web.ts";
import { type Call, rawEmail, textResult } from "./fake-executor.ts";

const SEND = "tools.google.api.gmail.users.gmailUsersMessagesSend";
const OK = textResult('{"status":"completed","execution":{"ok":true,"value":{"id":"m1"}}}');

async function withStore(run: (store: ReturnType<typeof makeStore>) => Promise<void>, reply: (call: Call) => CallToolResult = () => OK) {
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-approvals-"));
	try {
		await run(makeStore(dir, reply));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function makeStore(dir: string, reply: (call: Call) => CallToolResult) {
	const calls: Call[] = [];
	const notes: string[] = [];
	const clock = { now: Date.parse("2026-10-31T10:00:00Z") };
	const open = () =>
		createApprovals({
			file: join(dir, "approvals.json"),
			call: async (name, args) => {
				calls.push({ name, args });
				return reply({ name, args });
			},
			notify: async (text) => notes.push(text),
			now: () => clock.now,
		});
	return { calls, notes, clock, open, approvals: open() };
}

// Executor's Gmail send: an upload of the base64 message.
const email = (body: string) => ({ accountId: "acc_1", input: { path: { userId: "me" }, contentType: "message/rfc822", body } });
type Sent = { calls: { path: string; input: ReturnType<typeof email> } };
const REPLY = rawEmail([
	"To: Sarah Kim <sarah@studio.org>",
	"Subject: =?UTF-8?B?" + Buffer.from("Re: Friday’s review", "utf8").toString("base64") + "?=",
	"In-Reply-To: <abc@mail.gmail.com>",
	"Content-Type: text/plain; charset=UTF-8",
	"",
	"Could we move it to 2 PM?",
]);

test("a Gmail raw message decodes for the card, and edits re-encode keeping threading headers", () => {
	assert.deepEqual(readRaw(REPLY), { to: "Sarah Kim <sarah@studio.org>", subject: "Re: Friday’s review", body: "Could we move it to 2 PM?", editable: true });
	const edited = writeRaw(REPLY, { to: "sarah@studio.org", subject: "Re: Friday’s review — 2 PM?", body: "Could we move it to 2 PM?\nThanks" });
	assert.deepEqual(readRaw(edited), { to: "sarah@studio.org", subject: "Re: Friday’s review — 2 PM?", body: "Could we move it to 2 PM?\nThanks", editable: true });
	assert.match(Buffer.from(edited, "base64url").toString("utf8"), /^In-Reply-To: <abc@mail\.gmail\.com>\r\n/);

	const html = rawEmail([
		"To: a@b.c",
		"Subject: Hi",
		'Content-Type: multipart/alternative; boundary="xx"',
		"",
		"--xx",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: quoted-printable",
		"",
		"caf=C3=A9 at 5",
		"--xx",
		"Content-Type: text/html",
		"",
		"<p>café at 5</p>",
		"--xx--",
	]);
	assert.deepEqual(readRaw(html), { to: "a@b.c", subject: "Hi", body: "café at 5", editable: false });
	assert.equal(titleFor("tools.google.api.calendar.calendars.calendarEventsDelete"), "Delete calendar events");
	assert.equal(titleFor("tools.google.api.gmail.users.gmailUsersMessagesTrash"), "Trash gmail messages");
});

test("approving runs the exact call once with the owner's edits and tells the bot what was sent", () =>
	withStore(async ({ approvals, calls, notes }) => {
		const card = await approvals.request({ callId: "c1", path: SEND, input: email(REPLY) });
		const done = await approvals.approve(card.id, { to: "Sarah Kim <sarah@studio.org>", subject: "Re: Friday’s review", body: "Could we move it to 2 PM? Thanks!" });
		assert.equal(done.status, "done");
		assert.equal(done.edited, true);
		assert.equal(calls.length, 1);
		const sent = (calls[0]?.args as Sent).calls;
		assert.equal(sent.path, SEND);
		assert.deepEqual(sent.input.input.path, { userId: "me" }, "other fields kept");
		assert.equal(sent.input.input.contentType, "message/rfc822");
		assert.equal(readRaw(sent.input.input.body).body, "Could we move it to 2 PM? Thanks!");
		assert.match(notes[0] ?? "", /^\[approval\] The owner approved and it ran: Send email to Sarah Kim <sarah@studio\.org>: "Re: Friday’s review"\.\nThe owner edited it first\. What was sent:[\s\S]*Thanks!/);
		await assert.rejects(approvals.approve(card.id), ApprovalError, "a second click does nothing");
		assert.equal(calls.length, 1);
	}));

test("Gmail's own body.raw and a plain-text message both become Executor's upload, shown on the card", () =>
	withStore(async ({ approvals, calls }) => {
		const message = "To: sarah@studio.org\r\nSubject: Hi\r\n\r\nSee you at 2.";
		const forms = [{ body: { raw: Buffer.from(message).toString("base64url") } }, { contentType: "message/rfc822", body: message }];
		for (const form of forms) {
			const card = await approvals.request({ callId: "u", path: SEND, input: { accountId: "acc_1", input: { path: { userId: "me" }, ...form } } });
			assert.deepEqual(card.email, { to: "sarah@studio.org", subject: "Hi", body: "See you at 2.", editable: true });
			await approvals.approve(card.id);
		}
		for (const call of calls) {
			const sent = (call.args as Sent).calls.input.input;
			assert.equal(sent.contentType, "message/rfc822");
			assert.equal(readRaw(sent.body).body, "See you at 2.");
		}
	}));

test("when Executor holds an approved send for its own approval, the owner's click accepts it", () =>
	withStore(
		async ({ approvals, calls }) => {
			const card = await approvals.request({ callId: "c1", path: SEND, input: email(REPLY) });
			assert.equal((await approvals.approve(card.id)).status, "done");
			assert.deepEqual(
				calls.map((call) => call.name),
				["call", "resume"],
			);
			assert.deepEqual(calls[1]?.args, { requestId: "apr_9", response: { action: "accept" } });
		},
		(call) => (call.name === "call" ? textResult('{"status":"approval-required","requestId":"apr_9"}') : OK),
	));

test("Executor's field-based Gmail send shows as an email, and edits change the fields", () =>
	withStore(async ({ approvals, calls }) => {
		const path = "tools.google.gmail.send";
		const card = await approvals.request({ callId: "f", path, input: { to: ["sarah@studio.org"], subject: "Friday", body: "2 PM?" } });
		assert.equal(card.title, "Send email");
		assert.deepEqual(card.email, { to: "sarah@studio.org", subject: "Friday", body: "2 PM?", editable: true });
		await approvals.approve(card.id, { to: "sarah@studio.org, dana@studio.org", subject: "Friday review", body: "2 PM works?" });
		assert.deepEqual((calls[0]?.args as { calls: { input: unknown } }).calls.input, { to: ["sarah@studio.org", "dana@studio.org"], subject: "Friday review", body: "2 PM works?" });

		// A reply leaves To and Subject to Gmail unless the owner fills them in.
		const reply = await approvals.request({ callId: "r", path, input: { replyToMessageId: "m1", body: "Sounds good." } });
		assert.equal(reply.title, "Send reply");
		assert.deepEqual(reply.email, { to: "", subject: "", body: "Sounds good.", editable: true, reply: true });
		await approvals.approve(reply.id, { to: "", subject: "", body: "Sounds good, see you then." });
		assert.deepEqual((calls[1]?.args as { calls: { input: unknown } }).calls.input, { replyToMessageId: "m1", to: null, subject: null, body: "Sounds good, see you then." });
	}));

test("discarding runs nothing, and a failed call is reported as failed", () =>
	withStore(
		async ({ approvals, calls, notes }) => {
			const kept = await approvals.request({ callId: "c1", path: "tools.google.api.calendar.calendars.calendarEventsDelete", input: {}, summary: "Design review, Fri 11 AM" });
			assert.equal((await approvals.discard(kept.id)).status, "discarded");
			assert.deepEqual(calls, []);
			assert.equal(notes[0], "[approval] The owner discarded: Delete calendar events: Design review, Fri 11 AM. Don't try it again unless they ask.");

			const card = await approvals.request({ callId: "c2", path: SEND, input: email(REPLY) });
			const failed = await approvals.approve(card.id);
			assert.equal(failed.status, "failed");
			assert.match(notes[1] ?? "", /^\[approval\] The owner approved Send email .* but it failed: .*quota/);
		},
		() => textResult('{"status":"completed","execution":{"ok":false,"error":"quota exceeded"}}'),
	));

test("waiting requests survive a restart and expire after 7 days", () =>
	withStore(async ({ approvals, open, clock }) => {
		const card = await approvals.request({ callId: "c1", path: SEND, input: email(REPLY) });
		const reopened = open();
		assert.equal((await reopened.list())[0]?.status, "waiting");
		clock.now += 8 * 24 * 60 * 60 * 1000;
		assert.equal((await reopened.list())[0]?.status, "expired");
		await assert.rejects(reopened.approve(card.id), /already expired/);
	}));

test("the web app lists, approves with edits, and discards", () =>
	withStore(async ({ approvals, calls }) => {
		const server: Server = createBotServer({ say: async (text) => text, approvals, context: BACKGROUND_CONTEXT });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");
		const base = `http://127.0.0.1:${address.port}`;
		const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		try {
			const card = await approvals.request({ callId: "c1", path: SEND, input: email(REPLY) });
			const other = await approvals.request({ callId: "c2", path: SEND, input: email(REPLY) });
			const listing = await (await fetch(`${base}/api/approvals`)).json();
			assert.deepEqual(listing.approvals.map((a: { id: string }) => a.id), [card.id, other.id]);
			assert.equal((await post(`/api/approvals/${card.id}/approve`, { to: "x@y.z", subject: "S", body: "B" })).status, 200);
			assert.equal(readRaw((calls[0]?.args as Sent).calls.input.input.body).to, "x@y.z");
			assert.equal((await post(`/api/approvals/${card.id}/approve`, {})).status, 409);
			assert.equal((await post(`/api/approvals/${other.id}/discard`, {})).status, 200);
			assert.equal((await post(`/api/approvals/${other.id}/approve`, { to: 5 })).status, 400);
			assert.equal(calls.length, 1);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}));
