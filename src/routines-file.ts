// routines.json: the human-editable config file that holds routine definitions (id, title, prompt,
// cron). The bot syncs it into Durable state on start, on its own writes, and when it changes on
// disk. Run history (lastFiredAt) is not stored here; it stays in the Durable doc.
// Reading validates the whole file and throws on the first problem, so a bad edit changes nothing.
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { nextFire, toCronSpec } from "./cron.ts";

export const MAX_ROUTINES = 50;
export const DEFAULT_ROUTINE_FILE = join(import.meta.dirname, "..", "routines.json");

export type RoutineDefinition = {
	id: string;
	title: string;
	prompt: string;
	cron: string;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${what} is not an object`);
	}
	return value as Record<string, unknown>;
}

/**
 * Read and validate the routine definitions at `path`. Returns `undefined` when the file does not
 * exist. Entries without an id get one assigned (`assignedIds` tells the caller to write them back).
 * Cron specs come back normalized. Throws on malformed JSON, bad fields, duplicate ids, an invalid
 * or never-firing cron, or more than MAX_ROUTINES entries.
 */
export async function readRoutineFile(
	path: string,
): Promise<{ defs: RoutineDefinition[]; assignedIds: boolean } | undefined> {
	const name = basename(path);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.replace(/^\uFEFF/, "")); // Windows editors may prepend a BOM
	} catch (error) {
		throw new Error(`${name} is not valid JSON: ${messageOf(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`${name}: expected a JSON array of routines`);
	if (parsed.length > MAX_ROUTINES) {
		throw new Error(`${name} lists ${parsed.length} routines; the limit of ${MAX_ROUTINES} applies`);
	}

	let assignedIds = false;
	const seen = new Set<string>();
	const defs = parsed.map((entry, index): RoutineDefinition => {
		const what = `${name} entry ${index + 1}`;
		const record = asRecord(entry, what);
		const title = record.title;
		const prompt = record.prompt;
		const cron = record.cron;
		if (typeof title !== "string" || title.trim().length === 0) throw new Error(`${what}: title is required`);
		if (typeof prompt !== "string" || prompt.trim().length === 0) throw new Error(`${what}: prompt is required`);
		if (typeof cron !== "string" || cron.trim().length === 0) throw new Error(`${what}: cron is required`);
		let spec: string;
		try {
			spec = toCronSpec(cron);
			nextFire(spec, new Date());
		} catch (error) {
			throw new Error(`${what} (${title}): ${messageOf(error)}`);
		}
		let id = record.id;
		if (id === undefined || id === null || id === "") {
			id = crypto.randomUUID();
			assignedIds = true;
		}
		if (typeof id !== "string" || id.trim().length === 0) throw new Error(`${what}: id must be a non-empty string`);
		if (seen.has(id)) throw new Error(`${name}: duplicate routine id ${JSON.stringify(id)}`);
		seen.add(id);
		return { id, title, prompt, cron: spec };
	});
	return { defs, assignedIds };
}

/** Atomically replace the routine file (write beside it, then rename over it). */
export async function writeRoutineFile(path: string, defs: readonly RoutineDefinition[]): Promise<void> {
	const temporary = `${path}.tmp`;
	await writeFile(temporary, `${JSON.stringify(defs, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}
