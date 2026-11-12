// Chunked uploads release their slot on transfer failure, including caller cancellation.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore, sqliteBackend } from "@earendil-works/chord";
import { filesFacet } from "@earendil-works/chord/app/files";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@p2/app/v1";
import { Files, writeChunks } from "@p2/app/v1/node";
import { testHost } from "./helpers.ts";

for (const outcome of ["error", "abort"] as const) {
	test(`reuse:discord-upload-chunk-writer: ${outcome} releases the real upload slot`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "p2-upload-cancel-"));
		const cleanup: (() => Promise<void>)[] = [];
		t.after(async () => {
			for (const close of cleanup.reverse()) await close();
			await rm(directory, { recursive: true, force: true });
		});
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), BACKGROUND_CONTEXT);
		cleanup.push(() => store.close(BACKGROUND_CONTEXT));
		const host = await testHost({ store, facets: [filesFacet(directory, {}, 1)] });
		cleanup.push(() => host.close());
		const files = host.host.hold(Files, {}, BACKGROUND_CONTEXT);
		const controller = new AbortController();
		const write = {
			space: "uploads",
			path: "cancelled",
			mime: "application/octet-stream",
			source: "test",
			key: "retry-key",
		};
		await assert.rejects(
			writeChunks(
				files,
				write,
				async () => {
					if (outcome === "abort") controller.abort();
					throw new Error("injected transfer failure");
				},
				1,
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			),
			/injected transfer failure/,
		);
		let reads = 0;
		const finished = await writeChunks(
			files,
			{ ...write, path: "another", key: "another-key" },
			async () => (reads++ === 0 ? Uint8Array.of(42) : new Uint8Array()),
			1,
			BACKGROUND_CONTEXT,
		);
		assert.equal(finished.size, 1);
		assert.equal((await files.byKey({ space: "uploads", key: "another-key" }, BACKGROUND_CONTEXT))?.id, finished.id);
	});
}
