// grokbot service entry point. Run with `pnpm start` (or start.py). Opens the Pi Durable Harness on
// data/grokbot.sqlite, resumes any unfinished or sleeping work, and accepts owner messages on
// POST http://127.0.0.1:43142/say (body: plain text; reply: the bot's answer as plain text).
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createComputerExtension } from "./computer.ts";
import { createEmailExtension } from "./email.ts";
import { DATA_DIR, log } from "./log.ts";
import { bindRoutines, createRoutinesExtension } from "./routines.ts";
import { traceExtension } from "./trace.ts";
import { createBotModels } from "./xai-auth.ts";

export const MODEL = { provider: "xai", modelId: process.env.GROKBOT_MODEL || "grok-4.7" } as const;
const PORT = Number(process.env.GROKBOT_PORT || 43142);
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
const models = createBotModels(); // xAI subscription sign-in from `node src/login.ts`, else XAI_API_KEY

const registry = createRegistry();
registry.install(
	defineExtension({
		name: "persona",
		sections: [
			section(
				"preamble",
				() =>
					[
						"You are Grokbot, a self-hosted personal agent that runs 24/7 for one owner.",
						`The owner's email is ${process.env.OWNER_EMAIL || "(unset)"}. Email is how you reach the owner when they are not chatting with you.`,
						"You never operate a computer yourself: delegate every on-screen task to computer_use, one at a time.",
						"For recurring or future work, create a routine with schedule. A message starting with [routine] is a routine firing: do the work, and email the owner only if the outcome is worth it.",
						"Be brief.",
					].join("\n"),
				{ tag: false },
			),
		],
	}),
);
registry.install(traceExtension);
registry.install(createComputerExtension());
registry.install(createEmailExtension());
registry.install(createRoutinesExtension());

const harness = await Harness.open(await openNodeSqliteStorage(join(DATA_DIR, "grokbot.sqlite")), { models, registry }, context);
const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "medium" } });
bindRoutines(harness); // lets cancel_routine abort tasks on this Harness
harness.resume();
log(`grokbot up: model ${MODEL.provider}/${MODEL.modelId}, root ${root.id}`);

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

createServer(async (req, res) => {
	if (req.method !== "POST" || req.url !== "/say") return void res.writeHead(404).end();
	req.setEncoding("utf8");
	let body = "";
	for await (const chunk of req) body += chunk;
	log("owner:", body);
	try {
		const answer = await say(body);
		log("bot:", answer);
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(answer);
	} catch (error) {
		log("say failed:", String(error));
		res.writeHead(500).end(String(error));
	}
}).listen(PORT, "127.0.0.1", () => log(`listening on http://127.0.0.1:${PORT}/say`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		log(`${signal}: closing`);
		await harness.close(context);
		process.exit(0);
	});
}
