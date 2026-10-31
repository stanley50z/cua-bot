// The bot's models, defined the way Pi's ~/.pi/agent/models.json defines custom providers: models.json in
// the project root lists providers, each an endpoint (baseUrl), an API ("openai-responses" or
// "openai-completions", also settable per model), an apiKey, and the models it serves; "default" names
// the model the bot and its computer-use child run on, as "provider/model". apiKey is either the key or
// "$NAME" to read environment variable NAME, so keys can stay in .env or the user's environment.
// CUABOT_MODEL ("provider/model") overrides the default. pi-ai's xAI provider stays registered too.
// main.ts and preflight.ts call createBotModels() and botModel(); computer.ts calls botModel().
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, type ApiKeyAuth, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import { createXaiModels } from "./xai-auth.ts";

export const MODELS_FILE = join(import.meta.dirname, "..", "models.json");

const APIS = ["openai-responses", "openai-completions"] as const;
type ConfigApi = (typeof APIS)[number];

type ModelConfig = Partial<Omit<Model<Api>, "id" | "api" | "provider" | "baseUrl">> & { id: string; api?: ConfigApi };
type ProviderConfig = { name?: string; baseUrl: string; api?: ConfigApi; apiKey: string; headers?: Record<string, string>; models: ModelConfig[] };
export type ModelsConfig = { default: string; providers: Record<string, ProviderConfig> };

export class ModelsConfigError extends Error {}

const isApi = (value: unknown): value is ConfigApi => APIS.includes(value as ConfigApi);

/** Read and check models.json. Throws ModelsConfigError naming the problem. */
export function readModelsConfig(file = MODELS_FILE): ModelsConfig {
	let config: ModelsConfig;
	try {
		config = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as ModelsConfig;
	} catch (error) {
		throw new ModelsConfigError(`Can't read ${file}: ${error instanceof Error ? error.message : String(error)}. Copy models.example.json to models.json.`);
	}
	const fail = (problem: string) => {
		throw new ModelsConfigError(`${file}: ${problem}`);
	};
	if (typeof config?.providers !== "object" || config.providers === null) fail("needs a providers object");
	for (const [id, provider] of Object.entries(config.providers)) {
		if (typeof provider.baseUrl !== "string" || provider.baseUrl === "") fail(`provider ${id} needs a baseUrl`);
		if (typeof provider.apiKey !== "string" || provider.apiKey === "") fail(`provider ${id} needs an apiKey (the key, or "$ENV_VAR")`);
		if (provider.api !== undefined && !isApi(provider.api)) fail(`provider ${id}: api must be one of ${APIS.join(", ")}`);
		if (!Array.isArray(provider.models) || provider.models.length === 0) fail(`provider ${id} needs at least one model`);
		for (const model of provider.models) {
			if (typeof model.id !== "string" || model.id === "") fail(`provider ${id} has a model without an id`);
			if (model.api !== undefined && !isApi(model.api)) fail(`model ${id}/${model.id}: api must be one of ${APIS.join(", ")}`);
		}
	}
	if (typeof config.default !== "string" || !config.default.includes("/")) fail('needs "default" as "provider/model"');
	return config;
}

/** "provider/model" to a model reference. Model ids may contain "/", so only the first one splits. */
export function parseModelRef(text: string): ModelRef {
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) throw new ModelsConfigError(`"${text}" is not "provider/model"`);
	return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

// "$NAME" reads environment variable NAME; anything else is the key itself.
function apiKeyAuth(providerId: string, apiKey: string): ApiKeyAuth {
	if (apiKey.startsWith("$")) return envApiKeyAuth(`${providerId} API key`, [apiKey.slice(1)]);
	return { name: `${providerId} API key`, resolve: async () => ({ auth: { apiKey }, source: "models.json" }) };
}

/** One configured provider as a pi-ai provider. Missing model fields get conservative defaults. */
export function providerFromConfig(id: string, config: ProviderConfig) {
	const baseUrl = config.baseUrl.replace(/\/+$/, "");
	const models: Model<Api>[] = config.models.map((model) => ({
		name: model.id,
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...model,
		api: model.api ?? config.api ?? "openai-responses",
		provider: id,
		baseUrl,
	}));
	return createProvider<Api>({
		id,
		name: config.name ?? id,
		baseUrl,
		...(config.headers === undefined ? {} : { headers: config.headers }),
		auth: { apiKey: apiKeyAuth(id, config.apiKey) },
		models,
		api: { "openai-responses": openAIResponsesApi(), "openai-completions": openAICompletionsApi() },
	});
}

let cached: ModelsConfig | undefined;
const config = () => (cached ??= readModelsConfig());

/** The model the bot and its computer-use child run on. */
export function botModel(): ModelRef {
	return parseModelRef(process.env.CUABOT_MODEL?.trim() || config().default);
}

/** Every provider the bot can use: xAI, plus each provider in models.json. */
export function createBotModels() {
	const models = createXaiModels();
	for (const [id, provider] of Object.entries(config().providers)) models.setProvider(providerFromConfig(id, provider));
	return models;
}
