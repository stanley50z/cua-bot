// Settings > Model: the model and reasoning effort every bot runs on unless its edit dialog overrides them (src/bots.ts).
// Both live in .env as CUABOT_MODEL and CUABOT_REASONING, so a hand edit and the web app change the same two lines.
// main.ts builds one with createModelSettings() and web.ts serves it at GET/PUT /api/model.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { botModel, botThinking, ModelsConfigError, parseThinkingLevel } from "./models.ts";

const ENV_FILE = join(import.meta.dirname, "..", ".env");

export type ModelSettings = ReturnType<typeof createModelSettings>;

/** `text` (a .env file) with each key's line replaced, or added at the end. Every other line stays as it was. */
export function withEnvValues(text: string, values: Record<string, string>): string {
	return Object.entries(values).reduce((env, [key, value]) => {
		const line = new RegExp(`^${key}=.*$`, "m");
		if (line.test(env)) return env.replace(line, () => `${key}=${value}`);
		return `${env}${env === "" || env.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
	}, text);
}

/** `apply` puts every bot on the current settings. `envFile` is for tests. */
export function createModelSettings(options: { models: Models; apply: () => Promise<void>; envFile?: string }) {
	const { models, apply, envFile = ENV_FILE } = options;

	/** The model named "provider/model". Throws ModelsConfigError unless it has a key or sign-in. */
	async function check(model: string) {
		const target = (await models.getAvailable()).find((choice) => `${choice.provider}/${choice.id}` === model);
		if (target === undefined) throw new ModelsConfigError(`${model} has no key or sign-in`);
		return target;
	}

	/** What Settings shows: the current pick, and every model with a key or sign-in with the efforts it supports. */
	async function state() {
		const { provider, modelId } = botModel();
		const model = `${provider}/${modelId}`;
		const current = models.getModel(provider, modelId);
		const thinkingLevel = current === undefined ? botThinking() : clampThinkingLevel(current, botThinking());
		const choices = (await models.getAvailable()).map((choice) => ({
			id: `${choice.provider}/${choice.id}`,
			provider: models.getProvider(choice.provider)?.name ?? choice.provider,
			name: choice.name,
			levels: getSupportedThinkingLevels(choice),
		}));
		// A model with no key or sign-in still shows, so the page says what the bots are set to.
		if (!choices.some((choice) => choice.id === model)) choices.unshift({ id: model, provider, name: modelId, levels: [thinkingLevel] });
		return { model, thinkingLevel, choices };
	}

	/** Saves the pick to .env and applies it without a restart. A model that can't take the effort gets its nearest. */
	async function set(model: string, level: string): Promise<Awaited<ReturnType<typeof state>>> {
		const thinkingLevel: ModelThinkingLevel = clampThinkingLevel(await check(model), parseThinkingLevel(level));
		const values = { CUABOT_MODEL: model, CUABOT_REASONING: thinkingLevel };
		writeFileSync(envFile, withEnvValues(existsSync(envFile) ? readFileSync(envFile, "utf8") : "", values));
		Object.assign(process.env, values);
		await apply();
		return state();
	}

	return { state, set, check };
}
