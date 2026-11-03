// Pi's coding tools on any machine the owner can reach with ssh. read, write, edit, bash (and powershell when cua-bot
// runs on Windows) take an optional `machine`: omitted, they act on the computer cua-bot runs on; otherwise it is an SSH
// destination, resolved by the owner's own ssh and ~/.ssh/config like `ssh <machine>`, and the call runs there through
// a pi-env daemon pi-env deploys on first use. cua-bot holds no machine names: the prompt section lists the Host
// aliases of the owner's ~/.ssh/config, re-read on every request, and the tool schemas never change.
// main.ts installs createMachines().extension and calls close() at shutdown. Nothing connects until a call names a
// machine, so one that is asleep fails only its own calls, and the next call tries again.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RemoteExecutionEnv, sshConnection } from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createBashTool, createEditTool, createPowerShellTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { defineExtension, section, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";

/** A destination `ssh` takes as its host argument (`alias` or `user@host`), never as an option. */
const DESTINATION = /^[^\s-][^\s]*$/;

/** A machine's environment, built when a call first names the machine. */
export type Machines = (machine: string) => Promise<ExecutionEnv>;

const MACHINE = {
	type: "string",
	description: "Which computer to act on: omit for the one cua-bot runs on, or an SSH destination as `ssh` takes it (a Host alias from the owner's SSH config, or user@host).",
};

/**
 * The tool with an optional `machine` argument: omitted, it runs as is; named, on that machine's environment.
 * Exported for test/machines.test.ts.
 */
export function withMachine(tool: ToolRegistration, machines: Machines): ToolRegistration {
	return {
		...tool,
		// Pi's coding tools all take an object of named arguments. Extending it as plain JSON Schema keeps its `required`
		// list, so its optional arguments stay optional and `machine` joins them.
		parameters: { ...tool.parameters, properties: { ...(tool.parameters as { properties: object }).properties, machine: MACHINE } },
		execute: async (args, api, context) => {
			const { machine, ...rest } = args as typeof args & { machine?: string };
			if (machine === undefined) return tool.execute(rest, api, context);
			if (!DESTINATION.test(machine)) throw new Error(`"${machine}" is not an SSH destination`);
			// The api is a plain object whose getters close over the call; only env changes.
			const remote: ToolExecutionApi = Object.create(api, { env: { value: await machines(machine) } });
			return tool.execute(rest, remote, context);
		},
	};
}

/**
 * The Host aliases of an ssh config, without patterns (`*`, `?`, `!`). Exported for test/machines.test.ts; the
 * section reads the owner's ~/.ssh/config (Include files are not followed).
 */
export function sshHosts(config: string): string[] {
	const hosts = [...config.matchAll(/^\s*Host\s+(.+)$/gim)].flatMap((match) => match[1]!.trim().split(/\s+/));
	return [...new Set(hosts.filter((host) => !/[*?!]/.test(host)))];
}

function ownerHosts(): string[] {
	try {
		return sshHosts(readFileSync(join(homedir(), ".ssh", "config"), "utf8"));
	} catch {
		return [];
	}
}

/**
 * The destination's host keys, already trusted in the owner's ~/.ssh/known_hosts, are stored under the host name
 * `ssh -G` resolves it to; pi-env checks strictly against that file and never writes to it.
 */
async function sshTarget(machine: string) {
	const { stdout } = await promisify(execFile)("ssh", ["-G", machine], { encoding: "utf8", timeout: 10_000, windowsHide: true });
	const hostname = /^hostname (\S+)$/m.exec(stdout)?.[1] ?? machine;
	return { host: machine, hostKeyAlias: hostname, knownHostsFile: join(homedir(), ".ssh", "known_hosts") };
}

/** One lazy connection per machine; its environment is built once the daemon reports the home folder. */
function machineEnv(machine: string) {
	let connection: ReturnType<typeof sshConnection>["connection"] | undefined;
	let env: Promise<ExecutionEnv> | undefined;
	const get = () => {
		env ??= (async () => {
			// A login shell, so commands see the PATH of ~/.zprofile and the like (Homebrew on a Mac).
			connection ??= sshConnection({ ...(await sshTarget(machine)), loginShell: true }).connection;
			const { home } = await connection.info();
			return new RemoteExecutionEnv({ connection, id: `pi-env:${machine}`, cwd: home });
		})().catch((error: unknown) => {
			env = undefined;
			throw error;
		});
		return env;
	};
	return { get, close: () => connection?.close() };
}

/**
 * Used by main.ts: the `coding-tools` extension (Pi's tools, each with `machine`) and a section naming the owner's
 * SSH hosts, and `close()`, which ends the SSH connections at shutdown.
 */
export function createMachines() {
	const envs = new Map<string, ReturnType<typeof machineEnv>>();
	const machines: Machines = (machine) => {
		let env = envs.get(machine);
		if (env === undefined) envs.set(machine, (env = machineEnv(machine)));
		return env.get();
	};
	const tools = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
	if (process.platform === "win32") tools.push(createPowerShellTool());
	const extension = defineExtension({
		name: "coding-tools",
		tools: tools.map((tool) => withMachine(tool, machines)),
		sections: [
			section(
				"machines",
				() => {
					const hosts = ownerHosts();
					return `To act on another machine, pass an SSH destination as \`machine\` to read, write, edit, or bash; it resolves like \`ssh <machine>\` with the owner's SSH config${hosts.length === 0 ? "" : `, whose hosts are ${hosts.join(", ")}`}. Paths then start in that machine's home folder, and bash on Windows runs Git Bash. A machine that is asleep, offline, or not yet trusted in ~/.ssh/known_hosts fails the call; say so instead of retrying in a loop.`;
				},
				{ tag: false },
			),
		],
	});
	return { extension, close: () => envs.forEach((env) => env.close()) };
}
