// What the web app's Connections tab shows (Settings > Connections): the computer cua-bot runs on, each machine of the
// owner's ~/.ssh/config with whether its SSH port answers, and every Cua Space, under the computer that provides it.
// main.ts builds one with createConnections() and web.ts serves a fresh check at GET /api/connections. Nothing here is
// configured: the machines are the owner's SSH hosts and the Spaces are what Cua lists, so it works the same for anyone.
import { connect } from "node:net";
import type { Executor } from "./executor.ts";

/** A Cua Space as listed by `cua mcp`'s list_spaces, or by ~/.cua/spaces.json when that can't answer. */
export type Space = { id: string; name?: string; os?: string; phase?: string; version?: string; hostName?: string };
export type SpaceView = Space & { isDefault: boolean };

/** The computer cua-bot runs on. Its addresses tell which SSH hosts and Spaces are this computer. */
export type Here = { name: string; os: string; user: string; addresses: string[]; pid: number; startedAt: number; database: string };

export type Machine = { aliases: string[]; address: string; port: number; user?: string; online: boolean; spaces: SpaceView[] };

export type ConnectionsSnapshot = {
	here: Omit<Here, "addresses"> & { aliases: string[]; spaces: SpaceView[] };
	machines: Machine[];
	/** Spaces on no computer listed here: cloud Spaces, and machines outside the owner's SSH config. */
	otherSpaces: SpaceView[];
	/** Why the Spaces come from ~/.cua/spaces.json instead of Cua's live list, when they do. */
	spacesError?: string;
	checkedAt: number;
};

export type ConnectionsDeps = {
	here: Here;
	/** The owner's SSH Host aliases. */
	hosts: () => string[];
	/** Where `ssh <alias>` connects. */
	resolve: (alias: string) => Promise<{ address: string; port: number; user?: string }>;
	/** Whether a TCP connection to the address opens. */
	probe: (address: string, port: number) => Promise<boolean>;
	/** The live list; it may throw, and then `fallback` is shown. */
	spaces: () => Promise<Space[]>;
	fallback: () => Space[];
	/** The bots' default Space's id. */
	defaultSpace?: string;
	now?: () => number;
};

const PROBE_MS = 3000;

/** True once a TCP connection opens within `ms`. Used by main.ts as the SSH machines' probe. */
export function probeTcp(address: string, port: number, ms = PROBE_MS): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: address, port });
		// Covers the name lookup too, which a dead DNS name can drag out.
		const timer = setTimeout(() => done(false), ms);
		function done(open: boolean) {
			clearTimeout(timer);
			socket.destroy();
			resolve(open);
		}
		socket.once("connect", () => done(true)).once("error", () => done(false));
	});
}

const text = (record: Record<string, unknown>, ...keys: string[]) => {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
};

/** list_spaces's records in the Space shape; records without an id are dropped. Exported for test/connections.test.ts. */
export function parseSpaces(records: unknown): Space[] {
	if (!Array.isArray(records)) throw new Error("list_spaces did not return a list");
	return records.flatMap((record: unknown) => {
		if (record === null || typeof record !== "object") return [];
		const r = record as Record<string, unknown>;
		const id = text(r, "id");
		if (id === undefined) return [];
		const fields = {
			name: text(r, "name"),
			os: text(r, "os_pretty_name", "os_name", "os"),
			phase: text(r, "phase"),
			version: text(r, "spacesd_version"),
			hostName: text(r, "host_name"),
		};
		return [{ id, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) }];
	});
}

/** Cua's live Space list through the bot's `cua mcp` session. Used by main.ts. */
export async function listCuaSpaces(call: Executor): Promise<Space[]> {
	const result = await call("list_spaces", {}, AbortSignal.timeout(15_000));
	const body = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
	if (result.isError === true) throw new Error(body || "list_spaces failed");
	return parseSpaces(JSON.parse(body));
}

/** The host a `direct:<host>:<port>` Space id dials, without IPv6 brackets. */
function directHost(id: string): string | undefined {
	if (!id.startsWith("direct:")) return undefined;
	const rest = id.slice("direct:".length);
	const colon = rest.lastIndexOf(":");
	return (colon === -1 ? rest : rest.slice(0, colon)).replace(/^\[|\]$/g, "").toLowerCase();
}

/** Used by main.ts. Each call checks again: the SSH config, every host's port, and Cua's Space list. */
export function createConnections(deps: ConnectionsDeps) {
	return async (): Promise<ConnectionsSnapshot> => {
		const { here } = deps;
		const local = new Set([...here.addresses, here.name, "localhost"].map((name) => name.toLowerCase()));
		const isHere = (address: string) => local.has(address.toLowerCase()) || /^127\./.test(address);

		let spaces: Space[];
		let spacesError: string | undefined;
		try {
			spaces = await deps.spaces();
		} catch (error) {
			spacesError = error instanceof Error ? error.message : String(error);
			spaces = deps.fallback();
		}

		// Aliases that reach the same place (`Host razor overpricedrazor`, or two entries for one address) are one machine.
		type Target = Awaited<ReturnType<ConnectionsDeps["resolve"]>>;
		const resolved = await Promise.all(
			deps.hosts().map(async (alias) => ({ alias, target: await deps.resolve(alias).catch((): Target => ({ address: alias, port: 22 })) })),
		);
		const groups = new Map<string, Target & { aliases: string[] }>();
		for (const { alias, target } of resolved) {
			const key = `${target.user ?? ""}@${target.address.toLowerCase()}:${target.port}`;
			const group = groups.get(key);
			if (group === undefined) groups.set(key, { aliases: [alias], ...target });
			else group.aliases.push(alias);
		}
		const hereAliases = [...groups.values()].filter((group) => isHere(group.address)).flatMap((group) => group.aliases);
		const remote = [...groups.values()].filter((group) => !isHere(group.address));
		const online = await Promise.all(remote.map((group) => deps.probe(group.address, group.port)));

		const hereSpaces: SpaceView[] = [];
		const otherSpaces: SpaceView[] = [];
		const machines: Machine[] = remote.map((group, index) => ({ ...group, online: online[index]!, spaces: [] }));
		for (const space of spaces) {
			const view = { ...space, isDefault: space.id === deps.defaultSpace };
			const host = directHost(space.id);
			const named = space.hostName?.toLowerCase();
			// A local Space runs beside the cua CLI, on this computer; a relay Space names the machine that provides it.
			if (space.id.startsWith("local:") || (host !== undefined && isHere(host)) || (named !== undefined && local.has(named))) {
				hereSpaces.push(view);
				continue;
			}
			const machine = machines.find(
				(m) =>
					(host !== undefined && m.address.toLowerCase() === host) ||
					(named !== undefined && m.aliases.some((alias) => alias.toLowerCase() === named)),
			);
			(machine?.spaces ?? otherSpaces).push(view);
		}

		const { addresses: _addresses, ...shown } = here;
		return {
			here: { ...shown, aliases: hereAliases, spaces: hereSpaces },
			machines,
			otherSpaces,
			...(spacesError === undefined ? {} : { spacesError }),
			checkedAt: (deps.now ?? Date.now)(),
		};
	};
}

export type Connections = ReturnType<typeof createConnections>;
