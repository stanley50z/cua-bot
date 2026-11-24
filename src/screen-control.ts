// Which Space the web portal's live screen shows, and who drives it: the bots, or the owner. The screen shows the Space
// the newest move named: drive() moves it to the Space a computer_use task (src/computer.ts) starts on, unless the owner
// has control of the one shown, and the owner picks any Space with show() (POST /api/computer/space). The expanded live view takes control (POST /api/computer/control) and hands it back with "I'm done";
// src/web.ts also hands it back when the last live viewer leaves. While the owner has it, every on-screen step on the
// shown Space waits in botTurn(), so a running task pauses where it is and resumes on the owner's screen as they left
// it. Tasks on other Spaces carry on. `driving` says a bot's task runs on the shown Space, which lets the portal skip
// taking control on expand while one does.

export type ScreenControl = ReturnType<typeof createScreenControl>;

/**
 * `space` names the Space to show until a task moves the screen; `shown` hears each move, so src/computer.ts can keep
 * it across a restart.
 */
export function createScreenControl(options: { space?: () => string | undefined; shown?: (space: string) => void } = {}) {
	let moved: string | undefined;
	let owner = false;
	// Running tasks per Space; computer.ts runs one at a time on each, but several Spaces can run at once.
	const running = new Map<string, number>();
	const waiting: (() => void)[] = [];
	const listeners = new Set<() => void>();
	const changed = () => {
		for (const listener of listeners) listener();
	};
	const shownSpace = () => moved ?? options.space?.();

	return {
		/** The Space the live screen shows. */
		get space() {
			return shownSpace();
		},
		/** Whether the owner has control. */
		get owner() {
			return owner;
		},
		/** Whether a bot's computer_use task is running on the shown Space, even if it is waiting for the owner. */
		get driving() {
			const space = shownSpace();
			return space !== undefined && (running.get(space) ?? 0) > 0;
		},
		/** true when the owner takes control, false when they hand it back to the bots. */
		set(next: boolean) {
			if (owner === next) return;
			owner = next;
			if (!owner) for (const resume of waiting.splice(0)) resume();
			changed();
		},
		/**
		 * The owner's pick of the Space to show, idle or not. Any control they had of the old one goes back to the bots, so
		 * its waiting task resumes; a bot task that starts after this moves the screen again.
		 */
		show(space: string) {
			if (space === shownSpace()) return;
			moved = space;
			options.shown?.(space);
			owner = false;
			for (const resume of waiting.splice(0)) resume();
			changed();
		},
		/** Runs one bot task on `space`, and shows that Space unless the owner has control. */
		async drive<T>(space: string, work: () => Promise<T>): Promise<T> {
			if (!owner && space !== shownSpace()) {
				moved = space;
				options.shown?.(space);
			}
			running.set(space, (running.get(space) ?? 0) + 1);
			changed();
			try {
				return await work();
			} finally {
				const left = running.get(space)! - 1;
				if (left === 0) running.delete(space);
				else running.set(space, left);
				changed();
			}
		},
		/** Resolves once the bots may drive `space`: at once, or when the owner hands the shown Space back. */
		botTurn(space: string): Promise<void> {
			return owner && space === shownSpace() ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
		},
		/** Calls `listener` when `space`, `owner` or `driving` changes, until the returned function is called. */
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}
