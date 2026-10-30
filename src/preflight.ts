// Demo pre-flight. Run from the project root while the bot is stopped:
//   node --env-file-if-exists=.env src/preflight.ts
// Prints one line per check. Exits 0 when every check passes, and 1 otherwise.
// Never prints tokens or passwords. OWNER_EMAIL is safe to print.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createTransport } from "nodemailer";
import { listDriverToolNames } from "./computer.ts";
import { CREDENTIAL_FILE, createBotModels } from "./xai-auth.ts";

const REQUIRED_ENV = ["OWNER_EMAIL", "SMTP_USER", "SMTP_PASS"] as const;
const XAI_TIMEOUT_MS = 60_000;
const SPACE_TIMEOUT_MS = 60_000;
const SMTP_TIMEOUT_MS = 20_000;
const SECRET_KEYS = new Set(["access", "refresh", "key", "id_token", "password", "secret", "token", "api_key", "access_token", "refresh_token"]);

type Status = "PASS" | "FAIL" | "INFO";

type Check = {
	status: Status;
	name: string;
	detail: string;
};

type CredentialState = "present" | "absent" | "invalid";

function report(status: Status, name: string, detail: string): Check {
	return { status, name, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clip(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// Values that must never appear in check output: env secrets, plus token fields from the credential file.
function secretValues(): string[] {
	const found: string[] = [];
	for (const name of ["SMTP_PASS", "XAI_API_KEY"]) {
		const value = process.env[name]?.trim();
		if (value !== undefined && value.length >= 8) found.push(value);
	}
	if (!existsSync(CREDENTIAL_FILE)) return found;
	try {
		collectSecrets(JSON.parse(readFileSync(CREDENTIAL_FILE, "utf8")), found);
	} catch {
		// The xai check reports a broken file. There is nothing safe to redact from it.
	}
	return found;
}

function collectSecrets(value: unknown, found: string[], key?: string): void {
	if (typeof value === "string") {
		if (key !== undefined && SECRET_KEYS.has(key) && value.length >= 8) found.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectSecrets(item, found);
		return;
	}
	if (!isRecord(value)) return;
	for (const [childKey, child] of Object.entries(value)) collectSecrets(child, found, childKey);
}

const secrets = secretValues();

function scrub(text: string): string {
	let out = text;
	for (const secret of secrets) out = out.split(secret).join("[redacted]");
	return out;
}

function messageOf(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const cleaned = clip(scrub(text));
	return cleaned.length > 0 ? cleaned : "request failed";
}

// Rejects when `work` does not settle in time. A late settlement from `work` is ignored.
function deadline<T>(ms: number, work: Promise<T>, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
		}, ms);
		work.then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

function credentialState(): CredentialState {
	if (!existsSync(CREDENTIAL_FILE)) return "absent";
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CREDENTIAL_FILE, "utf8"));
	} catch {
		return "invalid";
	}
	if (!isRecord(parsed)) return "invalid";
	if (!Object.hasOwn(parsed, "xai") || parsed.xai === null || parsed.xai === undefined) return "absent";
	return "present";
}

function checkEnv(): Check {
	const missing = REQUIRED_ENV.filter((name) => (process.env[name]?.trim() ?? "").length === 0);
	if (missing.length > 0) return report("FAIL", "env", `missing ${missing.join(", ")}. Set them in .env`);
	return report("PASS", "env", `OWNER_EMAIL ${process.env.OWNER_EMAIL?.trim()}; SMTP_USER and SMTP_PASS set`);
}

// Confirms xAI auth with one short completion on an in-memory Harness. Does not open data/grokbot.sqlite.
async function checkXai(): Promise<Check> {
	const stored = credentialState();
	const apiKey = (process.env.XAI_API_KEY?.trim() ?? "").length > 0;
	if (stored === "invalid") {
		return report("FAIL", "xai", "data/xai-credential.json is not valid JSON. Fix: run `node src/login.ts`");
	}
	if (stored !== "present" && !apiKey) {
		return report("FAIL", "xai", "no xai entry in data/xai-credential.json and XAI_API_KEY is unset. Fix: run `node src/login.ts`");
	}
	const modelId = process.env.GROKBOT_MODEL || "grok-4.7";
	const via = stored === "present" ? "stored credential" : "XAI_API_KEY";
	try {
		const reply = await deadline(XAI_TIMEOUT_MS, askModel(modelId), "xai");
		const shown = reply.length > 0 ? reply : "(empty)";
		return report("PASS", "xai", `${modelId} via ${via} replied ${JSON.stringify(shown)}`);
	} catch (error) {
		return report("FAIL", "xai", `${modelId}: ${messageOf(error)}. Fix: run \`node src/login.ts\``);
	}
}

async function askModel(modelId: string): Promise<string> {
	const models = createBotModels();
	const registry = createRegistry();
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "xai", modelId }, thinkingLevel: "off" },
		});
		harness.resume();
		const settled = await (
			await root.submit({ type: "input", content: "Reply with exactly: ok" }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		if (settled.type !== "input" || settled.status !== "done") {
			if (settled.status === "unanswered") throw new Error(unanswered(settled.reason, settled.detail));
			throw new Error(`settled ${settled.type} ${settled.status}`);
		}
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
		const message = entry?.model?.[0];
		const text = message?.role === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ") : "";
		return clip(scrub(text), 80);
	} finally {
		await harness.close(BACKGROUND_CONTEXT).catch(() => {});
	}
}

function unanswered(reason: string, detail: unknown): string {
	if (detail === undefined) return `unanswered (${reason})`;
	const extra = typeof detail === "string" ? detail : JSON.stringify(detail);
	return `unanswered (${reason}) ${clip(scrub(extra))}`;
}

// Logs in to Gmail SMTP and disconnects. Does not send mail.
async function checkSmtp(): Promise<Check> {
	const user = process.env.SMTP_USER?.trim() ?? "";
	const pass = process.env.SMTP_PASS?.trim() ?? "";
	if (user.length === 0 || pass.length === 0) {
		return report("FAIL", "smtp", "SMTP_USER or SMTP_PASS is empty. Fix: use a Gmail app password");
	}
	const transporter = createTransport({
		host: "smtp.gmail.com",
		port: 465,
		secure: true,
		auth: { user, pass },
		connectionTimeout: SMTP_TIMEOUT_MS,
		greetingTimeout: SMTP_TIMEOUT_MS,
		socketTimeout: SMTP_TIMEOUT_MS,
	});
	try {
		await deadline(SMTP_TIMEOUT_MS + 5_000, transporter.verify(), "smtp");
		return report("PASS", "smtp", `smtp.gmail.com:465 login ok for ${user}`);
	} catch (error) {
		return report("FAIL", "smtp", `${messageOf(error)}. Fix: use a Gmail app password`);
	} finally {
		transporter.close();
	}
}

// Lists the paired Mac's driver tools the same way the computer extension does. Read-only: no clicks or typing.
async function checkSpace(): Promise<Check> {
	try {
		const names = await deadline(SPACE_TIMEOUT_MS, listDriverToolNames(), "space");
		const missing = ["get_desktop_state", "click"].filter((name) => !names.includes(name));
		if (missing.length > 0) {
			return report("FAIL", "space", `${names.length} tools; missing ${missing.join(", ")}. Fix: open the Cua Spaces app and check the Mac mini is online`);
		}
		return report("PASS", "space", `${names.length} tools; get_desktop_state and click present`);
	} catch (error) {
		return report("FAIL", "space", `${messageOf(error)}. Fix: open the Cua Spaces app and check the Mac mini is online`);
	}
}

function checkPort(): Promise<Check> {
	const raw = process.env.GROKBOT_PORT;
	const port = raw === undefined || raw.trim() === "" ? 43142 : Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return Promise.resolve(report("FAIL", "port", `GROKBOT_PORT ${JSON.stringify(raw ?? "")} is not a usable port`));
	}
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", (error: Error & { code?: string }) => {
			const why = error.code === "EADDRINUSE" ? `127.0.0.1:${port} is in use` : messageOf(error);
			resolve(report("FAIL", "port", `${why}. Fix: python stop.py`));
		});
		server.listen(port, "127.0.0.1", () => {
			server.close((error) => {
				if (error) resolve(report("FAIL", "port", `${error.message}. Fix: python stop.py`));
				else resolve(report("PASS", "port", `127.0.0.1:${port} is free`));
			});
		});
	});
}

function checkData(): Check {
	const exists = existsSync(join(import.meta.dirname, "..", "data", "grokbot.sqlite"));
	if (exists) return report("INFO", "data", "data/grokbot.sqlite exists; existing conversation will be reused");
	return report("INFO", "data", "data/grokbot.sqlite does not exist");
}

const checks = await Promise.all([checkEnv(), checkXai(), checkSmtp(), checkSpace(), checkPort(), checkData()]);
for (const item of checks) console.log(`${item.status} ${item.name} — ${item.detail}`);
process.exit(checks.some((item) => item.status === "FAIL") ? 1 : 0);
