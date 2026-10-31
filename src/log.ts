// The bot's single log: log(...) appends one line to data/logs/cua-bot.log and echoes it to stdout.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = join(import.meta.dirname, "..", "data");
export const LOG_DIR = join(DATA_DIR, "logs");
mkdirSync(LOG_DIR, { recursive: true });

export function log(...parts: unknown[]): void {
	const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
	appendFileSync(join(LOG_DIR, "cua-bot.log"), `${line}\n`);
	console.log(line);
}
