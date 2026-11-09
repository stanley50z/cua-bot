// The web portal's computer pane: one-line step summaries, call/result pairing from a computer_use
// child transcript, and picking the newest screenshot. Run:  node --test test/computer-view.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, Harness, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { createComputerView, stepDetail } from "../src/computer-view.ts";

const context = BACKGROUND_CONTEXT;

test("step details name what the driver call acted on", () => {
	assert.equal(stepDetail({ text: "oat yogurt" }), '"oat yogurt"');
	assert.equal(stepDetail({ app_name: "Notes" }), "Notes");
	assert.equal(stepDetail({ keys: ["cmd", "n"] }), "cmd+n");
	assert.equal(stepDetail({ x: 120, y: 48 }), "at 120, 48");
	assert.equal(stepDetail({}), "");
	assert.equal(stepDetail({ session: "screen-capture", max_image_dimension: 1200 }), "", "driver bookkeeping is not a detail");
	assert.ok(stepDetail({ text: "x".repeat(200) }).endsWith("…"));
});

test("a snapshot pairs the child's driver calls with their results and shows the newest screenshot", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-computer-"));
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const child = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const reply = (calls: { id: string; name: string; arguments: Record<string, unknown> }[], timestamp: number) => ({
			model: [
				{
					role: "assistant" as const,
					content: calls.map((call) => ({ type: "toolCall" as const, ...call })),
					api: "faux",
					provider: "faux",
					model: "faux-1",
					usage,
					stopReason: "toolUse" as const,
					timestamp,
				},
			],
		});
		const result = (toolCallId: string, toolName: string, isError: boolean) => ({
			model: [{ role: "toolResult" as const, toolCallId, toolName, content: [{ type: "text" as const, text: "ok" }], isError, timestamp: 0 }],
			data: { diagnostics: [] },
		});
		await child.commit(async (tx) => {
			await tx.appendEntry(AssistantEntry, child.id, reply([{ id: "a", name: "launch_app", arguments: { app_name: "Notes" } }], 1000) as never);
			await tx.appendEntry(ToolResultEntry, child.id, result("a", "launch_app", false) as never);
			await tx.appendEntry(AssistantEntry, child.id, reply([{ id: "b", name: "click", arguments: { x: 10, y: 20 } }, { id: "c", name: "type_text", arguments: { text: "milk" } }], 2000) as never);
			await tx.appendEntry(ToolResultEntry, child.id, result("b", "click", true) as never);
		}, context);
		await writeFile(join(dir, "2026-10-31T09-00-00-000Z.png"), "a");
		await writeFile(join(dir, "2026-10-31T09-42-00-000Z.png"), "b");
		await writeFile(join(dir, "notes.txt"), "not a shot");
		await writeFile(join(dir, "zz-browser-test.png"), "a png the bot did not take");

		const view = createComputerView({ harness, storage, conversation: root, shotsDir: dir, space: "Mac mini", context });
		const snapshot = await view.snapshot(child.id);
		assert.equal(snapshot.space, "Mac mini");
		assert.equal(snapshot.shot?.name, "2026-10-31T09-42-00-000Z.png");
		assert.deepEqual(
			snapshot.steps.map((step) => [step.name, step.detail, step.status, step.at]),
			[
				["launch_app", "Notes", "done", 1000],
				["click", "at 10, 20", "error", 2000],
				["type_text", '"milk"', "running", 2000],
			],
		);

		const empty = await createComputerView({ harness, storage, conversation: root, shotsDir: join(dir, "missing"), context }).snapshot();
		assert.deepEqual(empty, { steps: [] }, "no owned child and no shots folder");
	} finally {
		await harness.close(context);
		await rm(dir, { recursive: true, force: true });
	}
});
