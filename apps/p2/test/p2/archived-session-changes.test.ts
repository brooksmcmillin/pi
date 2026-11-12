// Archived publication waits for real session shutdown and excludes restoration until publication finishes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withTelemetry } from "@earendil-works/chord/context";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, defineFacet } from "@p2/app/v1";
import { ArchivedSessionChanges } from "../../plugins/sessions/contract.server.ts";
import { Catalog, SessionArchived, SessionOperations, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionWorkers } from "../../src/hosts/session-workers.ts";
import { ServerNatives } from "../../src/runtime/server.ts";
import { WorkerBoundary } from "../../src/runtime/session-worker.ts";
import { holdIn, poll, startFixture } from "./helpers.ts";

test("PR #9: archived publication waits for hooks and shutdown, and fences restore", { timeout: 60_000 }, async (t) => {
	const entered = Promise.withResolvers<void>();
	const releaseHook = Promise.withResolvers<void>();
	const publishing = Promise.withResolvers<void>();
	const releasePublication = Promise.withResolvers<void>();
	let failHook = false;
	const events: string[] = [];
	const resume = SessionWorkers.prototype.resume;
	t.mock.method(SessionWorkers.prototype, "resume", async function (this: SessionWorkers, id: string) {
		events.push("restore");
		return resume.call(this, id);
	});
	const fixture = await startFixture({
		facets: [
			{
				name: "archive-gate",
				facet: defineFacet((_host, self) => {
					self.contribute(SessionArchived, {
						gate: async () => {
							entered.resolve();
							await releaseHook.promise;
							if (failHook) throw new Error("injected archive hook failure");
						},
					});
				}),
			},
		],
	});
	t.after(async () => {
		releaseHook.resolve();
		releasePublication.resolve();
		await fixture.close();
	});
	const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
	const row = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
	await fixture.server.host.root(async (ctx) => {
		const boundary = await ctx.get(WorkerBoundary, { session: row.id });
		await boundary.cancel(ctx);
		const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
		const changes = (await fixture.server.host.registry(ArchivedSessionChanges, ctx)).value!;
		assert(workers.running().includes(row.id));
		assert.equal(await changes.whileArchived(row.id, async () => assert.fail("active session"), ctx), false);
		await sessions.archive({ id: row.id }, ctx);
		await entered.promise;
		const catalog = await ctx.get(Catalog, {});
		assert.notEqual((await catalog.get({ id: row.id }, ctx)).archivedAt, null);
		assert(workers.running().includes(row.id), "catalog archive precedes actual worker shutdown");
		const cleanup = changes.whileArchived(
			row.id,
			async () => {
				assert(!workers.running().includes(row.id), "publication requires actual shutdown");
				assert.notEqual((await catalog.get({ id: row.id }, ctx)).archivedAt, null);
				publishing.resolve();
				await releasePublication.promise;
				events.push("published");
			},
			ctx,
		);
		releaseHook.resolve();
		await publishing.promise;
		const telemetry = new InMemoryTelemetryContext();
		const operations = await ctx.get(SessionOperations, {});
		const restoring = telemetry.startSpan({ name: "restore-test" }, (span) =>
			operations.restore({ id: row.id }, withTelemetry(span, ctx)),
		);
		await poll(() =>
			telemetry
				.getSpans()
				.some(
					(span) =>
						span.name === "chord.method" &&
						span.attributes.type === "p2.session-operations" &&
						span.attributes.member === "restore",
				),
		);
		assert.deepEqual(events, [], "restore arrived but cannot resume a worker during archived publication");
		assert.notEqual((await catalog.get({ id: row.id }, ctx)).archivedAt, null);
		releasePublication.resolve();
		assert.equal(await cleanup, true);
		await restoring;
		assert.deepEqual(events, ["published", "restore"]);
		assert.equal((await catalog.get({ id: row.id }, ctx)).archivedAt, null);

		failHook = true;
		await sessions.archive({ id: row.id }, ctx);
		await assert.rejects(
			changes.whileArchived(row.id, async () => assert.fail("failed archive"), ctx),
			/injected archive hook failure/,
		);
		failHook = false;
		assert.equal(
			await changes.whileArchived(
				row.id,
				async () => {
					assert(!workers.running().includes(row.id));
				},
				ctx,
			),
			true,
			"failed cleanup remains retryable",
		);
	}, BACKGROUND_CONTEXT);
});
