// Every Cua Spaces tool for the bot. main.ts launches the cua CLI's MCP server (`cua mcp`, the same server
// Claude Code uses) over stdio with createCuaExtension(connectCua(command)), and each of its tools becomes a deferred tool named
// cua_<name>: Spaces, sandboxes, files in and out, apps and windows, coding agents in a Space, teleport,
// hotspot, sharing, volumes. Deferred tools are not offered until the bot loads them with tool_search, so the
// ~150 schemas cost nothing on turns that don't use them. Calls go through the same reconnecting MCP session
// as Executor (createExecutor), so a crashed `cua mcp` is relaunched on the next call.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { createExecutor, type Executor } from "./executor.ts";

const PREFIX = "cua_";
// Creating a Space or starting an agent can take minutes.
const REQUEST_TIMEOUT_MS = 10 * 60_000;
// Cua tools the bots don't get, for now. notify_user: bots reach the owner only with send_message (owner's call, 2026-11-02).
const DISABLED = new Set(["notify_user"]);

/** The Cua Spaces app's bundled CLI on Windows, else `cua` on PATH. CUA_MCP_COMMAND overrides both (see main.ts). */
export function defaultCuaCommand(): string {
	const bundled = join(process.env.LOCALAPPDATA ?? "", "Programs", "cua-spaces", "resources", "native", "cua.exe");
	return process.platform === "win32" && existsSync(bundled) ? bundled : "cua";
}

/** Starts `command mcp` and opens an MCP session to it over stdio. */
export const connectCua = (command: string) => async () => {
	const client = new McpClient({ name: "cua-bot", version: "0.1.0", requestTimeoutMs: REQUEST_TIMEOUT_MS });
	await client.connect(new StdioTransport({ command, args: ["mcp"] }));
	return client;
};

/**
 * Used by main.ts at startup. Lists the server's tools once; throws when the server can't start or answer. Tool calls
 * go through `call`, a session main.ts shares with the web portal's Connections tab; without it, one of its own.
 */
export async function createCuaExtension(
	connect: () => Promise<McpClient>,
	options: { defaultSpace?: string; call?: Executor } = {},
): Promise<Extension> {
	const { defaultSpace, call = createExecutor(connect) } = options;
	const first = await connect();
	const listed = (await first.listTools()).filter((tool) => !DISABLED.has(tool.name));
	const instructions = first.instructions ?? "";
	await first.close();

	const tools = listed.map((tool) =>
		defineTool({
			name: `${PREFIX}${tool.name}`,
			description: tool.description ?? `Cua tool ${tool.name}`,
			parameters: Type.Unsafe<Record<string, unknown>>({ ...tool.inputSchema, type: "object" }),
			deferred: true,
			outputLimits: { maxBytes: 256 * 1024, maxLines: 4000, retain: "tail" },
			execute: async (args, _api, context) => {
				const result = await call(tool.name, args, context.abortSignal);
				const output = toLlmContent(result);
				if (output.length === 0) output.push({ type: "text", text: "(no output)" });
				return { output, isError: result.isError === true };
			},
		}),
	);

	return defineExtension({
		name: "cua",
		tools,
		sections: [
			section("cua", () =>
				[
					`Cua Spaces: every tool of Cua's MCP server is yours as ${PREFIX}<name>. They are loaded on demand: call tool_search with what you need (e.g. "upload a file to a space", "start a coding agent in a space") and the matches are offered from then on.`,
					defaultSpace === undefined ? "" : `Where a tool asks for a space, pass the id of the Space the work is on; the default Space is ${defaultSpace}.`,
					`Available: ${listed.map((tool) => tool.name).join(", ")}.`,
					instructions,
				]
					.filter((line) => line !== "")
					.join("\n"),
			),
		],
	});
}
