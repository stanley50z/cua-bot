// The persona's date line. Run from the repo root:  node --test test/today.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { today } from "../src/today.ts";

test("today uses the owner's local date, not UTC", () => {
	// 8:04 PM Eastern on Oct 31 is already Nov 1 in UTC.
	assert.equal(
		today(new Date("2026-11-01T00:04:00Z"), "America/New_York"),
		"Today is Saturday, October 31, 2026, in the owner's time zone (America/New_York).",
	);
});
