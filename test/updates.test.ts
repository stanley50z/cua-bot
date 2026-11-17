// Settings > General's Versions (src/updates.ts): which rows a check lists and when they're outdated, how cua and
// cua-bot's own updates start and finish, the Unix update script against a fake cua, and /api/versions.
// Run from the repo root:  node --test test/updates.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Space } from "../src/connections.ts";
import { createUpdates, isNewer, launchCommand, readLog, statusCommand, UNIX_SCRIPT, type UpdatesDeps } from "../src/updates.ts";
import { createBotServer } from "../src/web.ts";

const PC: Space = { id: "relay:pc", name: "Windows PC", os: "Windows 11 Pro", version: "0.10.1" };
const MAC: Space = { id: "direct:100.1.2.3:43141", name: "Mac mini", os: "macOS 26.7.2", version: "0.7.0" };
const SANDBOX: Space = { id: "local:linux-1", name: "sandbox", os: "Ubuntu", version: "0.5.0" };

// Deps for a computer cua-bot runs on (PC) with a Mac and a local sandbox. `logs` is each place's update log.
function fakeDeps(overrides: Partial<UpdatesDeps> = {}) {
	const ran: { where: string; command: string }[] = [];
	const logs = new Map<string, string>();
	const updated: string[][] = [];
	const deps: UpdatesDeps = {
		hereName: "pc-host",
		hereWindows: true,
		installed: (pkg) => ({ "@earendil-works/pi-durable": "1.5.2", "@trycua/cua": "0.9.0" })[pkg],
		latestPackage: async (pkg) => (pkg === "@trycua/cua" ? "0.28.1" : "1.5.2"),
		latestCua: async () => "0.28.1",
		spaces: async () => [PC, MAC, SANDBOX],
		isHere: async (id) => id === PC.id,
		localCua: async () => "0.10.1",
		run: async (where, command) => {
			const place = where === "here" ? "here" : where.id;
			ran.push({ where: place, command });
			return command === statusCommand(true) || command === statusCommand(false) ? (logs.get(place) ?? "") : "started";
		},
		dependencies: () => ["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@trycua/cua", "croner"],
		updatePackages: async (packages) => void updated.push(packages),
		now: () => 1000,
		...overrides,
	};
	return { deps, ran, logs, updated };
}

test("isNewer compares major.minor.patch and ignores prerelease tags", () => {
	assert.equal(isNewer("0.28.1", "0.9.0"), true);
	assert.equal(isNewer("0.10.1", "0.9.9"), true);
	assert.equal(isNewer("1.5.2", "1.5.2"), false);
	assert.equal(isNewer("1.5.2", "1.6.0"), false);
	assert.equal(isNewer("0.38.1-nightly.2026", "0.38.1"), false);
});

test("a check lists cua-bot's packages and cua on each computer with a Space, but not sandboxes", async () => {
	const { deps } = fakeDeps();
	const { rows, errors } = await createUpdates(deps).check();
	assert.deepEqual(errors, []);
	assert.deepEqual(
		rows.map((row) => [row.target, row.machine, row.here, row.what, row.installed, row.latest, row.outdated]),
		[
			["pi", "Windows PC", true, "Pi", "1.5.2", "1.5.2", false],
			["cua-sdk", "Windows PC", true, "cua SDK", "0.9.0", "0.28.1", true],
			["cua:here", "Windows PC", true, "cua", "0.10.1", "0.28.1", true],
			[`cua:${MAC.id}`, "Mac mini", false, "cua", "0.7.0", "0.28.1", true],
		],
	);
});

test("without a Space of its own, this computer's cua is the one on its PATH, and an unreachable release is reported", async () => {
	const { deps } = fakeDeps({ spaces: async () => [MAC], isHere: async () => false, localCua: async () => "0.27.0", latestCua: async () => { throw new Error("offline"); } });
	const { rows, errors } = await createUpdates(deps).check();
	assert.deepEqual(rows.find((row) => row.target === "cua:here"), { target: "cua:here", machine: "pc-host", here: true, what: "cua", installed: "0.27.0", outdated: false });
	assert.deepEqual(errors, ["Could not read the newest cua release: offline"]);
});

test("a cua update starts the script on that computer and finishes when its log says so", async () => {
	const { deps, ran, logs } = fakeDeps();
	const updates = createUpdates(deps);
	await updates.check();
	await updates.start([`cua:${MAC.id}`, "cua:here"]);
	assert.deepEqual(ran.filter((r) => r.command === launchCommand(false) || r.command === launchCommand(true)).map((r) => [r.where, r.command === launchCommand(true)]), [
		[MAC.id, false],
		["here", true],
	]);
	await assert.rejects(updates.start(["cua:here"]), /already updating/);

	logs.set(MAC.id, "cua-bot-update: started\ninstalling\n");
	let rows = (await updates.check()).rows;
	assert.equal(rows.find((row) => row.target === `cua:${MAC.id}`)?.job?.state, "running");

	logs.set(MAC.id, "cua-bot-update: started\ncua-bot-update: done (cua 0.28.1)\n");
	logs.set("here", "cua-bot-update: started\ncopy failed\r\ncua-bot-update: failed (cua host setup exited 1)\r\n");
	rows = (await updates.check()).rows;
	assert.deepEqual(rows.find((row) => row.target === `cua:${MAC.id}`)?.job, { state: "done", message: "cua 0.28.1", startedAt: 1000 });
	assert.deepEqual(rows.find((row) => row.target === "cua:here")?.job, { state: "failed", message: "cua-bot-update: started\ncopy failed\ncua host setup exited 1", startedAt: 1000 });
});

test("cua-bot's own packages update together, after the cua updates, and a failure is reported", async () => {
	const order: string[] = [];
	const { deps, updated } = fakeDeps({
		run: async (where) => {
			order.push(`run ${where === "here" ? "here" : where.id}`);
			return "started";
		},
		updatePackages: async (packages) => {
			order.push("packages");
			updated.push(packages);
		},
	});
	const updates = createUpdates(deps);
	await updates.check();
	await updates.start(["pi", "cua-sdk", `cua:${MAC.id}`]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(order.slice(order.indexOf(`run ${MAC.id}`)), [`run ${MAC.id}`, "packages"]);
	assert.deepEqual(updated, [["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@trycua/cua"]]);
	const rows = (await updates.check()).rows;
	assert.deepEqual(rows.find((row) => row.target === "pi")?.job, { state: "done", message: "Restarting cua-bot", startedAt: 1000 });

	const failing = createUpdates(fakeDeps({ updatePackages: async () => { throw new Error("tsc found 3 errors"); } }).deps);
	await failing.check();
	await failing.start(["cua-sdk"]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual((await failing.check()).rows.find((row) => row.target === "cua-sdk")?.job, { state: "failed", message: "tsc found 3 errors", startedAt: 1000 });
});

test("readLog waits for a done or failed line", () => {
	assert.equal(readLog(""), undefined);
	assert.equal(readLog("cua-bot-update: starting\n"), undefined);
	assert.deepEqual(readLog("x\ncua-bot-update: done (cua 0.28.1)"), { state: "done", message: "cua 0.28.1" });
});

// The real Unix script with a stub installer and a fake cua: it sets the host up again with its runner, name and
// direct address, and ends its log with done.
test("the Unix update script keeps a direct host's runner, name and address", { skip: !hasSh() && "no sh on PATH" }, async () => {
	const home = await mkdtemp(join(tmpdir(), "cua-bot-update-"));
	try {
		const bin = join(home, "stub-bin");
		mkdirSync(bin);
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		mkdirSync(join(home, ".cua", "host"), { recursive: true });
		// curl prints an installer that does nothing.
		writeFileSync(join(bin, "curl"), "#!/bin/sh\necho 'exit 0'\n");
		const cua = join(home, ".local", "bin", "cua");
		writeFileSync(cua, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'cua 0.28.1'; else for a in "$@"; do echo "$a"; done > "$HOME/args"; fi\n`);
		for (const file of [join(bin, "curl"), cua]) chmodSync(file, 0o755);
		writeFileSync(
			join(home, ".cua", "host", "config.json"),
			JSON.stringify({ mode: "direct", listen: "100.1.2.3:43141", name: "Mac mini (Tailscale)", runner: "launchd", sharing: true }, null, 2),
		);
		const script = join(home, "update.sh");
		writeFileSync(script, UNIX_SCRIPT);
		const path = `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`;
		execFileSync("sh", [script], { env: { ...process.env, HOME: home, PATH: path } });
		assert.deepEqual(readFileSync(join(home, "args"), "utf8").trim().split("\n"), ["host", "setup", "--runner", "launchd", "--name", "Mac mini (Tailscale)", "--direct", "100.1.2.3:43141"]);
		assert.deepEqual(readLog(readFileSync(join(home, ".cua", "cua-bot-update.log"), "utf8")), { state: "done", message: "cua 0.28.1" });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

function hasSh() {
	try {
		execFileSync("sh", ["-c", "exit 0"]);
		return true;
	} catch {
		return false;
	}
}

test("GET /api/versions checks and POST /api/versions/update starts updates", async () => {
	const { deps, updated } = fakeDeps();
	const logged: string[] = [];
	const server = createBotServer({ say: async () => "", context: BACKGROUND_CONTEXT, updates: createUpdates(deps), log: (line) => void logged.push(String(line)) });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}/api/versions`;
	const post = (body: unknown) => fetch(`${base}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	try {
		assert.equal((await (await fetch(base)).json()).rows.length, 4);
		assert.equal((await post({ targets: [] })).status, 400);
		assert.equal((await post({ targets: ["cua:nowhere"] })).status, 409);
		const started = await post({ targets: ["cua-sdk"] });
		assert.equal(started.status, 200);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(updated, [["@trycua/cua"]]);
		assert.deepEqual(logged, ["owner (web): started updating cua-sdk"]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
