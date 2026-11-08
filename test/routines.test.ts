// Routine cron scheduling: sleep, fire, restart, cancel, run-now, the 50 cap, legacy inputs,
// and state written by the pre-cron (v1) code. Run from the repo root:
//   node --test test/routines.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	createRegistry,
	Harness,
	type HarnessOptions,
	MemoryStorage,
	type SetTimer,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { bindRoutines, createRoutinesExtension, syncRoutines } from "../src/routines.ts";

const context = BACKGROUND_CONTEXT;
const TITLE = "Morning sweep";
const PROMPT = "Triage the inbox";
const MODEL = { provider: "faux", modelId: "faux-1" } as const;
// Tue 2023-11-14T22:13:20Z. The v1 fixture was generated at this instant too.
const BASE = 1_700_000_000_000;

const tempDirs: string[] = [];
after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function freshRoutineFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-routines-file-"));
	tempDirs.push(dir);
	const file = join(dir, "cua-bot", "routines.json");
	await mkdir(dirname(file), { recursive: true });
	return file;
}

function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function answerFor(request: { messages: readonly Message[] }): AssistantMessage {
	const last = request.messages.findLast((message) => message.role !== "system");
	if (last === undefined) return fauxAssistantMessage([fauxText("ok")]);
	const text = messageText(last);
	if (last.role === "toolResult") return fauxAssistantMessage([fauxText("ok")]);
	if (text.startsWith("[routine]")) return fauxAssistantMessage([fauxText("Done.")]);
	if (text.startsWith("cancel ")) {
		const id = text.slice("cancel ".length).trim();
		return fauxAssistantMessage([fauxToolCall("cancel_routine", { id })], { stopReason: "toolUse" });
	}
	if (text.startsWith("run ")) {
		const id = text.slice("run ".length).trim();
		return fauxAssistantMessage([fauxToolCall("run_routine", { id })], { stopReason: "toolUse" });
	}
	if (text.includes("list routines")) {
		return fauxAssistantMessage([fauxToolCall("list_routines", {})], { stopReason: "toolUse" });
	}
	if (text.includes("schedule banana")) {
		return fauxAssistantMessage([fauxToolCall("schedule", { title: TITLE, prompt: PROMPT, cron: "banana" })], {
			stopReason: "toolUse",
		});
	}
	if (text.includes("schedule legacy")) {
		return fauxAssistantMessage(
			[fauxToolCall("schedule", { title: TITLE, prompt: PROMPT, schedule: { kind: "dailyAt", hour: 8, minute: 0 } })],
			{ stopReason: "toolUse" },
		);
	}
	if (text.includes("schedule weekdays")) {
		return fauxAssistantMessage(
			[fauxToolCall("schedule", { title: TITLE, prompt: PROMPT, cron: "CRON_TZ=UTC 30 7 * * 1-5" })],
			{ stopReason: "toolUse" },
		);
	}
	if (text.includes("schedule once")) {
		return fauxAssistantMessage([fauxToolCall("schedule", { title: TITLE, prompt: PROMPT, cron: "@every 1m", once: true })], {
			stopReason: "toolUse",
		});
	}
	if (text.includes("schedule 51")) {
		const calls = Array.from({ length: 51 }, (_, i) =>
			fauxToolCall("schedule", { title: `R${i + 1}`, prompt: PROMPT, cron: "@every 1m" }, { id: `cap-${i + 1}` }),
		);
		return fauxAssistantMessage(calls, { stopReason: "toolUse" });
	}
	if (text.includes("schedule")) {
		return fauxAssistantMessage([fauxToolCall("schedule", { title: TITLE, prompt: PROMPT, cron: "@every 1m" })], {
			stopReason: "toolUse",
		});
	}
	return fauxAssistantMessage([fauxText("ok")]);
}

function scriptedModel() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const reply: FauxResponseStep = (request) => {
		faux.appendResponses([reply]);
		return answerFor(request);
	};
	faux.setResponses([reply]);
	return models;
}

type Opened = {
	clock: { now: number };
	reports: string[];
	harness: Harness;
	root: Conversation;
	routineFile: string;
};

async function openSession(
	storage: Storage,
	clock: { now: number },
	models: ReturnType<typeof scriptedModel>,
	routineFile?: string,
): Promise<Opened> {
	const reports: string[] = [];
	const registry = createRegistry();
	registry.install(createRoutinesExtension());
	const setTimer: SetTimer = () => () => {};
	const options: HarnessOptions = {
		models,
		registry,
		now: () => clock.now,
		setTimer,
		onReport: ({ kind, error }) => {
			reports.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
		},
	};
	const harness = await Harness.open(storage, options, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	const file = routineFile ?? (await freshRoutineFile());
	bindRoutines({ harness, root, dir: dirname(dirname(file)), now: () => clock.now });
	harness.resume();
	await syncRoutines(context);
	return { clock, reports, harness, root, routineFile: file };
}

async function say(root: Conversation, content: string): Promise<void> {
	const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
	assert.equal(settled.status, "done", `unanswered: ${settled.status === "unanswered" ? settled.reason : ""}`);
}

async function transcript(root: Conversation): Promise<string> {
	const view = await root.context(context);
	return view.messages.map((message) => `${message.role}: ${messageText(message)}`).join("\n");
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 8_000;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

async function sleepDeadline(harness: Harness): Promise<number> {
	let until = 0;
	await eventually(async () => {
		const inspection = await harness.inspect(context);
		for (const task of inspection.tasks) {
			const state = task.record.state;
			if (task.record.kind === "cua-bot.routine" && state.status === "sleeping") {
				until = state.until;
				return true;
			}
		}
		return false;
	});
	return until;
}

async function routineTaskCount(harness: Harness): Promise<number> {
	const inspection = await harness.inspect(context);
	return inspection.tasks.filter((task) => task.record.kind === "cua-bot.routine").length;
}

function scheduledId(log: string): { id: string; taskId: number } {
	const match = log.match(/Scheduled ([0-9a-f-]{36}) task (\d+)/i);
	assert.ok(match?.[1] !== undefined && match[2] !== undefined, log);
	return { id: match[1], taskId: Number(match[2]) };
}

function wakeCount(log: string): number {
	return log.split(`[routine] "${TITLE}"`).length - 1;
}

function assertNoFaults(session: Opened): void {
	assert.equal(session.reports.filter((line) => line.startsWith("task_faulted") || line.startsWith("migration_failed")).join("\n"), "");
}

test("schedule returns before the routine fires", { timeout: 20_000 }, async () => {
	const clock = { now: BASE };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "please schedule a routine");
		const log = await transcript(session.root);
		assert.match(log, /Scheduled /);
		assert.equal(log.includes("[routine]"), false);
		const until = await sleepDeadline(session.harness);
		assert.equal(until, BASE + 60_000);
		await say(session.root, "list routines");
		const listed = await transcript(session.root);
		assert.match(listed, /Morning sweep/);
		assert.match(listed, /@every 1m/);
		assert.match(listed, /next /);
		const saved = JSON.parse(await readFile(session.routineFile, "utf8")) as Array<{ id: string; title: string; cron: string }>;
		assert.equal(saved.length, 1);
		assert.equal(saved[0]?.title, TITLE);
		assert.equal(saved[0]?.cron, "@every 1m");
		assert.equal(saved[0]?.id, scheduledId(log).id);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
	}
});

test("advancing the clock fires a [routine] turn", { timeout: 20_000 }, async () => {
	const clock = { now: BASE };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "please schedule a routine");
		const until = await sleepDeadline(session.harness);
		clock.now = until;
		session.harness.resume();
		await eventually(async () => wakeCount(await transcript(session.root)) === 1);
		const log = await transcript(session.root);
		assert.match(log, /is due \(every 1m\)/);
		assert.match(log, /Nobody is waiting/);
		assert.match(log, new RegExp(PROMPT));
		assert.match(log, /send_message the owner only if the outcome needs them/);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
	}
});

test("a routine sleeping in sqlite still fires after reopen", { timeout: 20_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "cua-bot-routines-"));
	const database = join(directory, "session.sqlite");
	const clock = { now: BASE };
	const models = scriptedModel();
	const routineFile = join(directory, "cua-bot", "routines.json");
	await mkdir(dirname(routineFile), { recursive: true });
	let session = await openSession(await openNodeSqliteStorage(database), clock, models, routineFile);
	try {
		await say(session.root, "please schedule a routine");
		const until = await sleepDeadline(session.harness);
		await session.harness.close(context);

		session = await openSession(await openNodeSqliteStorage(database), clock, models, routineFile);
		session.harness.resume();
		const still = await sleepDeadline(session.harness);
		assert.equal(still, until);
		assert.equal((await transcript(session.root)).includes("[routine]"), false);

		clock.now = until;
		session.harness.resume();
		await eventually(async () => wakeCount(await transcript(session.root)) === 1);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancel_routine aborts the sleeper before it can fire", { timeout: 20_000 }, async () => {
	const clock = { now: BASE };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "please schedule a routine");
		const until = await sleepDeadline(session.harness);
		const { id, taskId } = scheduledId(await transcript(session.root));
		await say(session.root, `cancel ${id}`);
		const record = await session.harness.getTask(taskId as TaskId, context);
		assert.equal(record?.state.status, "terminal");
		if (record?.state.status === "terminal") assert.equal(record.state.outcome.status, "aborted");
		assert.match(await transcript(session.root), /Cancelled /);
		assert.equal(existsSync(session.routineFile), false, "a bot without routines has no file");

		clock.now = until + 60_000;
		session.harness.resume();
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal((await transcript(session.root)).includes("[routine]"), false);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
	}
});

test("weekday cron survives a restart and a missed weekend fires once", { timeout: 20_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "cua-bot-routines-"));
	const database = join(directory, "session.sqlite");
	const clock = { now: BASE };
	const models = scriptedModel();
	// From Tue 2023-11-14T22:13:20Z, weekdays 07:30 UTC next fires Wed 2023-11-15T07:30:00Z.
	const firstDue = Date.UTC(2023, 10, 15, 7, 30);
	const routineFile = join(directory, "cua-bot", "routines.json");
	await mkdir(dirname(routineFile), { recursive: true });
	let session = await openSession(await openNodeSqliteStorage(database), clock, models, routineFile);
	try {
		await say(session.root, "schedule weekdays please");
		assert.equal(await sleepDeadline(session.harness), firstDue);
		await session.harness.close(context);

		session = await openSession(await openNodeSqliteStorage(database), clock, models, routineFile);
		assert.equal(await sleepDeadline(session.harness), firstDue);

		// Sleep through the slot and the weekend: Sat 2023-11-18T07:30:00Z. One fire, no replay.
		clock.now = Date.UTC(2023, 10, 18, 7, 30);
		session.harness.resume();
		await eventually(async () => wakeCount(await transcript(session.root)) === 1);
		// Rearmed for Mon 2023-11-20T07:30:00Z.
		assert.equal(await sleepDeadline(session.harness), Date.UTC(2023, 10, 20, 7, 30));
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(wakeCount(await transcript(session.root)), 1);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("the second firing says when it last ran, and list shows it", { timeout: 20_000 }, async () => {
	const clock = { now: BASE };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "please schedule a routine");
		const firstDue = await sleepDeadline(session.harness);
		clock.now = firstDue;
		session.harness.resume();
		await eventually(async () => wakeCount(await transcript(session.root)) === 1);

		const secondDue = await sleepDeadline(session.harness);
		assert.equal(secondDue, firstDue + 60_000);
		await say(session.root, "list routines");
		assert.match(await transcript(session.root), new RegExp(`last ${new Date(firstDue).toISOString()}`));

		clock.now = secondDue;
		session.harness.resume();
		await eventually(async () => wakeCount(await transcript(session.root)) === 2);
		assert.match(await transcript(session.root), /last ran 1 minute ago/);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
	}
});

test("a once routine fires one time and removes itself", { timeout: 20_000 }, async () => {
	const clock = { now: BASE };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "schedule once please");
		const { taskId } = scheduledId(await transcript(session.root));
		assert.match(await transcript(session.root), /It removes itself after that\./);
		const saved = JSON.parse(await readFile(session.routineFile, "utf8")) as Array<{ once?: boolean }>;
		assert.equal(saved[0]?.once, true);
		await say(session.root, "list routines");
		assert.match(await transcript(session.root), /@every 1m {2}once {2}next /);

		const until = await sleepDeadline(session.harness);
		clock.now = until;
		session.harness.resume();
		await eventually(async () => wakeCount(await transcript(session.root)) === 1);
		await eventually(async () => !existsSync(session.routineFile));
		assert.match(await transcript(session.root), /is due \(once, every 1m\)/);

		const record = await session.harness.getTask(taskId as TaskId, context);
		assert.equal(record?.state.status, "terminal");
		if (record?.state.status === "terminal") assert.equal(record.state.outcome.status, "completed");

		clock.now = until + 300_000;
		session.harness.resume();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(wakeCount(await transcript(session.root)), 1);
		await say(session.root, "list routines");
		assert.match(await transcript(session.root), /No routines\./);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
	}
});

test("run_routine fires now without the clock moving", { timeout: 20_000 }, async () => {
	const clock = { now: BASE };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "please schedule a routine");
		const until = await sleepDeadline(session.harness);
		const { id } = scheduledId(await transcript(session.root));
		await say(session.root, `run ${id}`);
		await eventually(async () => wakeCount(await transcript(session.root)) === 1);
		assert.equal(clock.now, BASE);
		assert.equal(await sleepDeadline(session.harness), until);
		assert.match(await transcript(session.root), /Running "Morning sweep" now/);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
	}
});

test("invalid cron is rejected and creates nothing", { timeout: 20_000 }, async () => {
	const clock = { now: BASE };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "schedule banana please");
		assert.match(await transcript(session.root), /Invalid cron/);
		assert.equal(await routineTaskCount(session.harness), 0);
		await say(session.root, "list routines");
		assert.match(await transcript(session.root), /No routines\./);
		await say(session.root, "run 00000000-0000-0000-0000-000000000000");
		assert.match(await transcript(session.root), /No routine /);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
	}
});

test("legacy schedule objects still schedule, stored as cron", { timeout: 20_000 }, async () => {
	const clock = { now: BASE };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "schedule legacy please");
		// dailyAt 08:00 local: today 08:00 if still ahead, else tomorrow (calendar arithmetic, no cron code).
		const base = new Date(BASE);
		let expected = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 8, 0, 0, 0);
		if (expected.getTime() <= BASE) expected = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 8, 0, 0, 0);
		assert.equal(await sleepDeadline(session.harness), expected.getTime());
		await say(session.root, "list routines");
		assert.match(await transcript(session.root), /0 8 \* \* \*/);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
	}
});

test("the 51st routine is refused at the 50 cap", { timeout: 30_000 }, async () => {
	const clock = { now: BASE };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "schedule 51 routines");
		const log = await transcript(session.root);
		assert.equal((log.match(/Scheduled [0-9a-f-]{36}/g) ?? []).length, 50);
		assert.match(log, /limit of 50/);
		assert.equal(await routineTaskCount(session.harness), 50);
		assertNoFaults(session);
	} finally {
		await session.harness.close(context);
	}
});
