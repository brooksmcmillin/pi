/**
 * Tests for git-based extension updates, specifically handling force-push scenarios.
 *
 * These tests verify that DefaultPackageManager.update() handles:
 * - Normal git updates (no force-push)
 * - Force-pushed remotes after a complete history rewrite
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { allowNetwork } from "./test-network-env.ts";

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
	getGitInstallPath(source: GitSourceForTest, scope: "temporary"): string;
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
			expect(getCurrentCommit(installedDir)).toBe(newCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
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

	it("reclaims a leftover backup without replacing the up-to-date checkout", async () => {
		setupRemoteAndInstall();
		const original = getCurrentCommit(installedDir);
		const identity = join(realpathSync(dirname(installedDir)), "extension");
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
		it("rebuilds a checkout marked incomplete by an older Pi version", async () => {
			setupRemoteAndInstall();
			const newCommit = createCommit(
				remoteDir,
				"package.json",
				JSON.stringify({ name: "test-extension", version: "1.0.0" }),
				"Add package.json",
			);

			git(["pull", "--ff-only"], installedDir);
			const installs: Array<string | undefined> = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				const commandLine = `${command} ${args.join(" ")}`;
				if (command === "npm") {
					installs.push(options?.cwd);
					return;
				}
				const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf-8" });
				if (result.status !== 0) {
					throw new Error(`Command failed: ${commandLine}\n${result.stderr}`);
				}
			};
			const markerPath = join(dirname(installedDir), ".extension.pi-update-incomplete");
			writeFileSync(markerPath, "");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(newCommit);
			expect(installs).toEqual([expect.stringContaining(".extension.pi-update-")]);
			expect(existsSync(markerPath)).toBe(false);
		});
	});

	describe("force-push scenarios", () => {
		it("should handle complete history rewrite", async () => {
			setupRemoteAndInstall();

			// Remote gets several commits
			createCommit(remoteDir, "extension.ts", "// v2", "v2");
			createCommit(remoteDir, "extension.ts", "// v3", "v3");

			await packageManager.update();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v3");

			// Maintainer force-pushes completely different history
			git(["reset", "--hard", "HEAD~2"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// rewrite-a", "Rewrite A");
			const finalCommit = createCommit(remoteDir, "extension.ts", "// rewrite-b", "Rewrite B");

			// Should handle this gracefully
			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(finalCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// rewrite-b");
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

			expect(getCurrentCommit(installedDir)).toBe(v2Commit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");

			git(["checkout", "v1"], installedDir);

			await packageManager.update(pinnedSource);

			expect(getCurrentCommit(installedDir)).toBe(v2Commit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});
	});

	describe("temporary git sources", () => {
		it("should refresh cached temporary git sources when resolving", async () => {
			const managerWithPaths = packageManager as unknown as PackageManagerPathInternals;
			const cachedDir = managerWithPaths.getGitInstallPath(managerWithPaths.parseSource(gitSource), "temporary");
			const extensionFile = join(cachedDir, "pi-extensions", "session-breakdown.ts");

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

			expect(resources.extensions.some((entry) => entry.path === extensionFile)).toBe(true);
			expect(getCurrentCommit(cachedDir)).toBe(newCommit);
			expect(getFileContent(cachedDir, "pi-extensions/session-breakdown.ts")).toBe("// fresh");
		});
	});
});
