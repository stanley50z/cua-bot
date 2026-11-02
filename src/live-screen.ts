// The computer pane's live view of the paired Mac. src/main.ts builds one with createLiveScreen(openLiveStream)
// and src/web.ts streams it to each open pane at GET /api/computer/live. Every pane shares one view-only
// H.264 media session: the first viewer opens it, the last one to leave closes it, and a viewer that joins
// late, or falls behind, skips frames until the next keyframe so its decoder never sees a broken GOP.

/** One H.264 access unit (Annex-B). A keyframe carries its SPS and PPS. */
export type LiveFrame = { keyframe: boolean; data: Uint8Array };

/** What createLiveScreen needs from the Mac: frames into `sink` until `close()` or `sink.closed`. */
export type OpenLiveStream = (sink: { frame(frame: LiveFrame): void; closed(reason: string): void }) => Promise<{
	requestKeyframe(): void;
	close(): Promise<void>;
}>;

type Viewer = {
	/** Returns false when this viewer's socket is backed up. */
	send(frame: LiveFrame): boolean;
	end(reason: string): void;
	synced: boolean;
};

type Session = { stream?: Awaited<ReturnType<OpenLiveStream>> };

export type LiveScreen = ReturnType<typeof createLiveScreen>;

export function createLiveScreen(open: OpenLiveStream) {
	const viewers = new Set<Viewer>();
	// The media session the viewers watch, opening or open. A stale session's late events are ignored.
	let session: Session | undefined;

	const endAll = (from: Session, reason: string) => {
		if (session !== from) return;
		session = undefined;
		for (const viewer of viewers) viewer.end(reason);
		viewers.clear();
	};

	const start = () => {
		const current: Session = {};
		session = current;
		const sink = {
			frame(frame: LiveFrame) {
				if (session !== current) return;
				let behind = false;
				for (const viewer of viewers) {
					if (!viewer.synced && !frame.keyframe) continue;
					viewer.synced = viewer.send(frame);
					behind ||= !viewer.synced;
				}
				if (behind) current.stream?.requestKeyframe();
			},
			closed: (reason: string) => endAll(current, reason),
		};
		open(sink).then(
			(stream) => {
				if (session === current) current.stream = stream;
				else void stream.close().catch(() => {});
			},
			(error: unknown) => endAll(current, error instanceof Error ? error.message : String(error)),
		);
	};

	return {
		/** Streams frames to `send` from the next keyframe on. `end` runs once if the stream fails or closes. Returns the unsubscribe. */
		subscribe(send: Viewer["send"], end: Viewer["end"]): () => void {
			const viewer: Viewer = { send, end, synced: false };
			viewers.add(viewer);
			if (session === undefined) start();
			else session.stream?.requestKeyframe();
			return () => {
				if (!viewers.delete(viewer) || viewers.size > 0) return;
				const stream = session?.stream;
				session = undefined;
				void stream?.close().catch(() => {});
			};
		},
	};
}
