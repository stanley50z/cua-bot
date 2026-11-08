// Arguments the bot sends to Cua driver tools, and how a `space` argument picks a Space. Run from the repo root:
// node --test test/computer.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { createComputerExtension, pickSpace, shotArgs } from "../src/computer.ts";

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

test("the main agent is offered space_bash and computer_use, both taking an optional space", () => {
	const tools = createComputerExtension(createRegistry()).tools ?? [];
	assert.deepEqual(tools.filter((tool) => tool.deferred !== true).map((tool) => tool.name), ["computer_use", "space_bash"]);
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
