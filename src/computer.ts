// The paired Mac for every bot: space_bash runs CLI commands there directly, and computer_use runs a
// foreground child for on-screen work, one task at a time across all bots. The child gets every live driver tool of the Mac. They are deferred on this
// extension, so the main agent is offered them only after loading them with tool_search (src/main.ts installs it).
import { traceExtension } from "./trace.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { embedded } from "@trycua/cua";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	defineExtension,
	defineTool,
	type Extension,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { toLlmContent, type CallToolResult, type LlmContent } from "@earendil-works/pi-mcp";
import type { OpenLiveStream } from "./live-screen.ts";
import { botModel } from "./models.ts";

const SHOT_EDGE = 1200;
const SHOTS_DIR = join(import.meta.dirname, "..", "data", "shots");
const CHILD_BRIEF = [
	"Operate the Mac only with your tools.",
	"Take a screenshot first (get_desktop_state returns one).",
	"For clicks, pass screenshot pixel coordinates to the driver tool (its x and y). Do not convert points yourself.",
	"After each action, take another screenshot and verify it.",
	"Finish with a concise summary and the absolute path of the last screenshot.",
	"Image results include a line `saved: <path>`.",
].join(" ");

type ConnectedSpace = Awaited<ReturnType<ReturnType<ReturnType<typeof embedded>["spaces"]>["space"]>>;

type DriverInfo = {
	name: string;
	description: string;
	inputSchemaJson: string;
	readOnly: boolean;
};

// Used when the Mac's driver registry can't be listed. Normally the child gets every live driver tool.
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

const extensionTools: ToolRegistration[] = [];
let spacePromise: Promise<ConnectedSpace> | undefined;
let infosPromise: Promise<DriverInfo[]> | undefined;
let toolsPromise: Promise<void> | undefined;
let foundNames: string[] = [];
let registryKind: "live" | "fallback" = "fallback";
let toolService: string | undefined;
let listFailure: unknown;

const computerExtension: Extension = defineExtension({
	name: "computer",
	tools: extensionTools,
});

/** Installed by src/main.ts. The main agent is offered computer_use and space_bash; a foreground child runs the screen. */
export function createComputerExtension(): Extension {
	return computerExtension;
}

/** Used by test/computer.smoke.ts. Builds the child's driver tools from the live registry; the child also gets space_bash. */
export async function prepareComputerTools(): Promise<string[]> {
	await ensureDriverTools();
	return extensionTools.filter((tool) => tool.name !== "computer_use").map((tool) => tool.name);
}

/** Used by test/computer.smoke.ts. Names from the live driver registry, before space_bash is added. */
export async function listDriverToolNames(): Promise<string[]> {
	await driverInfos();
	if (listFailure !== undefined) throw listFailure;
	return foundNames;
}

/**
 * Used by test/computer.smoke.ts. One read-only capture, saved under data/shots.
 * Prefers get_desktop_state or screenshot from the driver; otherwise Space.screenshot.
 */
export async function captureScreenshot(): Promise<string> {
	const space = await connectSpace();
	const infos = await driverInfos();
	const chosen =
		registryKind === "live"
			? (infos.find((info) => info.name === "get_desktop_state") ?? infos.find((info) => info.name === "screenshot"))
			: undefined;
	if (chosen !== undefined) {
		const args = shotArgs(parseSchema(chosen.inputSchemaJson), {});
		const result = await space.callTool(chosen.name, JSON.stringify(args), toolService, undefined);
		const content = rememberShots(llmContent(result));
		const saved = firstSaved(content);
		if (saved !== undefined) return saved;
		const detail = result.text.replace(/\s+/g, " ").slice(0, 240);
		throw new Error(`${chosen.name} returned no image${detail.length > 0 ? `: ${detail}` : ""}`);
	}
	const shot = await space.screenshot({ maxDimension: SHOT_EDGE, includeCursor: false });
	return savePng(new Uint8Array(shot.image));
}

// Every bot shares the one Mac, so computer_use runs one task at a time across all of them.
let screen: Promise<unknown> = Promise.resolve();
function onScreen<T>(work: () => Promise<T>): Promise<T> {
	const run = screen.then(work);
	screen = run.catch(() => undefined);
	return run;
}

const computerUse = defineTool({
	name: "computer_use",
	description:
		"Delegate one on-screen task to the computer-use agent on the owner's Mac. It returns a short summary and the path of the last screenshot.",
	parameters: Type.Object({
		task: Type.String({ description: "What to do on the Mac, as a self-contained instruction" }),
	}),
	replay: "safe",
	executionMode: "sequential",
	execute: async ({ task }, api, callContext) => {
		await ensureDriverTools();
		const childTools = extensionTools.filter((tool) => tool.name !== "computer_use");
		const child = await api.commit(async (tx) => {
			const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
			const id = existing?.id ?? (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id;
			await configure(tx, id, {
				model: botModel(), // the bot's own model
				extensions: [traceExtension, computerExtension],
				tools: childTools,
				modelTools: childTools,
				instructions: CHILD_BRIEF,
			});
			return id;
		}, callContext);
		await api.details({ conversationId: child }, callContext);
		const handle = await api.conversation(child, callContext);
		if (handle === undefined) throw new Error("computer_use lost its child conversation");
		const request = { type: "input", content: `${CHILD_BRIEF}\n\nTask:\n${task}`, requestId: `computer:${api.taskId}` } as const;
		const settled = await onScreen(async () => (await handle.submit(request, callContext)).wait(callContext));
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

const spaceBash = defineTool({
	name: "space_bash",
	description:
		"Run a shell command on the owner's Mac (/bin/sh -c) and return its output. Use it for CLI tools, files, and inspection; use computer_use for anything on screen.",
	parameters: Type.Object({
		command: Type.String({ description: "Shell command" }),
	}),
	executionMode: "sequential",
	outputLimits: { maxBytes: 64 * 1024, maxLines: 2000, retain: "tail" },
	execute: async ({ command }) => {
		const space = await connectSpace();
		const result = await space.bash(command, undefined);
		const text = result.rendered.length > 0 ? result.rendered : fallbackBashText(result);
		return {
			output: [{ type: "text", text: text.length > 0 ? text : "(no output)" }],
			isError: result.timedOut || result.error !== undefined,
		};
	},
});

extensionTools.push(computerUse, spaceBash);

async function connectSpace(): Promise<ConnectedSpace> {
	spacePromise ??= openSpace().catch((error: unknown) => {
		spacePromise = undefined;
		throw error;
	});
	return spacePromise;
}

async function openSpace(): Promise<ConnectedSpace> {
	const id = process.env.CUA_SPACE_ID?.trim() || spaceIdFromRegistry();
	if (id === undefined || id.length === 0) {
		throw new Error("Set CUA_SPACE_ID or add a machine in ~/.cua/spaces.json");
	}
	return embedded().spaces().space(id);
}

/** Used by main.ts for the cua_* tools' prompt section. The paired Space's id. */
export function spaceId(): string | undefined {
	return process.env.CUA_SPACE_ID?.trim() || spaceIdFromRegistry();
}

function spaceIdFromRegistry(): string | undefined {
	return registrySpaces()[0]?.id;
}

/** Used by the web app's computer pane. The paired Space's display name, falling back to its id. */
export function spaceLabel(): string | undefined {
	const id = process.env.CUA_SPACE_ID?.trim() || spaceIdFromRegistry();
	const entry = registrySpaces().find((space) => space.id === id);
	return entry?.name ?? id;
}

/**
 * Used by the web app's Take control button (POST /api/computer/control). A link to the paired Mac in
 * cua-spacesd's HTML5 viewer (live video, mouse and keyboard, clipboard, file drop), good for an hour.
 * The viewer refuses to be framed, so the app opens it in a new tab.
 */
export async function viewerLink(): Promise<{ url: string; expiresAt: string }> {
	const client = await (await connectSpace()).spacesd();
	const minted: unknown = JSON.parse(
		await client.callJson(
			"/cua.env.v1.SystemService/CreateViewerTicket",
			JSON.stringify({ policy: "SESSION_POLICY_ALLOW_ACTIVATION", clipboard: true }),
			undefined,
		),
	);
	if (minted === null || typeof minted !== "object" || !("viewerPath" in minted) || typeof minted.viewerPath !== "string") {
		throw new Error("cua-spacesd returned no viewer link");
	}
	const expiresAt = "expiresAt" in minted && typeof minted.expiresAt === "string" ? minted.expiresAt : "";
	return { url: new URL(minted.viewerPath, client.endpoint()).href, expiresAt };
}

/**
 * Used by src/main.ts as createLiveScreen's opener (src/live-screen.ts). A view-only H.264 stream of the
 * Mac's primary display, decoded by the web app. The SDK's own streamSession needs the Cua Spaces app's
 * streaming client, so this mints a media ticket and attaches to it directly.
 */
export const openLiveStream: OpenLiveStream = async (sink) => {
	const space = await connectSpace();
	const ticket = await space.openStream({ codecs: ["h264"], maxFps: 15, maxDimension: 1280, audio: false, policy: "view_only" });
	const session = await space
		.attachStream(
			ticket,
			{
				// The SDK may reuse the buffer after onFrame returns, so each frame is copied out.
				onFrame: (frame) => sink.frame({ keyframe: frame.keyframe, data: new Uint8Array(frame.data.slice(0)) }),
				onEvent: (event) => {
					if (event.kind === "closed") sink.closed(`the Mac closed the live stream: ${event.json}`);
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
		close: async () => {
			await session.close().catch(() => {});
			await space.closeStream(ticket.mediaSessionId).catch(() => {});
		},
	};
};

function registrySpaces(): { id: string; name?: string }[] {
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
		const name = "name" in space && typeof space.name === "string" && space.name !== "" ? space.name : undefined;
		return [{ id: space.id, ...(name === undefined ? {} : { name }) }];
	});
}

function driverInfos(): Promise<DriverInfo[]> {
	infosPromise ??= fetchInfos().catch((error: unknown) => {
		infosPromise = undefined;
		throw error;
	});
	return infosPromise;
}

async function fetchInfos(): Promise<DriverInfo[]> {
	const space = await connectSpace();
	try {
		let listed = await space.listTools(undefined);
		toolService = undefined;
		if (!looksLikeDriver(listed) && space.services().includes("driver")) {
			const driver = await space.listTools("driver");
			if (driver.length > 0) {
				listed = driver;
				toolService = "driver";
			}
		}
		if (listed.length === 0) throw new Error("driver registry is empty");
		foundNames = listed.map((tool) => tool.name);
		registryKind = "live";
		listFailure = undefined;
		return listed;
	} catch (error) {
		foundNames = FALLBACK.map((tool) => tool.name);
		registryKind = "fallback";
		toolService = undefined;
		listFailure = error;
		return FALLBACK;
	}
}

function looksLikeDriver(tools: readonly { name: string }[]): boolean {
	const names = new Set(tools.map((tool) => tool.name));
	return names.has("click") || names.has("type_text") || names.has("get_desktop_state") || names.has("screenshot");
}

function ensureDriverTools(): Promise<void> {
	toolsPromise ??= populateDriverTools().catch((error: unknown) => {
		toolsPromise = undefined;
		throw error;
	});
	return toolsPromise;
}

async function populateDriverTools(): Promise<void> {
	const infos = await driverInfos();
	const used = new Set<string>(["computer_use", "space_bash"]);
	extensionTools.push(...infos.map((info) => driverTool(info, used)));
}

function driverTool(info: DriverInfo, used: Set<string>): ToolRegistration {
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
		executionMode: "sequential",
		outputLimits: { maxBytes: 256 * 1024, maxLines: 4000, retain: "tail" },
		execute: async (args) => {
			const space = await connectSpace();
			const callArgs = shotArgs(schema, args);
			const result = await space.callTool(info.name, JSON.stringify(callArgs), toolService, undefined);
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
 * drops screenshot_out_file: that writes the PNG on the Mac and returns no image, so the child would act blind and
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
