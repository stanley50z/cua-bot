// One-time sign-in: `node src/login.ts`. Runs xAI's device-code flow with your SuperGrok / X Premium account
// and saves the credential to data/xai-credential.json for the bot. Stop the bot first; one process owns the file.
import { spawn } from "node:child_process";
import { CREDENTIAL_FILE, createXaiModels } from "./xai-auth.ts";

const models = createXaiModels();
await models.login("xai", "oauth", {
	prompt: async (prompt) => {
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
});
console.log(`Signed in. Credential saved to ${CREDENTIAL_FILE}`);
