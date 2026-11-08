// Start at sign-in (Settings > Startup): registers start.py to run when the owner signs in to this computer, so a
// restart doesn't leave the bots off until someone starts them. Windows gets a value under HKCU's Run key, macOS a
// LaunchAgent in ~/Library/LaunchAgents, Linux an XDG autostart entry in ~/.config/autostart; none needs admin rights.
// main.ts builds one with createAutostart() and web.ts serves it at GET/PUT /api/autostart.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const NAME = "cua-bot";
const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;

/** What Settings shows: whether this OS can start the bot at sign-in, whether it will, and where that is saved. */
export type AutostartState = { supported: boolean; enabled: boolean; where: string };
export type Autostart = ReturnType<typeof createAutostart>;

/** Runs reg.exe with these arguments; true when it exits 0. */
type Reg = (args: string[]) => Promise<boolean>;

const reg: Reg = (args) => new Promise((resolve) => execFile("reg", args, { windowsHide: true }, (error) => resolve(error === null)));

/**
 * `startScript` is start.py's absolute path. `python` defaults to CUABOT_PYTHON, the windowless interpreter start.py
 * ran under, else pythonw or python3 on PATH. `path` is the PATH the macOS and Linux entries start with, since their
 * sign-in environment may not find node and pnpm. The rest are for tests.
 */
export function createAutostart(options: {
	startScript: string;
	python?: string;
	platform?: NodeJS.Platform;
	home?: string;
	path?: string;
	reg?: Reg;
}) {
	const platform = options.platform ?? process.platform;
	const python = options.python ?? (process.env.CUABOT_PYTHON || (platform === "win32" ? "pythonw" : "python3"));
	const home = options.home ?? homedir();
	const path = options.path ?? process.env.PATH ?? "";
	const runReg = options.reg ?? reg;
	const { startScript } = options;

	// Where each OS keeps the entry, and what it holds.
	const file =
		platform === "darwin"
			? { path: join(home, "Library", "LaunchAgents", `${NAME}.plist`), text: () => launchAgent(python, startScript, path) }
			: platform === "linux"
				? { path: join(home, ".config", "autostart", `${NAME}.desktop`), text: () => desktopEntry(python, startScript, path) }
				: undefined;
	const supported = platform === "win32" || file !== undefined;
	const where = platform === "win32" ? `${RUN_KEY}\\${NAME}` : (file?.path ?? "");

	async function enabled(): Promise<boolean> {
		if (platform === "win32") return runReg(["query", RUN_KEY, "/v", NAME]);
		return file !== undefined && existsSync(file.path);
	}

	return {
		async state(): Promise<AutostartState> {
			return { supported, enabled: supported && (await enabled()), where };
		},

		/** Adds or removes the entry. Throws on an OS without one, or when the change didn't take. */
		async set(on: boolean): Promise<AutostartState> {
			if (!supported) throw new Error(`Starting at sign-in isn't supported on ${platform}.`);
			if (platform === "win32") {
				const ok = on
					? await runReg(["add", RUN_KEY, "/v", NAME, "/t", "REG_SZ", "/d", `"${python}" "${startScript}"`, "/f"])
					: !(await enabled()) || (await runReg(["delete", RUN_KEY, "/v", NAME, "/f"]));
				if (!ok) throw new Error(`reg.exe could not ${on ? "add" : "remove"} ${where}.`);
			} else if (file !== undefined) {
				if (on) {
					await mkdir(dirname(file.path), { recursive: true });
					await writeFile(file.path, file.text(), "utf8");
				} else {
					await rm(file.path, { force: true });
				}
			}
			return { supported, enabled: await enabled(), where };
		},
	};
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// RunAtLoad runs it once per sign-in. start.py leaves the service in its own session, and AbandonProcessGroup keeps
// launchd from cleaning up after start.py exits anyway.
function launchAgent(python: string, startScript: string, path: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${NAME}</string>
	<key>ProgramArguments</key><array><string>${xml(python)}</string><string>${xml(startScript)}</string></array>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
	<key>RunAtLoad</key><true/>
	<key>AbandonProcessGroup</key><true/>
</dict>
</plist>
`;
}

// Exec arguments are double-quoted with the reserved characters backslash-escaped. The Desktop Entry spec then
// escapes every backslash again as a string value, and doubles % for field codes.
const execArg = (text: string) =>
	`"${text.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`.replace(/\\/g, "\\\\").replace(/%/g, "%%");

function desktopEntry(python: string, startScript: string, path: string): string {
	return `[Desktop Entry]
Type=Application
Name=${NAME}
Comment=Starts cua-bot when you sign in
Exec=env ${execArg(`PATH=${path}`)} ${execArg(python)} ${execArg(startScript)}
NoDisplay=true
`;
}
