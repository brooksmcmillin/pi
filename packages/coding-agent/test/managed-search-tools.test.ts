import * as childProcesses from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { OwnerActivity } from "../src/core/owner-activity.ts";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcesses>()),
	spawn: vi.fn(),
}));

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pi-search-tools-"));
	directories.push(dir);
	vi.stubEnv(ENV_AGENT_DIR, dir);
	mkdirSync(join(dir, "bin"));
	for (const name of ["fd", "rg"])
		writeFileSync(join(dir, "bin", name + (process.platform === "win32" ? ".exe" : "")), "mocked spawn only");
	const child = new childProcesses.ChildProcess();
	Object.defineProperties(child, {
		pid: { value: 123 },
		stdout: { value: new PassThrough() },
		stderr: { value: new PassThrough() },
	});
	vi.spyOn(child, "kill").mockReturnValue(true);
	const spawned = Promise.withResolvers<void>();
	vi.mocked(childProcesses.spawn)
		.mockReset()
		.mockImplementation(() => {
			spawned.resolve();
			return child;
		});
	return { dir, child, spawned: spawned.promise };
}

describe("managed search tool lifetimes", () => {
	it("find cancellation may return early but cannot release the owner before process acknowledgement", async () => {
		const { dir, child, spawned } = setup();
		const tool = createFindTool(dir);
		const owner = new OwnerActivity();
		const abort = new AbortController();
		const toolReturned = Promise.withResolvers<void>();
		const result = owner.submit(
			owner.snapshot,
			() => true,
			true,
			async () => {
				await expect(tool.execute("find", { pattern: "*" }, abort.signal)).rejects.toThrow("aborted");
				toolReturned.resolve();
			},
		);
		if (result.status !== "running") throw new Error(result.reason);
		await spawned;
		abort.abort();
		await toolReturned.promise;
		expect(owner.busy).toBe(true);
		child.emit("exit", null, "SIGTERM");
		expect(owner.busy).toBe(true);
		child.emit("close", null, "SIGTERM");
		await result.completion;
		expect(await result.settlement).toBe("settled");
	});

	for (const createTool of [createFindTool, createGrepTool]) {
		it(`${createTool.name} fences cancellation during asynchronous preparation before spawn`, async () => {
			const { dir } = setup();
			const tool = createTool(dir);
			const owner = new OwnerActivity();
			const abort = new AbortController();
			const result = owner.submit(
				owner.snapshot,
				() => true,
				true,
				async () => {
					await expect(tool.execute("search", { pattern: "*" }, abort.signal)).rejects.toBeDefined();
				},
			);
			if (result.status !== "running") throw new Error(result.reason);
			abort.abort();
			await result.completion;
			expect(childProcesses.spawn).not.toHaveBeenCalled();
			expect(await result.settlement).toBe("settled");
		});

		it(`${createTool.name} fences stale ownership after asynchronous preparation`, async () => {
			const { dir } = setup();
			const tool = createTool(dir);
			const owner = new OwnerActivity();
			const result = owner.submit(
				owner.snapshot,
				() => true,
				true,
				async () => {
					await expect(tool.execute("search", { pattern: "*" })).rejects.toThrow("stale");
				},
			);
			if (result.status !== "running") throw new Error(result.reason);
			owner.invalidate();
			await result.completion;
			expect(childProcesses.spawn).not.toHaveBeenCalled();
		});
	}
});
