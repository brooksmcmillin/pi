/**
 * Terminal-status demo: pi -e ./background-work.ts, then /background-work.
 * No model calls. Start it twice to see independent background registrations.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const jobs = new Map<ReturnType<typeof setTimeout>, () => void>();

	pi.registerCommand("background-work", {
		description: "Keep terminal status working for ten seconds without running the agent",
		handler: async (_args, ctx) => {
			const release = ctx.ui.beginBackgroundWork();
			const timer = setTimeout(() => {
				try {
					ctx.ui.notify("Background work finished", "info");
				} finally {
					jobs.delete(timer);
					release();
				}
			}, 10_000);
			jobs.set(timer, release);
		},
	});

	pi.on("session_shutdown", () => {
		for (const [timer, release] of jobs) {
			clearTimeout(timer);
			release();
		}
		jobs.clear();
	});
}
