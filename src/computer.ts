// Every Cua Space the owner's Cua account lists, for every bot. space_bash runs CLI commands on one directly, space_read
// reads one of its files (Pi's read tool, images included, on a copy downloaded to this PC), and computer_use runs a
// foreground child for on-screen work there, one task at a time per Space. All three take `space`, a
// Space's name or id as Cua lists it; without it they use the default Space (CUA_SPACE_ID, else the first in
// ~/.cua/spaces.json). The SDK runtime signs in with the `cua auth login` session, so relay Spaces (a computer the Cua
// Spaces app shares, such as the one cua-bot runs on) open as well as direct ones. spacesText() names the Spaces in
// the prompt; tool descriptions stay generic.
// Each Space's driver tools live in their own extension, `space:<id>`, installed by the Space's first computer_use
// call. Two Spaces can both have a `click` with different schemas, so the child selects only its Space's extension,
// and the main agent never gets them: src/tool-search.ts skips them, and code mode can't call them.
// main.ts installs createComputerExtension(registry, images).
import { traceExtension } from "./trace.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { embedded } from "@trycua/cua";
import { Type } from "typebox";
import {
	AssistantEntry,
	configure,
	type ConversationId,
	type Cursor,
	defineDoc,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Extension,
	type Harness,
	type InputSubmissionDraft,
	LiveDoc,
	type Page,
	type Registry,
	type SettledSubmissionRecord,
	type ToolExecutionApi,
	ToolResultEntry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createReadTool, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { toLlmContent, type CallToolResult, type LlmContent } from "@earendil-works/pi-mcp";
import type { OpenLiveStream } from "./live-screen.ts";
import { botModel } from "./models.ts";
import { createScreenControl } from "./screen-control.ts";

const SHOT_EDGE = 1200;
const SHOTS_DIR = join(import.meta.dirname, "..", "data", "shots");
// The Space the live screen last moved to, so it shows the same one after a restart: `{ "space": "<id>" }`.
const SCREEN_FILE = join(import.meta.dirname, "..", "data", "screen.json");
const CHILD_BRIEF = [
	"Operate the computer only with your tools.",
	"Take a screenshot first (get_desktop_state returns one).",
	"For clicks, pass screenshot pixel coordinates to the driver tool (its x and y). Do not convert points yourself.",
	"After each action, take another screenshot and verify it.",
	"Finish with a concise summary and the absolute path of the last screenshot.",
	"Image results include a line `saved: <path>`.",
	"To look at an image file or read any file on the Space, use space_read; never open a file in an app just to see it.",
].join(" ");
const SPACE_ARG = "Which Cua Space: its name or id, as your prompt lists them. Omit it for the default Space (inside computer_use, the Space the task runs on).";

/** Prefix of each Space's driver extension. src/tool-search.ts keeps their tools out of the main agent's search. */
export const SPACE_EXTENSION = "space:";

type SpacesApi = ReturnType<ReturnType<typeof embedded>["spaces"]>;
type ConnectedSpace = Awaited<ReturnType<SpacesApi["space"]>>;

/** A Space as the bots address it: Cua's id, its display name, and its system. */
export type SpaceEntry = { id: string; name?: string; os?: string };

type DriverInfo = {
	name: string;
	description: string;
	inputSchemaJson: string;
	readOnly: boolean;
};

// Used when a Space's driver registry can't be listed. Normally the child gets every live driver tool.
const FALLBACK: DriverInfo[] = [
	{
		name: "screenshot",
		description: "Capture the screen as a PNG. The long edge is capped around 1200 pixels.",
		inputSchemaJson: JSON.stringify({
			type: "object",
			properties: { max_dimension: { type: "integer", description: "Long-edge cap in pixels" } },
		}),
		readOnly: true,
	},
	{
		name: "click",
		description: "Click at screenshot pixel coordinates.",
		inputSchemaJson: JSON.stringify({
			type: "object",
			properties: { x: { type: "number" }, y: { type: "number" } },
			required: ["x", "y"],
		}),
		readOnly: false,
	},
	{
		name: "type_text",
		description: "Type text into the focused field.",
		inputSchemaJson: JSON.stringify({
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		}),
		readOnly: false,
	},
	{
		name: "launch_app",
		description: "Launch an application by name.",
		inputSchemaJson: JSON.stringify({
			type: "object",
			properties: { name: { type: "string" } },
		}),
		readOnly: false,
	},
];

// The Space a computer_use child works on, so its space_bash defaults to that Space, after a restart too. Also read
// by the web portal's computer pane (taskSpaceName).
const ChildSpaceDoc = defineDoc<{ id: string; name: string }>({
	kind: "cua-bot.computer-space",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ id: "", name: "" }),
	checkpointWhen: () => false,
});

let spacesApi: SpacesApi | undefined;
const spaces = () => (spacesApi ??= embedded({ accountFromSession: true }).spaces());

/** `make()` once per key; a rejection is dropped, so the next call tries again. */
function once<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
	let value = cache.get(key);
	if (value === undefined) {
		value = make().catch((error: unknown) => {
			cache.delete(key);
			throw error;
		});
		cache.set(key, value);
	}
	return value;
}

const connections = new Map<string, Promise<ConnectedSpace>>();
const connectSpace = (id: string) => once(connections, id, () => spaces().space(id));

const computerTools: ToolRegistration[] = [];
const computerExtension: Extension = defineExtension({ name: "computer", tools: computerTools });
let registry: Pick<Registry, "install"> | undefined;

/**
 * Installed by src/main.ts into `into`, where each Space's driver extension is installed later. The main agent is
 * offered computer_use, space_bash and space_read; a foreground child runs the screen. `images` fits the images
 * space_read returns to the model's limits; without it, an image too large to send is refused.
 */
export function createComputerExtension(into: Pick<Registry, "install">, images?: ImageProcessor): Extension {
	registry = into;
	spaceRead = readFromSpace(createReadTool(images === undefined ? {} : { images }), downloadFromSpace);
	computerTools.splice(0, computerTools.length, computerUse, spaceBash, spaceRead);
	return computerExtension;
}

/** Every Space Cua lists, read fresh; ~/.cua/spaces.json when Cua can't answer. */
export async function listSpaces(): Promise<SpaceEntry[]> {
	try {
		return (await spaces().list()).map((space) => ({
			id: space.id,
			...(space.name === "" ? {} : { name: space.name }),
			...(space.osPrettyName || space.os ? { os: space.osPrettyName || space.os } : {}),
		}));
	} catch {
		return registrySpaces();
	}
}

/** The bots' default Space: CUA_SPACE_ID, else the first in ~/.cua/spaces.json. The live screen shows it until a task moves it. */
export function defaultSpaceId(): string | undefined {
	return process.env.CUA_SPACE_ID?.trim() || registrySpaces()[0]?.id;
}

const labels = new Map<string, Promise<string>>();

/** Used by main.ts for the computer pane. A Space's display name, falling back to its id; looked up once per Space. */
export function spaceLabel(id: string): Promise<string> {
	return once(labels, id, async () => (await listSpaces()).find((space) => space.id === id)?.name ?? id);
}

const homes = new Map<string, Promise<boolean>>();

/**
 * Used by main.ts for the computer pane. Whether the Space is the desktop of the computer cua-bot runs on: its spacesd
 * reports this computer's hostname. Asked once per Space; a Space that can't be reached is asked again next time.
 */
export function isThisComputer(id: string): Promise<boolean> {
	return once(homes, id, async () => {
		const { hostname: name } = JSON.parse((await connectSpace(id)).capabilitiesJson()) as { hostname?: string };
		return name?.toLowerCase() === hostname().toLowerCase();
	});
}

/** Used by preflight.ts. The default Space's display name, falling back to its id. */
export async function defaultSpaceLabel(): Promise<string | undefined> {
	const id = defaultSpaceId();
	return id === undefined ? undefined : spaceLabel(id);
}

/**
 * The Space `ref` names, by id or by display name in any case; without `ref`, the default. Exported for
 * test/computer.test.ts; resolveSpace() passes Cua's live list.
 */
export function pickSpace(listed: readonly SpaceEntry[], ref: string | undefined, fallback: string | undefined): SpaceEntry {
	const wanted = ref?.trim() || fallback;
	if (wanted === undefined) throw new Error("No Cua Space to use: add one in the Cua Spaces app, or set CUA_SPACE_ID");
	const byId = listed.find((space) => space.id === wanted);
	if (byId !== undefined) return byId;
	const named = listed.filter((space) => space.name?.toLowerCase() === wanted.toLowerCase());
	if (named.length === 1) return named[0]!;
	const known = listed.map((space) => describeSpace(space)).join("; ") || "none";
	if (named.length > 1) throw new Error(`${named.length} Spaces are named "${wanted}"; pass an id instead. Spaces: ${known}`);
	// A default Cua doesn't list (CUA_SPACE_ID naming a Space this account can't see) is still tried, so the SDK says why.
	if (!ref?.trim()) return { id: wanted };
	throw new Error(`No Cua Space "${wanted}". Spaces: ${known}`);
}

const resolveSpace = async (ref: string | undefined) => pickSpace(await listSpaces(), ref, defaultSpaceId());

/** A Space as the model reads it: `"name" (system, id <id>)`. */
function describeSpace(space: SpaceEntry, isDefault = false): string {
	const details = [space.os, `id ${space.id}`, isDefault ? "the default" : undefined].filter((part) => part !== undefined).join(", ");
	return `${space.name === undefined ? "" : `"${space.name}" `}(${details})`;
}

/** Used by main.ts's prompt. Every Space with its system and id, and which is the default; read on each request. */
export async function spacesText(): Promise<string> {
	const listed = await listSpaces();
	if (listed.length === 0) return "no Cua Space (Cua lists none)";
	const fallback = defaultSpaceId();
	return listed.map((space) => describeSpace(space, space.id === fallback)).join("; ");
}

/** Used by the web portal's computer pane. The name of the Space a computer_use child ran on. */
export async function taskSpaceName(reader: Pick<Harness, "snapshot">, child: ConversationId, context: Context): Promise<string | undefined> {
	return (await reader.snapshot(ChildSpaceDoc, child, context))?.name || undefined;
}

type Drivers = { infos: DriverInfo[]; service?: string; failure?: unknown };
const driverLists = new Map<string, Promise<Omit<Drivers, "failure">>>();

/** The Space's driver registry, kept once listed. Until it lists, FALLBACK, and the next call lists again. */
async function drivers(id: string): Promise<Drivers> {
	const space = await connectSpace(id);
	try {
		return await once(driverLists, id, async () => {
			const listed = await space.listTools(undefined);
			if (!looksLikeDriver(listed) && space.services().includes("driver")) {
				const driver = await space.listTools("driver");
				if (driver.length > 0) return { infos: driver, service: "driver" };
			}
			if (listed.length === 0) throw new Error("driver registry is empty");
			return { infos: listed };
		});
	} catch (failure) {
		return { infos: FALLBACK, failure };
	}
}

function looksLikeDriver(tools: readonly { name: string }[]): boolean {
	const names = new Set(tools.map((tool) => tool.name));
	return names.has("click") || names.has("type_text") || names.has("get_desktop_state") || names.has("screenshot");
}

const installed = new Map<string, { extension: Extension; live: boolean }>();

/** The Space's driver extension, installed on its first computer_use call and again once a FALLBACK one can list. */
async function spaceExtension(id: string): Promise<Extension> {
	const current = installed.get(id);
	if (current?.live) return current.extension;
	if (registry === undefined) throw new Error("createComputerExtension() was not given the registry");
	const { infos, service, failure } = await drivers(id);
	const used = new Set(["computer_use", "space_bash", "space_read"]);
	const extension = defineExtension({ name: `${SPACE_EXTENSION}${id}`, tools: infos.map((info) => driverTool(id, service, info, used)) });
	registry.install(extension);
	installed.set(id, { extension, live: failure === undefined });
	return extension;
}

/** Used by test/computer.smoke.ts. The child's tools on a Space: its driver tools, space_bash and space_read. */
export async function prepareComputerTools(ref?: string): Promise<string[]> {
	const extension = await spaceExtension((await resolveSpace(ref)).id);
	return [spaceBash, spaceRead, ...(extension.tools ?? [])].map((tool) => tool.name);
}

/** Used by test/computer.smoke.ts and preflight.ts. Names from a Space's live driver registry. */
export async function listDriverToolNames(ref?: string): Promise<string[]> {
	const { infos, failure } = await drivers((await resolveSpace(ref)).id);
	if (failure !== undefined) throw failure;
	return infos.map((info) => info.name);
}

/**
 * Used by test/computer.smoke.ts. One read-only capture on a Space, saved under data/shots.
 * Prefers get_desktop_state or screenshot from the driver; otherwise Space.screenshot.
 */
export async function captureScreenshot(ref?: string): Promise<string> {
	const { id } = await resolveSpace(ref);
	const space = await connectSpace(id);
	const { infos, service, failure } = await drivers(id);
	const chosen =
		failure === undefined
			? (infos.find((info) => info.name === "get_desktop_state") ?? infos.find((info) => info.name === "screenshot"))
			: undefined;
	if (chosen !== undefined) {
		const args = shotArgs(parseSchema(chosen.inputSchemaJson), {});
		const result = await space.callTool(chosen.name, JSON.stringify(args), service, undefined);
		const content = rememberShots(llmContent(result));
		const saved = firstSaved(content);
		if (saved !== undefined) return saved;
		const detail = result.text.replace(/\s+/g, " ").slice(0, 240);
		throw new Error(`${chosen.name} returned no image${detail.length > 0 ? `: ${detail}` : ""}`);
	}
	const shot = await space.screenshot({ maxDimension: SHOT_EDGE, includeCursor: false });
	return savePng(new Uint8Array(shot.image));
}

function savedScreen(): string | undefined {
	try {
		const { space } = JSON.parse(readFileSync(SCREEN_FILE, "utf8")) as { space?: unknown };
		return typeof space === "string" && space !== "" ? space : undefined;
	} catch {
		return undefined;
	}
}

const saved = savedScreen();

/**
 * Used by src/main.ts for the web portal's live screen and Take control. It shows the Space a computer_use task last
 * started on (kept in data/screen.json), else the default. While the owner has control, every driver call on that
 * Space waits.
 */
export const screenControl = createScreenControl({
	space: () => saved ?? defaultSpaceId(),
	shown: (space) => {
		mkdirSync(join(SCREEN_FILE, ".."), { recursive: true });
		writeFileSync(SCREEN_FILE, `${JSON.stringify({ space })}\n`);
	},
});

// Bots that share a Space share its screen, so computer_use runs one task at a time on each Space.
const screens = new Map<string, Promise<unknown>>();
function onScreen<T>(id: string, work: () => Promise<T>): Promise<T> {
	const run = (screens.get(id) ?? Promise.resolve()).then(() => screenControl.drive(id, work));
	screens.set(id, run.catch(() => undefined));
	return run;
}

const computerUse = defineTool({
	name: "computer_use",
	description:
		"Delegate one on-screen task to a computer-use agent on a Cua Space. It returns a short summary and the path of the last screenshot.",
	parameters: Type.Object({
		task: Type.String({ description: "What to do on the Space's computer, as a self-contained instruction" }),
		space: Type.Optional(Type.String({ description: SPACE_ARG })),
	}),
	replay: "safe",
	executionMode: "sequential",
	execute: async ({ task, space: ref }, api, callContext) => {
		const space = await resolveSpace(ref);
		const extension = await spaceExtension(space.id);
		const childTools = [spaceBash, spaceRead, ...(extension.tools ?? [])];
		const instructions = `${CHILD_BRIEF} You work on the Cua Space ${describeSpace(space)}.`;
		// The child thinks like the bot that called it.
		const { model = botModel(), thinkingLevel } = await api.agent(callContext);
		const child = await api.commit(async (tx) => {
			const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
			const id = existing?.id ?? (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id;
			await configure(tx, id, {
				model,
				thinkingLevel,
				extensions: [traceExtension, computerExtension, extension],
				tools: childTools,
				modelTools: childTools,
				instructions,
			});
			Object.assign(await tx.doc(ChildSpaceDoc, id), { id: space.id, name: space.name ?? space.id });
			return id;
		}, callContext);
		await api.details({ conversationId: child, space: space.name ?? space.id }, callContext);
		const request = { type: "input", content: `${instructions}\n\nTask:\n${task}`, requestId: `computer:${api.taskId}` } as const;
		const settled = await runComputerTask(api, child, request, callContext, (work) => onScreen(space.id, work));
		if (settled === "stopped") {
			return { output: [{ type: "text", text: await stoppedReport(api, child, callContext) }], details: { conversationId: child } };
		}
		if (settled.status !== "done" || settled.type !== "input") {
			throw new Error(`computer_use failed: ${settled.status}`);
		}
		const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), callContext);
		const message = entry?.model?.[0];
		const text = message?.role === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") : "";
		return {
			output: [{ type: "text", text: text.length > 0 ? text : "(computer-use agent returned no text)" }],
			details: { conversationId: child },
		};
	},
});

// How to stop each computer_use call in progress, by its child conversation. Filled by runComputerTask().
const stops = new Map<ConversationId, () => void>();

/**
 * Used by src/chat.ts when the owner steers a bot. Ends the computer_use call driving `child` as soon as the child's
 * action in progress returns, so the bot reads the owner's message next. Does nothing when no call drives `child`.
 */
export function stopComputerTask(child: ConversationId): void {
	stops.get(child)?.();
}

/**
 * Runs `request` in computer_use's child conversation `child` and returns its settled submission, or "stopped" when
 * stopComputerTask() ended it first. `queue` holds the run until the Space's screen is free; a call stopped while it
 * waits never starts. Used by computer_use, and by tests shaped like it.
 */
export async function runComputerTask(
	api: Pick<ToolExecutionApi, "conversation" | "watchDoc">,
	child: ConversationId,
	request: InputSubmissionDraft,
	context: Context,
	queue = <T>(work: () => Promise<T>) => work(),
): Promise<SettledSubmissionRecord | "stopped"> {
	const stop = Promise.withResolvers<"stopped">();
	let stopped = false;
	stops.set(child, () => {
		stopped = true;
		stop.resolve("stopped");
	});
	try {
		return await queue(async () => {
			if (stopped) return "stopped";
			const handle = await api.conversation(child, context);
			if (handle === undefined) throw new Error("computer_use lost its child conversation");
			const settled = (await handle.submit(request, context)).wait(context);
			const first = await Promise.race([settled, stop.promise]);
			if (first !== "stopped") return first;
			await actionEnds(api, child, context);
			await handle.abort(context);
			const last = await settled;
			return last.status === "done" ? last : "stopped";
		});
	} finally {
		stops.delete(child);
	}
}

// Resolves once none of `child`'s tool calls is running: at once while its model thinks or between two calls, else when
// the call in progress returns.
async function actionEnds(api: Pick<ToolExecutionApi, "watchDoc">, child: ConversationId, context: Context): Promise<void> {
	const idle = (live: { tools?: readonly { status: string }[] } | undefined) => !live?.tools?.some((tool) => tool.status === "running");
	const watch = await api.watchDoc(LiveDoc, child, context);
	if (watch === undefined || idle(watch.value)) {
		await watch?.stop();
		return;
	}
	const ended = Promise.withResolvers<void>();
	watch.start(async (call) => {
		if (call.kind === "value" && idle(call.value)) ended.resolve();
	});
	await ended.promise;
	await watch.stop();
}

/** What computer_use answers when the owner's steer stopped it: that it stopped, and the steps its child took. */
export async function stoppedReport(api: Pick<ToolExecutionApi, "commit">, child: ConversationId, context: Context): Promise<string> {
	const steps = await stepsOf((cursor) => api.commit((tx) => tx.scanEntries({ conversationId: child, order: "ascending" }, 200, cursor), context));
	const lines = steps.map((step) => `- ${step.name}${step.detail === "" ? "" : ` ${step.detail}`}${step.status === "done" ? "" : ` (${step.status === "error" ? "failed" : "cut off"})`}`);
	return [
		"Stopped early: the owner sent you a new message, which follows. The task is unfinished; the screen is as the last step left it.",
		lines.length === 0 ? "No step was taken." : `Steps taken:\n${lines.join("\n")}`,
	].join("\n");
}

const MAX_STEPS = 40;
const DETAIL_LIMIT = 80;

/** One tool call of a computer_use child, for the portal's step log (src/computer-view.ts) and stoppedReport(). */
export type ComputerStep = { callId: string; name: string; detail: string; at: number; status: "running" | "done" | "error" };

const clipDetail = (text: string) => (text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text);

/** A short human summary of a driver call's arguments, for one line of the step log. */
export function stepDetail(args: Record<string, unknown>): string {
	for (const key of ["text", "app_name", "name", "bundle_id", "element_description", "query", "url", "keys", "key", "command"]) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return clipDetail(key === "text" ? `"${value}"` : value);
		if (Array.isArray(value) && value.length > 0) return clipDetail(value.join("+"));
	}
	if (typeof args.x === "number" && typeof args.y === "number") return `at ${args.x}, ${args.y}`;
	// The driver's session label and image sizing say nothing about what the step did.
	const { session: _session, max_image_dimension: _a, max_dimension: _b, maxDimension: _c, ...meaningful } = args;
	const rest = JSON.stringify(meaningful);
	return rest === "{}" ? "" : clipDetail(rest);
}

/** The last MAX_STEPS tool calls of a child conversation, oldest first; `page` reads its entries in ascending order. */
export async function stepsOf(page: (cursor: Cursor | undefined) => Promise<Page<EntryRecord, Cursor>>): Promise<ComputerStep[]> {
	const steps = new Map<string, ComputerStep>();
	let cursor: Cursor | undefined;
	do {
		const { items, next } = await page(cursor);
		for (const entry of items) {
			const message = entry.model?.[0];
			if (AssistantEntry.is(entry) && message?.role === "assistant") {
				const reply = message as AssistantMessage;
				for (const part of reply.content) {
					if (part.type !== "toolCall") continue;
					steps.set(part.id, {
						callId: part.id,
						name: part.name,
						detail: stepDetail(part.arguments as Record<string, unknown>),
						at: reply.timestamp,
						status: "running",
					});
				}
			} else if (ToolResultEntry.is(entry) && message?.role === "toolResult") {
				const result = message as ToolResultMessage;
				const step = steps.get(result.toolCallId);
				if (step !== undefined) step.status = result.isError ? "error" : "done";
			}
		}
		cursor = next;
	} while (cursor !== undefined);
	return [...steps.values()].slice(-MAX_STEPS);
}

const spaceBash = defineTool({
	name: "space_bash",
	description:
		"Run a shell command on a Cua Space (/bin/sh -c; cmd.exe /C on Windows) and return its output. Use it for CLI tools, files, and inspection; use computer_use for anything on screen.",
	parameters: Type.Object({
		command: Type.String({ description: "Shell command" }),
		space: Type.Optional(Type.String({ description: SPACE_ARG })),
	}),
	executionMode: "sequential",
	outputLimits: { maxBytes: 64 * 1024, maxLines: 2000, retain: "tail" },
	execute: async ({ command, space: ref }, api, context) => {
		const space = await callSpace(ref, api, context);
		const result = await space.bash(command, undefined);
		const text = result.rendered.length > 0 ? result.rendered : fallbackBashText(result);
		return {
			output: [{ type: "text", text: text.length > 0 ? text : "(no output)" }],
			isError: result.timedOut || result.error !== undefined,
		};
	},
});

/** The Space `ref` names; without it, a computer_use child's own Space, else the default. */
async function callSpace(ref: string | undefined, api: ToolExecutionApi, context: Context) {
	const own = ref?.trim() ? undefined : (await api.snapshot(ChildSpaceDoc, api.conversationId, context))?.id;
	return connectSpace(own || (await resolveSpace(ref)).id);
}

/** Copies a Space's file into `dir` on this PC and returns the copy's path. */
export type SpaceDownload = (file: { path: string; space?: string }, dir: string, api: ToolExecutionApi, context: Context) => Promise<string>;

async function downloadFromSpace(...[{ path, space: ref }, dir, api, context]: Parameters<SpaceDownload>) {
	const space = await callSpace(ref, api, context);
	return (await space.download(path, dir, undefined)).dest;
}

/**
 * Pi's `read` as space_read: `download` copies the Space's file into a fresh temp folder on this PC, `read` runs on
 * the copy, and the folder is removed. So text, images and their resizing are all Pi's own. Exported for
 * test/computer.test.ts; createComputerExtension downloads with the cua SDK.
 */
export function readFromSpace(read: ToolRegistration, download: SpaceDownload): ToolRegistration {
	const { properties } = read.parameters as { properties: Record<string, unknown> };
	return {
		...read,
		name: "space_read",
		description: `Read a file on a Cua Space, by its absolute path there. ${read.description}`,
		// Plain JSON Schema extends read's own, keeping its required list, so `space` stays optional.
		parameters: {
			...read.parameters,
			properties: {
				...properties,
				path: { type: "string", description: "Absolute path of the file on the Space" },
				space: { type: "string", description: SPACE_ARG },
			},
		},
		execute: async (args, api, context) => {
			const { space, ...rest } = args as typeof args & { path: string; space?: string };
			const dir = await mkdtemp(join(tmpdir(), "cua-bot-space-read-"));
			try {
				const copy = await download({ path: rest.path, ...(space === undefined ? {} : { space }) }, dir, api, context);
				// Relative to the temp folder, so what read says about the file names the file, not the folder.
				const local: ToolExecutionApi = Object.create(api, { env: { value: new NodeExecutionEnv({ cwd: dir }) } });
				return await read.execute({ ...rest, path: relative(dir, copy) }, local, context);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	};
}

// Replaced by createComputerExtension with one that has main.ts's image processor.
let spaceRead = readFromSpace(createReadTool(), downloadFromSpace);

/**
 * Used by src/main.ts as createLiveScreen's opener (src/live-screen.ts). An H.264 stream of the primary display of the
 * Space screenControl shows (the default when that Space is gone from Cua's list), decoded by the web portal, that also
 * takes the owner's input while they have control. The SDK's own streamSession needs the Cua Spaces app's streaming
 * client, so this mints a media ticket and attaches to it directly.
 */
export const openLiveStream: OpenLiveStream = async (sink) => {
	const listed = await listSpaces();
	const shown = listed.some((space) => space.id === screenControl.space) ? screenControl.space : undefined;
	const space = await connectSpace(pickSpace(listed, shown, defaultSpaceId()).id);
	const ticket = await space.openStream({ codecs: ["h264"], maxFps: 15, maxDimension: 0, audio: false, policy: "allow_activation" });
	// Input batches carry contiguous sequence numbers; the first one on a socket may start anywhere, and after a
	// gap cua-spacesd names the sequence it expects next.
	let sequence = 1;
	const session = await space
		.attachStream(
			ticket,
			{
				// The SDK may reuse the buffer after onFrame returns, so each frame is copied out.
				onFrame: (frame) => sink.frame({ keyframe: frame.keyframe, data: new Uint8Array(frame.data.slice(0)) }),
				onEvent: (event) => {
					if (event.kind === "closed") sink.closed(`the Space closed the live stream: ${event.json}`);
					if (event.kind === "error") {
						const { code, expected_sequence } = (JSON.parse(event.json) as { payload?: { code?: string; expected_sequence?: number } }).payload ?? {};
						if (code === "input_sequence_gap" && expected_sequence !== undefined) sequence = expected_sequence;
					}
				},
			},
			undefined,
		)
		.catch(async (error: unknown) => {
			await space.closeStream(ticket.mediaSessionId).catch(() => {});
			throw error;
		});
	return {
		requestKeyframe: () => void session.requestKeyframe().catch(() => {}),
		input: (events) => {
			// 256 events is the protocol's bound on one batch.
			for (let i = 0; i < events.length; i += 256) {
				const batch = events.slice(i, i + 256);
				const message = { type: "interactive_input", payload: { session_id: session.sessionId(), first_sequence: sequence, events: batch } };
				try {
					session.sendControl(JSON.stringify(message));
				} catch {
					return; // the socket closed, and its close event ends the viewers
				}
				sequence += batch.length;
			}
		},
		close: async () => {
			await session.close().catch(() => {});
			await space.closeStream(ticket.mediaSessionId).catch(() => {});
		},
	};
};

/** The Spaces added in ~/.cua/spaces.json (or $CUA_HOME), read fresh. listSpaces's and src/connections.ts's fallback. */
export function registrySpaces(): SpaceEntry[] {
	const home = process.env.CUA_HOME?.trim() || join(homedir(), ".cua");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(home, "spaces.json"), "utf8"));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((space: unknown) => {
		if (space === null || typeof space !== "object" || !("id" in space) || typeof space.id !== "string" || space.id === "") return [];
		const text = (key: string) => {
			const value: unknown = (space as Record<string, unknown>)[key];
			return typeof value === "string" && value !== "" ? value : undefined;
		};
		const name = text("name");
		const os = text("osPrettyName") ?? text("os");
		return [{ id: space.id, ...(name === undefined ? {} : { name }), ...(os === undefined ? {} : { os }) }];
	});
}

/** One driver tool of Space `id`, for its computer_use child alone. */
function driverTool(id: string, service: string | undefined, info: DriverInfo, used: Set<string>): ToolRegistration {
	const name = sanitizeToolName(info.name, used);
	const schema = parseSchema(info.inputSchemaJson);
	const { screenshot_out_file: _, ...properties } = objectProperties(schema.properties); // shotArgs drops it anyway
	const description = clip(info.description.trim().length > 0 ? info.description.trim() : `Driver tool ${info.name}`);
	const labeled = name === info.name ? description : `${description}\n(driver tool ${info.name})`;
	return defineTool({
		name,
		description: labeled,
		parameters: Type.Unsafe<Record<string, unknown>>({
			...schema,
			type: "object",
			properties,
		}),
		deferred: true,
		// Code mode would reach whichever Space's `click` the registry resolves last, so only the child's model calls them.
		callers: ["model"],
		executionMode: "sequential",
		outputLimits: { maxBytes: 256 * 1024, maxLines: 4000, retain: "tail" },
		execute: async (args) => {
			await screenControl.botTurn(id);
			const space = await connectSpace(id);
			const callArgs = shotArgs(schema, args);
			const result = await space.callTool(info.name, JSON.stringify(callArgs), service, undefined);
			const output = rememberShots(llmContent(result));
			if (output.length === 0) output.push({ type: "text", text: result.text.length > 0 ? result.text : "(no output)" });
			return { output, isError: result.isError };
		},
	});
}

function fallbackBashText(result: { stdout: string; stderr: string; error?: string; exitCode?: number }): string {
	const parts = [result.stdout, result.stderr.length > 0 ? `[stderr]\n${result.stderr}` : "", result.error ?? ""];
	if (result.exitCode !== undefined) parts.push(`[exit ${result.exitCode}]`);
	return parts.filter((part) => part.length > 0).join("\n");
}

function sanitizeToolName(name: string, used: Set<string>): string {
	const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
	const base = cleaned.length > 0 ? cleaned : "tool";
	let candidate = base;
	let n = 2;
	while (used.has(candidate) || !/^[A-Za-z0-9_-]{1,64}$/.test(candidate)) {
		const suffix = `_${n++}`;
		candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
	}
	used.add(candidate);
	return candidate;
}

function parseSchema(json: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(json);
		if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// A broken schema still becomes an object the model can call.
	}
	return {};
}

function objectProperties(value: unknown): Record<string, unknown> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	return {};
}

/**
 * Used before every driver call (and by captureScreenshot). Caps the screenshot edge unless the model set one, and
 * drops screenshot_out_file: that writes the PNG on the Space and returns no image, so the child would act blind and
 * nothing would reach data/shots.
 */
export function shotArgs(schema: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
	const properties = objectProperties(schema.properties);
	const { screenshot_out_file: _, ...next } = args;
	if ("max_image_dimension" in properties && next.max_image_dimension === undefined) next.max_image_dimension = SHOT_EDGE;
	else if ("max_dimension" in properties && next.max_dimension === undefined) next.max_dimension = SHOT_EDGE;
	else if ("maxDimension" in properties && next.maxDimension === undefined) next.maxDimension = SHOT_EDGE;
	return next;
}

function llmContent(result: { contentJson: string; structuredJson?: string; text: string }): LlmContent[] {
	let raw: unknown = [];
	try {
		raw = JSON.parse(result.contentJson);
	} catch {
		raw = [];
	}
	let structuredContent: unknown;
	if (result.structuredJson !== undefined && result.structuredJson.length > 0) {
		try {
			structuredContent = JSON.parse(result.structuredJson);
		} catch {
			structuredContent = undefined;
		}
	}
	const content = normalizeContent(raw);
	const llm = toLlmContent({ content, structuredContent });
	if (llm.length === 0 && result.text.length > 0) llm.push({ type: "text", text: result.text });
	return llm;
}

function normalizeContent(raw: unknown): CallToolResult["content"] {
	if (!Array.isArray(raw)) return [];
	const blocks: CallToolResult["content"] = [];
	for (const part of raw) {
		if (part === null || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			blocks.push({ type: "text", text: record.text });
			continue;
		}
		if (record.type === "image" && typeof record.data === "string") {
			const mime = record.mimeType ?? record.mime_type;
			blocks.push({ type: "image", data: record.data, mimeType: typeof mime === "string" ? mime : "image/png" });
			continue;
		}
		const resource = record.resource;
		if (record.type === "resource" && resource !== null && typeof resource === "object") {
			const body = resource as Record<string, unknown>;
			if (typeof body.uri !== "string") continue;
			if (typeof body.text === "string") {
				blocks.push({ type: "resource", resource: { uri: body.uri, text: body.text } });
			} else if (typeof body.blob === "string") {
				blocks.push({
					type: "resource",
					resource: {
						uri: body.uri,
						blob: body.blob,
						...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
					},
				});
			}
		}
	}
	return blocks;
}

function rememberShots(content: LlmContent[]): LlmContent[] {
	const paths: string[] = [];
	for (const block of content) {
		if (block.type !== "image") continue;
		const bytes = decodeImage(block.data);
		if (bytes.length === 0 || !isPng(bytes)) continue;
		paths.push(savePng(bytes));
	}
	if (paths.length === 0) return content;
	const line = paths.map((path) => `saved: ${path}`).join("\n");
	const lastText = content.findLast((block) => block.type === "text");
	if (lastText?.type === "text") lastText.text = lastText.text.length > 0 ? `${lastText.text}\n${line}` : line;
	else content.push({ type: "text", text: line });
	return content;
}

function firstSaved(content: readonly LlmContent[]): string | undefined {
	for (const block of content) {
		if (block.type !== "text") continue;
		const match = block.text.match(/saved: (.+)/);
		if (match?.[1] !== undefined) return match[1];
	}
	return undefined;
}

function decodeImage(data: string): Uint8Array {
	const payload = data.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
	return Buffer.from(payload, "base64");
}

function isPng(bytes: Uint8Array): boolean {
	return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function savePng(bytes: Uint8Array): string {
	mkdirSync(SHOTS_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	let file = join(SHOTS_DIR, `${stamp}.png`);
	let n = 2;
	while (existsSync(file)) file = join(SHOTS_DIR, `${stamp}-${n++}.png`);
	writeFileSync(file, bytes);
	return file;
}

function clip(text: string): string {
	return text.length <= 1000 ? text : `${text.slice(0, 1000)}…`;
}
