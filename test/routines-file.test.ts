// routines.json <-> Durable sync and the host-side manager the web UI uses: create from file,
// edit/remove/add by rewriting the file, invalid files rejected without touching running state,
// adoption when the file is missing, and add/update/delete/run operations.
// Run from the repo root:  node --test test/routines-file.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	createRegistry,
	Harness,
	MemoryStorage,
	type TaskId,
} from "@earendil-works/pi-durable";
import {
	addRoutine,
	bindRoutines,
	createRoutinesExtension,
	deleteRoutine,
	listRoutineViews,
	runRoutineNow,
	syncRoutines,
	updateRoutine,
} from "../src/routines.ts";

const context = BACKGROUND_CONTEXT;
// Tue 2023-11-14T22:13:20Z.
const BASE = 1_700_000_000_000;

function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function scriptedModel() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const reply: FauxResponseStep = (request) => {
		faux.appendResponses([reply]);
		const last = request.messages.findLast((message) => message.role !== "system");
		const text = last === undefined ? "" : messageText(last);
		return fauxAssistantMessage([fauxText(text.startsWith("[routine]") ? "Done." : "ok")]);
	};
	faux.setResponses([reply]);
	return models;
}

type Session = {
	dir: string;
	file: string;
	clock: { now: number };
	harness: Harness;
	root: Conversation;
};

async function open(): Promise<Session> {
	const dir = await mkdtemp(join(tmpdir(), "grokbot-routine-file-"));
	const file = join(dir, "routines.json");
	const clock = { now: BASE };
	const registry = createRegistry();
	registry.install(createRoutinesExtension());
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: scriptedModel(), registry, now: () => clock.now, setTimer: () => () => {} },
		context,
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	bindRoutines({ harness, root, filePath: file, now: () => clock.now });
	harness.resume();
	return { dir, file, clock, harness, root };
}

async function close(session: Session): Promise<void> {
	await session.harness.close(context);
	await rm(session.dir, { recursive: true, force: true });
}

async function writeDefs(session: Session, defs: unknown): Promise<void> {
	await writeFile(session.file, typeof defs === "string" ? defs : `${JSON.stringify(defs, null, 2)}\n`, "utf8");
}

async function readDefs(session: Session): Promise<Array<{ id: string; title: string; prompt: string; cron: string }>> {
	return JSON.parse(await readFile(session.file, "utf8")) as Array<{ id: string; title: string; prompt: string; cron: string }>;
}

// Newly created tasks reach "sleeping" on a scheduler tick, so poll until `count` are there.
async function sleeping(session: Session, count: number): Promise<Array<{ id: TaskId; until: number }>> {
	let found: Array<{ id: TaskId; until: number }> = [];
	await eventually(async () => {
		const inspection = await session.harness.inspect(context);
		found = [];
		for (const task of inspection.tasks) {
			if (task.record.kind === "grokbot.routine" && task.record.state.status === "sleeping") {
				found.push({ id: task.record.id, until: task.record.state.until });
			}
		}
		return found.length === count;
	});
	return found.sort((a, b) => a.until - b.until);
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 8_000;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

const AGENDA = { id: "agenda", title: "Morning agenda", prompt: "Brief me", cron: "CRON_TZ=UTC 30 7 * * 1-5" };
const SWEEP = { id: "sweep", title: "Sweep", prompt: "Triage", cron: "@every 1m" };

test("sync creates sleeping routines from the file and fills in missing ids", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const { id: _dropped, ...sweepWithoutId } = SWEEP;
		await writeDefs(session, [AGENDA, sweepWithoutId]);
		const summary = await syncRoutines(context);
		assert.deepEqual(summary, { created: 2, updated: 0, deleted: 0, total: 2, adopted: false });

		const views = await listRoutineViews(context);
		assert.equal(views.length, 2);
		assert.equal(views[0]?.title, "Sweep");
		assert.equal(views[0]?.label, "every 1m");
		assert.equal(views[0]?.nextFire, "2023-11-14T22:14:20.000Z");
		assert.equal(views[1]?.title, "Morning agenda");
		assert.equal(views[1]?.label, "weekdays 07:30 UTC");
		assert.equal(views[1]?.nextFire, "2023-11-15T07:30:00.000Z");

		assert.deepEqual(
			(await sleeping(session, 2)).map((task) => task.until),
			[BASE + 60_000, Date.UTC(2023, 10, 15, 7, 30)],
		);

		const saved = await readDefs(session);
		assert.equal(saved[0]?.id, "agenda");
		assert.ok(typeof saved[1]?.id === "string" && saved[1].id.length > 0);
		assert.equal(saved[1]?.id, views[0]?.id);
	} finally {
		await close(session);
	}
});

test("rewriting the file then syncing edits, removes, and adds routines", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		await writeDefs(session, [AGENDA, SWEEP]);
		await syncRoutines(context);
		const before = await sleeping(session, 2);
		const sweepTask = before.find((task) => task.until === BASE + 60_000);
		assert.ok(sweepTask);

		await writeDefs(session, [
			{ ...AGENDA, cron: "@every 2m" },
			{ id: "nightly", title: "Nightly", prompt: "Wrap up", cron: "CRON_TZ=UTC 0 22 * * *" },
		]);
		const summary = await syncRoutines(context);
		assert.deepEqual(summary, { created: 1, updated: 1, deleted: 1, total: 2, adopted: false });

		const removed = await session.harness.getTask(sweepTask.id, context);
		assert.equal(removed?.state.status, "terminal");

		const views = await listRoutineViews(context);
		assert.deepEqual(
			views.map((view) => view.id),
			["agenda", "nightly"],
		);
		assert.equal(views[0]?.nextFire, new Date(BASE + 120_000).toISOString());
		assert.equal(views[1]?.nextFire, "2023-11-15T22:00:00.000Z");
		assert.deepEqual(
			(await sleeping(session, 2)).map((task) => task.until),
			[BASE + 120_000, Date.UTC(2023, 10, 15, 22, 0)],
		);
	} finally {
		await close(session);
	}
});

test("an invalid file is rejected whole and running state is untouched", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		await writeDefs(session, [SWEEP]);
		await syncRoutines(context);
		const deadlineBefore = (await sleeping(session, 1)).map((task) => task.until);

		await writeDefs(session, "not json{");
		await assert.rejects(syncRoutines(context), /not valid JSON/);
		await writeDefs(session, [{ ...SWEEP, cron: "banana" }]);
		await assert.rejects(syncRoutines(context), /Invalid cron/);
		await writeDefs(session, [SWEEP, SWEEP]);
		await assert.rejects(syncRoutines(context), /duplicate/);
		await writeDefs(
			session,
			Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, title: `R${i}`, prompt: "x", cron: "@every 1m" })),
		);
		await assert.rejects(syncRoutines(context), /limit of 50/);
		await writeDefs(session, [{ id: "x", title: "", prompt: "x", cron: "@every 1m" }]);
		await assert.rejects(syncRoutines(context), /title/);

		assert.deepEqual(
			(await listRoutineViews(context)).map((view) => view.id),
			["sweep"],
		);
		assert.deepEqual(
			(await sleeping(session, 1)).map((task) => task.until),
			deadlineBefore,
		);
	} finally {
		await close(session);
	}
});

test("a UTF-8 BOM from a Windows editor is tolerated", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		await writeDefs(session, "\uFEFF" + JSON.stringify([SWEEP]));
		const summary = await syncRoutines(context);
		assert.equal(summary.created, 1);
		assert.deepEqual(
			(await listRoutineViews(context)).map((view) => view.id),
			["sweep"],
		);
	} finally {
		await close(session);
	}
});

test("a missing file adopts current routines instead of deleting them", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		await addRoutine({ title: "Sweep", prompt: "Triage", cron: "@every 1m" }, context);
		const deadlineBefore = (await sleeping(session, 1)).map((task) => task.until);
		assert.deepEqual(deadlineBefore, [BASE + 60_000]);

		await rm(session.file);
		const summary = await syncRoutines(context);
		assert.equal(summary.adopted, true);
		assert.equal(summary.total, 1);
		const saved = await readDefs(session);
		assert.equal(saved[0]?.cron, "@every 1m");
		assert.deepEqual(
			(await sleeping(session, 1)).map((task) => task.until),
			deadlineBefore,
		);
	} finally {
		await close(session);
	}
});

test("add, update, run, and delete through the manager", { timeout: 20_000 }, async () => {
	const session = await open();
	try {
		const created = await addRoutine({ title: "Tue Fri", prompt: "Standup notes", cron: "CRON_TZ=UTC 0 9 * * 2,5" }, context);
		assert.equal(created.label, "Tuesdays and Fridays 09:00 UTC");
		assert.equal(created.nextFire, "2023-11-17T09:00:00.000Z");
		assert.deepEqual(
			(await readDefs(session)).map((def) => def.id),
			[created.id],
		);

		const updated = await updateRoutine(created.id, { title: "Tue Fri", prompt: "Standup notes", cron: "@every 5m" }, context);
		assert.equal(updated.nextFire, new Date(BASE + 300_000).toISOString());

		const ran = await runRoutineNow(created.id, context);
		assert.equal(ran.lastFiredAt, new Date(BASE).toISOString());
		await eventually(async () => {
			const view = await session.root.context(context);
			return view.messages.some((message) => messageText(message).includes('[routine] "Tue Fri" is due'));
		});

		await deleteRoutine(created.id, context);
		assert.deepEqual(await listRoutineViews(context), []);
		assert.deepEqual(await readDefs(session), []);

		await assert.rejects(updateRoutine("nope", { title: "x", prompt: "y", cron: "@daily" }, context), /No routine/);
		await assert.rejects(deleteRoutine("nope", context), /No routine/);
		await assert.rejects(runRoutineNow("nope", context), /No routine/);
		await assert.rejects(addRoutine({ title: "x", prompt: "y", cron: "banana" }, context), /Invalid cron/);
		await assert.rejects(addRoutine({ title: " ", prompt: "y", cron: "@daily" }, context), /title/);
	} finally {
		await close(session);
	}
});
