import * as childProcesses from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSearchTool, spawnSearchProcess } from "../src/core/managed-search-process.ts";
import { OwnerActivity } from "../src/core/owner-activity.ts";
import * as toolsManager from "../src/utils/tools-manager.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcesses>()),
	spawn: vi.fn(),
}));

function fakeProcess(pid: number | undefined = 123) {
	const child = new childProcesses.ChildProcess();
	Object.defineProperties(child, {
		pid: { value: pid, configurable: true },
		stdout: { value: new PassThrough() },
		stderr: { value: new PassThrough() },
	});
	vi.mocked(childProcesses.spawn).mockReset().mockReturnValue(child);
	vi.spyOn(child, "kill").mockReturnValue(true);
	return child;
}

function submit(owner: OwnerActivity, operation: () => Promise<void>) {
	const result = owner.submit(owner.snapshot, () => true, true, operation);
	if (result.status !== "running") throw new Error(result.reason);
	return result;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("managed search settlement", () => {
	it("reports inherited startup uncertainty while the old operation is still running", async () => {
		const owner = new OwnerActivity();
		const pending = Promise.withResolvers<void>();
		const result = submit(owner, () => pending.promise);
		const incoming = new OwnerActivity();
		incoming.markUncertain();
		incoming.inherit(owner);
		expect(await result.settlement).toBe("uncertain");
		pending.resolve();
		await result.completion;
		expect(incoming.busy).toBe(true);
	});

	it("cancellation after direct exit does not signal a reused PID or certify inherited stdio", async () => {
		vi.useFakeTimers();
		const child = fakeProcess();
		const owner = new OwnerActivity();
		const result = submit(owner, async () => {
			const process = spawnSearchProcess("audited-leaf", []);
			child.emit("exit", 0, null);
			process.stop();
		});
		expect(child.kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await result.settlement).toBe("uncertain");
		await result.completion;
		child.emit("close", 0, null);
		expect(owner.busy).toBe(true);
	});

	it("does not grant subprocess capability to cache maintenance", async () => {
		fakeProcess();
		const owner = new OwnerActivity();
		await owner.captureMaintenance()(
			() => true,
			() => true,
			async () => {
				await expect(resolveSearchTool("rg", false)).rejects.toThrow("maintenance");
				expect(() => spawnSearchProcess("audited-leaf", [])).toThrow("maintenance");
			},
		);
		expect(childProcesses.spawn).not.toHaveBeenCalled();
	});

	it("joins registered processes after the operation returns, including inherited stdio", async () => {
		const child = fakeProcess();
		const owner = new OwnerActivity();
		const result = submit(owner, async () => {
			spawnSearchProcess("audited-leaf", []);
		});
		let completed = false;
		void result.completion.then(() => {
			completed = true;
		});
		child.emit("exit", 0, null);
		await Promise.resolve();
		expect(completed).toBe(false);
		expect(owner.busy).toBe(true);
		child.emit("close", 0, null);
		await result.completion;
		expect(await result.settlement).toBe("settled");
		expect(owner.busy).toBe(false);
	});

	it("joins every registered child, not just the first acknowledgement", async () => {
		const owner = new OwnerActivity();
		const first = Promise.withResolvers<"settled">();
		const second = Promise.withResolvers<"settled">();
		const result = submit(owner, async () => {
			owner.joinSubprocess(first.promise);
			owner.joinSubprocess(second.promise);
		});
		first.resolve("settled");
		await Promise.resolve();
		expect(owner.busy).toBe(true);
		second.resolve("settled");
		await result.completion;
		expect(await result.settlement).toBe("settled");
	});

	it("signal delivery is not settlement", async () => {
		const child = fakeProcess();
		const owner = new OwnerActivity();
		const result = submit(owner, async () => {
			spawnSearchProcess("audited-leaf", []).stop();
		});
		expect(child.kill).toHaveBeenCalledOnce();
		expect(owner.busy).toBe(true);
		child.emit("exit", null, "SIGTERM");
		child.emit("close", null, "SIGTERM");
		await result.completion;
		expect(await result.settlement).toBe("settled");
	});

	it.each(["false", "throw", "error", "deadline"] as const)(
		"retains uncertainty after cleanup %s",
		async (failure) => {
			vi.useFakeTimers();
			const child = fakeProcess();
			if (failure === "false") vi.mocked(child.kill).mockReturnValue(false);
			if (failure === "throw")
				vi.mocked(child.kill).mockImplementation(() => {
					throw new Error("denied");
				});
			const owner = new OwnerActivity();
			const result = submit(owner, async () => {
				const process = spawnSearchProcess("audited-leaf", []);
				process.stop();
				if (failure === "error") child.emit("error", new Error("kill failed"));
			});
			if (failure === "deadline") await vi.advanceTimersByTimeAsync(5_000);
			expect(await result.settlement).toBe("uncertain");
			await result.completion;
			owner.invalidate();
			const replacement = new OwnerActivity();
			replacement.inherit(owner);
			child.emit("exit", 0, null);
			child.emit("close", 0, null);
			expect(
				replacement.submit(
					replacement.snapshot,
					() => true,
					true,
					async () => {},
				),
			).toEqual({ status: "rejected", reason: "busy" });
			// Ordinary human work remains available; it cannot clear the autonomous claim.
			await replacement.track(async () => {});
			expect(replacement.busy).toBe(true);
		},
	);

	it("blocks further dispatch within a running reservation after supervision is lost", async () => {
		const child = fakeProcess();
		const owner = new OwnerActivity();
		const result = submit(owner, async () => {
			spawnSearchProcess("audited-leaf", []);
			child.emit("error", new Error("lost supervision"));
			expect(() => OwnerActivity.dispatchRequest()).toThrow("uncertain");
			expect(() => spawnSearchProcess("second", [])).toThrow("uncertain");
		});
		await result.completion;
		expect(await result.settlement).toBe("uncertain");
		expect(childProcesses.spawn).toHaveBeenCalledOnce();
	});

	it("does not treat a close without exit acknowledgement as settlement", async () => {
		const child = fakeProcess();
		const owner = new OwnerActivity();
		const result = submit(owner, async () => {
			spawnSearchProcess("audited-leaf", []);
			child.emit("close", null, null);
		});
		await result.completion;
		expect(await result.settlement).toBe("uncertain");
	});

	it("accounts for a failed spawn without leaving an uncertain writer", async () => {
		const child = fakeProcess(undefined);
		// An explicit undefined must override fakeProcess's default pid.
		Object.defineProperty(child, "pid", { value: undefined });
		const owner = new OwnerActivity();
		const result = submit(owner, async () => {
			spawnSearchProcess("missing", []);
			child.emit("error", new Error("ENOENT"));
			child.emit("close", -2, null);
		});
		await result.completion;
		expect(await result.settlement).toBe("settled");
	});

	it("keeps human-started process activity across replacement until acknowledged", async () => {
		const child = fakeProcess();
		const old = new OwnerActivity();
		await old.track(async () => {
			spawnSearchProcess("audited-leaf", []);
		});
		const replacement = new OwnerActivity();
		replacement.inherit(old);
		expect(replacement.busy).toBe(true);
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		await vi.waitFor(() => expect(replacement.busy).toBe(false));
	});

	it("rejects custom backends and cancellation before any subprocess or provisioning", async () => {
		const ensure = vi.spyOn(toolsManager, "ensureTool");
		fakeProcess();
		const owner = new OwnerActivity();
		const controller = new AbortController();
		controller.abort();
		const result = submit(owner, async () => {
			await expect(resolveSearchTool("fd", true)).rejects.toThrow("unsupported");
			expect(() => spawnSearchProcess("audited-leaf", [], controller.signal)).toThrow();
		});
		await result.completion;
		expect(ensure).not.toHaveBeenCalled();
		expect(childProcesses.spawn).not.toHaveBeenCalled();
	});
});
