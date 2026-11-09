// Who drives the default Space's screen: the bots, or the owner. The web portal's expanded live view takes control
// (POST /api/computer/control) and hands it back with "I'm done"; src/web.ts also hands it back when the last
// live viewer leaves. While the owner has it, every on-screen step of computer_use (src/computer.ts) waits in
// botTurn(), so a running task pauses where it is and resumes on the owner's screen as they left it. drive() marks
// the time any bot's task runs there, which lets the portal skip taking control on expand while one does.

export type ScreenControl = ReturnType<typeof createScreenControl>;

export function createScreenControl() {
	let owner = false;
	let driving = false;
	const waiting: (() => void)[] = [];
	const listeners = new Set<() => void>();
	const changed = () => {
		for (const listener of listeners) listener();
	};

	return {
		/** Whether the owner has control. */
		get owner() {
			return owner;
		},
		/** Whether a bot's computer_use task is running on the screen, even if it is waiting for the owner. */
		get driving() {
			return driving;
		},
		/** true when the owner takes control, false when they hand it back to the bots. */
		set(next: boolean) {
			if (owner === next) return;
			owner = next;
			if (!owner) for (const resume of waiting.splice(0)) resume();
			changed();
		},
		/** Runs one bot task on the screen. src/computer.ts runs these one at a time, so `driving` needs no count. */
		async drive<T>(work: () => Promise<T>): Promise<T> {
			driving = true;
			changed();
			try {
				return await work();
			} finally {
				driving = false;
				changed();
			}
		},
		/** Resolves once the bots may drive: at once, or when the owner hands control back. */
		botTurn(): Promise<void> {
			return owner ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
		},
		/** Calls `listener` when `owner` or `driving` changes, until the returned function is called. */
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}
