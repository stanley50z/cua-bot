// Subscription sign-ins pi-ai ships: SuperGrok / X Premium for xAI and Sign in with ChatGPT for OpenAI, stored in
// data/credentials.json. `node src/login.ts <provider>` signs in once; main.ts calls createBotModels() and pi-ai
// refreshes the token inside modify(). XAI_API_KEY and OPENAI_API_KEY still work when nothing is stored.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AuthOperationOptions,
	type Credential,
	type CredentialStore,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

export const CREDENTIAL_FILE = join(import.meta.dirname, "..", "data", "credentials.json");
const LEGACY_CREDENTIAL_FILE = join(dirname(CREDENTIAL_FILE), "xai-credential.json");

// A CredentialStore that keeps credentials in memory and writes the whole map to one JSON file after every
// change. One process owns the file (the bot or the login script), so no cross-process lock is needed.
class FileCredentialStore implements CredentialStore {
	#memory = new InMemoryCredentialStore();
	#path: string;
	#ready: Promise<void>;

	constructor(path: string) {
		this.#path = path;
		const saved: Record<string, Credential> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
		this.#ready = Promise.all(
			Object.entries(saved).map(([id, credential]) => this.#memory.modify(id, async () => credential)),
		).then(() => {});
	}

	async read(providerId: string, options?: AuthOperationOptions) {
		await this.#ready;
		return this.#memory.read(providerId, options);
	}

	async list(options?: AuthOperationOptions) {
		await this.#ready;
		return this.#memory.list(options);
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	) {
		await this.#ready;
		const next = await this.#memory.modify(providerId, fn, options);
		await this.#save();
		return next;
	}

	async delete(providerId: string, options?: AuthOperationOptions) {
		await this.#ready;
		await this.#memory.delete(providerId, options);
		await this.#save();
	}

	async #save() {
		const all: Record<string, Credential> = {};
		for (const { providerId } of await this.#memory.list()) {
			const credential = await this.#memory.read(providerId);
			if (credential) all[providerId] = credential;
		}
		mkdirSync(dirname(this.#path), { recursive: true });
		writeFileSync(this.#path, JSON.stringify(all, null, 2), { mode: 0o600 });
	}
}

// A Models collection with the sign-in providers over the file-backed store. src/models.ts adds the bot's other
// providers; login.ts uses it alone.
export function createSignInModels() {
	if (existsSync(LEGACY_CREDENTIAL_FILE) && !existsSync(CREDENTIAL_FILE)) renameSync(LEGACY_CREDENTIAL_FILE, CREDENTIAL_FILE);
	const models = createModels({ credentials: new FileCredentialStore(CREDENTIAL_FILE) });
	models.setProvider(xaiProvider());
	models.setProvider(openaiProvider());
	return models;
}
