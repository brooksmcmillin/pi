import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSearchProcess } from "../src/core/managed-search-process.ts";
import { OwnerActivity } from "../src/core/owner-activity.ts";

const fixture = fileURLToPath(new URL("./fixtures/settlement-process.cjs", import.meta.url));

describe("disposable subprocess settlement", () => {
	it("joins a live marker writer after its tool promise returned, then acknowledges cancellation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-settlement-"));
		const marker = join(dir, "marker");
		const release = join(dir, "release");
		const owner = new OwnerActivity();
		let processHandle: ReturnType<typeof spawnSearchProcess> | undefined;
		try {
			const result = owner.submit(
				owner.snapshot,
				() => true,
				true,
				async () => {
					processHandle = spawnSearchProcess(process.execPath, [fixture, "leaf", marker, release]);
					await once(processHandle.child.stdout, "data");
				},
			);
			if (result.status !== "running" || !processHandle) throw new Error("not started");
			await once(processHandle.child.stdout, "data");
			expect(readFileSync(marker, "utf8")).toContain("ready");
			expect(owner.busy).toBe(true);
			processHandle.stop();
			await result.completion;
			expect(await result.settlement).toBe("settled");
			expect(readFileSync(marker, "utf8")).toContain("stopped");
			expect(processHandle.child.exitCode).toBe(0);
			expect(owner.busy).toBe(false);
		} finally {
			writeFileSync(release, "release");
			if (processHandle && processHandle.child.exitCode === null && processHandle.child.signalCode === null) {
				const closed = once(processHandle.child, "close");
				processHandle.child.kill("SIGKILL");
				await closed;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// This is a deliberately unsupported non-leaf fixture, not a supported search backend.
	it.skipIf(process.platform === "win32")(
		"retains uncertainty after a parent exits and macOS/Unix group cleanup is signalled",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-settlement-group-"));
			const marker = join(dir, "marker");
			const release = join(dir, "release");
			const root = spawn(process.execPath, [fixture, "parent", marker, release], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const closed = once(root, "close");
			try {
				await once(root, "exit");
				// The parent is gone, but an inherited pipe and marker-writing descendant remain.
				await once(root.stdout, "data");
				expect(readFileSync(marker, "utf8")).toContain("tick");
				const owner = new OwnerActivity();
				const result = owner.submit(
					owner.snapshot,
					() => true,
					true,
					async () => {
						owner.markUncertain();
					},
				);
				if (result.status !== "running") throw new Error(result.reason);
				expect(await result.settlement).toBe("uncertain");
				process.kill(-root.pid!, "SIGTERM");
				expect(owner.busy).toBe(true);
				await closed;
				await result.completion;
				expect(readFileSync(marker, "utf8")).toContain("stopped");
				expect(owner.busy).toBe(true);
			} finally {
				// The release barrier also stops the known fixture if an assertion fails before signalling.
				writeFileSync(release, "release");
				await closed;
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
