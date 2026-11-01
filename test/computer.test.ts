// Arguments the bot sends to Cua driver tools. Run from the repo root:  node --test test/computer.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { shotArgs } from "../src/computer.ts";

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
