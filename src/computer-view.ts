// What the web portal's computer pane shows: the name of the Space on the live screen, the newest screenshot, and the
// driver steps of the bot's most recent computer_use run, with the Space it ran on and the topic it ran in. src/bots.ts
// builds one per bot with createComputerView() and hands it to createChat() for the bot's chat and its topics' chats,
// which push fresh snapshots while a computer_use call is running. computer_use runs its driver calls in a child
// conversation of the calling one (src/computer.ts), so the newest conversation the bot or one of its open topics
// owns is its latest run.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, Storage } from "@earendil-works/pi-durable";
import { type ComputerStep, stepsOf, taskSpaceName } from "./computer.ts";

export type ComputerSnapshot = {
	/** The Space the live screen shows. */
	space?: string;
	/** The Space the steps ran on. */
	taskSpace?: string;
	/** The topic the steps ran in (src/topics.ts); absent for a run in the bot's own chat. */
	topic?: string;
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

/**
 * One per bot; `conversation` is the bot whose computer_use runs the steps come from, and `topics` lists its open topics,
 * whose runs count as the bot's.
 */
export function createComputerView(deps: {
	harness: Harness;
	storage: Storage;
	conversation: Conversation;
	shotsDir: string;
	/** The name of the Space the live screen shows, read for each snapshot. */
	space?: () => string | undefined | Promise<string | undefined>;
	/** The bot's open topics, read for each snapshot. */
	topics?: () => Promise<readonly { id: number; name: string }[]>;
	context: Context;
}) {
	const { harness, storage, conversation, shotsDir, context } = deps;
	// The newest computer_use run of the bot or one of its topics, with the topic's name; `running` when it is one of them.
	async function latestRun(running: ConversationId | undefined): Promise<{ id?: ConversationId; topic?: string }> {
		const owners = [{ id: conversation.id, topic: undefined as string | undefined }, ...((await deps.topics?.()) ?? []).map((t) => ({ id: t.id as ConversationId, topic: t.name }))];
		const newest = await Promise.all(
			owners.map(async (owner) => ({ ...owner, run: (await storage.scanConversations({ ownerConversationId: owner.id, order: "descending" }, 1, undefined, context)).items[0]?.id })),
		);
		const found = running === undefined ? newest.filter((n) => n.run !== undefined).sort((a, b) => Number(b.run) - Number(a.run))[0] : newest.find((n) => n.run === running);
		const id = running ?? found?.run;
		return { ...(id === undefined ? {} : { id }), ...(found?.topic === undefined ? {} : { topic: found.topic }) };
	}
	return {
		/** Read the pane's state now. `running` names the child of a computer_use call in progress, when known. */
		async snapshot(running?: ConversationId): Promise<ComputerSnapshot> {
			const { id: childId, topic } = await latestRun(running);
			const child = childId === undefined ? undefined : await harness.conversation(childId, context);
			const taskSpace = childId === undefined ? undefined : await taskSpaceName(harness, childId, context);
			const space = await deps.space?.();
			return {
				...(space === undefined ? {} : { space }),
				...(taskSpace === undefined ? {} : { taskSpace }),
				...(topic === undefined ? {} : { topic }),
				...(await newestShot(shotsDir).then((shot) => (shot === undefined ? {} : { shot }))),
				steps: child === undefined ? [] : await stepsOf((cursor) => child.entries({ order: "ascending" }, 200, cursor, context)),
			};
		},
	};
}
