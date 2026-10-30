// Recurring work for the main conversation. Durable sleeps until each fire, then posts a `[routine]`
// turn and sleeps again. The host calls bindRoutines(harness) after Harness.open so cancel_routine
// can abort that task: a tool has no abortTask, and waiting on the routine from schedule would deadlock.
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
import { nextFireDate, routineTurnText, scheduleLabel, type RoutineSchedule } from "@trycua/cua/spaces/routines";

type RoutineItem = {
	title: string;
	prompt: string;
	schedule: RoutineSchedule;
	taskId: TaskId;
};

type RoutinesState = {
	items: { [id: string]: RoutineItem };
};

const RoutinesDoc = defineDoc<RoutinesState>({
	kind: "grokbot.routines",
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
	schedule: RoutineSchedule;
};

// `due` is epoch milliseconds on the Harness clock. A Date would not survive the checkpoint.
type RoutineState = { phase: "wait" } | { phase: "fire"; due: number };

const RoutineTask = defineTask<RoutineInput, RoutineState, null>({
	name: "grokbot.routine",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		// Sleep until the next slot. The phase ends once the sleep is stored.
		wait: async (task, runtime, ctx) => {
			const due = nextFireDate(task.input.schedule, new Date(runtime.now()));
			if (due === undefined) {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "failed", error: { message: "schedule has no next fire time" } },
					}),
					ctx,
				);
				return;
			}
			const at = due.getTime();
			await runtime.sleepUntil(at, { phase: "fire", due: at }, ctx);
		},
		// Post the firing and go back to wait. Do not wait for the answer: that queues behind this conversation.
		fire: async (task, runtime, ctx) => {
			const due = task.state.checkpoint.due;
			const conversation = await runtime.conversation(runtime.conversationId, ctx);
			if (conversation !== undefined) {
				await conversation.submit(
					{
						type: "input",
						content: routineTurnText(task.input),
						requestId: `${task.id}:${due}`,
						whenBusy: "followUp",
					},
					ctx,
				);
			}
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait" } }), ctx);
		},
	},
	abort: (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const ScheduleSchema = Type.Union([
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

const schedule = defineTool({
	name: "schedule",
	description:
		"Schedule a prompt to run on a clock, then again after each fire. " +
		"schedule is everyMinutes {minutes}, dailyAt {hour, minute}, or weeklyOn {weekday, hour, minute}. " +
		"weekday is 1 for Sunday through 7 for Saturday. Returns the routine id.",
	parameters: Type.Object({
		title: Type.String(),
		prompt: Type.String(),
		schedule: ScheduleSchema,
	}),
	execute: async (args, api, ctx) => {
		const id = crypto.randomUUID();
		const taskId = await api.commit(async (tx) => {
			const doc = await tx.doc(RoutinesDoc, api.conversationId);
			const created = await tx.createTask(
				RoutineTask,
				{ title: args.title, prompt: args.prompt, schedule: args.schedule },
				{ ownership: { kind: "conversation" }, background: true },
			);
			doc.items[id] = {
				title: args.title,
				prompt: args.prompt,
				schedule: args.schedule,
				taskId: created,
			};
			return created;
		}, ctx);
		const due = nextFireDate(args.schedule, new Date(api.now()));
		return text(
			`Scheduled ${id} task ${taskId} "${args.title}". Next fire: ${due?.toISOString() ?? "unknown"}.`,
		);
	},
});

const listRoutines = defineTool({
	name: "list_routines",
	description: "List saved routines and the next time each one fires.",
	parameters: Type.Object({}),
	execute: async (_args, api, ctx) => {
		const items = (await api.snapshot(RoutinesDoc, api.conversationId, ctx))?.items ?? {};
		const now = new Date(api.now());
		const lines = Object.entries(items).map(([id, item]) => {
			const next = nextFireDate(item.schedule, now);
			return `${id}  ${item.title}  ${scheduleLabel(item.schedule)}  next ${next?.toISOString() ?? "none"}`;
		});
		return text(lines.length === 0 ? "No routines." : lines.join("\n"));
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
			return {
				isError: true,
				output: [{ type: "text" as const, text: "bindRoutines(harness) was not called after Harness.open." }],
			};
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

// Installed on the Harness registry. Adds schedule, list_routines, and cancel_routine to the main agent.
export function createRoutinesExtension(): Extension {
	return defineExtension({
		name: "routines",
		sections: [
			section(
				"routines",
				() =>
					"Call schedule for later or repeating work (every weekday at 9:00 is five weeklyOn entries, weekday 1=Sunday through 7=Saturday, or dailyAt for every day); a user message starting with [routine] is a routine firing.",
			),
		],
		tasks: [RoutineTask],
		tools: [schedule, listRoutines, cancelRoutine],
	});
}
