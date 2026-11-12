// A security-sensitive transition must inspect even cold workers and never accept a lost inspection.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionWorkers } from "../../src/hosts/session-workers.ts";
import { Session } from "../../src/runtime/chord.ts";
import { Hosts, ServerNatives } from "../../src/runtime/server.ts";
import { WorkerBoundary } from "../../src/runtime/session-worker.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("required worker preparation", { timeout: 60_000 }, () => {
	let fixture: Fixture;
	before(async () => {
		fixture = await startFixture();
	});
	after(async () => {
		await fixture?.close();
	});

	it("refuses a cold session before mutation when its placement check refuses", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await fixture.server.host.root(async (ctx) => {
			const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
			assert.equal(workers.generation(session.id), 0);
			let inspected = false;
			let mutated = false;
			await assert.rejects(
				workers.pauseChecked(
					session.id,
					async () => {
						inspected = true;
						assert(workers.generation(session.id) > 0, "cold worker opened for inspection");
						return { kind: "refused", reason: "incompatible placement" };
					},
					async () => {
						mutated = true;
					},
					ctx,
				),
				/incompatible placement/,
			);
			assert.equal(inspected, true);
			assert.equal(mutated, false);
		}, BACKGROUND_CONTEXT);
	});

	it("rejects inspection failure after the inspected worker exits, without mutation", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await fixture.server.host.root(async (ctx) => {
			const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
			const boundary = await ctx.get(WorkerBoundary, { session: session.id });
			const hosts = await ctx.get(Hosts, {});
			const states = await until(hosts.workers, (value) => value?.[session.id]?.running === true);
			const pid = states?.[session.id]?.pid;
			assert(pid);
			let mutated = false;
			await assert.rejects(
				workers.pauseChecked(
					session.id,
					async () => {
						assert.equal((await boundary.prepare(null, ctx)).accepted, true);
						process.kill(pid, "SIGKILL");
						await until(hosts.workers, (value) => value?.[session.id]?.running === false);
						throw new Error("inspection lost");
					},
					async () => {
						mutated = true;
					},
					ctx,
				),
				/inspection lost/,
			);
			assert.equal(mutated, false);
		}, BACKGROUND_CONTEXT);
	});

	it("rejects a replacement generation between inspection and stop", async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await fixture.server.host.root(async (ctx) => {
			const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
			assert(workers instanceof SessionWorkers);
			const hosts = await ctx.get(Hosts, {});
			let mutated = false;
			await assert.rejects(
				workers.pauseChecked(
					session.id,
					async () => {
						const boundary = await ctx.get(WorkerBoundary, { session: session.id });
						assert.equal((await boundary.prepare(null, ctx)).accepted, true);
						const generation = workers.generation(session.id);
						// Chord recovery does not enter p2's lifecycle queue.
						await workers.workers.stop(Session({ id: session.id }), ctx);
						await workers.workers.retry(Session({ id: session.id }), ctx);
						await until(
							hosts.workers,
							(value) => value?.[session.id]?.running === true && value[session.id]!.generation > generation,
						);
						return { kind: "prepared", generation };
					},
					async () => {
						mutated = true;
					},
					ctx,
				),
				/inspected worker exited or was replaced/,
			);
			assert.equal(mutated, false);
		}, BACKGROUND_CONTEXT);
	});

	it("excludes a direct Chord retry during publication, then restarts normally", async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await fixture.server.host.root(async (ctx) => {
			const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
			assert(workers instanceof SessionWorkers);
			let inspected = 0;
			await workers.pauseChecked(
				session.id,
				async () => {
					const boundary = await ctx.get(WorkerBoundary, { session: session.id });
					assert.equal((await boundary.prepare(null, ctx)).accepted, true);
					inspected = workers.generation(session.id);
					return { kind: "prepared", generation: inspected };
				},
				async () => {
					assert(!workers.running().includes(session.id));
					await workers.workers.retry(Session({ id: session.id }), ctx);
					await until(workers.workers.state, (value) => value?.[`session|${session.id}`]?.status === "failed");
					assert.equal(workers.generation(session.id), inspected);
					assert(!workers.running().includes(session.id));
				},
				ctx,
			);
			assert(workers.generation(session.id) > inspected);
			assert(workers.running().includes(session.id));
			const boundary = await ctx.get(WorkerBoundary, { session: session.id });
			assert.equal((await boundary.prepare(null, ctx)).accepted, true);
			await boundary.cancel(ctx);
		}, BACKGROUND_CONTEXT);
	});

	for (const failure of [false, true]) {
		it(`cleans up after publication ${failure ? "fails" : "finishes"} despite caller cancellation`, async () => {
			const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
			const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
			await fixture.server.host.root(async (ctx) => {
				const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
				const controller = new AbortController();
				let published = false;
				const operation = workers.pauseChecked(
					session.id,
					async () => {
						const boundary = await ctx.get(WorkerBoundary, { session: session.id });
						assert.equal((await boundary.prepare(null, ctx)).accepted, true);
						return { kind: "prepared", generation: workers.generation(session.id) };
					},
					async () => {
						controller.abort(new Error("caller left"));
						published = true;
						if (failure) throw new Error("publication failed");
					},
					withAbortSignal(controller.signal, ctx),
				);
				if (failure) await assert.rejects(operation, /publication failed/);
				else await operation;
				assert.equal(published, true);
				assert(workers.running().includes(session.id));
				const boundary = await ctx.get(WorkerBoundary, { session: session.id });
				assert.equal((await boundary.prepare(null, ctx)).accepted, true);
				await boundary.cancel(ctx);
			}, BACKGROUND_CONTEXT);
		});
	}
});
