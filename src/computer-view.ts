// What the web portal's computer pane shows: the default Space's name, the newest screenshot, and the
// driver steps of the bot's most recent computer_use run, with the Space it ran on. src/bots.ts builds one per bot with
// createComputerView() and hands it to createChat(), which pushes fresh snapshots while a computer_use
// call is running. computer_use runs its driver calls in a child conversation of the bot's (src/computer.ts),
// so the newest conversation the bot owns is its latest run.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, Storage } from "@earendil-works/pi-durable";
import { type ComputerStep, stepsOf, taskSpaceName } from "./computer.ts";

export type ComputerSnapshot = {
	/** The default Space, which the live screen shows. */
	space?: string;
	/** The Space the steps ran on. */
	taskSpace?: string;
	shot?: { name: string; at: number };
	steps: ComputerStep[];
};

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

export type ComputerView = ReturnType<typeof createComputerView>;

/** One per bot; `conversation` is the bot whose computer_use runs the steps come from. */
export function createComputerView(deps: {
	harness: Harness;
	storage: Storage;
	conversation: Conversation;
	shotsDir: string;
	/** The default Space's name, or main.ts's pending lookup of it, which each snapshot waits for. */
	space?: string | Promise<string | undefined>;
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
			const space = await deps.space;
			return {
				...(space === undefined ? {} : { space }),
				...(taskSpace === undefined ? {} : { taskSpace }),
				...(await newestShot(shotsDir).then((shot) => (shot === undefined ? {} : { shot }))),
				steps: child === undefined ? [] : await stepsOf((cursor) => child.entries({ order: "ascending" }, 200, cursor, context)),
			};
		},
	};
}
