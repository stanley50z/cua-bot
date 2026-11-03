// The computer pane's shared live stream: one media session for every viewer, keyframe gating, closing
// when the last viewer leaves, and the owner's input over it. Exercised against a fake opener.
// Run from the repo root:  node --test test/live-screen.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveScreen, type InputEvent, type LiveFrame, type OpenLiveStream } from "../src/live-screen.ts";

type Sink = Parameters<OpenLiveStream>[0];

function fakeMac() {
	const mac = { opens: 0, closes: 0, keyframeRequests: 0, sinks: [] as Sink[], input: [] as InputEvent[][], fail: undefined as Error | undefined };
	const open: OpenLiveStream = async (sink) => {
		mac.opens++;
		if (mac.fail !== undefined) throw mac.fail;
		mac.sinks.push(sink);
		return {
			requestKeyframe: () => void mac.keyframeRequests++,
			input: (events) => void mac.input.push(events),
			close: async () => void mac.closes++,
		};
	};
	return { mac, open };
}

const key = (n: number): LiveFrame => ({ keyframe: true, data: new Uint8Array([n]) });
const delta = (n: number): LiveFrame => ({ keyframe: false, data: new Uint8Array([n]) });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("viewers share one session, a late joiner waits for a keyframe, and the last one out closes it", async () => {
	const { mac, open } = fakeMac();
	const live = createLiveScreen(open);
	const first: number[] = [];
	const second: number[] = [];
	const leaveFirst = live.subscribe((frame) => (first.push(frame.data[0]!), true), () => {});
	await settle();
	const sink = mac.sinks[0]!;
	sink.frame(key(1));
	sink.frame(delta(2));

	const leaveSecond = live.subscribe((frame) => (second.push(frame.data[0]!), true), () => {});
	assert.equal(mac.opens, 1);
	assert.equal(mac.keyframeRequests, 1);
	sink.frame(delta(3));
	sink.frame(key(4));
	sink.frame(delta(5));
	assert.deepEqual(first, [1, 2, 3, 4, 5]);
	assert.deepEqual(second, [4, 5]);

	leaveFirst();
	assert.equal(mac.closes, 0);
	leaveSecond();
	await settle();
	assert.equal(mac.closes, 1);
});

test("a viewer that falls behind skips to the next keyframe", async () => {
	const { mac, open } = fakeMac();
	const live = createLiveScreen(open);
	const got: number[] = [];
	let keepingUp = true;
	live.subscribe((frame) => (got.push(frame.data[0]!), keepingUp), () => {});
	await settle();
	const sink = mac.sinks[0]!;
	sink.frame(key(1));
	keepingUp = false;
	sink.frame(delta(2));
	keepingUp = true;
	sink.frame(delta(3));
	sink.frame(key(4));
	assert.deepEqual(got, [1, 2, 4]);
	assert.equal(mac.keyframeRequests, 1);
});

test("a failed open or a closed stream ends every viewer, and the next viewer opens a fresh session", async () => {
	const { mac, open } = fakeMac();
	const live = createLiveScreen(open);
	const ended: string[] = [];
	mac.fail = new Error("Mac unreachable");
	live.subscribe(() => true, (reason) => ended.push(reason));
	await settle();
	assert.deepEqual(ended, ["Mac unreachable"]);

	mac.fail = undefined;
	live.subscribe(() => true, (reason) => ended.push(reason));
	await settle();
	assert.equal(mac.opens, 2);
	mac.sinks[0]!.closed("socket closed");
	assert.deepEqual(ended, ["Mac unreachable", "socket closed"]);
});

test("a stale session's late close does not end the viewers of a newer one", async () => {
	const { mac, open } = fakeMac();
	const live = createLiveScreen(open);
	const leave = live.subscribe(() => true, () => {});
	await settle();
	leave();
	const ended: string[] = [];
	live.subscribe(() => true, (reason) => ended.push(reason));
	await settle();
	mac.sinks[0]!.closed("closed by client");
	assert.deepEqual(ended, []);
	assert.equal(mac.opens, 2);
});

test("input goes over the open session, and is refused until one is open", async () => {
	const { mac, open } = fakeMac();
	const live = createLiveScreen(open);
	const typed: InputEvent[] = [{ kind: "text_commit", text: "hi" }];
	assert.equal(live.input(typed), false);
	const leave = live.subscribe(() => true, () => {});
	assert.equal(live.watching(), 1);
	await settle();
	assert.equal(live.input(typed), true);
	assert.deepEqual(mac.input, [typed]);
	leave();
	assert.equal(live.watching(), 0);
	assert.equal(live.input(typed), false);
});
