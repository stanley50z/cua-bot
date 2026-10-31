import { access } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { createTransport, type Transporter } from "nodemailer";

const REQUIRED_ENV = ["OWNER_EMAIL", "SMTP_USER", "SMTP_PASS"] as const;

function missingEnv(): string[] {
	return REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
}

function errorResult(text: string) {
	return { output: [{ type: "text" as const, text }], isError: true as const };
}

async function rejectedAttachments(paths: readonly string[]): Promise<string[]> {
	const problems: string[] = [];
	for (const file of paths) {
		if (!isAbsolute(file)) {
			problems.push(`${file} is not an absolute path`);
			continue;
		}
		try {
			await access(file);
		} catch {
			problems.push(`${file} does not exist`);
		}
	}
	return problems;
}

// Installed by the cua-bot service (`registry.install(createEmailExtension())`).
// Gives the agent send_email, which always writes to OWNER_EMAIL.
export function createEmailExtension(options?: { transport?: Transporter }): Extension {
	let gmail: Transporter | undefined;
	// Gmail SMTP with an app password. Built on the first send so importing this module opens nothing.
	const transport = (user: string, pass: string): Transporter => {
		if (options?.transport) return options.transport;
		gmail ??= createTransport({
			host: "smtp.gmail.com",
			port: 465,
			secure: true,
			auth: { user, pass },
		});
		return gmail;
	};

	const sendEmail = defineTool({
		name: "send_email",
		description:
			"Email the owner. The recipient is fixed to the owner; you cannot choose it. Attach screenshots by the absolute path they were saved to.",
		parameters: Type.Object({
			subject: Type.String({ description: "Subject line" }),
			body: Type.String({ description: "Plain-text body" }),
			attachments: Type.Optional(
				Type.Array(
					Type.String({
						description: "Absolute path of a file to attach, such as a screenshot under data/shots",
					}),
				),
			),
		}),
		execute: async (args) => {
			const missing = missingEnv();
			if (missing.length > 0) return errorResult(`Missing ${missing.join(", ")}`);
			const owner = process.env.OWNER_EMAIL?.trim() ?? "";
			const from = process.env.SMTP_USER?.trim() ?? "";
			const pass = process.env.SMTP_PASS?.trim() ?? "";
			const problems = await rejectedAttachments(args.attachments ?? []);
			if (problems.length > 0) return errorResult(`Attachment rejected: ${problems.join("; ")}`);
			try {
				const info: { messageId?: unknown } = await transport(from, pass).sendMail({
					from,
					to: owner,
					subject: args.subject,
					text: args.body,
					attachments: args.attachments?.map((file) => ({ filename: basename(file), path: file })),
				});
				const messageId = typeof info.messageId === "string" ? info.messageId : "unknown";
				return { output: [{ type: "text" as const, text: `sent to ${owner} (messageId ${messageId})` }] };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`send failed: ${message}`);
			}
		},
	});

	return defineExtension({
		name: "email",
		tools: [sendEmail],
		sections: [
			section(
				"email",
				() =>
					"Use send_email to reach the owner proactively. Attach screenshots by their saved absolute path, such as files under data/shots.",
			),
		],
	});
}
