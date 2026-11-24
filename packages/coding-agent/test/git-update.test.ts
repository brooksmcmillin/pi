/**
 * Tests for git-based extension updates, specifically handling force-push scenarios.
 *
 * These tests verify that DefaultPackageManager.update() handles:
 * - Normal git updates (no force-push)
 * - Force-pushed remotes after a complete history rewrite
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { allowNetwork } from "./test-network-env.ts";

const fsFixture = vi.hoisted(() => ({ aliasFrom: "", aliasTo: "", blockedRename: "" }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const map = (path: Parameters<typeof fs.existsSync>[0]) => (path === fsFixture.aliasFrom ? fsFixture.aliasTo : path);
	return {
		...fs,
		existsSync: (path: Parameters<typeof fs.existsSync>[0]) => fs.existsSync(map(path)),
		statSync: ((path, options) => fs.statSync(map(path)!, options)) as typeof fs.statSync,
		renameSync: ((from, to) => {
			if (to === fsFixture.blockedRename) throw new Error("injected pointer rename failure");
			fs.renameSync(from, to);
		}) as typeof fs.renameSync,
	};
});

// Helper to run git commands in a directory
function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: git ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function initGitRepo(repoDir: string): void {
	git(["init", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
}

// Helper to create a commit with a file
function createCommit(repoDir: string, filename: string, content: string, message: string): string {
	writeFileSync(join(repoDir, filename), content);
	git(["add", filename], repoDir);
	git(["commit", "-m", message], repoDir);
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get current commit hash
function getCurrentCommit(repoDir: string): string {
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get file content
function getFileContent(repoDir: string, filename: string): string {
	return readFileSync(join(repoDir, filename), "utf-8");
}

type GitSourceForTest = {
	type: "git";
	repo: string;
	host: string;
	path: string;
	pinned: boolean;
	ref?: string;
};

interface PackageManagerPathInternals {
	parseSource(source: string): GitSourceForTest;
	getGitInstallPath(source: GitSourceForTest, scope: "user" | "temporary"): string;
}

describe("DefaultPackageManager git update", () => {
	let tempDir: string;
	let remoteDir: string; // Simulates the "remote" repository
	let agentDir: string; // The agent directory where extensions are installed
	let installedDir: string; // The installed extension directory
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	// Git source that maps to our installed directory structure.
	// Must use "git:" prefix so parseSource() treats it as a git source
	// (bare "github.com/..." is not recognized as a git URL).
	const gitSource = "git:github.com/test/extension";

	beforeEach(() => {
		allowNetwork();
		tempDir = join(tmpdir(), `git-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");

		// This matches the path structure: agentDir/git/<host>/<path>
		installedDir = join(agentDir, "git", "github.com", "test", "extension");

		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		fsFixture.blockedRename = "";
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/** Sets up a "remote" repository and clones it to the installed directory. */
	function setupRemoteAndInstall(): void {
		// Create "remote" repository
		mkdirSync(remoteDir, { recursive: true });
		initGitRepo(remoteDir);
		createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

		// Clone to installed directory (simulating what install() does)
		mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
		git(["clone", remoteDir, installedDir], tempDir);
		git(["config", "--local", "user.email", "test@test.com"], installedDir);
		git(["config", "--local", "user.name", "Test"], installedDir);

		// Add to global packages so update() processes this source
		settingsManager.setPackages([gitSource]);
	}

	const selected = (source = gitSource, scope: "user" | "temporary" = "user") => {
		const manager = packageManager as unknown as PackageManagerPathInternals;
		return manager.getGitInstallPath(manager.parseSource(source), scope);
	};

	describe("normal updates (no force-push)", () => {
		it("should skip reset, clean, and install when already up to date", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			writeFileSync(join(remoteDir, "package.json"), JSON.stringify({ name: "test-extension", version: "1.0.0" }));
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			settingsManager.setPackages([gitSource]);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "npm") {
					return;
				}
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			const updated: string[] = [];
			packageManager.setProgressCallback((event) => {
				if (event.type === "result" && event.action === "update" && event.message) updated.push(event.message);
			});
			await packageManager.update();

			expect(updated).toEqual([]);
			expect(executedCommands).toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(executedCommands).not.toContain("git fetch --prune origin");
			expect(executedCommands.some((command) => /^git .*\b(reset|clean)\b/.test(command))).toBe(false);
			expect(executedCommands.some((command) => command.startsWith("npm install"))).toBe(false);
		});

		it("should update to latest commit when remote has new commits", async () => {
			setupRemoteAndInstall();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
			const oldCommit = getCurrentCommit(installedDir);

			// Add a new commit to remote
			const newCommit = createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			// Update via package manager (no args = uses settings)
			const updated: string[] = [];
			packageManager.setProgressCallback((event) => {
				if (event.type === "result" && event.action === "update" && event.message) updated.push(event.message);
			});
			await packageManager.update();

			// Verify update succeeded
			expect(updated).toEqual([`${gitSource} ${oldCommit.slice(0, 7)} -> ${newCommit.slice(0, 7)}`]);
			expect(getCurrentCommit(selected())).toBe(newCommit);
			expect(getFileContent(selected(), "extension.ts")).toBe("// v2");
		});
	});

	it("refuses to stage a checkout with a separate Git directory", async () => {
		mkdirSync(remoteDir, { recursive: true });
		initGitRepo(remoteDir);
		const original = createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
		mkdirSync(dirname(installedDir), { recursive: true });
		const metadataDir = join(tempDir, "separate-metadata");
		git(["clone", "--separate-git-dir", metadataDir, remoteDir, installedDir], tempDir);
		settingsManager.setPackages([gitSource]);
		createCommit(remoteDir, "extension.ts", "// v2", "Update");

		await expect(packageManager.update()).rejects.toThrow("standalone .git directory");
		expect(getCurrentCommit(installedDir)).toBe(original);
		expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
	});

	it.skipIf(process.platform === "win32")("refuses to stage a checkout with linked refs", async () => {
		setupRemoteAndInstall();
		const original = getCurrentCommit(installedDir);
		const refs = join(installedDir, ".git", "refs");
		const externalRefs = join(tempDir, "shared-refs");
		renameSync(refs, externalRefs);
		symlinkSync(externalRefs, refs, "dir");
		createCommit(remoteDir, "extension.ts", "// v2", "Update");

		await expect(packageManager.update()).rejects.toThrow("symbolic link in Git metadata");
		expect(getCurrentCommit(installedDir)).toBe(original);
		expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
	});

	it.each(["absolute", "tilde", "anchored glob", "active exact", "active delta"])(
		"preserves a %s exclusion after selecting a new revision",
		async (kind) => {
			setupRemoteAndInstall();
			mkdirSync(join(remoteDir, "extensions"));
			createCommit(remoteDir, "extensions/excluded.ts", "export default function() {}", "Add excluded extension");
			createCommit(remoteDir, "extensions/enabled.ts", "export default function() {}", "Add enabled extension");
			const exclusion =
				kind === "tilde"
					? `-~/${relative(tempDir, join(installedDir, "extensions", "excluded.ts")).replaceAll("\\", "/")}`
					: `-${join(installedDir, "extensions", "excluded.ts")}`;
			if (kind === "tilde") vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", tempDir);
			const patterns =
				kind === "anchored glob" ? [`!${join(installedDir, "extensions", "excl*.ts")}`] : ["*", exclusion];
			settingsManager.setPackages([{ source: gitSource, extensions: patterns }]);

			await packageManager.update();

			let active = selected();
			expect(active).not.toBe(installedDir);
			if (kind === "active exact" || kind === "active delta") {
				const reported = packageManager.listConfiguredPackages()[0]?.installedPath;
				expect(reported).toBe(active);
				settingsManager.setPackages([
					{
						source: gitSource,
						autoload: kind !== "active delta",
						extensions: [
							`-${join(reported!, "extensions", "excluded.ts")}`,
							`+${join(reported!, "extensions", "enabled.ts")}`,
						],
					},
				]);
				createCommit(remoteDir, "extension.ts", "// v3", "Advance revision without changing extensions");
				await packageManager.update();
				active = selected();
				expect(active).not.toBe(reported);
			}
			const { extensions } = await packageManager.resolve();
			expect(extensions.find((entry) => entry.path === join(active, "extensions", "excluded.ts"))?.enabled).toBe(
				false,
			);
			expect(extensions.find((entry) => entry.path === join(active, "extensions", "enabled.ts"))?.enabled).toBe(
				true,
			);
		},
	);

	it("loads and removes a repository with a nonreserved revision prefix", async () => {
		const source = "git:github.com/test/.pi-revision-tools";
		const worker = join(dirname(installedDir), ".pi-revision-tools", "extensions", "worker.ts");
		mkdirSync(dirname(worker), { recursive: true });
		writeFileSync(worker, "export default function() {}");
		const reserved = `git:github.com/test/.pi-revision-${"a".repeat(64)}-Ab1234`;
		settingsManager.setPackages([reserved, source]);
		const resolved = await packageManager.resolve();
		expect(resolved.installFailures).toEqual([
			expect.objectContaining({ source: reserved, message: expect.stringContaining("reserved revision namespace") }),
		]);
		expect(resolved.extensions.some((entry) => entry.path === worker && entry.enabled)).toBe(true);
		expect(packageManager.listConfiguredPackages().find((entry) => entry.source === source)?.installedPath).toBe(
			dirname(dirname(worker)),
		);
		await expect(packageManager.removeAndPersist(source)).resolves.toBe(true);
		expect(existsSync(worker)).toBe(false);
	});

	it.each([false, true])("isolates invalid revision state (directory: %s)", async (directory) => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "extension.ts", "// v2", "Update");
		await packageManager.update();
		const active = selected();
		const key = basename(active).match(/^\.pi-revision-([a-f0-9]{64})-/)?.[1];
		if (!key) throw new Error("Expected a selected revision");
		const pointer = join(agentDir, "git", ".git-update-state", `${key}.current`);
		if (directory) {
			rmSync(pointer);
			mkdirSync(pointer);
		} else {
			writeFileSync(pointer, "invalid");
		}
		const other = join(agentDir, "git", "github.com", "test", "other", "extensions", "healthy.ts");
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/healthy.ts", "export default function() {}", "Add healthy extension");
		git(["clone", remoteDir, dirname(dirname(other))], tempDir);
		settingsManager.setPackages([gitSource, "git:github.com/test/other"]);

		const resources = await packageManager.resolve();
		expect(resources.installFailures).toEqual([
			{
				source: gitSource,
				scope: "user",
				message: expect.stringContaining(directory ? "Expected a regular file" : "Invalid Git revision pointer"),
			},
		]);
		expect(resources.extensions.some((entry) => entry.metadata.source === gitSource)).toBe(false);
		expect(resources.extensions.some((entry) => entry.path === other && entry.enabled)).toBe(true);
		const listed = packageManager.listConfiguredPackages();
		expect(listed.find((entry) => entry.source === gitSource)?.installedPath).toBeUndefined();
		expect(listed.find((entry) => entry.source === "git:github.com/test/other")?.installedPath).toBe(
			dirname(dirname(other)),
		);
		createCommit(remoteDir, "extension.ts", "// v3", "Update healthy package");
		expect(await packageManager.checkForAvailableUpdates()).toEqual([
			expect.objectContaining({ source: "git:github.com/test/other" }),
		]);
		if (directory) return;
		await expect(packageManager.removeAndPersist(gitSource)).resolves.toBe(true);
		expect(existsSync(active)).toBe(false);
		expect(existsSync(installedDir)).toBe(false);
		expect(existsSync(other)).toBe(true);
	});

	it("waits for the logical checkout lock before resolving a missing selected revision", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
		await packageManager.update();
		const active = selected();
		const key = basename(active).match(/^\.pi-revision-([a-f0-9]{64})-/)?.[1];
		if (!key) throw new Error("Expected a selected revision");
		const state = join(agentDir, "git", ".git-update-state", key);
		const held = join(tempDir, "held-revision");
		const release = lockfile.lockSync(state, { realpath: false });
		vi.stubEnv("PI_OFFLINE", "1");
		renameSync(active, held);
		let settled = false;
		const resolution = packageManager.resolve().finally(() => {
			settled = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(settled).toBe(false);
		} finally {
			renameSync(held, active);
			release();
			await resolution;
		}
		expect(
			(await resolution).extensions.some((entry) => entry.path === join(active, "extensions", "worker.ts")),
		).toBe(true);
	});

	it("keeps the selected checkout when publishing another revision fails", async () => {
		setupRemoteAndInstall();
		const expected = createCommit(remoteDir, "extension.ts", "// v2", "Update");
		await packageManager.update();
		const active = selected();
		const key = basename(active).match(/^\.pi-revision-([a-f0-9]{64})-/)?.[1];
		if (!key) throw new Error("Expected a selected revision");
		const pointer = join(agentDir, "git", ".git-update-state", `${key}.current`);
		fsFixture.blockedRename = pointer;
		createCommit(remoteDir, "extension.ts", "// v3", "New update");

		await expect(packageManager.update()).rejects.toThrow("injected pointer rename failure");
		expect(selected()).toBe(active);
		expect(getCurrentCommit(active)).toBe(expected);
		expect(getFileContent(active, "extension.ts")).toBe("// v2");

		rmSync(pointer);
		mkdirSync(pointer);
		await expect(packageManager.removeAndPersist(gitSource)).rejects.toThrow("expected a regular file");
		expect(packageManager.listConfiguredPackages().some((entry) => entry.source === gitSource)).toBe(true);
		expect(existsSync(installedDir)).toBe(true);
		expect(getCurrentCommit(active)).toBe(expected);
	});

	it("distinguishes case-sensitive checkout names and shares selection for filesystem case aliases", async () => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "extension.ts", "// v2", "Update");
		await packageManager.update();
		const active = selected();
		const aliasSource = "git:github.com/test/EXTENSION";
		const aliasPath = join(dirname(installedDir), "EXTENSION");
		if (existsSync(aliasPath)) {
			expect(basename(selected(aliasSource))).toBe(basename(active));
			await packageManager.remove(aliasSource);
			expect(existsSync(active)).toBe(false);
			expect(existsSync(installedDir)).toBe(false);
		} else {
			const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
			fsFixture.aliasFrom = aliasPath;
			fsFixture.aliasTo = installedDir;
			try {
				Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
				expect(selected(aliasSource)).toBe(active);
			} finally {
				Object.defineProperty(process, "platform", platform);
				fsFixture.aliasFrom = "";
				fsFixture.aliasTo = "";
			}
			mkdirSync(aliasPath);
			expect(selected(aliasSource)).toBe(aliasPath);
			await packageManager.remove(aliasSource);
			expect(getFileContent(active, "extension.ts")).toBe("// v2");
		}
	});

	it("keeps the selected revision after moving its managed root", async () => {
		setupRemoteAndInstall();
		const expected = createCommit(remoteDir, "extension.ts", "// v2", "Update");
		await packageManager.update();
		const active = selected();
		const newRoot = join(tempDir, "moved-agent");
		renameSync(agentDir, newRoot);
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir: newRoot, settingsManager });
		expect(selected()).toBe(join(newRoot, relative(agentDir, active)));
		expect(getCurrentCommit(selected())).toBe(expected);
	});

	it("reclaims a leftover backup without replacing the up-to-date checkout", async () => {
		setupRemoteAndInstall();
		const original = getCurrentCommit(installedDir);
		const identity = relative(join(agentDir, "git"), installedDir);
		const key = createHash("sha256")
			.update(process.platform === "win32" ? identity.toLowerCase() : identity)
			.digest("hex");
		const previous = join(agentDir, "git", ".git-update-state", `${key}.previous`);
		mkdirSync(previous, { recursive: true });
		writeFileSync(join(previous, "extension.ts"), "// old backup");
		writeFileSync(join(installedDir, "local.txt"), "keep");

		await packageManager.update();

		expect(existsSync(previous)).toBe(false);
		expect(getCurrentCommit(installedDir)).toBe(original);
		expect(getFileContent(installedDir, "local.txt")).toBe("keep");
	});

	describe("legacy interrupted updates", () => {
		// https://github.com/earendil-works/pi/issues/11597
		it.each([false, true])("rebuilds a legacy incomplete checkout (marker cleanup blocked: %s)", async (blocked) => {
			setupRemoteAndInstall();
			const newCommit = createCommit(
				remoteDir,
				"package.json",
				JSON.stringify({ name: "test-extension", version: "1.0.0" }),
				"Add package.json",
			);

			git(["pull", "--ff-only"], installedDir);
			const installs: Array<string | undefined> = [];
			const markerPath = join(dirname(installedDir), ".extension.pi-update-incomplete");
			writeFileSync(markerPath, "");
			const warnings: string[] = [];
			packageManager.setProgressCallback((event) => {
				if (event.message?.includes("Could not remove temporary Git package files")) warnings.push(event.message);
			});
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				const commandLine = `${command} ${args.join(" ")}`;
				if (command === "npm") {
					installs.push(options?.cwd);
					if (blocked) {
						rmSync(markerPath);
						mkdirSync(markerPath);
					}
					return;
				}
				const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf-8" });
				if (result.status !== 0) {
					throw new Error(`Command failed: ${commandLine}\n${result.stderr}`);
				}
			};
			await packageManager.update();

			expect(getCurrentCommit(selected())).toBe(newCommit);
			expect(installs).toEqual([expect.stringContaining(".pi-revision-")]);
			expect(existsSync(markerPath)).toBe(blocked);
			expect(warnings).toEqual(blocked ? [expect.stringContaining(markerPath)] : []);
		});
	});

	describe("force-push scenarios", () => {
		it("should handle complete history rewrite", async () => {
			setupRemoteAndInstall();

			// Remote gets several commits
			createCommit(remoteDir, "extension.ts", "// v2", "v2");
			createCommit(remoteDir, "extension.ts", "// v3", "v3");

			await packageManager.update();
			expect(getFileContent(selected(), "extension.ts")).toBe("// v3");

			// Maintainer force-pushes completely different history
			git(["reset", "--hard", "HEAD~2"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// rewrite-a", "Rewrite A");
			const finalCommit = createCommit(remoteDir, "extension.ts", "// rewrite-b", "Rewrite B");

			// Should handle this gracefully
			await packageManager.update();

			expect(getCurrentCommit(selected())).toBe(finalCommit);
			expect(getFileContent(selected(), "extension.ts")).toBe("// rewrite-b");
		});
	});

	describe("pinned sources", () => {
		it("should checkout the configured pinned git ref during full and targeted updates", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			const v1Commit = createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["tag", "v1"], remoteDir);
			const v2Commit = createCommit(remoteDir, "extension.ts", "// v2", "Second commit");
			git(["tag", "v2"], remoteDir);

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["checkout", "v1"], installedDir);
			expect(getCurrentCommit(installedDir)).toBe(v1Commit);

			const pinnedSource = `${gitSource}@v2`;
			settingsManager.setPackages([pinnedSource]);

			await packageManager.update();

			expect(getCurrentCommit(selected(pinnedSource))).toBe(v2Commit);
			expect(getFileContent(selected(), "extension.ts")).toBe("// v2");

			git(["checkout", "v1"], selected(pinnedSource));

			await packageManager.update(pinnedSource);

			expect(getCurrentCommit(selected(pinnedSource))).toBe(v2Commit);
			expect(getFileContent(selected(), "extension.ts")).toBe("// v2");
		});
	});

	describe("temporary git sources", () => {
		it("should refresh cached temporary git sources when resolving", async () => {
			const managerWithPaths = packageManager as unknown as PackageManagerPathInternals;
			const cachedDir = managerWithPaths.getGitInstallPath(managerWithPaths.parseSource(gitSource), "temporary");

			mkdirSync(join(remoteDir, "pi-extensions"), { recursive: true });
			initGitRepo(remoteDir);
			writeFileSync(
				join(remoteDir, "package.json"),
				JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
			);
			git(["add", "package.json"], remoteDir);
			createCommit(remoteDir, "pi-extensions/session-breakdown.ts", "// stale", "Initial package");
			mkdirSync(dirname(cachedDir), { recursive: true });
			git(["clone", remoteDir, cachedDir], tempDir);
			const newCommit = createCommit(remoteDir, "pi-extensions/session-breakdown.ts", "// fresh", "Update package");
			settingsManager.setNpmCommand(["npm", "--offline", "--ignore-scripts"]);

			const resources = await packageManager.resolveExtensionSources([gitSource], { temporary: true });

			const active = selected(gitSource, "temporary");
			expect(
				resources.extensions.some((entry) => entry.path === join(active, "pi-extensions", "session-breakdown.ts")),
			).toBe(true);
			expect(getCurrentCommit(active)).toBe(newCommit);
			expect(getFileContent(active, "pi-extensions/session-breakdown.ts")).toBe("// fresh");
		});
	});
});
