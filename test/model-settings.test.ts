// Settings > Model: the model and reasoning effort are saved in .env without touching its other lines, applied to
// the bots at once, and served at /api/model. Run from the repo root:  node --test test/model-settings.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createModelSettings, withEnvValues } from "../src/model-settings.ts";
import { botAgent, ModelsConfigError, providerFromConfig } from "../src/models.ts";
import { createBotServer } from "../src/web.ts";

function catalog() {
	const models = createModels();
	models.setProvider(providerFromConfig("sub", { baseUrl: "https://example/v1", apiKey: "sk-test", models: [{ id: "smart", reasoning: true }, { id: "plain" }] }));
	return models;
}

async function withSettings(run: (settings: ReturnType<typeof createModelSettings>, envFile: string, applied: () => number) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-model-settings-"));
	const envFile = join(dir, ".env");
	const saved = { CUABOT_MODEL: process.env.CUABOT_MODEL, CUABOT_REASONING: process.env.CUABOT_REASONING };
	process.env.CUABOT_MODEL = "sub/smart";
	process.env.CUABOT_REASONING = "medium";
	let applied = 0;
	try {
		await writeFile(envFile, "OWNER_EMAIL=me@example.com\r\nCUABOT_MODEL=sub/old\r\nSECRET=a=b#c\r\n");
		await run(createModelSettings({ models: catalog(), apply: async () => void applied++, envFile }), envFile, () => applied);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(dir, { recursive: true, force: true });
	}
}

test("withEnvValues replaces a key's line, appends a new one, and leaves the rest", () => {
	assert.equal(withEnvValues("A=1\nB=2\n", { B: "$&3" }), "A=1\nB=$&3\n");
	assert.equal(withEnvValues("A=1", { B: "2" }), "A=1\nB=2\n");
	assert.equal(withEnvValues("", { B: "2" }), "B=2\n");
	assert.equal(withEnvValues("# B=old\nXB=1\n", { B: "2" }), "# B=old\nXB=1\nB=2\n");
});

test("a change is saved to .env, reaches the agent settings, and is applied at once", async () => {
	await withSettings(async (settings, envFile, applied) => {
		const state = await settings.set("sub/smart", "high");
		assert.equal(state.thinkingLevel, "high");
		assert.deepEqual(botAgent(), { model: { provider: "sub", modelId: "smart" }, thinkingLevel: "high" });
		assert.equal(applied(), 1);
		assert.equal(await readFile(envFile, "utf8"), "OWNER_EMAIL=me@example.com\r\nCUABOT_MODEL=sub/smart\r\nSECRET=a=b#c\r\nCUABOT_REASONING=high\n");
	});
});

test("a model that can't reason drops to off, and its levels say so", async () => {
	await withSettings(async (settings) => {
		const state = await settings.set("sub/plain", "high");
		assert.equal(state.model, "sub/plain");
		assert.equal(state.thinkingLevel, "off");
		assert.deepEqual(state.choices.find((choice) => choice.id === "sub/plain")?.levels, ["off"]);
	});
});

test("a model with no key or an unknown effort is refused and changes nothing", async () => {
	await withSettings(async (settings, envFile, applied) => {
		const before = await readFile(envFile, "utf8");
		await assert.rejects(settings.set("nope/x", "high"), ModelsConfigError);
		await assert.rejects(settings.set("sub/smart", "extreme"), ModelsConfigError);
		assert.equal(await readFile(envFile, "utf8"), before);
		assert.equal(applied(), 0);
		assert.equal(process.env.CUABOT_MODEL, "sub/smart");
	});
});

test("the current model still shows when it has no key", async () => {
	await withSettings(async (settings) => {
		process.env.CUABOT_MODEL = "gone/old";
		const state = await settings.state();
		assert.equal(state.model, "gone/old");
		assert.deepEqual(state.choices[0], { id: "gone/old", provider: "gone", name: "old", levels: ["medium"] });
	});
});

test("CUABOT_REASONING defaults to medium and a typo names the valid efforts", async () => {
	await withSettings(async () => {
		delete process.env.CUABOT_REASONING;
		assert.equal(botAgent().thinkingLevel, "medium");
		process.env.CUABOT_REASONING = "hgih";
		assert.throws(botAgent, /must be one of off, minimal, low, medium, high, xhigh, max, not "hgih"/);
	});
});

test("/api/model reads and changes the settings and answers 400 for a bad pick", async () => {
	await withSettings(async (modelSettings) => {
		const server = createBotServer({ say: async () => "", context: BACKGROUND_CONTEXT, modelSettings });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");
		const url = `http://127.0.0.1:${address.port}/api/model`;
		const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		try {
			assert.equal(((await (await fetch(url)).json()) as { model: string }).model, "sub/smart");
			const changed = await put({ model: "sub/smart", thinkingLevel: "low" });
			assert.equal(changed.status, 200);
			assert.equal(((await changed.json()) as { thinkingLevel: string }).thinkingLevel, "low");
			assert.equal((await put({ model: "nope/x", thinkingLevel: "low" })).status, 400);
			assert.equal((await put({ model: 1 })).status, 400);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
