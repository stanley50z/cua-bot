// The bot's model. By default it is a model deployed on the owner's Azure AI Foundry resource, reached
// over Foundry's OpenAI-compatible endpoint (AZURE_FOUNDRY_BASE_URL, e.g.
// https://<resource>.services.ai.azure.com/openai/v1) with AZURE_FOUNDRY_API_KEY. Either may live in the
// user's environment instead of .env. main.ts, computer.ts (the computer-use child), and preflight.ts all
// use MODEL and createBotModels(). The xAI provider stays registered for GROKBOT_PROVIDER=xai.
import { type Api, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createXaiModels } from "./xai-auth.ts";

export const MODEL = {
	provider: process.env.GROKBOT_PROVIDER || "azure-foundry",
	modelId: process.env.GROKBOT_MODEL || "grok-4.6",
} as const;

const low = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } as const;

// The deployments on the owner's Foundry resource. The id is the deployment name.
const FOUNDRY_MODELS: Omit<Model<Api>, "provider" | "baseUrl">[] = [
	{
		id: "grok-4.6",
		name: "Grok 4.6 (Azure Foundry)",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: low,
		input: ["text", "image"],
		contextWindow: 500_000,
		maxTokens: 500_000,
		cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6 Astra (Azure Foundry)",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...low, xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	},
	{
		id: "GLM-5.3-Flash",
		name: "GLM-5.3-Flash (Azure Foundry)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: low,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
	},
	{
		id: "FW-Kimi-K3",
		name: "Kimi K3 (Azure Foundry)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { max: "max" },
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		cost: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 0 },
	},
];

/** Azure AI Foundry as a pi-ai provider. Unconfigured (and skipped by Models) without a key. */
export function azureFoundryProvider(baseUrl: string) {
	const models: Model<Api>[] = FOUNDRY_MODELS.map((model) => ({ ...model, provider: "azure-foundry", baseUrl }));
	return createProvider<Api>({
		id: "azure-foundry",
		name: "Azure AI Foundry",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Azure Foundry API key", ["AZURE_FOUNDRY_API_KEY"]) },
		models,
		api: { "openai-responses": openAIResponsesApi(), "openai-completions": openAICompletionsApi() },
	});
}

/** Every provider the bot can use: xAI always, Azure Foundry when AZURE_FOUNDRY_BASE_URL is set. */
export function createBotModels() {
	const models = createXaiModels();
	const baseUrl = process.env.AZURE_FOUNDRY_BASE_URL?.trim();
	if (baseUrl) models.setProvider(azureFoundryProvider(baseUrl.replace(/\/+$/, "")));
	return models;
}
