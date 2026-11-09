// What the web portal's computer pane shows: the default Space's name, the newest screenshot, and the
// driver steps of the bot's most recent computer_use run, with the Space it ran on. src/bots.ts builds one per bot with
// createComputerView() and hands it to createChat(), which pushes fresh snapshots while a computer_use
// call is running. computer_use runs its driver calls in a child conversation of the bot's (src/computer.ts),
// so the newest conversation the bot owns is its latest run.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	type Cursor,
	type Harness,
	type Storage,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { taskSpaceName } from "./computer.ts";

const MAX_STEPS = 40;
const DETAIL_LIMIT = 80;

export type ComputerStep = { callId: string; name: string; detail: string; at: number; status: "running" | "done" | "error" };
export type ComputerSnapshot = {
	/** The default Space, which the live screen shows. */
	space?: string;
	/** The Space the steps ran on. */
	taskSpace?: string;
	shot?: { name: string; at: number };
	steps: ComputerStep[];
};

const clip = (text: string) => (text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text);

/** A short human summary of a driver call's arguments, for one line of the step log. */
export function stepDetail(args: Record<string, unknown>): string {
	for (const key of ["text", "app_name", "name", "bundle_id", "element_description", "query", "url", "keys", "key", "command"]) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return clip(key === "text" ? `"${value}"` : value);
		if (Array.isArray(value) && value.length > 0) return clip(value.join("+"));
	}
	if (typeof args.x === "number" && typeof args.y === "number") return `at ${args.x}, ${args.y}`;
	// The driver's session label and image sizing say nothing about what the step did.
	const { session: _session, max_image_dimension: _a, max_dimension: _b, maxDimension: _c, ...meaningful } = args;
	const rest = JSON.stringify(meaningful);
	return rest === "{}" ? "" : clip(rest);
}

// computer.ts names screenshots by ISO time (2026-10-31T09-42-00-000Z.png, maybe with a -n suffix), so
// the newest sorts last. Other files in the folder are ignored.
const SHOT_FILE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z(-\d+)?\.png$/;

async function newestShot(dir: string): Promise<ComputerSnapshot["shot"]> {
	const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => SHOT_FILE.test(name)).sort();
	const name = names.at(-1);
	if (name === undefined) return undefined;
	const info = await stat(join(dir, name)).catch(() => undefined);
	return info === undefined ? undefined : { name, at: info.mtimeMs };
}

async function stepsOf(conversation: Conversation, context: Context): Promise<ComputerStep[]> {
	const steps = new Map<string, ComputerStep>();
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
		for (const entry of page.items) {
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
		cursor = page.next;
	} while (cursor !== undefined);
	return [...steps.values()].slice(-MAX_STEPS);
}

export type ComputerView = ReturnType<typeof createComputerView>;

/** One per bot; `conversation` is the bot whose computer_use runs the steps come from. */
export function createComputerView(deps: {
	harness: Harness;
	storage: Storage;
	conversation: Conversation;
	shotsDir: string;
	space?: string;
	context: Context;
}) {
	const { harness, storage, conversation, shotsDir, context } = deps;
	return {
		/** Read the pane's state now. `running` names the child of a computer_use call in progress, when known. */
		async snapshot(running?: ConversationId): Promise<ComputerSnapshot> {
			let childId = running;
			if (childId === undefined) {
				const page = await storage.scanConversations({ ownerConversationId: conversation.id, order: "descending" }, 1, undefined, context);
				childId = page.items[0]?.id;
			}
			const child = childId === undefined ? undefined : await harness.conversation(childId, context);
			const taskSpace = childId === undefined ? undefined : await taskSpaceName(harness, childId, context);
			return {
				...(deps.space === undefined ? {} : { space: deps.space }),
				...(taskSpace === undefined ? {} : { taskSpace }),
				...(await newestShot(shotsDir).then((shot) => (shot === undefined ? {} : { shot }))),
				steps: child === undefined ? [] : await stepsOf(child, context),
			};
		},
	};
}
