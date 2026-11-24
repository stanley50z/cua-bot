// Which Space the live screen shows and who drives it (src/screen-control.ts): the screen follows the Space a bot's
// task starts on, except while the owner has control, the owner shows any Space, and only the shown Space's steps
// wait for the owner.
// Run from the repo root:  node --test test/screen-control.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createScreenControl } from "../src/screen-control.ts";

test("the screen shows the default until a task starts elsewhere, and moves with each task", async () => {
	const shown: string[] = [];
	const control = createScreenControl({ space: () => "mac", shown: (space) => void shown.push(space) });
	assert.equal(control.space, "mac");

	await control.drive("mac", async () => {});
	assert.deepEqual(shown, [], "a task on the shown Space doesn't move it");

	const pc = Promise.withResolvers<void>();
	const running = control.drive("pc", () => pc.promise);
	assert.equal(control.space, "pc");
	assert.equal(control.driving, true);
	pc.resolve();
	await running;
	assert.equal(control.driving, false);
	assert.equal(control.space, "pc", "the screen stays on the Space the bot last drove");
	assert.deepEqual(shown, ["pc"]);
});

test("while the owner has control, a task elsewhere neither moves the screen nor waits", async () => {
	const control = createScreenControl({ space: () => "mac" });
	control.set(true);
	let macResumed = false;
	void control.botTurn("mac").then(() => (macResumed = true));
	await control.botTurn("pc");
	await control.drive("pc", async () => {
		assert.equal(control.space, "mac");
		assert.equal(control.driving, false, "the bot drives the PC, not the screen the owner holds");
	});
	assert.equal(macResumed, false);
	control.set(false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(macResumed, true);
});

test("the owner shows any Space, idle or not, handing back control, and the next task moves the screen again", async () => {
	const shown: string[] = [];
	const control = createScreenControl({ space: () => "mac", shown: (space) => void shown.push(space) });
	const mac = Promise.withResolvers<void>();
	const running = control.drive("mac", () => mac.promise);
	control.set(true);
	let macResumed = false;
	void control.botTurn("mac").then(() => (macResumed = true));

	control.show("pc");
	assert.equal(control.space, "pc");
	assert.equal(control.owner, false, "the owner takes control of the new Space themselves");
	assert.equal(control.driving, false, "the bot's task runs on the Mac, off screen");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(macResumed, true, "the Mac's waiting task resumes");
	assert.deepEqual(shown, ["pc"]);

	control.set(true);
	await control.botTurn("mac");
	control.set(false);
	mac.resolve();
	await running;
	await control.drive("mac", async () => assert.equal(control.space, "mac"));
	assert.deepEqual(shown, ["pc", "mac"]);
});
