// The bot's tool_search (src/tool-search.ts) never offers a Space's driver tools: they belong to that Space's
// computer_use child. Run from the repo root:  node --test test/tool-search.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Agent, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { SPACE_EXTENSION } from "../src/computer.ts";
import { withoutDriverTools } from "../src/tool-search.ts";

const deferred = (name: string) =>
	defineTool({ name, description: name, parameters: Type.Object({}), deferred: true, execute: async () => ({ output: [] }) });

test("the Spaces' driver tools are left out of the deferred tools tool_search sees", () => {
	const cua = defineExtension({ name: "cua", tools: [deferred("cua_list_spaces"), deferred("cua_upload")] });
	const mac = defineExtension({ name: `${SPACE_EXTENSION}direct:mac`, tools: [deferred("click"), deferred("get_desktop_state")] });
	const pc = defineExtension({ name: `${SPACE_EXTENSION}relay:pc`, tools: [deferred("click"), deferred("get_window_state")] });
	const agent = { extensions: [cua, mac, pc], deferred: [...cua.tools!, mac.tools![1]!, ...pc.tools!] } as unknown as Agent;
	assert.deepEqual(withoutDriverTools(agent).deferred.map((tool) => tool.name), ["cua_list_spaces", "cua_upload"]);
});
