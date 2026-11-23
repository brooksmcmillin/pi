import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
for (const mode of ["setup", "body", "teardown", "pass", "fail", "clock-jump"]) {
	test(
		`diagnostics preserve ${mode} evidence and reap processes`,
		{ timeout: 15000, skip: process.platform === "win32" },
		async (t) => {
			const root = mkdtempSync(join(tmpdir(), "p2-hang-"));
			try {
				const directory = join(root, "attempt");
				const clockJump = mode === "clock-jump";
				const marker = join(root, "clock-jump");
				const env = {
					...process.env,
					P2_DIAGNOSTIC_FIXTURE: clockJump ? "body" : mode,
					P2_DIAGNOSTIC_CLOCK_JUMP: marker,
				};
				const started = performance.now();
				// This is an independent runner, not a child of the outer Node test harness.
				delete env.NODE_TEST_CONTEXT;
				const child = spawn(
					process.execPath,
					[
						...(clockJump ? ["--import", "./test/fixtures/diagnostic-clock-jump.mjs"] : []),
						"scripts/test-diagnose.mjs",
						directory,
						clockJump ? "60" : "2",
						"--test",
						"--test-concurrency=1",
						"test/fixtures/diagnostic-hang.mjs",
					],
					{
						cwd,
						env,
						stdio: "inherit",
					},
				);
				t.after(() => {
					child.kill("SIGTERM");
					const path = join(directory, "events.jsonl");
					if (!existsSync(path)) return;
					const spawnEvent = readFileSync(path, "utf8")
						.trim()
						.split("\n")
						.map(JSON.parse)
						.find((event) => event.event === "spawn");
					if (!spawnEvent) return;
					try {
						process.kill(-spawnEvent.pgid, "SIGKILL");
					} catch (error) {
						if (error.code !== "ESRCH") throw error;
					}
				});
				if (clockJump) {
					const path = join(directory, "phases.jsonl");
					while (!existsSync(path) || !readFileSync(path, "utf8").includes('"phase":"test:start"')) {
						assert.ok(performance.now() - started < 5000, "hanging fixture did not become ready");
						await new Promise((resolve) => setTimeout(resolve, 25));
					}
					writeFileSync(marker, "advance");
				}
				const code = await new Promise((resolve, reject) => {
					child.on("error", reject);
					child.on("exit", resolve);
				});
				const hanging = clockJump || ["setup", "body", "teardown"].includes(mode);
				assert.equal(code, hanging ? 124 : mode === "fail" ? 1 : 0);
				const events = readFileSync(join(directory, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
				const phases = readFileSync(join(directory, "phases.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
				assert.equal(events[0].event, "launch");
				assert.ok(events.some((event) => event.event === "spawn" && event.pid === event.pgid));
				assert.ok(events.some((event) => event.event === "runner-exit"));
				assert.equal(events.at(-1).event, "terminal");
				assert.ok(performance.now() - started < 10000);
				if (clockJump) assert.ok(events.at(-1).elapsedMs >= 60_000);
				const names = phases.map((entry) => entry.phase);
				assert.ok(names.includes("node-preload"));
				assert.ok(names.includes("fixture-module"));
				if (hanging) {
					const prefix = mode === "body" || clockJump ? "test" : mode;
					assert.ok(names.includes(`${prefix}:start`));
					assert.ok(!names.includes(`${prefix}:end`));
					assert.ok(events.some((event) => event.reason === "deadline"));
					assert.ok(new Set(phases.map((entry) => entry.pid)).size >= 2, "fixture and grandchild recorded");
				} else {
					assert.ok(names.includes("teardown:end"));
				}
				for (const pid of new Set([
					...phases.map((entry) => entry.pid),
					events.find((event) => event.event === "spawn").pid,
				])) {
					assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `pid ${pid} survived`);
				}
			} finally {
				t.after(() => rmSync(root, { recursive: true, force: true }));
			}
		},
	);
}
