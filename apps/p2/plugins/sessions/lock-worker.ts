// The session's lock on its worker: followed from the server's `SessionLock` and mirrored into the session's Durable
// state (`SessionLockDoc`), where the tool guard and the prompt read it at each use.
import type { Harness } from "@earendil-works/pi-durable";
import {
	awaitWithContext,
	type Context,
	type Ctx,
	expectVariant,
	type FacetHost,
	type SessionLock as Lock,
	untilAborted,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { harnessOf, SessionLockDoc } from "@p2/app/v1/worker";
import { SessionLock, SessionLockMirror } from "./contract.ts";

/** Commits `lock` as the session's lock unless it is that already. */
async function mirrorLock(durable: Harness, lock: Lock | null, context: Context): Promise<void> {
	const current = (await durable.snapshot(SessionLockDoc, context))?.lock ?? null;
	if (JSON.stringify(current) === JSON.stringify(lock)) return;
	await durable.commit(async (tx) => {
		(await tx.doc(SessionLockDoc)).lock = lock === null ? null : structuredClone(lock);
	}, context);
}

export function serveLockMirror(host: FacetHost): void {
	host.serve(SessionLockMirror, (_params, self) => {
		const harness = harnessOf(self);
		const view = self.get(SessionLock, {});
		const initialized = Promise.withResolvers<void>();
		void initialized.promise.catch(report);
		let chain: Promise<void> = Promise.resolve();
		self.onLive(async (ctx: Ctx) => {
			try {
				const watch = await expectVariant(view, "worker").lock.watch(ctx);
				chain = mirrorLock(harness().durable, watch.value, durableContext(ctx));
				void chain.catch(report);
				initialized.resolve();
				watch.start(async (call) => {
					const commit = () => {
						if (call.kind === "failed") throw call.error;
						return mirrorLock(harness().durable, call.value, durableContext(ctx));
					};
					// Keep failure visible to admissions, but let the next authoritative update recover the queue.
					chain = chain.then(commit, commit);
					void chain.catch(report);
				});
				try {
					await untilAborted(ctx);
				} finally {
					await watch.stop();
				}
			} catch (error) {
				initialized.reject(error);
				throw error;
			}
		});
		return {
			sync: async (ctx) => {
				await awaitWithContext(initialized.promise, ctx);
				await awaitWithContext(chain, ctx);
				// A disconnected reference retains its last value; it is not current authority.
				if (view.state.value.kind !== "live") throw new Error("Session lock authority is unavailable");
				return null;
			},
		};
	});
}

const report = (error: unknown): void => console.error("p2 sessions: mirroring the session's lock failed:", error);
