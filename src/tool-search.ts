// The bot's tool_search: pi-durable's BM25 search over deferred tools (every cua_* tool), plus exact names. BM25 ranks
// a short name like cua_list_spaces below tools with longer descriptions that share its words, and the bot already
// sees the cua_* names in its prompt, so any deferred tool named word-for-word in the query is loaded first. Each
// Space's driver tools (src/computer.ts) are deferred too, but they belong to that Space's computer_use child, so the
// search never sees them. Installed by main.ts in place of createToolSearchExtension().
import { type Agent, defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createToolSearchTool, type ToolSearchToolDetails } from "@earendil-works/pi-durable/tool-search";
import { SPACE_EXTENSION } from "./computer.ts";

/** The agent without the Spaces' driver tools among its deferred ones. Exported for test/tool-search.test.ts. */
export function withoutDriverTools(agent: Agent): Agent {
	const driver = new Set(
		agent.extensions.filter((extension) => extension.name.startsWith(SPACE_EXTENSION)).flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
	);
	return { ...agent, deferred: agent.deferred.filter((tool) => !driver.has(tool.name)) };
}

export function createBotToolSearchExtension(): Extension {
	const inner = createToolSearchTool();
	const tool = defineTool({
		...inner,
		description: `${inner.description}\n\nA deferred tool named exactly in the query (e.g. \`cua_list_spaces\`) is always loaded.`,
		execute: async (args, api, context) => {
			const agent = withoutDriverTools(await api.agent(context));
			// The api is a plain object whose getters close over the call; only agent changes.
			const scoped: ToolExecutionApi = Object.create(api, { agent: { value: async () => agent } });
			const deferred = new Set(agent.deferred.map((candidate) => candidate.name));
			const exact = [...new Set(args.query.split(/[\s,;`'"]+/).filter((word) => deferred.has(word)))];
			const result = await inner.execute(args, scoped, context);
			if (exact.length === 0) return result;
			const searched = (result.details as ToolSearchToolDetails | undefined)?.loaded ?? [];
			const loaded = [...new Set([...exact, ...searched])];
			const text = result.output?.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "";
			return {
				output: [{ type: "text", text: `Loaded by exact name: ${exact.join(", ")}.\n${text}` }],
				details: { loaded },
				control: { addTools: loaded },
			};
		},
	});
	return defineExtension({ name: "tool-search", tools: [tool] });
}
