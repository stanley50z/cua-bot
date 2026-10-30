// Routine sleep, fire, restart, and cancel. Run from the repo root:
//   node --test test/routines.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
import { bindRoutines, createRoutinesExtension } from "../src/routines.ts";

const context = BACKGROUND_CONTEXT;
const TITLE = "Morning sweep";
const PROMPT = "Triage the inbox";
const MODEL = { provider: "faux", modelId: "faux-1" } as const;

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
	if (text.includes("list routines")) {
		return fauxAssistantMessage([fauxToolCall("list_routines", {})], { stopReason: "toolUse" });
	}
	if (text.includes("schedule")) {
		return fauxAssistantMessage(
			[
				fauxToolCall("schedule", {
					title: TITLE,
					prompt: PROMPT,
					schedule: { kind: "everyMinutes", minutes: 1 },
				}),
			],
			{ stopReason: "toolUse" },
		);
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
};

async function openSession(storage: Storage, clock: { now: number }, models: ReturnType<typeof scriptedModel>): Promise<Opened> {
	const reports: string[] = [];
	const registry = createRegistry();
	registry.install(createRoutinesExtension());
	const setTimer: SetTimer = () => () => {};
	const options: HarnessOptions = {
		models,
		registry,
		now: () => clock.now,
		setTimer,
		onReport: (error, info) => {
			reports.push(`${info.type}: ${error instanceof Error ? error.message : String(error)}`);
		},
	};
	const harness = await Harness.open(storage, options, context);
	bindRoutines(harness);
	const root = await harness.root(context, { agent: { model: MODEL } });
	harness.resume();
	return { clock, reports, harness, root };
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
			if (task.record.kind === "grokbot.routine" && state.status === "sleeping") {
				until = state.until;
				return true;
			}
		}
		return false;
	});
	return until;
}

function scheduledId(log: string): { id: string; taskId: number } {
	const match = log.match(/Scheduled ([0-9a-f-]{36}) task (\d+)/i);
	assert.ok(match?.[1] !== undefined && match[2] !== undefined, log);
	return { id: match[1], taskId: Number(match[2]) };
}

test("schedule returns before the routine fires", { timeout: 20_000 }, async () => {
	const clock = { now: 1_700_000_000_000 };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "please schedule a routine");
		const log = await transcript(session.root);
		assert.match(log, /Scheduled /);
		assert.equal(log.includes("[routine]"), false);
		const until = await sleepDeadline(session.harness);
		assert.ok(until > clock.now);
		await say(session.root, "list routines");
		const listed = await transcript(session.root);
		assert.match(listed, /Morning sweep/);
		assert.match(listed, /next /);
		assert.equal(session.reports.filter((line) => line.startsWith("task_faulted")).join("\n"), "");
	} finally {
		await session.harness.close(context);
	}
});

test("advancing the clock fires a [routine] turn", { timeout: 20_000 }, async () => {
	const clock = { now: 1_700_000_000_000 };
	const session = await openSession(new MemoryStorage(), clock, scriptedModel());
	try {
		await say(session.root, "please schedule a routine");
		const until = await sleepDeadline(session.harness);
		clock.now = until;
		session.harness.resume();
		await eventually(async () => (await transcript(session.root)).includes(`[routine] ${TITLE}: ${PROMPT}`));
		assert.equal(session.reports.filter((line) => line.startsWith("task_faulted")).join("\n"), "");
	} finally {
		await session.harness.close(context);
	}
});

test("a routine sleeping in sqlite still fires after reopen", { timeout: 20_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "grokbot-routines-"));
	const database = join(directory, "session.sqlite");
	const clock = { now: 1_700_000_000_000 };
	const models = scriptedModel();
	let session = await openSession(await openNodeSqliteStorage(database), clock, models);
	try {
		await say(session.root, "please schedule a routine");
		const until = await sleepDeadline(session.harness);
		await session.harness.close(context);

		session = await openSession(await openNodeSqliteStorage(database), clock, models);
		session.harness.resume();
		const still = await sleepDeadline(session.harness);
		assert.equal(still, until);
		assert.equal((await transcript(session.root)).includes("[routine]"), false);

		clock.now = until;
		session.harness.resume();
		await eventually(async () => (await transcript(session.root)).includes(`[routine] ${TITLE}: ${PROMPT}`));
		assert.equal(session.reports.filter((line) => line.startsWith("task_faulted")).join("\n"), "");
	} finally {
		await session.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancel_routine aborts the sleeper before it can fire", { timeout: 20_000 }, async () => {
	const clock = { now: 1_700_000_000_000 };
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

		clock.now = until + 60_000;
		session.harness.resume();
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal((await transcript(session.root)).includes("[routine]"), false);
		assert.equal(session.reports.filter((line) => line.startsWith("task_faulted")).join("\n"), "");
	} finally {
		await session.harness.close(context);
	}
});
