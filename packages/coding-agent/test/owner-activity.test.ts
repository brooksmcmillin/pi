import { describe, expect, it } from "vitest";
import { OwnerActivity } from "../src/core/owner-activity.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("owner activity admission", () => {
	it("preserves outgoing and startup activity across replacement", async () => {
		const outgoing = new OwnerActivity();
		const incoming = new OwnerActivity();
		const oldGate = deferred();
		const newGate = deferred();
		const oldWork = outgoing.track(() => oldGate.promise);
		const newWork = incoming.track(() => newGate.promise);
		const oldSnapshot = outgoing.snapshot;
		outgoing.invalidate();
		incoming.inherit(outgoing);
		expect(
			incoming.submit(
				oldSnapshot,
				() => true,
				true,
				async () => {},
			),
		).toEqual({ status: "rejected", reason: "stale" });
		oldGate.resolve();
		await oldWork;
		expect(incoming.busy).toBe(true);
		newGate.resolve();
		await newWork;
		expect(outgoing.busy).toBe(false);
		expect(incoming.busy).toBe(false);
	});

	it("fences an autonomous request when unrelated work enters during preparation", async () => {
		const owner = new OwnerActivity();
		const gate = deferred();
		const pending = owner.submit(
			owner.snapshot,
			() => true,
			true,
			async () => {
				await gate.promise;
				owner.dispatch();
			},
		);
		await owner.track(async () => {});
		gate.resolve();
		if (pending.status !== "running") throw new Error("not admitted");
		await expect(pending.completion).rejects.toThrow("stale");
	});

	it("reserves before asynchronous preparation and rejects competitors without queuing", async () => {
		const owner = new OwnerActivity();
		const gate = deferred();
		const first = owner.submit(
			owner.snapshot,
			() => true,
			true,
			() => gate.promise,
		);
		expect(first.status).toBe("running");
		let secondRan = false;
		expect(
			owner.submit(
				owner.snapshot,
				() => true,
				true,
				async () => {
					secondRan = true;
				},
			),
		).toEqual({ status: "rejected", reason: "busy" });
		gate.resolve();
		if (first.status === "running") await first.completion;
		expect(secondRan).toBe(false);
		expect(owner.busy).toBe(false);
	});

	it("counts work that began before a snapshot was taken", async () => {
		const owner = new OwnerActivity();
		const gate = deferred();
		const shell = owner.track(() => gate.promise);
		expect(
			owner.submit(
				owner.snapshot,
				() => true,
				true,
				async () => {},
			),
		).toEqual({ status: "rejected", reason: "busy" });
		gate.resolve();
		await shell;
		expect(owner.busy).toBe(false);
	});

	it("fences pending dispatch on human intervention", async () => {
		const owner = new OwnerActivity();
		const gate = deferred();
		let dispatched = false;
		const result = owner.submit(
			owner.snapshot,
			() => true,
			true,
			async () => {
				await gate.promise;
				owner.dispatch();
				dispatched = true;
			},
		);
		owner.intervene();
		gate.resolve();
		if (result.status !== "running") throw new Error("not admitted");
		await expect(result.completion).rejects.toThrow("stale");
		expect(dispatched).toBe(false);
	});

	it("does not abort running work on human intervention, but lifecycle replacement fences it", async () => {
		const owner = new OwnerActivity();
		const gate = deferred();
		const result = owner.submit(
			owner.snapshot,
			() => true,
			true,
			async () => {
				owner.dispatch();
				await gate.promise;
				owner.assertCurrent();
			},
		);
		owner.intervene();
		expect(owner.busy).toBe(true);
		gate.resolve();
		if (result.status !== "running") throw new Error("not admitted");
		await result.completion;
		const replacementGate = deferred();
		const old = owner.submit(
			owner.snapshot,
			() => true,
			true,
			async () => {
				owner.dispatch();
				await replacementGate.promise;
				owner.assertCurrent();
			},
		);
		owner.invalidate();
		expect(owner.busy).toBe(true);
		replacementGate.resolve();
		if (old.status !== "running") throw new Error("not admitted");
		await expect(old.completion).rejects.toThrow("stale");
	});

	it("joins registered children without reacquiring the reservation", async () => {
		const owner = new OwnerActivity();
		const child = deferred();
		let nested!: Promise<void>;
		const result = owner.submit(
			owner.snapshot,
			() => true,
			true,
			async () => {
				nested = owner.track(() => owner.track(() => child.promise));
			},
		);
		await Promise.resolve();
		expect(owner.busy).toBe(true);
		child.resolve();
		if (result.status !== "running") throw new Error("not admitted");
		await result.completion;
		await nested;
		expect(owner.busy).toBe(false);
	});

	it("checks revocation immediately before dispatch", async () => {
		const owner = new OwnerActivity();
		let authorized = true;
		const gate = deferred();
		const result = owner.submit(
			owner.snapshot,
			() => authorized,
			true,
			async () => {
				await gate.promise;
				owner.dispatch();
			},
		);
		authorized = false;
		gate.resolve();
		if (result.status !== "running") throw new Error("not admitted");
		await expect(result.completion).rejects.toThrow("revoked");
	});

	it("rejects stale owners, unsupported coverage and revoked requests before running hooks", () => {
		const owner = new OwnerActivity();
		let ran = false;
		const run = async () => {
			ran = true;
		};
		expect(owner.submit(new OwnerActivity().snapshot, () => true, true, run)).toEqual({
			status: "rejected",
			reason: "stale",
		});
		expect(owner.submit(owner.snapshot, () => true, false, run)).toEqual({
			status: "rejected",
			reason: "unsupported",
		});
		expect(owner.submit(owner.snapshot, () => false, true, run)).toEqual({ status: "rejected", reason: "revoked" });
		expect(ran).toBe(false);
	});

	it("runs maintenance after original completion without retaining prompt consent", async () => {
		const owner = new OwnerActivity();
		let maintain!: ReturnType<OwnerActivity["captureMaintenance"]>;
		let consent = true;
		const original = owner.submit(
			owner.snapshot,
			() => consent,
			true,
			async () => {
				maintain = owner.captureMaintenance();
				owner.dispatch();
			},
		);
		if (original.status !== "running") throw new Error("not admitted");
		await original.completion;
		consent = false;
		const child = deferred();
		const started = deferred();
		let childScope = false;
		const refresh = maintain(
			() => true,
			() => true,
			async () => {
				expect(owner.guarded).toBe(true);
				expect(owner.maintenance).toBe(true);
				expect(() => owner.runHumanInput(async () => {})).toThrow("outgoing autonomous");
				OwnerActivity.dispatchRequest();
				void owner.track(async () => {
					started.resolve();
					await child.promise;
					childScope = owner.maintenance;
				});
			},
		);
		await started.promise;
		expect(owner.busy).toBe(true);
		child.resolve();
		await refresh;
		expect(childScope).toBe(true);
		expect(owner.busy).toBe(false);
	});

	it("keeps streaming maintenance separate from its still-running originating reservation", async () => {
		const owner = new OwnerActivity();
		const snapshot = owner.snapshot;
		const result = owner.submit(
			snapshot,
			() => true,
			true,
			async () => {
				const maintain = owner.captureMaintenance();
				owner.dispatch();
				await maintain(
					() => true,
					() => true,
					async () => {
						expect(owner.maintenance).toBe(true);
						OwnerActivity.dispatchRequest();
					},
				);
				expect(owner.maintenance).toBe(false);
				expect(owner.guarded).toBe(true);
				expect(owner.snapshot).toEqual(snapshot);
				owner.assertCurrent();
			},
		);
		if (result.status !== "running") throw new Error("not admitted");
		await result.completion;
		expect(owner.busy).toBe(false);
	});

	it("does not refresh an undispatched request or intervene against a newer reservation", async () => {
		const owner = new OwnerActivity();
		const gate = deferred();
		const oldMaintain = owner.captureMaintenance();
		const snapshot = owner.snapshot;
		const pending = owner.submit(
			snapshot,
			() => true,
			true,
			async () => {
				await expect(
					owner.captureMaintenance()(
						() => true,
						() => true,
						async () => {},
					),
				).rejects.toThrow("owner changed");
				await gate.promise;
				owner.dispatch();
			},
		);
		await expect(
			oldMaintain(
				() => true,
				() => true,
				async () => {},
			),
		).rejects.toThrow("owner changed");
		expect(owner.snapshot).toEqual(snapshot);
		gate.resolve();
		if (pending.status !== "running") throw new Error("not admitted");
		await pending.completion;
	});

	it.each(["context", "deadline", "intervention", "replacement"] as const)(
		"rechecks maintenance %s at physical dispatch",
		async (boundary) => {
			const owner = new OwnerActivity();
			let current = true;
			let timely = true;
			const entered = deferred();
			const release = deferred();
			const refresh = owner.captureMaintenance()(
				() => current,
				() => timely,
				async () => {
					entered.resolve();
					await release.promise;
					OwnerActivity.dispatchRequest();
				},
			);
			await entered.promise;
			if (boundary === "context") current = false;
			if (boundary === "deadline") timely = false;
			if (boundary === "intervention") owner.intervene();
			if (boundary === "replacement") owner.invalidate();
			release.resolve();
			await expect(refresh).rejects.toThrow("Cache maintenance");
			expect(owner.busy).toBe(false);
		},
	);

	it("does not admit reentrant competing submissions from authorization", async () => {
		const owner = new OwnerActivity();
		let competitor: unknown;
		const result = owner.submit(
			owner.snapshot,
			() => {
				competitor = owner.submit(
					owner.snapshot,
					() => true,
					true,
					async () => {},
				);
				return true;
			},
			true,
			async () => {},
		);
		expect(competitor).toEqual({ status: "rejected", reason: "busy" });
		if (result.status !== "running") throw new Error("not admitted");
		await result.completion;
	});
});
