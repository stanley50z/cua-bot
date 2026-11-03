// The PC the bot runs on, and code mode. Pi's coding tools (src/machines.ts) act on this PC through pcEnv when a
// call names no machine; the codemode tool runs a JavaScript script that calls any of the bot's tools. main.ts
// installs createPcExtensions() and passes pcEnv to Harness.open.
import { homedir } from "node:os";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defineExtension, type EnvTarget, section } from "@earendil-works/pi-durable";

/** Every tool call that names no machine works on this PC, starting in the owner's home folder. */
export const pcEnv = ({ cwd }: Pick<EnvTarget, "cwd">) => new NodeExecutionEnv({ cwd: cwd ?? homedir() });

const pcSection = defineExtension({
	name: "pc",
	sections: [
		section(
			"pc",
			() =>
				`Without \`machine\`, read, write, edit, and bash${process.platform === "win32" ? " (Git Bash), and powershell," : ""} act on the owner's PC, where cua-bot runs; paths start in ${homedir()}. space_bash and computer_use act on the Mac. Use codemode for many tool calls, loops, or work across machines.`,
			{ tag: false },
		),
	],
});

/** The section that says which machine the coding tools act on by default, and code mode. The sandbox closes with the process. */
export function createPcExtensions() {
	const codemode = createCodemodeExtension({
		sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }),
		namespaces: [{ name: "cua", description: "Cua Spaces: Spaces, sandboxes, files, apps, windows, sharing, volumes", prefix: "cua_" }],
	});
	return [pcSection, codemode];
}
