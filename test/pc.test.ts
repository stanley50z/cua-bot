// The PC tools and code mode: a codemode script calls bash and read, which act on this computer through
// pcEnv, and only the script's output reaches the model. Run from the repo root:  node --test test/pc.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createMachines } from "../src/machines.ts";
import { createPcExtensions, pcEnv } from "../src/pc.ts";

const context = BACKGROUND_CONTEXT;

const toolText = (messages: Message[]) => {
	const result = messages.findLast((m) => m.role === "toolResult");
	return result?.role === "toolResult" ? result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : "";
};

test("a codemode script runs bash and read on the PC", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "cua-bot-pc-"));
	const note = join(dir, "note.txt");
	await writeFile(note, "Job Package lives here\n");
	const code = [
		`const shell = await tools.bash({ command: "echo hi-from-bash" });`,
		`console.log(shell.output.trim(), shell.exitCode);`,
		`const file = await tools.read({ path: ${JSON.stringify(note)} });`,
		`console.log(JSON.stringify(file));`,
	].join("\n");
	let seen = "";
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "c1" })], { stopReason: "toolUse" }),
		(request) => {
			seen = toolText(request.messages);
			return fauxAssistantMessage([fauxText("Done.")]);
		},
	]);
	const registry = createRegistry();
	for (const extension of createPcExtensions()) registry.install(extension);
	registry.install(createMachines().extension);
	const harness = await Harness.open(new MemoryStorage(), { models, registry, env: pcEnv }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const settled = await (await root.submit({ type: "input", content: "check the PC" }, context)).wait(context);
		assert.equal(settled.status, "done");
		assert.match(seen, /hi-from-bash 0/, "bash ran on this computer");
		assert.match(seen, /Job Package lives here/, "read returned the file");
	} finally {
		await harness.close(context);
		await rm(dir, { recursive: true, force: true });
	}
});
