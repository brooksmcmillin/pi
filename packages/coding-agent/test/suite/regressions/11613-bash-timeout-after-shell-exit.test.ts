import type * as ChildProcessModule from "node:child_process";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { ChildProcess, spawn } from "child_process";
import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../../src/core/tools/bash.ts";

vi.mock("child_process", async (importOriginal) => {
	const original = await importOriginal<typeof ChildProcessModule>();
	return { ...original, spawn: vi.fn(original.spawn) };
});

/**
 * Regression test for https://github.com/earendil-works/pi/issues/11613
 *
 * The bash tool waits for stdout/stderr to close, not only for the shell to exit (#5303). A background
 * process that inherited those pipes and keeps writing keeps the tool waiting after the shell exited.
 * When the timeout then hit, the tool reported only "Command timed out", so the shell's real exit code
 * and the fact that it had already finished were lost. The tool now reports both.
 */
describe.skipIf(process.platform === "win32")("issue #11613 bash timeout after the shell exited", () => {
	const bashTool = createBashTool(tmpdir());

	async function runExpectingTimeout(command: string, timeout: number): Promise<string> {
		const error = await bashTool.execute("test-11613", { command, timeout }).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(Error);
		return (error as Error).message;
	}

	it("reports the shell's exit code when background processes kept writing until the timeout", async () => {
		// Control process events so host scheduling cannot cross the post-exit idle cutoff.
		const child = new ChildProcess();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		child.stdout = stdout;
		child.stderr = stderr;
		const spawned = Promise.withResolvers<void>();
		vi.mocked(spawn).mockImplementationOnce(() => {
			spawned.resolve();
			return child;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const failure = bashTool.execute("test-11613", { command: "controlled-child", timeout: 1 }).then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await spawned.promise;
			await vi.advanceTimersByTimeAsync(200);
			stderr.write("boom\n");
			child.emit("exit", 3, null);
			for (let elapsed = 200; elapsed < 920; elapsed += 90) {
				await vi.advanceTimersByTimeAsync(90);
				stdout.write("tick\n");
			}
			await vi.advanceTimersByTimeAsync(80);
			stdout.end();
			stderr.end();
			const error = await failure;
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toContain("boom");
			expect(message).toMatch(
				/Command timed out after 1 seconds\. The shell exited with code 3 after 0\.2 seconds, but background processes it started kept writing output until the timeout\.$/,
			);
		} finally {
			child.emit("close", 3, null);
			await failure;
			vi.useRealTimers();
		}
	});

	it("keeps the plain timeout message when the shell was still running at the deadline", async () => {
		const message = await runExpectingTimeout("echo started; sleep 30", 0.3);
		expect(message).toMatch(/started\s+Command timed out after 0\.3 seconds$/);
	});
});
