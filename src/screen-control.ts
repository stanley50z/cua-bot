// Who drives the paired Space's screen: the bots, or the owner. The web app's expanded live view takes control
// (POST /api/computer/control) and hands it back with "I'm done"; src/web.ts also hands it back when the last
// live viewer leaves. While the owner has it, every on-screen step of computer_use (src/computer.ts) waits in
// botTurn(), so a running task pauses where it is and resumes on the owner's screen as they left it.

export type ScreenControl = ReturnType<typeof createScreenControl>;

export function createScreenControl() {
	let owner = false;
	const waiting: (() => void)[] = [];
	const listeners = new Set<(owner: boolean) => void>();

	return {
		/** Whether the owner has control. */
		get owner() {
			return owner;
		},
		/** true when the owner takes control, false when they hand it back to the bots. */
		set(next: boolean) {
			if (owner === next) return;
			owner = next;
			if (!owner) for (const resume of waiting.splice(0)) resume();
			for (const listener of listeners) listener(owner);
		},
		/** Resolves once the bots may drive: at once, or when the owner hands control back. */
		botTurn(): Promise<void> {
			return owner ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
		},
		/** Calls `listener` on every change until the returned function is called. */
		subscribe(listener: (owner: boolean) => void): () => void {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}
