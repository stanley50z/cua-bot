// The live screen's SPS fix-up (src/h264.ts): the Mac's VUI-less SPS gains bitstream_restriction with no reordering,
// so Chrome's hardware decoder stops holding 4 frames back. The expected bytes were checked with ffmpeg's
// trace_headers (max_num_reorder_frames = 0, max_dec_frame_buffering = 1) and decode bit-identically to the original.
// Run from the repo root:  node --test test/h264.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { lowLatencyH264 } from "../src/h264.ts";

const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const START = "00000001";
// From cua-spacesd 0.7.0's macOS stream, 1920x1080 Constrained Baseline level 4.0, recorded 2026-11-24.
const MAC_SPS = "2742c028ab403c0113f2a0";
const MAC_PPS = "28ce3c80";
const PATCHED_SPS = "2742c028ab403c0113f2c03682211a80";
const SLICE = "2588840021ff";

test("a keyframe's VUI-less SPS gets a VUI that says no frame is reordered, and the rest stays byte for byte", () => {
	const keyframe = hex(START + MAC_SPS + START + MAC_PPS + "000001" + SLICE);
	assert.equal(Buffer.from(lowLatencyH264(keyframe)).toString("hex"), START + PATCHED_SPS + START + MAC_PPS + START + SLICE);
});

test("an SPS that already has a VUI, and a frame with no SPS, come back as the same array", () => {
	const withVui = hex(START + PATCHED_SPS + START + MAC_PPS);
	assert.equal(lowLatencyH264(withVui), withVui);
	const delta = hex(START + "2188840021ff");
	assert.equal(lowLatencyH264(delta), delta);
});

test("a truncated SPS is left alone", () => {
	const truncated = hex(START + MAC_SPS.slice(0, 8));
	assert.equal(lowLatencyH264(truncated), truncated);
});
