// The Connections tab's check (src/connections.ts): SSH aliases of one machine merge, an alias that points at this
// computer joins it, each Space lands under the computer that provides it, and Cua failing falls back to the registry.
// Run from the repo root:  node --test test/connections.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConnectionsDeps, createConnections, parseSpaces, probeTcp } from "../src/connections.ts";

const HERE = { name: "desk", os: "Windows 11 Pro", user: "me", addresses: ["127.0.0.1", "100.1.1.1"], pid: 42, startedAt: 1, database: "C:/db.sqlite" };
const TARGETS: Record<string, { address: string; port: number; user?: string }> = {
	mac: { address: "100.2.2.2", port: 22, user: "sid" },
	razor: { address: "100.3.3.3", port: 22, user: "me" },
	overpricedrazor: { address: "100.3.3.3", port: 22, user: "me" },
	self: { address: "100.1.1.1", port: 22 },
	gone: { address: "gone.example", port: 2222 },
};

function deps(overrides: Partial<ConnectionsDeps> = {}): ConnectionsDeps {
	return {
		here: HERE,
		hosts: () => Object.keys(TARGETS),
		resolve: async (alias) => TARGETS[alias]!,
		probe: async (address) => address !== "gone.example",
		spaces: async () => [
			{ id: "direct:100.2.2.2:43141", name: "Mac mini", phase: "ready" },
			{ id: "local:sandbox", name: "Sandbox" },
			{ id: "relay:abc", name: "Razor's", hostName: "razor" },
			{ id: "cloud:box", name: "Cloud box" },
		],
		fallback: () => [],
		pairedSpace: "direct:100.2.2.2:43141",
		now: () => 7,
		...overrides,
	};
}

test("machines merge by target, this computer keeps its aliases, and Spaces sit under their computer", async () => {
	const snapshot = await createConnections(deps())();
	assert.deepEqual(snapshot.here.aliases, ["self"]);
	assert.equal("addresses" in snapshot.here, false);
	assert.deepEqual(snapshot.here.spaces.map((s) => s.id), ["local:sandbox"]);
	assert.deepEqual(
		snapshot.machines.map((m) => [m.aliases, m.online, m.spaces.map((s) => [s.id, s.paired])]),
		[
			[["mac"], true, [["direct:100.2.2.2:43141", true]]],
			[["razor", "overpricedrazor"], true, [["relay:abc", false]]],
			[["gone"], false, []],
		],
	);
	assert.deepEqual(snapshot.otherSpaces.map((s) => s.id), ["cloud:box"]);
	assert.equal(snapshot.spacesError, undefined);
	assert.equal(snapshot.checkedAt, 7);
});

test("when Cua can't list its Spaces, the registry's show with the reason", async () => {
	const snapshot = await createConnections(
		deps({
			spaces: async () => {
				throw new Error("cua mcp did not start");
			},
			fallback: () => [{ id: "direct:100.2.2.2:43141", name: "Mac mini" }],
		}),
	)();
	assert.equal(snapshot.spacesError, "cua mcp did not start");
	assert.deepEqual(snapshot.machines[0]?.spaces.map((s) => s.name), ["Mac mini"]);
});

test("list_spaces records keep their display fields; records without an id are dropped", () => {
	assert.deepEqual(
		parseSpaces([
			{ id: "direct:h:1", name: "Mac", os: "macos", os_pretty_name: "macOS 26", phase: "ready", spacesd_version: "0.7.0", host_name: "" },
			{ name: "no id" },
		]),
		[{ id: "direct:h:1", name: "Mac", os: "macOS 26", phase: "ready", version: "0.7.0" }],
	);
	assert.throws(() => parseSpaces({}), /not return a list/);
});

test("the probe reports a closed port as not answering", async () => {
	assert.equal(await probeTcp("127.0.0.1", 1, 1000), false);
});
