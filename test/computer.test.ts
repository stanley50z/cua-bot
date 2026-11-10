// Arguments the bot sends to Cua driver tools, how a `space` argument picks a Space, and space_read. Run from the repo root:
// node --test test/computer.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, type Extension, Harness, type JsonObject, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { createComputerExtension, pickSpace, readFromSpace, shotArgs } from "../src/computer.ts";

const desktopState = {
	type: "object",
	properties: { max_image_dimension: { type: "integer" }, screenshot_out_file: { type: "string" } },
};

test("shotArgs caps the screenshot edge when the model leaves it unset", () => {
	assert.deepEqual(shotArgs(desktopState, {}), { max_image_dimension: 1200 });
});

test("shotArgs keeps screenshots inline so the child sees them and the host saves a copy", () => {
	// gpt-6.1-terra asked for a file on the Mac, which returns no image at all.
	assert.deepEqual(shotArgs(desktopState, { max_image_dimension: 0, screenshot_out_file: "/tmp/shot.png" }), { max_image_dimension: 0 });
});

test("the main agent is offered computer_use, space_bash and space_read, each taking an optional space", () => {
	const tools = createComputerExtension(createRegistry()).tools ?? [];
	assert.deepEqual(tools.filter((tool) => tool.deferred !== true).map((tool) => tool.name), ["computer_use", "space_bash", "space_read"]);
	for (const tool of tools) {
		const schema = tool.parameters as { properties: object; required?: string[] };
		assert.ok("space" in schema.properties);
		assert.equal(schema.required?.includes("space"), false);
	}
});

const SPACES = [
	{ id: "direct:100.2.2.2:43141", name: "Mac mini (Tailscale)", os: "macOS 26.7.2" },
	{ id: "relay:abc", name: "stanley50z(Windows PC)", os: "Windows 11 Pro" },
	{ id: "cloud:twin-a", name: "Twin" },
	{ id: "cloud:twin-b", name: "Twin" },
];

test("a Space is named by its Cua name in any case, or by its id; without one, the default", () => {
	assert.equal(pickSpace(SPACES, "stanley50z(windows pc)", SPACES[0]!.id).id, "relay:abc");
	assert.equal(pickSpace(SPACES, " relay:abc ", SPACES[0]!.id).id, "relay:abc");
	assert.equal(pickSpace(SPACES, undefined, SPACES[0]!.id).id, "direct:100.2.2.2:43141");
	assert.equal(pickSpace(SPACES, "", SPACES[0]!.id).id, "direct:100.2.2.2:43141");
});

test("an unknown or shared name fails with the Spaces to choose from", () => {
	assert.throws(() => pickSpace(SPACES, "razor", SPACES[0]!.id), /No Cua Space "razor"\. Spaces: "Mac mini \(Tailscale\)" \(macOS 26\.7\.2, id direct:/);
	assert.throws(() => pickSpace(SPACES, "twin", undefined), /2 Spaces are named "twin"; pass an id instead/);
	assert.equal(pickSpace(SPACES, "cloud:twin-b", undefined).id, "cloud:twin-b");
});

test("a default Cua doesn't list is still tried; no default at all is an error", () => {
	assert.deepEqual(pickSpace(SPACES, undefined, "relay:unlisted"), { id: "relay:unlisted" });
	assert.throws(() => pickSpace([], undefined, undefined), /No Cua Space to use/);
});

// A 1x1 PNG.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** One turn on a vision model: it calls `tool` with `args`; returns the tool result's content as the model then got it. */
async function callOnce(extension: Extension, tool: string, args: JsonObject) {
	let seen: Message | undefined;
	const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text", "image"] }] });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall(tool, args, { id: "c1" })], { stopReason: "toolUse" }),
		(request) => {
			seen = request.messages.findLast((m) => m.role === "toolResult");
			return fauxAssistantMessage([fauxText("Done.")]);
		},
	]);
	const registry = createRegistry();
	registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd: tmpdir() }) }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		assert.equal((await (await root.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
		return seen?.role === "toolResult" ? seen.content : [];
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

test("space_read is Pi's read on a copy of the Space's file, so the model sees an image instead of opening it in an app", async () => {
	// The computer_use child used to open PNGs in Paint or Photos to see them, having no tool that reads a file.
	const guest = await mkdtemp(join(tmpdir(), "cua-bot-guest-"));
	try {
		await writeFile(join(guest, "shot.png"), PIXEL);
		await writeFile(join(guest, "notes.md"), "# Shortlist\n");
		const calls: { path: string; space?: string }[] = [];
		const copies: string[] = [];
		const read = readFromSpace(createReadTool(), async (file, dir) => {
			calls.push(file);
			const copy = join(dir, basename(file.path));
			await copyFile(join(guest, basename(file.path)), copy);
			copies.push(copy);
			return copy;
		});
		const extension = defineExtension({ name: "space-read", tools: [read] });

		const image = await callOnce(extension, "space_read", { path: "C:/Users/me/shot.png", space: "Mac mini" });
		const block = image.find((part) => part.type === "image");
		assert.ok(block?.type === "image", "the model gets the image itself");
		assert.equal(block.mimeType, "image/png");
		assert.deepEqual(Buffer.from(block.data, "base64"), PIXEL);

		const text = await callOnce(extension, "space_read", { path: "/home/me/notes.md" });
		assert.match(text.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""), /# Shortlist/);

		assert.deepEqual(calls, [{ path: "C:/Users/me/shot.png", space: "Mac mini" }, { path: "/home/me/notes.md" }]);
		for (const copy of copies) assert.equal(existsSync(copy), false, "the downloaded copy is removed after the read");
	} finally {
		await rm(guest, { recursive: true, force: true });
	}
});
