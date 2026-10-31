// Recurring work for the main conversation. Each routine is a durable task that sleeps until its
// cron slot, posts a `[routine]` turn, and sleeps again. A deadline that passed while the bot was
// down fires once on resume and rearms from the wake time; missed slots are never replayed.
// The host calls bindRoutines(harness) after Harness.open so cancel_routine can abort the sleeper:
// a tool has no abortTask, and waiting on the routine from schedule would deadlock.
// Stored state is version 2 (cron strings); version 1 stored the legacy schedule objects from
// @trycua/cua/spaces/routines, and both migrates below convert them with legacyToCron.
import { Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	type Harness,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";
import { cronLabel, legacyToCron, nextFire, toCronSpec, type LegacySchedule } from "./cron.ts";

const MAX_ROUTINES = 50;

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

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`stored ${what} is not an object`);
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
	if (typeof value !== "string") throw new Error(`stored ${what} is not a string`);
	return value;
}

function asNumber(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`stored ${what} is not a number`);
	return value;
}

function asLegacySchedule(value: unknown): LegacySchedule {
	const record = asRecord(value, "schedule");
	switch (record.kind) {
		case "everyMinutes":
			return { kind: "everyMinutes", minutes: asNumber(record.minutes, "schedule minutes") };
		case "dailyAt":
			return {
				kind: "dailyAt",
				hour: asNumber(record.hour, "schedule hour"),
				minute: asNumber(record.minute, "schedule minute"),
			};
		case "weeklyOn":
			return {
				kind: "weeklyOn",
				weekday: asNumber(record.weekday, "schedule weekday"),
				hour: asNumber(record.hour, "schedule hour"),
				minute: asNumber(record.minute, "schedule minute"),
			};
		default:
			throw new Error(`stored schedule kind ${JSON.stringify(record.kind)} is unknown`);
	}
}

const RoutinesDoc = defineDoc<RoutinesState>({
	kind: "grokbot.routines",
	version: 2,
	scope: "conversation",
	history: "latest",
	// A fork is a different chat. It does not inherit routines whose tasks still belong to the parent.
	fork: "initial",
	initial: () => ({ items: {} }),
	migrate: (value, fromVersion) => {
		if (fromVersion !== 1) throw new Error(`cannot migrate grokbot.routines from version ${fromVersion}`);
		const items = asRecord(asRecord(value, "routines doc").items, "routines doc items");
		const migrated: RoutinesState = { items: {} };
		for (const [id, raw] of Object.entries(items)) {
			const item = asRecord(raw, `routine ${id}`);
			migrated.items[id] = {
				title: asString(item.title, `routine ${id} title`),
				prompt: asString(item.prompt, `routine ${id} prompt`),
				cron: legacyToCron(asLegacySchedule(item.schedule)),
				taskId: asNumber(item.taskId, `routine ${id} taskId`) as TaskId,
			};
		}
		return migrated;
	},
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

function migrateRoutineCheckpoint(value: unknown): RoutineState {
	const record = asRecord(value, "routine checkpoint");
	if (record.phase === "wait") return { phase: "wait" };
	if (record.phase === "fire") return { phase: "fire", due: asNumber(record.due, "routine checkpoint due") };
	throw new Error(`stored routine checkpoint phase ${JSON.stringify(record.phase)} is unknown`);
}

const RoutineTask = defineTask<RoutineInput, RoutineState, null>({
	name: "grokbot.routine",
	version: 2,
	initial: () => ({ phase: "wait" }),
	migrate: (input, checkpoint, fromVersion) => {
		if (fromVersion !== 1) throw new Error(`cannot migrate grokbot.routine from version ${fromVersion}`);
		const old = asRecord(input, "routine input");
		return {
			input: {
				title: asString(old.title, "routine input title"),
				prompt: asString(old.prompt, "routine input prompt"),
				cron: legacyToCron(asLegacySchedule(old.schedule)),
			},
			checkpoint: migrateRoutineCheckpoint(checkpoint),
		};
	},
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
		let spec: string;
		let due: Date;
		try {
			spec = toCronSpec(args.cron !== undefined ? args.cron : (args.schedule as LegacySchedule));
			due = nextFire(spec, new Date(api.now()));
		} catch (error) {
			return errorText(messageOf(error));
		}
		const id = crypto.randomUUID();
		const taskId = await api.commit(async (tx) => {
			const doc = await tx.doc(RoutinesDoc, api.conversationId);
			if (Object.keys(doc.items).length >= MAX_ROUTINES) return undefined;
			const created = await tx.createTask(
				RoutineTask,
				{ title: args.title, prompt: args.prompt, cron: spec },
				{ ownership: { kind: "conversation" }, background: true },
			);
			doc.items[id] = { title: args.title, prompt: args.prompt, cron: spec, taskId: created };
			return created;
		}, ctx);
		if (taskId === undefined) {
			return errorText(`Routine limit of ${MAX_ROUTINES} reached; cancel one first.`);
		}
		return text(`Scheduled ${id} task ${taskId} "${args.title}" (${spec}). Next fire: ${due.toISOString()}.`);
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
		const item = (await api.snapshot(RoutinesDoc, api.conversationId, ctx))?.items[args.id];
		if (item === undefined) return text(`No routine ${args.id}.`);
		const conversation = await api.conversation(api.conversationId, ctx);
		if (conversation === undefined) return errorText("run_routine lost its conversation.");
		const now = api.now();
		await conversation.submit(
			{
				type: "input",
				content: routineTurnText(item, now),
				requestId: `${item.taskId}:manual:${now}`,
				whenBusy: "followUp",
			},
			ctx,
		);
		await api.commit(async (tx) => {
			const doc = await tx.doc(RoutinesDoc, api.conversationId);
			const entry = doc.items[args.id];
			if (entry !== undefined) entry.lastFiredAt = now;
		}, ctx);
		return text(`Running "${item.title}" now.`);
	},
});

let bound: Harness | undefined;

// Call once with the open Harness, before the bot accepts work. cancel_routine aborts through it.
export function bindRoutines(harness: Harness): void {
	bound = harness;
}

const cancelRoutine = defineTool({
	name: "cancel_routine",
	description: "Stop a routine so it does not fire again. id is the id returned by schedule.",
	parameters: Type.Object({ id: Type.String() }),
	execute: async (args, api, ctx) => {
		const item = (await api.snapshot(RoutinesDoc, api.conversationId, ctx))?.items[args.id];
		if (item === undefined) return text(`No routine ${args.id}.`);
		const harness = bound;
		if (harness === undefined) {
			return errorText("bindRoutines(harness) was not called after Harness.open.");
		}
		await harness.abortTask(item.taskId, ctx);
		await api.waitForTask(item.taskId, ctx);
		await api.commit(async (tx) => {
			const doc = await tx.doc(RoutinesDoc, api.conversationId);
			delete doc.items[args.id];
		}, ctx);
		return text(`Cancelled ${args.id}.`);
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
					"Call schedule for later or repeating work: cron is a 5-field cron string, a nickname like @daily, or @every 30m, optionally prefixed CRON_TZ=Area/City. Prefer weekday daytime schedules like '30 7 * * 1-5'; never use bare @hourly. Use run_routine to fire one now. A user message starting with [routine] is a routine firing: nobody is waiting, so carry out the standing instruction and email the owner only if the outcome is worth it.",
			),
		],
		tasks: [RoutineTask],
		tools: [schedule, listRoutines, runRoutine, cancelRoutine],
	});
}
