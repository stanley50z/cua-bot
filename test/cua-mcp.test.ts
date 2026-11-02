// Cua's MCP server tools (src/cua-mcp.ts) against a fake server: every tool becomes a deferred cua_<name>,
// tool_search loads it (by exact name too), calls reach the server under the tool's own name, and a
// notify_user that went through is reported for the owner's push notification.
// Run from the repo root:  node --test test/cua-mcp.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createCuaExtension } from "../src/cua-mcp.ts";
import { createBotToolSearchExtension } from "../src/tool-search.ts";
import { fakeExecutor, textResult } from "./fake-executor.ts";

const context = BACKGROUND_CONTEXT;
const TOOLS = [
	{ name: "space_bash", description: "Run a shell command in a Space.", inputSchema: { type: "object" as const, properties: { space: { type: "string" }, command: { type: "string" } } } },
	{ name: "upload", description: "Copy a host file into a Space.", inputSchema: { type: "object" as const, properties: { space: { type: "string" }, path: { type: "string" } } } },
	{ name: "notify_user", description: "Tell the user something in the Cua app.", inputSchema: { type: "object" as const, properties: { title: { type: "string" }, body: { type: "string" } } } },
];

test("every Cua tool is deferred as cua_<name>, and tool_search loads it for the bot", { timeout: 20_000 }, async () => {
	const fake = fakeExecutor(({ args }) => textResult(`ran ${String(args.command)}`), TOOLS);
	const notified: unknown[] = [];
	const extension = await createCuaExtension(fake.connect, { pairedSpace: "direct:mac", notified: (note) => notified.push(note) });
	assert.deepEqual(
		(extension.tools ?? []).map((tool) => [tool.name, tool.deferred]),
		[["cua_space_bash", true], ["cua_upload", true], ["cua_notify_user", true]],
	);

	let results: ToolResultMessage[] = [];
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const step = (next: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory => (request) => {
		results = request.messages.filter((message: Message): message is ToolResultMessage => message.role === "toolResult");
		return next;
	};
	faux.setResponses([
		step(fauxAssistantMessage([fauxToolCall("cua_space_bash", { space: "direct:mac", command: "early" }, { id: "early" })], { stopReason: "toolUse" })),
		step(fauxAssistantMessage([fauxToolCall("tool_search", { query: "cua_space_bash, cua_notify_user to upload a host file", limit: 1 }, { id: "s" })], { stopReason: "toolUse" })),
		step(fauxAssistantMessage([fauxToolCall("cua_space_bash", { space: "direct:mac", command: "uname" }, { id: "b" })], { stopReason: "toolUse" })),
		step(fauxAssistantMessage([fauxToolCall("cua_notify_user", { title: "Mac checked", body: "Darwin" }, { id: "n" })], { stopReason: "toolUse" })),
		step(fauxAssistantMessage([fauxText("done")])),
	]);
	const registry = createRegistry();
	registry.install(extension);
	registry.install(createBotToolSearchExtension());
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		assert.equal(settled.status, "done");
	} finally {
		await harness.close(context);
	}

	assert.equal(results.find((message) => message.toolCallId === "early")?.isError, true, "not callable before tool_search");
	assert.deepEqual(fake.calls, [
		{ name: "space_bash", args: { space: "direct:mac", command: "uname" } },
		{ name: "notify_user", args: { title: "Mac checked", body: "Darwin" } },
	]);
	assert.deepEqual(notified, [{ title: "Mac checked", body: "Darwin" }]);
	const bash = results.find((message) => message.toolCallId === "b");
	assert.equal(bash?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""), "ran uname");
});
