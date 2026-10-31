import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { createTransport, type SendMailOptions } from "nodemailer";
import { createEmailExtension } from "../src/email.ts";

const OWNER = "owner@example.com";
const FROM = "bot@example.com";
const SUBJECT = "Shot from the desktop";
const BODY = "The window you asked about is open.";

function textOf(output: readonly { type: string; text?: string }[] | undefined): string {
	return (output ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
}

function attachmentPaths(options: SendMailOptions): string[] {
	const paths: string[] = [];
	for (const item of options.attachments ?? []) {
		if (typeof item.path === "string") paths.push(item.path);
	}
	return paths;
}

test("send_email delivers to OWNER_EMAIL", async () => {
	const saved = {
		OWNER_EMAIL: process.env.OWNER_EMAIL,
		SMTP_USER: process.env.SMTP_USER,
		SMTP_PASS: process.env.SMTP_PASS,
	};
	process.env.OWNER_EMAIL = OWNER;
	process.env.SMTP_USER = FROM;
	process.env.SMTP_PASS = "test-app-password";
	const directory = await mkdtemp(join(tmpdir(), "cua-bot-email-"));
	const shot = join(directory, "shot.png");
	await writeFile(shot, "png");

	const transport = createTransport({ jsonTransport: true });
	const sent: SendMailOptions[] = [];
	const sendMail = transport.sendMail.bind(transport);
	transport.sendMail = ((options: SendMailOptions) => {
		sent.push({
			from: options.from,
			to: options.to,
			subject: options.subject,
			text: options.text,
			attachments: options.attachments?.map((item) => ({ ...item })),
		});
		return sendMail(options);
	}) as typeof transport.sendMail;

	const extension = createEmailExtension({ transport });
	assert.equal(extension.tools?.[0]?.replay, undefined);
	const guidance = await extension.sections?.[0]?.render(undefined as never, BACKGROUND_CONTEXT);
	assert.match(guidance ?? "", /send_email/);

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("send_email", { subject: SUBJECT, body: BODY, attachments: [shot] }, { id: "mail-1" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("Sent.")]),
	]);
	const registry = createRegistry();
	registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "faux", modelId: "faux-1" } },
		});
		const settled = await (
			await root.submit({ type: "input", content: "Email me the screenshot." }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");

		const page = await root.entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const resultEntry = page.items.find((entry) => ToolResultEntry.is(entry));
		assert.ok(resultEntry);
		const message = resultEntry.model?.[0];
		assert.equal(message?.role, "toolResult");
		if (message?.role !== "toolResult") return;
		assert.equal(message.isError, false);
		assert.match(textOf(message.content), new RegExp(`^sent to ${OWNER} \\(messageId .+\\)`));

		assert.equal(sent.length, 1);
		const mail = sent[0];
		assert.ok(mail);
		assert.equal(mail.to, OWNER);
		assert.equal(mail.from, FROM);
		assert.equal(mail.subject, SUBJECT);
		assert.equal(mail.text, BODY);
		assert.deepEqual(attachmentPaths(mail), [shot]);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("send_email rejects a missing attachment and names missing env", async () => {
	const saved = {
		OWNER_EMAIL: process.env.OWNER_EMAIL,
		SMTP_USER: process.env.SMTP_USER,
		SMTP_PASS: process.env.SMTP_PASS,
	};
	process.env.OWNER_EMAIL = OWNER;
	process.env.SMTP_USER = FROM;
	process.env.SMTP_PASS = "test-app-password";
	try {
		const extension = createEmailExtension({ transport: createTransport({ jsonTransport: true }) });
		const tool = extension.tools?.[0];
		assert.ok(tool);
		const missingFile = await tool.execute(
			{ subject: SUBJECT, body: BODY, attachments: ["C:\\no\\such\\cua-bot-shot.png"] },
			undefined as never,
			BACKGROUND_CONTEXT,
		);
		assert.equal(missingFile.isError, true);
		assert.match(textOf(missingFile.output), /does not exist/);

		delete process.env.OWNER_EMAIL;
		delete process.env.SMTP_PASS;
		const missingEnv = await tool.execute({ subject: SUBJECT, body: BODY }, undefined as never, BACKGROUND_CONTEXT);
		assert.equal(missingEnv.isError, true);
		const text = textOf(missingEnv.output);
		assert.match(text, /OWNER_EMAIL/);
		assert.match(text, /SMTP_PASS/);
		assert.doesNotMatch(text, /SMTP_USER/);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
