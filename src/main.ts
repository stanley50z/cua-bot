// cua-bot service entry point. Run with `pnpm start` (or start.py). Opens the Pi Durable Harness on
// data/cua-bot.sqlite, resumes any unfinished or sleeping work, and accepts owner messages on
// POST http://127.0.0.1:43142/say (body: plain text; reply: the bot's answer as plain text).
// The same server hosts the routines GUI at http://127.0.0.1:43142/ (see src/web.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces, release, type, userInfo, version } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, createRegistry, type Cursor, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBots, createBotsExtension, DEFAULT_BOTS_DIR, readBots } from "./bots.ts";
import { toChatItem } from "./chat.ts";
import { createComputerExtension, defaultSpaceId, defaultSpaceLabel, openLiveStream, registrySpaces, screenControl, spacesText } from "./computer.ts";
import { createConnections, listCuaSpaces, probeTcp } from "./connections.ts";
import { createLiveScreen } from "./live-screen.ts";
import { createBotToolSearchExtension } from "./tool-search.ts";
import { connectCua, createCuaExtension, defaultCuaCommand } from "./cua-mcp.ts";
import { createComputerView } from "./computer-view.ts";
import { type Approvals, createApprovals, describeApproval } from "./approvals.ts";
import { createAutostart } from "./autostart.ts";
import { connectExecutor, createExecutor, createExecutorExtension } from "./executor.ts";
import { DATA_DIR, log } from "./log.ts";
import { createMachines, ownerHosts, resolveSsh } from "./machines.ts";
import { createMemory, createMemoryExtension, migrateMemory } from "./memory.ts";
import { createPcExtensions, pcEnv } from "./pc.ts";
import { createPush } from "./push.ts";
import { LEGACY_ROUTINE_FILE } from "./routines-file.ts";
import { bindRoutines, createRoutinesExtension, removeBotRoutines, routineDir, startRoutineFileWatch, syncRoutines } from "./routines.ts";
import { today } from "./today.ts";
import { traceExtension } from "./trace.ts";
import { createBotServer } from "./web.ts";
import { createModelSettings } from "./model-settings.ts";
import { botAgent, botModel, botThinking, createBotModels } from "./models.ts";
const PORT = Number(process.env.CUABOT_PORT || 43142);
const CRASH_DIR = join(DATA_DIR, "crash");
mkdirSync(CRASH_DIR, { recursive: true });

const crash = (kind: string) => (error: unknown) => {
	const file = join(CRASH_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
	writeFileSync(file, `${kind}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	log(`${kind}; crash report at ${file}`);
	process.exit(1);
};
process.on("uncaughtException", crash("uncaughtException"));
process.on("unhandledRejection", crash("unhandledRejection"));

const context = BACKGROUND_CONTEXT;
const models = createBotModels(); // providers from models.json; see src/models.ts

const registry = createRegistry();
registry.install(
	defineExtension({
		name: "persona",
		sections: [
			section(
				"preamble",
				async () =>
					[
						"You are a bot in cua-bot, a self-hosted personal agent that runs 24/7 for one owner.",
						`The owner's email is ${process.env.OWNER_EMAIL || "(unset)"}. Mail to the owner goes through Gmail in Executor like any other mail.`,
						"The owner sees only what you send with send_message; your own text is private notes. Answer the owner's messages with send_message, and send it whenever something needs them, even mid-task; each message pops up in their browser. When nothing needs the owner, send nothing. Never email the owner unless they ask for an email.",
						`Your computers are the Cua Spaces ${await spacesText()}. Run CLI commands on one with space_bash, and delegate every on-screen task to computer_use, one at a time. Both take \`space\`, a Space's name or id; pick the Space the work needs, and switch whenever it moves. Without \`space\` they use the default.`,
						"For recurring or future work, create a routine with schedule. A message starting with [routine] is a routine firing: do the work, and send_message the owner only if the outcome needs them.",
						"Be brief.",
					].join("\n"),
				{ tag: false },
			),
			section("today", () => today(new Date()), { tag: false }),
		],
	}),
);
registry.install(traceExtension);
registry.install(createBotsExtension({ agent: botAgent }));
registry.install(createComputerExtension(registry));
registry.install(createBotToolSearchExtension());
// Web Push to every browser that turned notifications on in the web app (data/push.json).
const push = createPush({ file: join(DATA_DIR, "push.json"), log });
// Every Cua Spaces tool, deferred until tool_search loads it. The rest of the bot works without the cua CLI.
const cuaCommand = process.env.CUA_MCP_COMMAND?.trim() || defaultCuaCommand();
const cuaConnect = connectCua(cuaCommand);
// One `cua mcp` session for the bots' cua_* tools and the web app's Connections tab.
const cua = createExecutor(cuaConnect);
try {
	registry.install(await createCuaExtension(cuaConnect, { defaultSpace: defaultSpaceId(), call: cua }));
} catch (error) {
	log(`cua: \`${cuaCommand} mcp\` failed (${error instanceof Error ? error.message : String(error)}); Cua Spaces tools are off`);
}
registry.install(createRoutinesExtension());
// codemode over every tool, and the section saying the coding tools act on this PC by default.
for (const extension of createPcExtensions()) registry.install(extension);
// read, write, edit, bash, and powershell, on this PC or, given `machine`, on any SSH destination of the owner's.
const machines = createMachines();
registry.install(machines.extension);
// The owner's memory, each fact tagged with the bots that get it. An install from before tags moves over first.
if (await migrateMemory({ dir: join(DATA_DIR, "memory"), botsDir: DEFAULT_BOTS_DIR, backupDir: join(DATA_DIR, "memory-backup-pre-tags") })) {
	log(`memory: moved to tags, backup in ${join(DATA_DIR, "memory-backup-pre-tags")}`);
}
const memory = createMemory({ dir: join(DATA_DIR, "memory") });
registry.install(createMemoryExtension({ memory, bots: readBots }));
const executorUrl = process.env.EXECUTOR_MCP_URL?.trim();
const executorKey = process.env.EXECUTOR_API_KEY?.trim();
let approvals: Approvals | undefined;
if (executorUrl && executorKey) {
	const executor = createExecutor(connectExecutor(executorUrl, executorKey));
	approvals = createApprovals({
		file: join(DATA_DIR, "approvals.json"),
		call: (name, args) => executor(name, args),
		// The owner's decision reaches the bot that asked as a message, after any turn in progress.
		notify: async (text, conversationId) => {
			const asked = conversationId === undefined ? root : ((await harness.conversation(conversationId as ConversationId, context)) ?? root);
			return asked.submit({ type: "input", content: text, whenBusy: "followUp" }, context);
		},
		filed: (approval) => void push.send({ title: "Approval needed", body: describeApproval(approval), tag: approval.id }),
	});
	registry.install(createExecutorExtension({ executor, approvals, ...(process.env.OWNER_EMAIL ? { ownerEmail: process.env.OWNER_EMAIL } : {}) }));
} else {
	log("executor: EXECUTOR_MCP_URL or EXECUTOR_API_KEY unset; Gmail and Calendar are off");
}

const DATABASE = join(DATA_DIR, "cua-bot.sqlite");
const storage = await openNodeSqliteStorage(DATABASE);
const harness = await Harness.open(storage, { models, registry, env: pcEnv }, context);
const root = await harness.root(context, { agent: botAgent() });
const logRoutineSyncFailure = (error: unknown) =>
	log("routine file sync failed:", error instanceof Error ? error.message : String(error));
bindRoutines({ harness, root, legacyFile: LEGACY_ROUTINE_FILE, onError: logRoutineSyncFailure });
harness.resume();
const synced = await syncRoutines(context);
log(
	`routines: ${synced.total} from ${routineDir()} (created ${synced.created}, updated ${synced.updated}, deleted ${synced.deleted}${synced.adopted ? ", adopted existing" : ""})`,
);
const stopWatching = startRoutineFileWatch(context, logRoutineSyncFailure);
log(`cua-bot up: model ${botModel().provider}/${botModel().modelId}, reasoning ${botThinking()}, root ${root.id}`);

// Submits one owner message to the root conversation and returns what the bot sent the owner (send_message) by the end of the turn.
async function say(text: string): Promise<string> {
	const before = (await root.entries({ order: "descending" }, 1, undefined, context)).items[0]?.id;
	const submission = await root.submit({ type: "input", content: text }, context);
	const settled = await submission.wait(context);
	if (settled.status !== "done" || settled.type !== "input") return `(unanswered: ${settled.reason ?? "unknown"})`;
	const sent: string[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await root.entries({ order: "ascending", ...(before === undefined ? {} : { minEntryId: before }) }, 200, cursor, context);
		for (const entry of page.items) {
			const item = entry.id === before ? undefined : toChatItem(entry);
			if (item?.kind === "assistant" && item.text !== "") sent.push(item.text);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return sent.join("\n\n");
}

const space = await defaultSpaceLabel();
const bots = await createBots({
	harness,
	root,
	context,
	agent: botAgent,
	// A renamed bot's routine file is renamed on the next sync and its memory tag follows; a deleted bot's routines
	// go with it and its tag comes off its facts.
	renamed: async (id, before, after) => {
		await memory.botRenamed({ id, name: before }, { id, name: after });
		await syncRoutines(context);
	},
	removing: async (id) => {
		const bot = bots.list().find((b) => b.id === id);
		if (bot !== undefined) await memory.botRemoved(bot);
		await removeBotRoutines(id, context);
	},
	sent: (bot, text) => void push.send({ title: bot.name, body: text }),
	computer: (conversation) =>
		createComputerView({ harness, storage, conversation, shotsDir: join(DATA_DIR, "shots"), context, ...(space === undefined ? {} : { space }) }),
});
log(`bots: ${bots.list().map((bot) => bot.name).join(", ")}`);
const live = createLiveScreen(openLiveStream);
// The Connections tab: this computer, which runs the Harness and every bot, then the owner's SSH machines and the Spaces.
const defaultSpace = defaultSpaceId();
const connections = createConnections({
	here: {
		name: hostname(),
		os: process.platform === "win32" ? `${version()} (${release()})` : `${type()} ${release()}`,
		user: userInfo().username,
		addresses: Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((nic) => nic.address)),
		pid: process.pid,
		startedAt: Date.now() - Math.round(process.uptime() * 1000),
		database: DATABASE,
	},
	hosts: ownerHosts,
	resolve: resolveSsh,
	probe: probeTcp,
	spaces: () => listCuaSpaces(cua),
	fallback: registrySpaces,
	...(defaultSpace === undefined ? {} : { defaultSpace }),
});
// Fits images the owner pastes in the chat to the model's limits, in a worker thread.
const images = await createNodePhotonImages();
// Settings > Startup: start.py at sign-in.
const autostart = createAutostart({ startScript: join(import.meta.dirname, "..", "start.py") });
// Settings > Model: the model and reasoning effort in .env, applied to every bot without a restart.
const modelSettings = createModelSettings({ models, apply: bots.applyAgent });
createBotServer({ say, bots, memory, memoryBots: () => bots.list(), images, context, log, control: screenControl, live, push, connections, autostart, modelSettings, ...(approvals === undefined ? {} : { approvals }) }).listen(PORT, "127.0.0.1", () =>
	log(`listening: web app http://127.0.0.1:${PORT}/ · chat POST http://127.0.0.1:${PORT}/say`),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		log(`${signal}: closing`);
		stopWatching();
		await bots.close();
		await harness.close(context);
		machines.close();
		process.exit(0);
	});
}
