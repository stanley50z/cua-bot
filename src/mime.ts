// Executor's Gmail send takes the whole message as base64 RFC 2822 text (an upload body). The approval card decodes
// it with readRaw() so the owner sees exactly what would be sent, and writeRaw() re-encodes the owner's
// edits while keeping every other header (threading, Cc, and so on) as the bot wrote it.

export type EmailView = {
	from?: string;
	to: string;
	cc?: string;
	subject: string;
	body: string;
	/** False for multipart mail (HTML, attachments): shown, but only sendable as written. */
	editable: boolean;
};

type Header = { name: string; value: string };

// Node decodes both the standard and the URL-safe base64 alphabets here.
const decode64 = (text: string) => Buffer.from(text, "base64");

// RFC 2047 encoded words, as in `=?UTF-8?B?…?=` subjects.
function decodeWords(value: string): string {
	return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_all, _charset: string, kind: string, text: string) =>
		kind.toUpperCase() === "B"
			? Buffer.from(text, "base64").toString("utf8")
			: Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8"),
	);
}

function splitMessage(text: string): { headers: Header[]; body: string } {
	const normalized = text.replace(/\r\n/g, "\n");
	const end = normalized.indexOf("\n\n");
	const head = end === -1 ? normalized : normalized.slice(0, end);
	const body = end === -1 ? "" : normalized.slice(end + 2);
	const headers: Header[] = [];
	for (const line of head.split("\n")) {
		const last = headers.at(-1);
		if (/^[ \t]/.test(line) && last !== undefined) last.value += ` ${line.trim()}`;
		else {
			const colon = line.indexOf(":");
			if (colon > 0) headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
		}
	}
	return { headers, body };
}

const header = (headers: Header[], name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

function decodeBody(body: string, encoding: string | undefined): string {
	switch (encoding?.toLowerCase()) {
		case "base64":
			return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
		case "quoted-printable": {
			const bytes = body.replace(/=\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
			return Buffer.from(bytes, "latin1").toString("utf8");
		}
		default:
			return body;
	}
}

// The first text/plain part of a multipart message, for display.
function plainPart(body: string, contentType: string): string | undefined {
	const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
	if (boundary === undefined) return undefined;
	// The text before the first boundary is a preamble, not a part.
	for (const part of body.split(`--${boundary}`).slice(1)) {
		if (part.startsWith("--")) break;
		const { headers, body: partBody } = splitMessage(part.replace(/^\n/, ""));
		const type = header(headers, "Content-Type") ?? "text/plain";
		if (type.toLowerCase().startsWith("text/plain")) return decodeBody(partBody, header(headers, "Content-Transfer-Encoding")).trimEnd();
		if (type.toLowerCase().startsWith("multipart/")) {
			const nested = plainPart(partBody, type);
			if (nested !== undefined) return nested;
		}
	}
	return undefined;
}

/** Decode a base64 message for the approval card. */
export function readRaw(raw: string): EmailView {
	const { headers, body } = splitMessage(decode64(raw).toString("utf8"));
	const contentType = header(headers, "Content-Type") ?? "text/plain";
	const multipart = contentType.toLowerCase().startsWith("multipart/");
	const from = header(headers, "From");
	const cc = header(headers, "Cc");
	return {
		...(from === undefined ? {} : { from: decodeWords(from) }),
		to: decodeWords(header(headers, "To") ?? ""),
		...(cc === undefined ? {} : { cc: decodeWords(cc) }),
		subject: decodeWords(header(headers, "Subject") ?? ""),
		body: (multipart ? (plainPart(body, contentType) ?? "(This email has no plain-text part.)") : decodeBody(body, header(headers, "Content-Transfer-Encoding")))
			.replace(/\r\n/g, "\n")
			.trimEnd(),
		editable: !multipart,
	};
}

const encodeWord = (value: string) => (/^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);
const REPLACED = new Set(["to", "subject", "mime-version", "content-type", "content-transfer-encoding"]);

/** Re-encode a single-part message with the owner's To, Subject, and body, keeping its other headers. */
export function writeRaw(raw: string, edit: { to: string; subject: string; body: string }): string {
	const { headers } = splitMessage(decode64(raw).toString("utf8"));
	const kept = headers.filter((h) => !REPLACED.has(h.name.toLowerCase())).map((h) => `${h.name}: ${h.value}`);
	const body = Buffer.from(edit.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
	const message = [
		...kept,
		`To: ${edit.to.replace(/[\r\n]+/g, " ")}`,
		`Subject: ${encodeWord(edit.subject.replace(/[\r\n]+/g, " "))}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
		"",
		body,
	].join("\r\n");
	return Buffer.from(message, "utf8").toString("base64");
}
