// models.json, the Pi-style list of model endpoints: it is checked on load, "$NAME" keys come from the
// environment, models get defaults for missing fields, and "provider/model" references split on the
// first slash. Run from the repo root:  node --test test/models.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { ModelsConfigError, parseModelRef, providerFromConfig, readModelsConfig } from "../src/models.ts";

async function withFile(text: string, run: (file: string) => void | Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-models-"));
	try {
		const file = join(dir, "models.json");
		await writeFile(file, text, "utf8");
		await run(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("the example config loads, and a broken one names its problem", async () => {
	const example = readModelsConfig(join(import.meta.dirname, "..", "models.example.json"));
	assert.equal(example.default, "azure-foundry/grok-4.6");
	const broken = (config: unknown, problem: RegExp) =>
		withFile(JSON.stringify(config), (file) => assert.throws(() => readModelsConfig(file), (error: unknown) => error instanceof ModelsConfigError && problem.test(error.message)));
	await broken({ default: "a/b", providers: { a: { apiKey: "$K", models: [{ id: "b" }] } } }, /provider a needs a baseUrl/);
	await broken({ default: "a/b", providers: { a: { baseUrl: "https://x", apiKey: "$K", api: "anthropic", models: [{ id: "b" }] } } }, /api must be one of/);
	await broken({ default: "a/b", providers: { a: { baseUrl: "https://x", apiKey: "$K", models: [] } } }, /at least one model/);
	await broken({ default: "b", providers: { a: { baseUrl: "https://x", apiKey: "$K", models: [{ id: "b" }] } } }, /"default" as "provider\/model"/);
	await withFile("{ not json", (file) => assert.throws(() => readModelsConfig(file), /Copy models\.example\.json/));
});

test("provider/model splits on the first slash only", () => {
	assert.deepEqual(parseModelRef("azure-foundry-2/FW-MiniMax-M2.5"), { provider: "azure-foundry-2", modelId: "FW-MiniMax-M2.5" });
	assert.deepEqual(parseModelRef("openrouter/qwen/qwen3"), { provider: "openrouter", modelId: "qwen/qwen3" });
	assert.throws(() => parseModelRef("grok-4.6"), ModelsConfigError);
});

test("models get defaults and per-model APIs, and keys come from the environment or the file", async () => {
	process.env.CUA_BOT_TEST_KEY = "from-env";
	try {
		const models = createModels();
		models.setProvider(
			providerFromConfig("foundry", {
				baseUrl: "https://example.services.ai.azure.com/openai/v1/",
				api: "openai-responses",
				apiKey: "$CUA_BOT_TEST_KEY",
				models: [{ id: "gpt-6.1-terra", reasoning: true, contextWindow: 500_000 }, { id: "FW-MiniMax-M2.5", api: "openai-completions" }],
			}),
		);
		models.setProvider(providerFromConfig("literal", { baseUrl: "https://other/v1", apiKey: "sk-literal", models: [{ id: "m" }] }));
		const terra = models.getModel("foundry", "gpt-6.1-terra");
		assert.equal(terra?.api, "openai-responses");
		assert.equal(terra?.baseUrl, "https://example.services.ai.azure.com/openai/v1", "trailing slash trimmed");
		assert.equal(terra?.contextWindow, 500_000);
		const minimax = models.getModel("foundry", "FW-MiniMax-M2.5");
		assert.equal(minimax?.api, "openai-completions");
		assert.equal(minimax?.reasoning, false);
		assert.deepEqual(minimax?.input, ["text"]);
		assert.equal((await models.getAuth("foundry"))?.auth.apiKey, "from-env");
		assert.equal((await models.getAuth("literal"))?.auth.apiKey, "sk-literal");
		delete process.env.CUA_BOT_TEST_KEY;
		assert.equal(await models.getAuth("foundry"), undefined, "unset variable leaves the provider unconfigured");
	} finally {
		delete process.env.CUA_BOT_TEST_KEY;
	}
});
