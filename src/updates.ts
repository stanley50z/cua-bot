// Settings > General's Versions list: Pi and the cua SDK that cua-bot runs on, and cua on this computer and on every
// other computer with a Cua Space, each against its newest release, with an update for each.
// - Pi (cua-bot's @earendil-works/* packages) and the cua SDK (@trycua/cua) update with `pnpm update --latest`, then
//   `pnpm check`. A failed check puts package.json and pnpm-lock.yaml back and reinstalls; a passing one restarts
//   cua-bot through restart.py.
// - cua on a computer runs the official installer (CLI only), then `cua host setup` again with the host's own runner,
//   name and direct address from ~/.cua/host/config.json, which installs the matching cua-spacesd and restarts it. The
//   script runs outside cua-spacesd's process tree (systemd-run, setsid or perl's setsid on macOS and Linux, a
//   WMI-created process on Windows), so that restart doesn't end it. It logs to ~/.cua/cua-bot-update.log on that
//   computer, and the log's last line says whether it finished.
// main.ts builds one with createUpdates(); web.ts serves GET /api/versions and POST /api/versions/update.
import { exec, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Space } from "./connections.ts";

export const ROOT = join(import.meta.dirname, "..");
const PI_PACKAGE = "@earendil-works/pi-durable";
const PI_SCOPE = "@earendil-works/";
const CUA_SDK_PACKAGE = "@trycua/cua";
const CUA_RELEASES = "https://github.com/trycua/cua/releases/download/cua-install-latest/release-artifacts.json";
const LOG_MARK = "cua-bot-update:";

/** `pi` and `cua-sdk` are cua-bot's packages; `cua:here` is cua on this computer, `cua:<space id>` on a Space's. */
export type Target = "pi" | "cua-sdk" | `cua:${string}`;
export type Job = { state: "running" | "done" | "failed"; message?: string; startedAt: number };
export type VersionRow = {
	target: Target;
	machine: string;
	here: boolean;
	what: "Pi" | "cua SDK" | "cua";
	installed?: string;
	latest?: string;
	outdated: boolean;
	job?: Job;
};
export type VersionsSnapshot = { rows: VersionRow[]; errors: string[]; checkedAt: number };

export type UpdatesDeps = {
	/** This computer's name, for its rows. */
	hereName: string;
	/** The installed version of one of cua-bot's packages. */
	installed: (pkg: string) => string | undefined;
	latestPackage: (pkg: string) => Promise<string>;
	latestCua: () => Promise<string>;
	spaces: () => Promise<Space[]>;
	/** Whether a Space is this computer's own desktop. */
	isHere: (space: string) => Promise<boolean>;
	/** cua's version on this computer, for when it has no Space. */
	localCua: () => Promise<string | undefined>;
	/** Runs a shell command (sh, or cmd.exe on Windows) on this computer or a Space and returns its output. */
	run: (where: "here" | Space, command: string) => Promise<string>;
	/** Whether this computer runs Windows. */
	hereWindows: boolean;
	/** cua-bot's dependency names, from package.json. */
	dependencies: () => string[];
	/** Updates these packages to their latest, checks the build, and restarts cua-bot. Throws when the update or check fails. */
	updatePackages: (packages: string[]) => Promise<void>;
	now?: () => number;
};

/** Whether `latest` is a newer release than `installed`, by their major.minor.patch. */
export function isNewer(latest: string, installed: string): boolean {
	const parts = (version: string) => version.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
	const [a, b] = [parts(latest), parts(installed)];
	for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	return false;
}

// A computer that provides Spaces is listed by its address (direct:) or on the relay (relay:). Other Spaces are
// sandboxes whose cua comes with their image, not from the installer.
const isComputer = (space: Space) => space.id.startsWith("direct:") || space.id.startsWith("relay:");
const isWindows = (space: Space) => /windows/i.test(space.os ?? "");

/** Used by main.ts. Each `check()` reads every version again; `start()` begins updates in the background. */
export function createUpdates(deps: UpdatesDeps) {
	const now = deps.now ?? Date.now;
	const jobs = new Map<Target, Job>();
	// Where each cua update runs, so a check can read its log there.
	const places = new Map<Target, { where: "here" | Space; windows: boolean }>();

	async function check(): Promise<VersionsSnapshot> {
		const errors: string[] = [];
		const latest = <T>(what: string, read: () => Promise<T>) =>
			read().catch((error: unknown) => {
				errors.push(`Could not read the newest ${what}: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			});
		const [pi, sdk, cua, spaces] = await Promise.all([
			latest("Pi", () => deps.latestPackage(PI_PACKAGE)),
			latest("cua SDK", () => deps.latestPackage(CUA_SDK_PACKAGE)),
			latest("cua release", deps.latestCua),
			deps.spaces().catch((error: unknown) => {
				errors.push(`Could not list the Cua Spaces: ${error instanceof Error ? error.message : String(error)}`);
				return [];
			}),
		]);
		const computers = spaces.filter(isComputer);
		const here = await Promise.all(computers.map((space) => deps.isHere(space.id).catch(() => false)));
		const hereSpace = computers.find((_, index) => here[index]);
		const hereCua = hereSpace?.version ?? (await deps.localCua().catch(() => undefined));
		places.set("cua:here", { where: "here", windows: deps.hereWindows });
		for (const space of computers) places.set(`cua:${space.id}`, { where: space, windows: isWindows(space) });

		const row = (target: Target, machine: string, isHere: boolean, what: VersionRow["what"], installed?: string, newest?: string): VersionRow => ({
			target,
			machine,
			here: isHere,
			what,
			...(installed === undefined ? {} : { installed }),
			...(newest === undefined ? {} : { latest: newest }),
			outdated: installed !== undefined && newest !== undefined && isNewer(newest, installed),
		});
		const hereMachine = hereSpace?.name ?? deps.hereName;
		const rows = [
			row("pi", hereMachine, true, "Pi", deps.installed(PI_PACKAGE), pi),
			row("cua-sdk", hereMachine, true, "cua SDK", deps.installed(CUA_SDK_PACKAGE), sdk),
			row("cua:here", hereMachine, true, "cua", hereCua, cua),
			...computers.filter((space) => space !== hereSpace).map((space) => row(`cua:${space.id}`, space.name ?? space.id, false, "cua", space.version, cua)),
		];
		await Promise.all(rows.map(async (r) => {
			await refreshJob(r.target);
			const job = jobs.get(r.target);
			if (job !== undefined) r.job = job;
		}));
		return { rows, errors, checkedAt: now() };
	}

	// A running cua update finishes when its log's last line says so; until the log can be read again, it is still running.
	async function refreshJob(target: Target) {
		const job = jobs.get(target);
		const place = places.get(target);
		if (job?.state !== "running" || place === undefined || !target.startsWith("cua:")) return;
		const log = await deps.run(place.where, statusCommand(place.windows)).catch(() => undefined);
		if (log === undefined) return;
		const outcome = readLog(log);
		if (outcome !== undefined) jobs.set(target, { ...job, ...outcome });
	}

	/** Starts updating each target in the background. Throws for a target that isn't listed or is already updating. */
	async function start(targets: Target[]): Promise<void> {
		for (const target of targets) {
			if (jobs.get(target)?.state === "running") throw new Error(`${target} is already updating`);
			if (target.startsWith("cua:") && !places.has(target)) throw new Error(`${target} is not in the Versions list`);
			if (target !== "pi" && target !== "cua-sdk" && !target.startsWith("cua:")) throw new Error(`${target} is not a version cua-bot can update`);
		}
		const begin = (target: Target) => jobs.set(target, { state: "running", startedAt: now() });
		for (const target of targets.filter((t) => t.startsWith("cua:"))) {
			const place = places.get(target)!;
			begin(target);
			try {
				await deps.run(place.where, launchCommand(place.windows));
			} catch (error) {
				jobs.set(target, { state: "failed", message: error instanceof Error ? error.message : String(error), startedAt: now() });
			}
		}
		// cua-bot's own packages last and in one go: a passing update restarts cua-bot.
		const own = targets.filter((t) => t === "pi" || t === "cua-sdk");
		if (own.length === 0) return;
		const packages = deps.dependencies().filter((name) => (own.includes("pi") && name.startsWith(PI_SCOPE)) || (own.includes("cua-sdk") && name === CUA_SDK_PACKAGE));
		own.forEach(begin);
		void deps.updatePackages(packages).then(
			() => own.forEach((t) => jobs.set(t, { state: "done", message: "Restarting cua-bot", startedAt: jobs.get(t)!.startedAt })),
			(error: unknown) => own.forEach((t) => jobs.set(t, { state: "failed", message: error instanceof Error ? error.message : String(error), startedAt: jobs.get(t)!.startedAt })),
		);
	}

	return { check, start };
}

export type Updates = ReturnType<typeof createUpdates>;

/** The outcome a cua update log ends with, or undefined while it runs. Exported for test/updates.test.ts. */
export function readLog(log: string): Omit<Job, "startedAt"> | undefined {
	const lines = log.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const last = lines.findLast((line) => line.startsWith(LOG_MARK));
	if (last === undefined) return undefined;
	const status = last.slice(LOG_MARK.length).trim();
	if (status.startsWith("done")) return { state: "done", message: status.replace(/^done\s*/, "").replace(/^\((.*)\)$/, "$1") };
	if (status.startsWith("failed")) return { state: "failed", message: [...lines.slice(-8, -1), status.replace(/^failed\s*/, "").replace(/^\((.*)\)$/, "$1")].join("\n") };
	return undefined;
}

// The update script for macOS and Linux (exported for test/updates.test.ts). It logs to ~/.cua/cua-bot-update.log and ends the log with done or failed.
export const UNIX_SCRIPT = `#!/bin/sh
# Written by cua-bot (Settings > General): installs the newest cua, then sets this computer's host service up again on it.
exec >"$HOME/.cua/cua-bot-update.log" 2>&1
echo "${LOG_MARK} started $(date)"
fail() { echo "${LOG_MARK} failed ($1)"; exit 1; }
curl -fsSL https://cua.ai/install.sh | sh -s -- --cli-only --yes --no-modify-path || fail "the cua installer failed"
if [ "$(id -u)" = 0 ]; then cua=/usr/local/bin/cua; else cua="$HOME/.local/bin/cua"; fi
config="$HOME/.cua/host/config.json"
if [ -f "$config" ]; then
  field() { sed -n "s/^ *\\"$1\\": *\\"\\(.*\\)\\",\\{0,1\\} *$/\\1/p" "$config" | head -n 1; }
  set -- host setup
  runner="$(field runner)"; [ -n "$runner" ] && set -- "$@" --runner "$runner"
  name="$(field name)"; [ -n "$name" ] && set -- "$@" --name "$name"
  [ "$(field mode)" = direct ] && set -- "$@" --direct "$(field listen)"
  "$cua" "$@" || fail "cua host setup failed"
fi
echo "${LOG_MARK} done ($("$cua" --version))"
`;

// The same for Windows, in PowerShell.
const WINDOWS_SCRIPT = `# Written by cua-bot (Settings > General): installs the newest cua, then sets this computer's host service up again on it.
$ErrorActionPreference = 'Stop'
"${LOG_MARK} started $(Get-Date -Format s)"
try {
  & ([scriptblock]::Create((Invoke-RestMethod https://cua.ai/install.ps1))) -CliOnly -Yes -NoModifyPath
  $cua = Join-Path $env:LOCALAPPDATA 'Programs\\cua\\bin\\cua.exe'
  $config = Join-Path $HOME '.cua\\host\\config.json'
  if (Test-Path -LiteralPath $config) {
    $c = Get-Content -Raw -LiteralPath $config | ConvertFrom-Json
    $setup = @('host', 'setup')
    if ($c.runner) { $setup += '--runner', $c.runner }
    if ($c.name) { $setup += '--name', $c.name }
    if ($c.mode -eq 'direct') { $setup += '--direct', $c.listen }
    & $cua @setup
    if ($LASTEXITCODE -ne 0) { throw "cua host setup exited $LASTEXITCODE" }
  }
  "${LOG_MARK} done ($(& $cua --version))"
} catch {
  "${LOG_MARK} failed ($_)"
  exit 1
}
`;

const encoded = (script: string) => `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;

/** The command that writes the update script and starts it outside the host service. Exported for tests. */
export function launchCommand(windows: boolean): string {
	if (windows) {
		return encoded(`$ErrorActionPreference = 'Stop'
$dir = Join-Path $HOME '.cua'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$script = Join-Path $dir 'cua-bot-update.ps1'
$log = Join-Path $dir 'cua-bot-update.log'
[IO.File]::WriteAllText($script, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(WINDOWS_SCRIPT, "utf8").toString("base64")}')))
Set-Content -LiteralPath $log -Value '${LOG_MARK} starting'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$line = "cmd.exe /c powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \`"$script\`" > \`"$log\`" 2>&1"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; ProcessStartupInformation = $startup }
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
'started'`);
	}
	return [
		'mkdir -p "$HOME/.cua"',
		'f="$HOME/.cua/cua-bot-update.sh"',
		`cat > "$f" <<'CUA_BOT_EOF'\n${UNIX_SCRIPT}CUA_BOT_EOF`,
		`echo "${LOG_MARK} starting" > "$HOME/.cua/cua-bot-update.log"`,
		'if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemd-run --user --collect --quiet sh "$f" 2>/dev/null || systemd-run --collect --quiet sh "$f"',
		'elif command -v setsid >/dev/null 2>&1; then setsid sh "$f" </dev/null >/dev/null 2>&1 &',
		`else perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sh "$f" </dev/null >/dev/null 2>&1 &`,
		"fi",
		"echo started",
	].join("\n");
}

/** The command that prints the end of the update log. Exported for tests. */
export function statusCommand(windows: boolean): string {
	return windows
		? encoded("Get-Content -Tail 20 -LiteralPath (Join-Path $HOME '.cua\\cua-bot-update.log')")
		: 'tail -n 20 "$HOME/.cua/cua-bot-update.log"';
}

/* ---------- what main.ts passes ---------- */

const shell = (command: string, options: { cwd?: string; timeout?: number } = {}) =>
	new Promise<string>((resolve, reject) =>
		exec(command, { ...options, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const output = `${stdout}${stderr}`;
			if (error === null) return resolve(output);
			const tail = output.trim().split(/\r?\n/).slice(-20).join("\n");
			reject(new Error(`${command.split(" ").slice(0, 4).join(" ")} failed${tail ? `:\n${tail}` : ` (${error.message})`}`));
		}),
	);

/** Runs a command on this computer. Used by main.ts as the "here" half of `run`. */
export const runHere = (command: string) => shell(command);

/** The installed version of one of cua-bot's packages, from node_modules. */
export function installedPackage(pkg: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(ROOT, "node_modules", pkg, "package.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

export function dependencies(): string[] {
	return Object.keys((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
}

async function getJson(url: string): Promise<unknown> {
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response.json();
}

/** The npm registry's latest release of a package. */
export async function latestPackage(pkg: string): Promise<string> {
	const { version } = (await getJson(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}/latest`)) as { version?: string };
	if (typeof version !== "string") throw new Error(`the npm registry gave no version for ${pkg}`);
	return version;
}

/** The newest cua CLI release, from the manifest the official installer reads. */
export async function latestCua(): Promise<string> {
	const { versions } = (await getJson(CUA_RELEASES)) as { versions?: { cli?: string } };
	if (typeof versions?.cli !== "string") throw new Error("the cua release manifest gave no CLI version");
	return versions.cli;
}

/** `cua --version` on this computer's PATH. */
export async function localCua(): Promise<string | undefined> {
	return /cua\s+(\S+)/.exec(await shell("cua --version", { timeout: 15_000 }))?.[1];
}

/**
 * `pnpm update --latest` for `packages`, then `pnpm check`. On a failure, package.json and pnpm-lock.yaml go back to
 * what they were, node_modules is reinstalled from them, and the error says what failed. On success cua-bot restarts.
 */
export async function updatePackages(packages: string[]): Promise<void> {
	const files = ["package.json", "pnpm-lock.yaml"].map((name) => join(ROOT, name));
	const saved = files.map((file) => readFileSync(file));
	try {
		await shell(`pnpm update --latest ${packages.join(" ")}`, { cwd: ROOT });
		await shell("pnpm check", { cwd: ROOT });
	} catch (error) {
		files.forEach((file, index) => writeFileSync(file, saved[index]!));
		const restored = await shell("pnpm install --frozen-lockfile", { cwd: ROOT }).then(
			() => "package.json and pnpm-lock.yaml are back as they were.",
			(reinstall: unknown) => `package.json and pnpm-lock.yaml are back as they were, but reinstalling failed: ${reinstall instanceof Error ? reinstall.message : String(reinstall)}`,
		);
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${restored}`);
	}
	restart();
}

/** Starts restart.py, which stops cua-bot and starts it again from outside this process tree. */
export function restart(): void {
	const python = process.env.CUABOT_PYTHON || (process.platform === "win32" ? "pythonw" : "python3");
	spawn(python, [join(ROOT, "restart.py")], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true }).unref();
}
