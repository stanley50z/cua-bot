// Start at sign-in (src/autostart.ts) on each OS: Windows writes and removes an HKCU Run value through reg.exe,
// macOS a LaunchAgent, Linux an XDG autostart entry; any other OS reports it unsupported. Plus GET/PUT /api/autostart.
// Run from the repo root:  node --test test/autostart.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAutostart } from "../src/autostart.ts";
import { createBotServer } from "../src/web.ts";

const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;

async function inTempHome(run: (home: string) => Promise<void>) {
	const home = await mkdtemp(join(tmpdir(), "cua-bot-autostart-"));
	try {
		await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

// A Run key in memory, answering reg.exe's query, add, and delete.
function fakeReg() {
	const values = new Map<string, string>();
	const calls: string[][] = [];
	const reg = async (args: string[]) => {
		calls.push(args);
		const [verb, key, , name] = args;
		assert.equal(key, RUN_KEY);
		if (verb === "query") return values.has(name!);
		if (verb === "add") {
			values.set(name!, args[args.indexOf("/d") + 1]!);
			return true;
		}
		if (verb === "delete") return values.delete(name!);
		return false;
	};
	return { values, calls, reg };
}

test("Windows adds a Run value that starts start.py windowless, and removes it", async () => {
	const { values, calls, reg } = fakeReg();
	const autostart = createAutostart({ startScript: String.raw`C:\bots\cua-bot\start.py`, python: String.raw`C:\Python\pythonw.exe`, platform: "win32", reg });
	assert.deepEqual(await autostart.state(), { supported: true, enabled: false, where: `${RUN_KEY}\\cua-bot` });

	assert.equal((await autostart.set(true)).enabled, true);
	assert.equal(values.get("cua-bot"), String.raw`"C:\Python\pythonw.exe" "C:\bots\cua-bot\start.py"`);

	assert.equal((await autostart.set(false)).enabled, false);
	assert.equal(values.size, 0);
	// Turning it off again finds nothing to delete and still succeeds.
	calls.length = 0;
	assert.equal((await autostart.set(false)).enabled, false);
	assert.ok(calls.every(([verb]) => verb === "query"));
});

test("Windows reports a reg.exe failure instead of claiming the change", async () => {
	const autostart = createAutostart({ startScript: "start.py", python: "pythonw", platform: "win32", reg: async () => false });
	await assert.rejects(autostart.set(true), /could not add/);
});

test("macOS writes a LaunchAgent that runs start.py at load with the bot's PATH", () =>
	inTempHome(async (home) => {
		const autostart = createAutostart({ startScript: "/Users/me/cua bot/start.py", python: "/usr/bin/python3", platform: "darwin", home, path: "/opt/homebrew/bin:/usr/bin" });
		const file = join(home, "Library", "LaunchAgents", "cua-bot.plist");
		assert.deepEqual(await autostart.state(), { supported: true, enabled: false, where: file });

		assert.equal((await autostart.set(true)).enabled, true);
		const plist = await readFile(file, "utf8");
		assert.match(plist, /<string>\/usr\/bin\/python3<\/string><string>\/Users\/me\/cua bot\/start.py<\/string>/);
		assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
		assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);

		assert.equal((await autostart.set(false)).enabled, false);
		assert.equal(existsSync(file), false);
	}));

test("Linux writes an autostart entry with every argument quoted and escaped", () =>
	inTempHome(async (home) => {
		const autostart = createAutostart({ startScript: "/home/me/100% $bot/start.py", python: "python3", platform: "linux", home, path: "/home/me/.nvm/bin:/usr/bin" });
		assert.equal((await autostart.set(true)).enabled, true);
		const entry = await readFile(join(home, ".config", "autostart", "cua-bot.desktop"), "utf8");
		assert.ok(entry.includes(String.raw`Exec=env "PATH=/home/me/.nvm/bin:/usr/bin" "python3" "/home/me/100%% \\$bot/start.py"`), entry);
		assert.equal((await autostart.set(false)).enabled, false);
	}));

test("another OS says it can't, and refuses to turn on", async () => {
	const autostart = createAutostart({ startScript: "start.py", platform: "freebsd" });
	assert.equal((await autostart.state()).supported, false);
	await assert.rejects(autostart.set(true), /isn't supported/);
});

test("GET/PUT /api/autostart read and change the setting, and 404 without one", async () => {
	const { reg } = fakeReg();
	const logged: string[] = [];
	const autostart = createAutostart({ startScript: "start.py", python: "pythonw", platform: "win32", reg });
	const server = createBotServer({ say: async () => "", context: BACKGROUND_CONTEXT, autostart, log: (line) => void logged.push(String(line)) });
	const bare = createBotServer({ say: async () => "", context: BACKGROUND_CONTEXT });
	const urlOf = async (s: typeof server) => {
		await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
		const address = s.address();
		assert.ok(address !== null && typeof address === "object");
		return `http://127.0.0.1:${address.port}/api/autostart`;
	};
	try {
		const url = await urlOf(server);
		assert.equal((await (await fetch(url)).json()).enabled, false);
		const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const on = await put({ enabled: true });
		assert.equal(on.status, 200);
		assert.equal((await on.json()).enabled, true);
		assert.equal((await (await fetch(url)).json()).enabled, true);
		assert.match(logged.join("\n"), /turned on start at sign-in/);
		assert.equal((await put({ enabled: "yes" })).status, 400);

		assert.equal((await fetch(await urlOf(bare))).status, 404);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => bare.close(() => resolve()));
	}
});
