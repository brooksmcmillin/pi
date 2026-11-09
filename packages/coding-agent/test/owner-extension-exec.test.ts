import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../src/core/exec.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const exec = vi.hoisted(() => vi.fn());
vi.mock("../src/core/exec.ts", () => ({ execCommand: exec }));
afterEach(() => exec.mockReset());

describe("extension exec owner accounting", () => {
	it("counts pi.exec started by a factory before session enrollment", async () => {
		let finish!: (value: ExecResult) => void;
		exec.mockImplementation(
			() =>
				new Promise<ExecResult>((resolve) => {
					finish = resolve;
				}),
		);
		let pending!: Promise<ExecResult>;
		const extensions = await createTestExtensionsResult([
			(pi) => {
				pending = pi.exec("offline-fixture", []);
			},
		]);
		const owner = extensions.runtime.ownerActivity;
		expect(exec).toHaveBeenCalledTimes(1);
		expect(
			owner.submit(
				owner.snapshot,
				() => true,
				true,
				async () => {},
			),
		).toEqual({ status: "rejected", reason: "busy" });
		finish({ stdout: "", stderr: "", code: 0, killed: false, truncated: false });
		await pending;
		expect(owner.busy).toBe(false);
	});

	it("fails closed before an autonomous subprocess starts", async () => {
		let api!: ExtensionAPI;
		const extensions = await createTestExtensionsResult([
			(pi) => {
				api = pi;
			},
		]);
		const owner = extensions.runtime.ownerActivity;
		const result = owner.submit(
			owner.snapshot,
			() => true,
			true,
			() => api.exec("offline-fixture", []),
		);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await expect(result.completion).rejects.toThrow("supported subprocess settlement backend");
		expect(exec).not.toHaveBeenCalled();
		expect(owner.busy).toBe(false);
	});
});
