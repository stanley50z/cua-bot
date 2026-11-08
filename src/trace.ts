// Logs every tool call and result, so a demo can watch the bot and its computer-use child work.
// Installed in main.ts and selected again by the computer_use child conversation in computer.ts.
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { log } from "./log.ts";

const BOT_TOOLS = new Set(["computer_use", "tool_search", "schedule", "list_routines", "run_routine", "cancel_routine", "remember", "forget", "recall", "executor_search", "executor_describe", "executor_call"]);
const clip = (text: string) => (text.length > 140 ? `${text.slice(0, 140)}…` : text).replace(/\s+/g, " ");
// space_bash can be either caller, and the Spaces' driver tools belong to computer_use children; they log as the child.
const who = (name: string) => (BOT_TOOLS.has(name) || name.startsWith("cua_") ? "bot" : "  child");

export const traceExtension = defineExtension({
	name: "trace",
	hooks: [
		hook(ToolTask, {
			beforeTool: (call) => {
				log(`${who(call.name)} → ${call.name}`, clip(JSON.stringify(call.arguments)));
				return undefined;
			},
			afterTool: (call, result) => {
				const text = result.output?.flatMap((c) => (c.type === "text" ? [c.text] : ["[image]"])).join(" ") ?? "";
				log(`${who(call.name)} ← ${call.name}${result.isError ? " ERROR" : ""}`, clip(text));
				return undefined;
			},
		}),
	],
});
