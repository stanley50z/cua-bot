// The coding tools' `machine` argument: a call that names an SSH destination runs Pi's own tool on that machine's
// environment; one that names none runs on the conversation's.
// Run from the repo root:  node --test test/machines.test.ts
// Live, over SSH to a real machine:  CUABOT_TEST_MACHINE=<an ssh alias of yours> node --test test/machines.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, type JsonObject, MemoryStorage, type Extension } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { createMachines, sshHosts, withMachine } from "../src/machines.ts";

const context = BACKGROUND_CONTEXT;

const toolText = (messages: Message[]) => {
	const result = messages.findLast((m) => m.role === "toolResult");
	return result?.role === "toolResult" ? result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : "";
};

/** One turn: the model calls `tool` with `args`, and the result text it then sees is returned. */
async function callOnce(extension: Extension, cwd: string, tool: string, args: JsonObject) {
	let seen = "";
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall(tool, args, { id: "c1" })], { stopReason: "toolUse" }),
		(request) => {
			seen = toolText(request.messages);
			return fauxAssistantMessage([fauxText("Done.")]);
		},
	]);
	const registry = createRegistry();
	registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		assert.equal(settled.status, "done");
		return seen;
	} finally {
		await harness.close(context);
	}
}

test("the prompt's hosts are the ssh config's Host aliases, without patterns", () => {
	const config = "Host box\n  HostName 10.0.0.2\nHost nas backup\nHost *.lan !evil\nhost lower\nMatch all\n";
	assert.deepEqual(sshHosts(config), ["box", "nas", "backup", "lower"]);
	assert.deepEqual(sshHosts(""), []);
});

test("one read tool acts on this computer, or on the SSH destination a call names", { timeout: 60_000 }, async () => {
	const here = await mkdtemp(join(tmpdir(), "cua-bot-here-"));
	const there = await mkdtemp(join(tmpdir(), "cua-bot-there-"));
	try {
		await writeFile(join(here, "note.txt"), "the PC's note\n");
		await writeFile(join(there, "note.txt"), "the other machine's note\n");
		const asked: string[] = [];
		const read = withMachine(createReadTool(), async (machine) => {
			asked.push(machine);
			return new NodeExecutionEnv({ cwd: there });
		});
		assert.equal(read.name, "read");
		const box = defineExtension({ name: "box", tools: [read] });
		const remote = await callOnce(box, here, "read", { path: "note.txt", machine: "me@box" });
		assert.match(remote, /the other machine's note/);
		const local = await callOnce(box, here, "read", { path: "note.txt" });
		assert.match(local, /the PC's note/);
		const option = await callOnce(box, here, "read", { path: "note.txt", machine: "-oProxyCommand=calc" });
		assert.match(option, /is not an SSH destination/);
		assert.deepEqual(asked, ["me@box"], "the destination is passed through as given; an option never reaches ssh");
	} finally {
		await rm(here, { recursive: true, force: true });
		await rm(there, { recursive: true, force: true });
	}
});

const live = process.env.CUABOT_TEST_MACHINE;
test("bash runs on the live machine over SSH", { skip: live === undefined && "set CUABOT_TEST_MACHINE", timeout: 180_000 }, async () => {
	const machines = createMachines();
	try {
		const seen = await callOnce(machines.extension, tmpdir(), "bash", { command: "uname -s; pwd; command -v brew || true", machine: live ?? "" });
		console.log(seen);
		assert.match(seen, /Darwin|Linux|MINGW|MSYS/);
	} finally {
		machines.close();
	}
});
