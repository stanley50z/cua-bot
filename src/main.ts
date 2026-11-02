// cua-bot service entry point. Run with `pnpm start` (or start.py). Opens the Pi Durable Harness on
// data/cua-bot.sqlite, resumes any unfinished or sleeping work, and accepts owner messages on
// POST http://127.0.0.1:43142/say (body: plain text; reply: the bot's answer as plain text).
// The same server hosts the routines GUI at http://127.0.0.1:43142/ (see src/web.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, configure, type ConversationId, createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBots, createBotsExtension } from "./bots.ts";
import { createComputerExtension, spaceId, spaceLabel, viewerLink } from "./computer.ts";
import { createBotToolSearchExtension } from "./tool-search.ts";
import { connectCua, createCuaExtension, defaultCuaCommand } from "./cua-mcp.ts";
import { createComputerView } from "./computer-view.ts";
import { type Approvals, createApprovals, describeApproval } from "./approvals.ts";
import { connectExecutor, createExecutor, createExecutorExtension } from "./executor.ts";
import { DATA_DIR, log } from "./log.ts";
import { createMemory, createMemoryExtension } from "./memory.ts";
import { createPush } from "./push.ts";
import { LEGACY_ROUTINE_FILE } from "./routines-file.ts";
import { bindRoutines, createRoutinesExtension, removeBotRoutines, routineDir, startRoutineFileWatch, syncRoutines } from "./routines.ts";
import { today } from "./today.ts";
import { traceExtension } from "./trace.ts";
import { createBotServer } from "./web.ts";
import { botModel, createBotModels } from "./models.ts";
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
const MODEL = botModel();

const registry = createRegistry();
registry.install(
	defineExtension({
		name: "persona",
		sections: [
			section(
				"preamble",
				() =>
					[
						"You are a bot in cua-bot, a self-hosted personal agent that runs 24/7 for one owner.",
						`The owner's email is ${process.env.OWNER_EMAIL || "(unset)"}. Mail to the owner goes through Gmail in Executor like any other mail.`,
						"To get the owner's attention now, call cua_notify_user (load it with tool_search): it pops up in their browser, even with no cua-bot tab open. Email the owner for what they should keep.",
						"The owner's Mac is yours to use. Run CLI commands there with space_bash. Delegate every on-screen task to computer_use, one at a time.",
						"For recurring or future work, create a routine with schedule. A message starting with [routine] is a routine firing: do the work, and notify or email the owner only if the outcome is worth it.",
						"Be brief.",
					].join("\n"),
				{ tag: false },
			),
			section("today", () => today(new Date()), { tag: false }),
		],
	}),
);
registry.install(traceExtension);
const AGENT = { model: MODEL, thinkingLevel: "medium" } as const;
registry.install(createBotsExtension({ agent: () => AGENT }));
registry.install(createComputerExtension());
registry.install(createBotToolSearchExtension());
// Web Push to every browser that turned notifications on in the web app (data/push.json).
const push = createPush({ file: join(DATA_DIR, "push.json"), log });
// Every Cua Spaces tool, deferred until tool_search loads it. The rest of the bot works without the cua CLI.
const cuaCommand = process.env.CUA_MCP_COMMAND?.trim() || defaultCuaCommand();
try {
	registry.install(await createCuaExtension(connectCua(cuaCommand), { pairedSpace: spaceId(), notified: (note) => void push.send(note) }));
} catch (error) {
	log(`cua: \`${cuaCommand} mcp\` failed (${error instanceof Error ? error.message : String(error)}); Cua Spaces tools are off`);
}
registry.install(createRoutinesExtension());
const memory = createMemory({ dir: join(DATA_DIR, "memory") });
registry.install(createMemoryExtension(memory));
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

const storage = await openNodeSqliteStorage(join(DATA_DIR, "cua-bot.sqlite"));
const harness = await Harness.open(storage, { models, registry }, context);
const root = await harness.root(context, { agent: AGENT });
// root() sets the agent only when it creates the conversation; apply the configured model to an existing one too.
await root.commit((tx) => configure(tx, root.id, AGENT), context);
bindRoutines({ harness, root, legacyFile: LEGACY_ROUTINE_FILE });
harness.resume();
const synced = await syncRoutines(context);
log(
	`routines: ${synced.total} from ${routineDir()} (created ${synced.created}, updated ${synced.updated}, deleted ${synced.deleted}${synced.adopted ? ", adopted existing" : ""})`,
);
const stopWatching = startRoutineFileWatch(context, (error) =>
	log("routine file sync failed:", error instanceof Error ? error.message : String(error)),
);
log(`cua-bot up: model ${MODEL.provider}/${MODEL.modelId}, root ${root.id}`);

// Submits one owner message to the root conversation and returns the answer text.
async function say(text: string): Promise<string> {
	const submission = await root.submit({ type: "input", content: text }, context);
	const settled = await submission.wait(context);
	if (settled.status !== "done" || settled.type !== "input") return `(unanswered: ${settled.reason ?? "unknown"})`;
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
}

const space = spaceLabel();
const bots = await createBots({
	harness,
	root,
	context,
	agent: AGENT,
	// A renamed bot's routine file is renamed on the next sync; a deleted bot's routines go with it.
	renamed: () => syncRoutines(context),
	removing: (id) => removeBotRoutines(id, context),
	computer: (conversation) =>
		createComputerView({ harness, storage, conversation, shotsDir: join(DATA_DIR, "shots"), context, ...(space === undefined ? {} : { space }) }),
});
log(`bots: ${bots.list().map((bot) => bot.name).join(", ")}`);
createBotServer({ say, bots, memory, model: MODEL.modelId, context, log, viewer: viewerLink, push, ...(approvals === undefined ? {} : { approvals }) }).listen(PORT, "127.0.0.1", () =>
	log(`listening: web app http://127.0.0.1:${PORT}/ · chat POST http://127.0.0.1:${PORT}/say`),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		log(`${signal}: closing`);
		stopWatching();
		await bots.close();
		await harness.close(context);
		process.exit(0);
	});
}
