// Recurring work, per bot. Each routine is a durable task of its bot's conversation that sleeps until
// its cron slot, posts a `[routine]` turn there, and sleeps again. A deadline that passed while the bot
// was down fires once on resume and rearms from the wake time; missed slots are never replayed. A routine
// marked `once` does not rearm: the firing removes it, whether or not the turn it posted has finished.
// Each bot's definitions live in its folder as bots/<bot-name>/routines.json (see routines-file.ts and
// botFolder in bots.ts); a bot without routines has no file. The manager below syncs those files into each bot's
// Durable doc and sleeper tasks; the chat tools and the web portal both go through it, so hand edits, GUI
// edits, and model edits converge. The host calls bindRoutines({harness, root}) after Harness.open,
// then syncRoutines() once at startup.
import { existsSync, mkdirSync, watch } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import {
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Conversation,
	type ConversationId,
	type Extension,
	type Harness,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";
import { cronLabel, nextFire, toCronSpec, type LegacySchedule } from "./cron.ts";
import { botFolder, DEFAULT_BOTS_DIR, MAIN_NAME, readBots } from "./bots.ts";
import {
	MAX_ROUTINES,
	readRoutineFile,
	writeRoutineFile,
	type RoutineDefinition,
} from "./routines-file.ts";

type RoutineItem = {
	title: string;
	prompt: string;
	cron: string;
	taskId: TaskId;
	/** Harness-clock milliseconds of the most recent firing (scheduled or run_routine). */
	lastFiredAt?: number;
	once?: boolean;
};

type RoutinesState = {
	items: { [id: string]: RoutineItem };
	/** Once-routines that fired but may still be in routines.json; the next sync drops them from the file. */
	spent?: string[];
};

const RoutinesDoc = defineDoc<RoutinesState>({
	kind: "cua-bot.routines",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A fork is a different chat. It does not inherit routines whose tasks still belong to the parent.
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: () => false,
});

type RoutineInput = {
	title: string;
	prompt: string;
	cron: string;
	once?: boolean;
};

// `due` is epoch milliseconds on the Harness clock. A Date would not survive the checkpoint.
type RoutineState = { phase: "wait" } | { phase: "fire"; due: number };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ago(fromMs: number, toMs: number): string {
	const seconds = Math.max(0, Math.round((toMs - fromMs) / 1_000));
	if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.round(seconds / 3_600);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.round(seconds / 86_400);
	return `${days} day${days === 1 ? "" : "s"} ago`;
}

// The `once` field to spread into a definition, item, or view. It is absent, not false, on ordinary routines.
function onceField(once: boolean | undefined): { once?: boolean } {
	return once === true ? { once } : {};
}

// A schedule in words. A once-routine's cron only names its slot, so a yearly cron does not read as "yearly".
function routineLabel(cron: string, once: boolean | undefined): string {
	return once === true ? `once, ${cronLabel(cron).replace(/^yearly /, "")}` : cronLabel(cron);
}

// The turn a firing posts. Nobody is waiting on it, so it says so and lets the model stay silent.
function routineTurnText(
	routine: { title: string; prompt: string; cron: string; once?: boolean; lastFiredAt?: number },
	nowMs: number,
): string {
	const last = routine.lastFiredAt === undefined ? "" : `; last ran ${ago(routine.lastFiredAt, nowMs)}`;
	return [
		`[routine] "${routine.title}" is due (${routineLabel(routine.cron, routine.once)}${last}). Nobody is waiting.`,
		`Your standing instruction: ${routine.prompt}`,
		"Carry it out; send_message the owner only if the outcome needs them.",
	].join("\n");
}

const RoutineTask = defineTask<RoutineInput, RoutineState, null>({
	name: "cua-bot.routine",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		// Sleep until the next slot. The phase ends once the sleep is stored.
		wait: async (task, runtime, ctx) => {
			let due: Date;
			try {
				due = nextFire(task.input.cron, new Date(runtime.now()));
			} catch (error) {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "failed", error: { message: messageOf(error) } },
					}),
					ctx,
				);
				return;
			}
			const at = due.getTime();
			await runtime.sleepUntil(at, { phase: "fire", due: at }, ctx);
		},
		// Post the firing, stamp lastFiredAt, and go back to wait. Do not wait for the answer:
		// that queues behind this conversation. A once-routine instead ends here: this commit removes it
		// and notes it as spent, so a crash before the sync below cannot bring it back from routines.json.
		fire: async (task, runtime, ctx) => {
			const due = task.state.checkpoint.due;
			const now = runtime.now();
			const items = (await runtime.snapshot(RoutinesDoc, runtime.conversationId, ctx))?.items ?? {};
			const mine = Object.values(items).find((item) => Number(item.taskId) === Number(task.id));
			const conversation = await runtime.conversation(runtime.conversationId, ctx);
			if (conversation !== undefined) {
				await conversation.submit(
					{
						type: "input",
						content: routineTurnText(
							{ ...task.input, lastFiredAt: mine?.lastFiredAt },
							now,
						),
						requestId: `${task.id}:${due}`,
						whenBusy: "followUp",
					},
					ctx,
				);
			}
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(RoutinesDoc, runtime.conversationId);
				const found = Object.entries(doc.items).find(([, item]) => Number(item.taskId) === Number(task.id));
				if (task.input.once === true) {
					if (found !== undefined) {
						delete doc.items[found[0]];
						doc.spent = [...(doc.spent ?? []), found[0]];
					}
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}
				if (found !== undefined) found[1].lastFiredAt = now;
				return { status: "running", checkpoint: { phase: "wait" } };
			}, ctx);
			// Not awaited: a sync can hold the queue while it waits on this very task to end.
			if (task.input.once === true) syncRoutines(BACKGROUND_CONTEXT).catch((error) => bound?.onError(error));
		},
	},
	abort: (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const LegacyScheduleSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("everyMinutes"),
		minutes: Type.Integer({ minimum: 1 }),
	}),
	Type.Object({
		kind: Type.Literal("dailyAt"),
		hour: Type.Integer({ minimum: 0, maximum: 23 }),
		minute: Type.Integer({ minimum: 0, maximum: 59 }),
	}),
	Type.Object({
		kind: Type.Literal("weeklyOn"),
		weekday: Type.Integer({ minimum: 1, maximum: 7 }),
		hour: Type.Integer({ minimum: 0, maximum: 23 }),
		minute: Type.Integer({ minimum: 0, maximum: 59 }),
	}),
]);

function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}

function errorText(value: string) {
	return { output: [{ type: "text" as const, text: value }], isError: true as const };
}

// Mutating tools go through the file-backed manager, on the calling bot's own routines.
function unboundError(): string | undefined {
	return bound === undefined ? "bindRoutines(...) was not called after Harness.open." : undefined;
}

const schedule = defineTool({
	name: "schedule",
	description:
		"Schedule a prompt to run on a clock, then again after each fire. Give cron: a 5-field cron string " +
		"(minute hour day-of-month month day-of-week, day-of-week 0 = Sunday), a nickname (@hourly, @daily, " +
		"@weekly, @monthly), or @every 30s|5m|2h, optionally prefixed with CRON_TZ=Area/City. Prefer weekday " +
		"daytime schedules like '30 7 * * 1-5'; never use bare @hourly. For a one-off, set once: true with a cron " +
		"naming the slot, like '0 12 9 11 *' for Nov 9 at 12:00. The legacy schedule object " +
		"(everyMinutes/dailyAt/weeklyOn, weekday 1 = Sunday) is still accepted and converted. Returns the routine id.",
	parameters: Type.Object({
		title: Type.String(),
		prompt: Type.String(),
		cron: Type.Optional(Type.String({ description: "Cron spec, e.g. '30 7 * * 1-5', '@daily', '@every 30m'" })),
		schedule: Type.Optional(LegacyScheduleSchema),
		once: Type.Optional(Type.Boolean({ description: "Fire at the next slot only, then remove the routine automatically." })),
	}),
	execute: async (args, api, ctx) => {
		if ((args.cron === undefined) === (args.schedule === undefined)) {
			return errorText("Give exactly one of cron or schedule.");
		}
		const guard = unboundError();
		if (guard !== undefined) return errorText(guard);
		let spec: string;
		try {
			spec = toCronSpec(args.cron !== undefined ? args.cron : (args.schedule as LegacySchedule));
			nextFire(spec, new Date(api.now()));
		} catch (error) {
			return errorText(messageOf(error));
		}
		try {
			const view = await addRoutine({ title: args.title, prompt: args.prompt, cron: spec, ...onceField(args.once), bot: Number(api.conversationId) }, ctx);
			const item = (await api.snapshot(RoutinesDoc, api.conversationId, ctx))?.items[view.id];
			const removal = view.once === true ? " It removes itself after that." : "";
			return text(`Scheduled ${view.id} task ${item?.taskId} "${view.title}" (${spec}). Next fire: ${view.nextFire}.${removal}`);
		} catch (error) {
			if (error instanceof RoutineLimitError || error instanceof RoutineValidationError) return errorText(error.message);
			throw error;
		}
	},
});

const listRoutines = defineTool({
	name: "list_routines",
	description: "List saved routines, their cron schedules, and the next and last times each fires.",
	parameters: Type.Object({}),
	execute: async (_args, api, ctx) => {
		const items = (await api.snapshot(RoutinesDoc, api.conversationId, ctx))?.items ?? {};
		const now = new Date(api.now());
		const lines = Object.entries(items).map(([id, item]) => {
			const last = item.lastFiredAt === undefined ? "" : `  last ${new Date(item.lastFiredAt).toISOString()}`;
			return `${id}  ${item.title}  ${item.cron}${item.once === true ? "  once" : ""}  next ${nextFire(item.cron, now).toISOString()}${last}`;
		});
		return text(lines.length === 0 ? "No routines." : lines.join("\n"));
	},
});

const runRoutine = defineTool({
	name: "run_routine",
	description: "Run a saved routine now, whatever its clock says. id is the id returned by schedule.",
	parameters: Type.Object({ id: Type.String() }),
	execute: async (args, api, ctx) => {
		const guard = unboundError();
		if (guard !== undefined) return errorText(guard);
		try {
			const view = await runRoutineNow(args.id, ctx, Number(api.conversationId));
			return text(`Running "${view.title}" now.`);
		} catch (error) {
			if (error instanceof RoutineNotFoundError) return text(`No routine ${args.id}.`);
			throw error;
		}
	},
});

// --- Host-side manager ----------------------------------------------------
// Each bot's routines.json in its folder is the source of truth for its definitions; the bot's Durable doc
// mirrors it and adds task ids + lastFiredAt. A bot without routines has no file. Every mutation
// funnels through one queue: edit the file, then sync. Sync aborts and recreates sleeper tasks until
// each bot's Durable state matches its file.

export class RoutineNotFoundError extends Error {}
export class RoutineLimitError extends Error {}
export class RoutineValidationError extends Error {}

export type RoutineView = {
	id: string;
	/** The bot it runs in. */
	bot: number;
	botName: string;
	title: string;
	prompt: string;
	cron: string;
	label: string;
	nextFire: string;
	lastFiredAt?: string;
	once?: boolean;
};

export type SyncSummary = {
	created: number;
	updated: number;
	deleted: number;
	total: number;
	adopted: boolean;
};

type BoundRoutines = {
	harness: Harness;
	root: Conversation;
	dir: string;
	/** The single routines.json from before each bot had its own file, moved to the main bot's file once. */
	legacyFile?: string;
	now: () => number;
	/** Told when the sync that follows a once-routine's firing fails. */
	onError: (error: unknown) => void;
	queue: Promise<unknown>;
	/** Each bot's file as of its last sync, so a renamed bot's file moves with it. */
	paths: Map<number, string>;
};

type RoutineBot = { id: number; name: string; main: boolean };

let bound: BoundRoutines | undefined;

// Call once with the open Harness and its root conversation (the main bot), before the bot accepts work.
export function bindRoutines(options: {
	harness: Harness;
	root: Conversation;
	dir?: string;
	legacyFile?: string;
	now?: () => number;
	onError?: (error: unknown) => void;
}): void {
	bound = {
		harness: options.harness,
		root: options.root,
		dir: options.dir ?? DEFAULT_BOTS_DIR,
		...(options.legacyFile === undefined ? {} : { legacyFile: options.legacyFile }),
		now: options.now ?? Date.now,
		onError: options.onError ?? console.error,
		queue: Promise.resolve(),
		paths: new Map(),
	};
}

// Every bot. Without a bot list (tests that only run routines) the root is the one bot.
async function routineBots(b: BoundRoutines, ctx: Context): Promise<RoutineBot[]> {
	const bots = await readBots(b.harness, ctx);
	return bots.some((bot) => bot.main) ? bots : [{ id: Number(b.root.id), name: MAIN_NAME, main: true }, ...bots];
}

async function botById(b: BoundRoutines, id: number | undefined, ctx: Context): Promise<RoutineBot> {
	const bots = await routineBots(b, ctx);
	const bot = id === undefined ? bots.find((candidate) => candidate.main) : bots.find((candidate) => candidate.id === id);
	if (bot === undefined) throw new RoutineValidationError("No such bot.");
	return bot;
}

const ROUTINE_FILE = "routines.json";
const fileOf = (b: BoundRoutines, bot: RoutineBot) => join(b.dir, botFolder(bot), ROUTINE_FILE);

async function conversationOf(b: BoundRoutines, bot: RoutineBot, ctx: Context): Promise<Conversation> {
	const conversation = bot.main ? b.root : await b.harness.conversation(bot.id as ConversationId, ctx);
	if (conversation === undefined) throw new Error(`${bot.name}'s conversation is missing`);
	return conversation;
}

// A bot with no routines has no file.
async function saveDefs(path: string, defs: readonly RoutineDefinition[]): Promise<void> {
	if (defs.length === 0) return rm(path, { force: true });
	await mkdir(dirname(path), { recursive: true });
	await writeRoutineFile(path, defs);
}

// The bot holding routine `id`; `only` limits the search to one bot, as the chat tools do.
async function locate(b: BoundRoutines, id: string, ctx: Context, only?: number): Promise<{ bot: RoutineBot; item: RoutineItem }> {
	for (const bot of await routineBots(b, ctx)) {
		if (only !== undefined && bot.id !== only) continue;
		const item = (await snapshotItems(b, bot, ctx))[id];
		if (item !== undefined) return { bot, item };
	}
	throw new RoutineNotFoundError(`No routine ${id}.`);
}

function requireBound(): BoundRoutines {
	if (bound === undefined) throw new Error("bindRoutines(...) was not called after Harness.open.");
	return bound;
}

function enqueue<T>(b: BoundRoutines, fn: () => Promise<T>): Promise<T> {
	const run = b.queue.then(fn);
	b.queue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function snapshotItems(b: BoundRoutines, bot: RoutineBot, ctx: Context): Promise<{ [id: string]: RoutineItem }> {
	return (await b.harness.snapshot(RoutinesDoc, bot.id as ConversationId, ctx))?.items ?? {};
}

function toView(bot: RoutineBot, id: string, item: RoutineItem, nowMs: number): RoutineView {
	return {
		id,
		bot: bot.id,
		botName: bot.name,
		title: item.title,
		prompt: item.prompt,
		cron: item.cron,
		label: routineLabel(item.cron, item.once),
		nextFire: nextFire(item.cron, new Date(nowMs)).toISOString(),
		...(item.lastFiredAt !== undefined ? { lastFiredAt: new Date(item.lastFiredAt).toISOString() } : {}),
		...onceField(item.once),
	};
}

async function viewFor(b: BoundRoutines, bot: RoutineBot, id: string, ctx: Context): Promise<RoutineView> {
	const item = (await snapshotItems(b, bot, ctx))[id];
	if (item === undefined) throw new RoutineNotFoundError(`No routine ${id}.`);
	return toView(bot, id, item, b.now());
}

/** Every bot's routines as the web portal shows them, soonest firing first. */
export async function listRoutineViews(ctx: Context): Promise<RoutineView[]> {
	const b = requireBound();
	const now = b.now();
	const views: RoutineView[] = [];
	for (const bot of await routineBots(b, ctx)) {
		for (const [id, item] of Object.entries(await snapshotItems(b, bot, ctx))) views.push(toView(bot, id, item, now));
	}
	return views.sort((x, y) => x.nextFire.localeCompare(y.nextFire));
}

// Sync one bot, assuming the queue is held. `saved` is what an edit just wrote; without it the file is
// read, and a missing file is adopted from what runs. A failure part-way (tasks aborted, commit not
// landed) heals on the next sync, which re-diffs the doc against the file.
async function syncInternal(b: BoundRoutines, bot: RoutineBot, ctx: Context, saved?: RoutineDefinition[]): Promise<SyncSummary> {
	const path = fileOf(b, bot);
	const previous = b.paths.get(bot.id);
	b.paths.set(bot.id, path);
	if (previous !== undefined && previous !== path && existsSync(previous) && !existsSync(path)) await rename(previous, path);
	const loaded = saved === undefined ? await readRoutineFile(path) : { defs: saved, assignedIds: false };
	const state = await b.harness.snapshot(RoutinesDoc, bot.id as ConversationId, ctx);
	const items = state?.items ?? {};
	if (loaded === undefined) {
		// No file: the bot has no routines, or its file was deleted. Adopt whatever already runs instead of deleting it.
		const defs = Object.entries(items).map(([id, item]) => ({
			id,
			title: item.title,
			prompt: item.prompt,
			cron: item.cron,
			...onceField(item.once),
		}));
		await saveDefs(path, defs);
		return { created: 0, updated: 0, deleted: 0, total: defs.length, adopted: defs.length > 0 };
	}
	const spent = state?.spent ?? [];
	const defs = loaded.defs.filter((def) => !spent.includes(def.id));
	if (loaded.assignedIds || defs.length < loaded.defs.length) await saveDefs(path, defs);

	const creates: RoutineDefinition[] = [];
	const updates: RoutineDefinition[] = [];
	for (const def of defs) {
		const existing = items[def.id];
		if (existing === undefined) creates.push(def);
		else if (
			existing.title !== def.title ||
			existing.prompt !== def.prompt ||
			existing.cron !== def.cron ||
			(existing.once === true) !== (def.once === true)
		) {
			updates.push(def);
		}
	}
	const wanted = new Set(defs.map((def) => def.id));
	const deletes = Object.keys(items).filter((id) => !wanted.has(id));

	for (const id of [...deletes, ...updates.map((def) => def.id)]) {
		const item = items[id];
		if (item === undefined) continue;
		await b.harness.abortTask(item.taskId, ctx);
		await b.harness.waitForTask(item.taskId, ctx);
	}
	if (creates.length > 0 || updates.length > 0 || deletes.length > 0 || spent.length > 0) {
		const conversation = await conversationOf(b, bot, ctx);
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(RoutinesDoc, conversation.id);
			delete doc.spent;
			for (const id of deletes) delete doc.items[id];
			for (const def of [...creates, ...updates]) {
				const previous = doc.items[def.id];
				const taskId = await tx.createTask(
					RoutineTask,
					{ title: def.title, prompt: def.prompt, cron: def.cron, ...onceField(def.once) },
					{ ownership: { kind: "conversation" }, background: true },
				);
				doc.items[def.id] = {
					title: def.title,
					prompt: def.prompt,
					cron: def.cron,
					...onceField(def.once),
					taskId,
					...(previous?.lastFiredAt !== undefined ? { lastFiredAt: previous.lastFiredAt } : {}),
				};
			}
		}, ctx);
	}
	return { created: creates.length, updated: updates.length, deleted: deletes.length, total: defs.length, adopted: false };
}

/**
 * Make every bot's Durable state match its file. An invalid file changes nothing for its bot; the other
 * bots still sync, then this throws naming each bad file.
 */
export async function syncRoutines(ctx: Context): Promise<SyncSummary> {
	const b = requireBound();
	return enqueue(b, async () => {
		const total: SyncSummary = { created: 0, updated: 0, deleted: 0, total: 0, adopted: false };
		const bots = await routineBots(b, ctx);
		const main = bots.find((bot) => bot.main);
		if (b.legacyFile !== undefined && main !== undefined && existsSync(b.legacyFile) && !existsSync(fileOf(b, main))) {
			await mkdir(dirname(fileOf(b, main)), { recursive: true });
			await rename(b.legacyFile, fileOf(b, main));
		}
		delete b.legacyFile;
		const failures: string[] = [];
		for (const bot of bots) {
			try {
				const summary = await syncInternal(b, bot, ctx);
				total.created += summary.created;
				total.updated += summary.updated;
				total.deleted += summary.deleted;
				total.total += summary.total;
				total.adopted ||= summary.adopted;
			} catch (error) {
				failures.push(messageOf(error));
			}
		}
		if (failures.length > 0) throw new Error(failures.join("; "));
		return total;
	});
}

// Definitions for an edit: adopts current state into the file first when the file is missing.
async function readDefsForEdit(b: BoundRoutines, bot: RoutineBot, ctx: Context): Promise<RoutineDefinition[]> {
	const loaded = await readRoutineFile(fileOf(b, bot));
	if (loaded !== undefined) return loaded.defs;
	await syncInternal(b, bot, ctx);
	return (await readRoutineFile(fileOf(b, bot)))?.defs ?? [];
}

function validateInput(
	input: { title: string; prompt: string; cron: string; once?: boolean },
	nowMs: number,
): { title: string; prompt: string; cron: string; once?: boolean } {
	const title = input.title.trim();
	const prompt = input.prompt.trim();
	if (title.length === 0) throw new RoutineValidationError("title is required");
	if (prompt.length === 0) throw new RoutineValidationError("prompt is required");
	try {
		const cron = toCronSpec(input.cron);
		nextFire(cron, new Date(nowMs));
		return { title, prompt, cron, ...onceField(input.once) };
	} catch (error) {
		throw new RoutineValidationError(messageOf(error));
	}
}

/** Add a routine to a bot (the main bot when `bot` is absent): append its definition to the bot's file and sync. */
export async function addRoutine(
	input: { title: string; prompt: string; cron: string; once?: boolean; bot?: number },
	ctx: Context,
): Promise<RoutineView> {
	const b = requireBound();
	const def = validateInput(input, b.now());
	return enqueue(b, async () => {
		const bot = await botById(b, input.bot, ctx);
		const defs = await readDefsForEdit(b, bot, ctx);
		if (defs.length >= MAX_ROUTINES) {
			throw new RoutineLimitError(`Routine limit of ${MAX_ROUTINES} reached; cancel one first.`);
		}
		const full: RoutineDefinition = { id: crypto.randomUUID(), ...def };
		const next = [...defs, full];
		await saveDefs(fileOf(b, bot), next);
		await syncInternal(b, bot, ctx, next);
		return viewFor(b, bot, full.id, ctx);
	});
}

/** Replace a routine's title, prompt, cron, and once flag (same id, same bot) and sync. */
export async function updateRoutine(
	id: string,
	input: { title: string; prompt: string; cron: string; once?: boolean },
	ctx: Context,
): Promise<RoutineView> {
	const b = requireBound();
	const def = validateInput(input, b.now());
	return enqueue(b, async () => {
		const { bot } = await locate(b, id, ctx);
		const defs = await readDefsForEdit(b, bot, ctx);
		const index = defs.findIndex((candidate) => candidate.id === id);
		if (index < 0) throw new RoutineNotFoundError(`No routine ${id}.`);
		defs[index] = { id, ...def };
		await saveDefs(fileOf(b, bot), defs);
		await syncInternal(b, bot, ctx, defs);
		return viewFor(b, bot, id, ctx);
	});
}

/** Remove a routine's definition and sync (its sleeper is aborted). `only` limits it to that bot's routines. */
export async function deleteRoutine(id: string, ctx: Context, only?: number): Promise<void> {
	const b = requireBound();
	return enqueue(b, async () => {
		const { bot } = await locate(b, id, ctx, only);
		const defs = await readDefsForEdit(b, bot, ctx);
		if (!defs.some((candidate) => candidate.id === id)) throw new RoutineNotFoundError(`No routine ${id}.`);
		const next = defs.filter((candidate) => candidate.id !== id);
		await saveDefs(fileOf(b, bot), next);
		await syncInternal(b, bot, ctx, next);
	});
}

/** Fire a routine now: post its wake turn to its bot and stamp lastFiredAt. `only` limits it to that bot's routines. A once-routine stays armed for its slot. */
export async function runRoutineNow(id: string, ctx: Context, only?: number): Promise<RoutineView> {
	const b = requireBound();
	return enqueue(b, async () => {
		const { bot, item } = await locate(b, id, ctx, only);
		const conversation = await conversationOf(b, bot, ctx);
		const now = b.now();
		await conversation.submit(
			{
				type: "input",
				content: routineTurnText(item, now),
				requestId: `${item.taskId}:manual:${now}`,
				whenBusy: "followUp",
			},
			ctx,
		);
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(RoutinesDoc, conversation.id);
			const entry = doc.items[id];
			if (entry !== undefined) entry.lastFiredAt = now;
		}, ctx);
		return viewFor(b, bot, id, ctx);
	});
}

/** Before a bot is deleted: stop its routines and delete its file. Called by src/bots.ts through main.ts. */
export async function removeBotRoutines(botId: number, ctx: Context): Promise<void> {
	const b = requireBound();
	return enqueue(b, async () => {
		const bot = (await routineBots(b, ctx)).find((candidate) => candidate.id === botId);
		if (bot === undefined) return;
		const items = await snapshotItems(b, bot, ctx);
		for (const item of Object.values(items)) {
			await b.harness.abortTask(item.taskId, ctx);
			await b.harness.waitForTask(item.taskId, ctx);
		}
		const conversation = await conversationOf(b, bot, ctx);
		await conversation.commit(async (tx) => {
			(await tx.doc(RoutinesDoc, conversation.id)).items = {};
		}, ctx);
		await rm(fileOf(b, bot), { force: true });
		b.paths.delete(bot.id);
	});
}

/** Next three fires (one for a once-routine) plus the friendly label for a spec, for the UI's live preview. Throws on a bad spec. */
export function previewCron(spec: string, once?: boolean): { label: string; next: string[] } {
	const b = requireBound();
	const normalized = toCronSpec(spec);
	const next: string[] = [];
	let from = new Date(b.now());
	for (let i = 0; i < (once === true ? 1 : 3); i++) {
		from = nextFire(normalized, from);
		next.push(from.toISOString());
	}
	return { label: routineLabel(normalized, once), next };
}

/** The folder of bot folders, each holding its routines.json (for logs and the UI). */
export function routineDir(): string {
	return requireBound().dir;
}

/** Watch the bot folders and sync after hand edits to a routines.json (debounced). Returns a stop function. */
export function startRoutineFileWatch(ctx: Context, onError: (error: unknown) => void): () => void {
	const b = requireBound();
	mkdirSync(b.dir, { recursive: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const watcher = watch(b.dir, { recursive: true }, (_event, filename) => {
		if (filename !== null && !filename.toString().endsWith(ROUTINE_FILE)) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			syncRoutines(ctx).catch(onError);
		}, 250);
	});
	watcher.on("error", onError);
	return () => {
		if (timer !== undefined) clearTimeout(timer);
		watcher.close();
	};
}

const cancelRoutine = defineTool({
	name: "cancel_routine",
	description: "Stop a routine so it does not fire again. id is the id returned by schedule.",
	parameters: Type.Object({ id: Type.String() }),
	execute: async (args, api, ctx) => {
		const guard = unboundError();
		if (guard !== undefined) return errorText(guard);
		try {
			await deleteRoutine(args.id, ctx, Number(api.conversationId));
			return text(`Cancelled ${args.id}.`);
		} catch (error) {
			if (error instanceof RoutineNotFoundError) return text(`No routine ${args.id}.`);
			throw error;
		}
	},
});

// Installed on the Harness registry. Adds schedule, list_routines, run_routine, and cancel_routine.
export function createRoutinesExtension(): Extension {
	return defineExtension({
		name: "routines",
		sections: [
			section(
				"routines",
				() =>
					"Call schedule for later or repeating work: cron is a 5-field cron string, a nickname like @daily, or @every 30m, optionally prefixed CRON_TZ=Area/City. Prefer weekday daytime schedules like '30 7 * * 1-5'; never use bare @hourly. Use run_routine to fire one now. For one-off work, pass once: true with a cron naming the slot, like '0 12 9 11 *' for Nov 9 at 12:00; it fires one time and removes itself, so never call cancel_routine for it afterward. Your routines are your own: schedule, run_routine, and cancel_routine act only on them, and each fires as a turn in your chat. The owner can also add, edit, and remove them in the web portal or your routines.json without you; list_routines always shows the current set. A user message starting with [routine] is a routine firing: nobody is waiting, so carry out the standing instruction and send_message the owner only if the outcome needs them.",
			),
		],
		tasks: [RoutineTask],
		tools: [schedule, listRoutines, runRoutine, cancelRoutine],
	});
}
