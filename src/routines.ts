// Recurring work for the main conversation. Each routine is a durable task that sleeps until its
// cron slot, posts a `[routine]` turn, and sleeps again. A deadline that passed while the bot was
// down fires once on resume and rearms from the wake time; missed slots are never replayed.
// Definitions live in routines.json (see routines-file.ts). The manager below syncs that file
// into the Durable doc and sleeper tasks; the chat tools and the web UI both go through it, so
// hand edits, GUI edits, and model edits converge. The host calls bindRoutines({harness, root})
// after Harness.open, then syncRoutines() once at startup.
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Conversation,
	type Extension,
	type Harness,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";
import { cronLabel, nextFire, toCronSpec, type LegacySchedule } from "./cron.ts";
import {
	DEFAULT_ROUTINE_FILE,
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
};

type RoutinesState = {
	items: { [id: string]: RoutineItem };
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

// The turn a firing posts. Nobody is waiting on it, so it says so and lets the model stay silent.
function routineTurnText(
	routine: { title: string; prompt: string; cron: string; lastFiredAt?: number },
	nowMs: number,
): string {
	const last = routine.lastFiredAt === undefined ? "" : `; last ran ${ago(routine.lastFiredAt, nowMs)}`;
	return [
		`[routine] "${routine.title}" is due (${cronLabel(routine.cron)}${last}). Nobody is waiting.`,
		`Your standing instruction: ${routine.prompt}`,
		"Carry it out; email the owner only if the outcome is worth it.",
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
		// that queues behind this conversation.
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
							{ title: task.input.title, prompt: task.input.prompt, cron: task.input.cron, lastFiredAt: mine?.lastFiredAt },
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
				const entry = Object.values(doc.items).find((item) => Number(item.taskId) === Number(task.id));
				if (entry !== undefined) entry.lastFiredAt = now;
				return { status: "running", checkpoint: { phase: "wait" } };
			}, ctx);
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

// Mutating tools go through the file-backed manager, which owns the root conversation's routines.
function mainConversationError(conversationId: unknown): string | undefined {
	if (bound === undefined) return "bindRoutines(...) was not called after Harness.open.";
	if (Number(conversationId) !== Number(bound.root.id)) return "Routines are managed on the main conversation; ask there.";
	return undefined;
}

const schedule = defineTool({
	name: "schedule",
	description:
		"Schedule a prompt to run on a clock, then again after each fire. Give cron: a 5-field cron string " +
		"(minute hour day-of-month month day-of-week, day-of-week 0 = Sunday), a nickname (@hourly, @daily, " +
		"@weekly, @monthly), or @every 30s|5m|2h, optionally prefixed with CRON_TZ=Area/City. Prefer weekday " +
		"daytime schedules like '30 7 * * 1-5'; never use bare @hourly. The legacy schedule object " +
		"(everyMinutes/dailyAt/weeklyOn, weekday 1 = Sunday) is still accepted and converted. Returns the routine id.",
	parameters: Type.Object({
		title: Type.String(),
		prompt: Type.String(),
		cron: Type.Optional(Type.String({ description: "Cron spec, e.g. '30 7 * * 1-5', '@daily', '@every 30m'" })),
		schedule: Type.Optional(LegacyScheduleSchema),
	}),
	execute: async (args, api, ctx) => {
		if ((args.cron === undefined) === (args.schedule === undefined)) {
			return errorText("Give exactly one of cron or schedule.");
		}
		const guard = mainConversationError(api.conversationId);
		if (guard !== undefined) return errorText(guard);
		let spec: string;
		try {
			spec = toCronSpec(args.cron !== undefined ? args.cron : (args.schedule as LegacySchedule));
			nextFire(spec, new Date(api.now()));
		} catch (error) {
			return errorText(messageOf(error));
		}
		try {
			const view = await addRoutine({ title: args.title, prompt: args.prompt, cron: spec }, ctx);
			const item = (await api.snapshot(RoutinesDoc, api.conversationId, ctx))?.items[view.id];
			return text(`Scheduled ${view.id} task ${item?.taskId} "${view.title}" (${spec}). Next fire: ${view.nextFire}.`);
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
			return `${id}  ${item.title}  ${item.cron}  next ${nextFire(item.cron, now).toISOString()}${last}`;
		});
		return text(lines.length === 0 ? "No routines." : lines.join("\n"));
	},
});

const runRoutine = defineTool({
	name: "run_routine",
	description: "Run a saved routine now, whatever its clock says. id is the id returned by schedule.",
	parameters: Type.Object({ id: Type.String() }),
	execute: async (args, api, ctx) => {
		const guard = mainConversationError(api.conversationId);
		if (guard !== undefined) return errorText(guard);
		try {
			const view = await runRoutineNow(args.id, ctx);
			return text(`Running "${view.title}" now.`);
		} catch (error) {
			if (error instanceof RoutineNotFoundError) return text(`No routine ${args.id}.`);
			throw error;
		}
	},
});

// --- Host-side manager ----------------------------------------------------
// routines.json is the source of truth for definitions; the Durable doc mirrors it and adds task
// ids + lastFiredAt. Every mutation funnels through one queue: edit the file, then sync. Sync
// aborts and recreates sleeper tasks until Durable state matches the file.

export class RoutineNotFoundError extends Error {}
export class RoutineLimitError extends Error {}
export class RoutineValidationError extends Error {}

export type RoutineView = {
	id: string;
	title: string;
	prompt: string;
	cron: string;
	label: string;
	nextFire: string;
	lastFiredAt?: string;
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
	filePath: string;
	now: () => number;
	queue: Promise<unknown>;
};

let bound: BoundRoutines | undefined;

// Call once with the open Harness and its root conversation, before the bot accepts work.
export function bindRoutines(options: {
	harness: Harness;
	root: Conversation;
	filePath?: string;
	now?: () => number;
}): void {
	bound = {
		harness: options.harness,
		root: options.root,
		filePath: options.filePath ?? DEFAULT_ROUTINE_FILE,
		now: options.now ?? Date.now,
		queue: Promise.resolve(),
	};
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

async function snapshotItems(b: BoundRoutines, ctx: Context): Promise<{ [id: string]: RoutineItem }> {
	return (await b.harness.snapshot(RoutinesDoc, b.root.id, ctx))?.items ?? {};
}

function toView(id: string, item: RoutineItem, nowMs: number): RoutineView {
	return {
		id,
		title: item.title,
		prompt: item.prompt,
		cron: item.cron,
		label: cronLabel(item.cron),
		nextFire: nextFire(item.cron, new Date(nowMs)).toISOString(),
		...(item.lastFiredAt !== undefined ? { lastFiredAt: new Date(item.lastFiredAt).toISOString() } : {}),
	};
}

async function viewFor(b: BoundRoutines, id: string, ctx: Context): Promise<RoutineView> {
	const item = (await snapshotItems(b, ctx))[id];
	if (item === undefined) throw new RoutineNotFoundError(`No routine ${id}.`);
	return toView(id, item, b.now());
}

/** All routines as the web UI shows them, soonest firing first. */
export async function listRoutineViews(ctx: Context): Promise<RoutineView[]> {
	const b = requireBound();
	const now = b.now();
	return Object.entries(await snapshotItems(b, ctx))
		.map(([id, item]) => toView(id, item, now))
		.sort((x, y) => x.nextFire.localeCompare(y.nextFire));
}

// Sync assuming the queue is held. A failure part-way (tasks aborted, commit not landed) heals on
// the next sync, which re-diffs the doc against the file.
async function syncInternal(b: BoundRoutines, ctx: Context): Promise<SyncSummary> {
	const loaded = await readRoutineFile(b.filePath);
	const items = await snapshotItems(b, ctx);
	if (loaded === undefined) {
		// First run, or the file was deleted: adopt whatever already runs instead of deleting it.
		const defs = Object.entries(items).map(([id, item]) => ({
			id,
			title: item.title,
			prompt: item.prompt,
			cron: item.cron,
		}));
		await writeRoutineFile(b.filePath, defs);
		return { created: 0, updated: 0, deleted: 0, total: defs.length, adopted: true };
	}
	const { defs, assignedIds } = loaded;
	if (assignedIds) await writeRoutineFile(b.filePath, defs);

	const creates: RoutineDefinition[] = [];
	const updates: RoutineDefinition[] = [];
	for (const def of defs) {
		const existing = items[def.id];
		if (existing === undefined) creates.push(def);
		else if (existing.title !== def.title || existing.prompt !== def.prompt || existing.cron !== def.cron) {
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
	if (creates.length > 0 || updates.length > 0 || deletes.length > 0) {
		await b.root.commit(async (tx) => {
			const doc = await tx.doc(RoutinesDoc, b.root.id);
			for (const id of deletes) delete doc.items[id];
			for (const def of [...creates, ...updates]) {
				const previous = doc.items[def.id];
				const taskId = await tx.createTask(
					RoutineTask,
					{ title: def.title, prompt: def.prompt, cron: def.cron },
					{ ownership: { kind: "conversation" }, background: true },
				);
				doc.items[def.id] = {
					title: def.title,
					prompt: def.prompt,
					cron: def.cron,
					taskId,
					...(previous?.lastFiredAt !== undefined ? { lastFiredAt: previous.lastFiredAt } : {}),
				};
			}
		}, ctx);
	}
	return { created: creates.length, updated: updates.length, deleted: deletes.length, total: defs.length, adopted: false };
}

/** Make Durable state match routines.json. Throws (changing nothing) when the file is invalid. */
export async function syncRoutines(ctx: Context): Promise<SyncSummary> {
	const b = requireBound();
	return enqueue(b, () => syncInternal(b, ctx));
}

// Definitions for an edit: adopts current state into the file first when the file is missing.
async function readDefsForEdit(b: BoundRoutines, ctx: Context): Promise<RoutineDefinition[]> {
	const loaded = await readRoutineFile(b.filePath);
	if (loaded !== undefined) return loaded.defs;
	await syncInternal(b, ctx);
	const adopted = await readRoutineFile(b.filePath);
	if (adopted === undefined) throw new Error(`routines file ${b.filePath} vanished during sync`);
	return adopted.defs;
}

function validateInput(
	input: { title: string; prompt: string; cron: string },
	nowMs: number,
): { title: string; prompt: string; cron: string } {
	const title = input.title.trim();
	const prompt = input.prompt.trim();
	if (title.length === 0) throw new RoutineValidationError("title is required");
	if (prompt.length === 0) throw new RoutineValidationError("prompt is required");
	try {
		const cron = toCronSpec(input.cron);
		nextFire(cron, new Date(nowMs));
		return { title, prompt, cron };
	} catch (error) {
		throw new RoutineValidationError(messageOf(error));
	}
}

/** Add a routine: append its definition to the file and sync. */
export async function addRoutine(
	input: { title: string; prompt: string; cron: string },
	ctx: Context,
): Promise<RoutineView> {
	const b = requireBound();
	const def = validateInput(input, b.now());
	return enqueue(b, async () => {
		const defs = await readDefsForEdit(b, ctx);
		if (defs.length >= MAX_ROUTINES) {
			throw new RoutineLimitError(`Routine limit of ${MAX_ROUTINES} reached; cancel one first.`);
		}
		const full: RoutineDefinition = { id: crypto.randomUUID(), ...def };
		await writeRoutineFile(b.filePath, [...defs, full]);
		await syncInternal(b, ctx);
		return viewFor(b, full.id, ctx);
	});
}

/** Replace a routine's title, prompt, and cron (same id) and sync. */
export async function updateRoutine(
	id: string,
	input: { title: string; prompt: string; cron: string },
	ctx: Context,
): Promise<RoutineView> {
	const b = requireBound();
	const def = validateInput(input, b.now());
	return enqueue(b, async () => {
		const defs = await readDefsForEdit(b, ctx);
		const index = defs.findIndex((candidate) => candidate.id === id);
		if (index < 0) throw new RoutineNotFoundError(`No routine ${id}.`);
		defs[index] = { id, ...def };
		await writeRoutineFile(b.filePath, defs);
		await syncInternal(b, ctx);
		return viewFor(b, id, ctx);
	});
}

/** Remove a routine's definition and sync (its sleeper is aborted). */
export async function deleteRoutine(id: string, ctx: Context): Promise<void> {
	const b = requireBound();
	return enqueue(b, async () => {
		const defs = await readDefsForEdit(b, ctx);
		if (!defs.some((candidate) => candidate.id === id)) throw new RoutineNotFoundError(`No routine ${id}.`);
		await writeRoutineFile(
			b.filePath,
			defs.filter((candidate) => candidate.id !== id),
		);
		await syncInternal(b, ctx);
	});
}

/** Fire a routine now: post its wake turn to the root conversation and stamp lastFiredAt. */
export async function runRoutineNow(id: string, ctx: Context): Promise<RoutineView> {
	const b = requireBound();
	return enqueue(b, async () => {
		const item = (await snapshotItems(b, ctx))[id];
		if (item === undefined) throw new RoutineNotFoundError(`No routine ${id}.`);
		const now = b.now();
		await b.root.submit(
			{
				type: "input",
				content: routineTurnText(item, now),
				requestId: `${item.taskId}:manual:${now}`,
				whenBusy: "followUp",
			},
			ctx,
		);
		await b.root.commit(async (tx) => {
			const doc = await tx.doc(RoutinesDoc, b.root.id);
			const entry = doc.items[id];
			if (entry !== undefined) entry.lastFiredAt = now;
		}, ctx);
		return viewFor(b, id, ctx);
	});
}

/** Next three fires plus the friendly label for a spec, for the UI's live preview. Throws on a bad spec. */
export function previewCron(spec: string): { label: string; next: string[] } {
	const b = requireBound();
	const normalized = toCronSpec(spec);
	const next: string[] = [];
	let from = new Date(b.now());
	for (let i = 0; i < 3; i++) {
		from = nextFire(normalized, from);
		next.push(from.toISOString());
	}
	return { label: cronLabel(normalized), next };
}

/** The config file the manager syncs (for logs and the UI header). */
export function routineFilePath(): string {
	return requireBound().filePath;
}

/** Watch the config file's directory and sync after hand edits (debounced). Returns a stop function. */
export function startRoutineFileWatch(ctx: Context, onError: (error: unknown) => void): () => void {
	const b = requireBound();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const watcher = watch(dirname(b.filePath), (_event, filename) => {
		if (filename !== null && filename.toString() !== basename(b.filePath)) return;
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
		const guard = mainConversationError(api.conversationId);
		if (guard !== undefined) return errorText(guard);
		try {
			await deleteRoutine(args.id, ctx);
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
					"Call schedule for later or repeating work: cron is a 5-field cron string, a nickname like @daily, or @every 30m, optionally prefixed CRON_TZ=Area/City. Prefer weekday daytime schedules like '30 7 * * 1-5'; never use bare @hourly. Use run_routine to fire one now. The owner can also add, edit, and remove routines in the web UI or routines.json without you; list_routines always shows the current set. A user message starting with [routine] is a routine firing: nobody is waiting, so carry out the standing instruction and email the owner only if the outcome is worth it.",
			),
		],
		tasks: [RoutineTask],
		tools: [schedule, listRoutines, runRoutine, cancelRoutine],
	});
}
