// The bot's tool_search: pi-durable's BM25 search over deferred tools (the Mac's driver tools and every cua_*
// tool), plus exact names. BM25 ranks a short name like cua_list_spaces below tools with longer descriptions
// that share its words, and the bot already sees the cua_* names in its prompt, so any deferred tool named
// word-for-word in the query is loaded first. Installed by main.ts in place of createToolSearchExtension().
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { createToolSearchTool, type ToolSearchToolDetails } from "@earendil-works/pi-durable/tool-search";

export function createBotToolSearchExtension(): Extension {
	const inner = createToolSearchTool();
	const tool = defineTool({
		...inner,
		description: `${inner.description}\n\nA deferred tool named exactly in the query (e.g. \`cua_list_spaces\`) is always loaded.`,
		execute: async (args, api, context) => {
			const deferred = new Set((await api.agent(context)).deferred.map((candidate) => candidate.name));
			const exact = [...new Set(args.query.split(/[\s,;`'"]+/).filter((word) => deferred.has(word)))];
			const result = await inner.execute(args, api, context);
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
