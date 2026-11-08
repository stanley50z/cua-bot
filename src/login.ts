// One-time sign-in: `node src/login.ts openai` (Sign in with ChatGPT) or `node src/login.ts xai` (SuperGrok / X Premium,
// the default). Saves the credential to data/credentials.json for the bot. Stop the bot first; one process owns the file.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { CREDENTIAL_FILE, createSignInModels } from "./sign-in.ts";

const provider = process.argv[2] ?? "xai";
const models = createSignInModels();
const terminal = createInterface({ input: process.stdin, output: process.stdout });
await models.login(
	provider,
	"oauth",
	{
		prompt: async (prompt) => {
			// ChatGPT's browser sign-in returns on its own; pasting the final URL is for a browser on another computer.
			if (prompt.type === "manual_code") return terminal.question(`${prompt.message} `, prompt.signal === undefined ? {} : { signal: prompt.signal });
			throw new Error(`Unexpected login prompt: ${prompt.type}`);
		},
		notify: (event) => {
			if (event.type === "device_code") {
				console.log(`Open ${event.verificationUri} and enter code ${event.userCode}`);
				// Best-effort browser open; the URL above works too.
				if (process.platform === "win32") spawn("cmd", ["/c", "start", "", event.verificationUri], { stdio: "ignore", detached: true });
				else spawn(process.platform === "darwin" ? "open" : "xdg-open", [event.verificationUri], { stdio: "ignore", detached: true });
			} else if (event.type === "auth_url") console.log(`Open ${event.url}`);
			else if (event.type === "info") console.log(event.message);
		},
	},
	{ getDeviceId: randomUUID, agentName: "cua-bot" },
);
terminal.close();
console.log(`Signed in. Credential saved to ${CREDENTIAL_FILE}`);
