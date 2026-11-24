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
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { allowNetwork } from "./test-network-env.ts";

const fsFixture = vi.hoisted(() => ({
	aliasFrom: "",
	aliasTo: "",
	blockedRename: "",
	duringCopy: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		cp: (async (from, to, options) => {
			await fsFixture.duringCopy?.();
			await fs.cp(from, to, options);
		}) as typeof fs.cp,
	};
});
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
		fsFixture.duringCopy = undefined;
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
				const aliasParent = join(tempDir, "alias-parent");
				symlinkSync(dirname(active), aliasParent, process.platform === "win32" ? "junction" : "dir");
				const historical = join(aliasParent, basename(active));
				const distinctParent = join(tempDir, "distinct-parent");
				mkdirSync(distinctParent);
				settingsManager.setPackages([
					{
						source: gitSource,
						autoload: kind !== "active delta",
						extensions: [
							...(kind === "active exact" ? ["!**/*.ts"] : []),
							`-${join(historical, "extensions", "excluded.ts")}`,
							`+${join(historical, "extensions", "enabled.ts")}`,
							`-${join(distinctParent, basename(active), "extensions", "enabled.ts")}`,
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

	it.each([false, true])(
		"deduplicates explicit extension paths after revision selection (excluded: %s)",
		async (excluded) => {
			setupRemoteAndInstall();
			mkdirSync(join(remoteDir, "extensions"));
			createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
			git(["pull", "--ff-only"], installedDir);
			const original = join(installedDir, "extensions", "worker.ts");
			settingsManager.setExtensionPaths([original]);
			settingsManager.setPackages([{ source: gitSource, extensions: excluded ? ["-extensions/worker.ts"] : ["*"] }]);
			const workers = async () =>
				(await packageManager.resolve()).extensions.filter((entry) => basename(entry.path) === "worker.ts");
			expect(await workers()).toEqual([expect.objectContaining({ path: original, enabled: !excluded })]);

			createCommit(remoteDir, "extension.ts", "// next", "Advance revision");
			await packageManager.update();
			const first = join(selected(), "extensions", "worker.ts");
			expect(first).not.toBe(original);
			expect(await workers()).toEqual([expect.objectContaining({ path: first, enabled: !excluded })]);

			const alias = join(tempDir, "alias");
			symlinkSync(dirname(installedDir), alias, process.platform === "win32" ? "junction" : "dir");
			settingsManager.setExtensionPaths([join(alias, relative(dirname(installedDir), first))]);
			createCommit(remoteDir, "extension.ts", "// next again", "Advance revision again");
			await packageManager.update();
			const second = join(selected(), "extensions", "worker.ts");
			expect(second).not.toBe(first);
			expect(await workers()).toEqual([expect.objectContaining({ path: second, enabled: !excluded })]);
		},
	);

	it("preserves top-level exclusions on resources omitted by the package manifest", async () => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "worker.ts", "export default function() {}", "Add standalone worker");
		createCommit(
			remoteDir,
			"package.json",
			JSON.stringify({ name: "fixture", version: "1.0.0", pi: { extensions: [] } }),
			"Declare manifest",
		);
		settingsManager.setNpmCommand(["npm", "--offline", "--ignore-scripts"]);
		git(["pull", "--ff-only"], installedDir);
		const declared = join(installedDir, "worker.ts");
		settingsManager.setExtensionPaths([declared]);
		for (const version of ["v2", "v3"]) {
			const prior = join(selected(), "worker.ts");
			settingsManager.setExtensionPaths([declared, `-${relative(agentDir, prior)}`]);
			createCommit(remoteDir, "extension.ts", `// ${version}`, "Advance revision");
			await packageManager.update();
			const current = join(selected(), "worker.ts");
			expect(current).not.toBe(prior);
			const workers = (await packageManager.resolve()).extensions.filter(
				(entry) => basename(entry.path) === "worker.ts",
			);
			expect(workers).toEqual([expect.objectContaining({ path: current, enabled: false })]);
		}
	});

	it.each([true, false])(
		"deduplicates extensions discovered from a checkout parent (excluded: %s)",
		async (excluded) => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "index.ts", "export default function() {}", "Add index");
			createCommit(
				remoteDir,
				"package.json",
				JSON.stringify({ name: "fixture", version: "1.0.0", pi: { extensions: ["./index.ts"] } }),
				"Declare index",
			);
			settingsManager.setNpmCommand(["npm", "--offline", "--ignore-scripts"]);
			git(["pull", "--ff-only"], installedDir);
			settingsManager.setExtensionPaths([dirname(installedDir)]);
			settingsManager.setPackages([{ source: gitSource, extensions: excluded ? ["-replacement.ts"] : ["*"] }]);
			createCommit(remoteDir, "replacement.ts", "export default function() {}", "Add replacement");
			createCommit(
				remoteDir,
				"package.json",
				JSON.stringify({ name: "fixture", version: "1.0.0", pi: { extensions: ["./replacement.ts"] } }),
				"Select replacement and retain old helper",
			);
			await packageManager.update();
			const indexes = (await packageManager.resolve()).extensions.filter((entry) =>
				["index.ts", "replacement.ts"].includes(basename(entry.path)),
			);
			expect(indexes).toEqual([
				expect.objectContaining({ path: join(selected(), "replacement.ts"), enabled: !excluded }),
			]);
		},
	);

	it.each(["root", "child", "explicit child", "explicit file", "retained alias exclusion"])(
		"uses the selected manifest through a %s alias",
		async (kind) => {
			setupRemoteAndInstall();
			settingsManager.setNpmCommand(["npm", "--offline", "--ignore-scripts"]);
			createCommit(remoteDir, "old.ts", "export default function() {}", "Add old entry");
			const manifest = (entry: string) =>
				JSON.stringify({ name: "fixture", version: "1.0.0", pi: { extensions: [entry] } });
			createCommit(remoteDir, "package.json", manifest("./old.ts"), "Declare old entry");
			git(["pull", "--ff-only"], installedDir);
			const root = join(agentDir, kind.startsWith("explicit") ? "custom-extensions" : "extensions");
			const alias = kind === "root" ? root : join(root, "alias");
			mkdirSync(dirname(alias), { recursive: true });
			symlinkSync(installedDir, alias, process.platform === "win32" ? "junction" : "dir");
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			const declarations =
				kind === "explicit child" ? [root] : kind === "explicit file" ? [join(alias, "new.ts")] : [];
			settingsManager.setExtensionPaths([...declarations, `-${relative(agentDir, join(alias, "new.ts"))}`]);
			createCommit(remoteDir, "new.ts", "export default function() {}", "Add replacement");
			createCommit(remoteDir, "package.json", manifest("./new.ts"), "Select replacement");
			await packageManager.update();
			const entries = (await packageManager.resolve()).extensions.filter((entry) =>
				["old.ts", "new.ts"].includes(basename(entry.path)),
			);
			const first = join(selected(), "new.ts");
			expect(existsSync(join(alias, "new.ts"))).toBe(false);
			expect(entries).toEqual([expect.objectContaining({ path: first, enabled: false })]);
			if (kind !== "retained alias exclusion") {
				settingsManager.setExtensionPaths([...declarations, `-${relative(agentDir, first)}`]);
			}
			createCommit(remoteDir, "extension.ts", "// v3", "Advance revision again");
			await packageManager.update();
			const next = join(selected(), "new.ts");
			expect(next).not.toBe(first);
			const resolved = await packageManager.resolve();
			const entriesAfterUpdate = resolved.extensions.filter((entry) =>
				["old.ts", "new.ts"].includes(basename(entry.path)),
			);
			expect(entriesAfterUpdate).toEqual([expect.objectContaining({ path: next, enabled: false })]);
			const item = entriesAfterUpdate[0];
			if (!item) throw new Error("Expected discovered extension");
			const noop = () => {};
			const selector = new ConfigSelectorComponent(
				{ global: resolved, project: resolved },
				settingsManager,
				tempDir,
				agentDir,
				noop,
				noop,
				noop,
			);
			const list = selector.getResourceList() as unknown as {
				toggleResource(resource: typeof item & { resourceType: "extensions" }): boolean;
				setProjectTopLevelOverride(
					resource: typeof item & { resourceType: "extensions" },
					state: "inherit",
				): boolean;
			};
			settingsManager.setProjectExtensionPaths([first, `-${first}`]);
			expect(list.setProjectTopLevelOverride({ ...item, resourceType: "extensions" }, "inherit")).toBe(true);
			expect(settingsManager.getProjectSettings().extensions).toEqual([]);
			expect((await packageManager.resolve()).extensions).toContainEqual(
				expect.objectContaining({ path: next, enabled: false }),
			);
			expect(list.toggleResource({ ...item, resourceType: "extensions" })).toBe(true);
			expect(settingsManager.getGlobalSettings().extensions).toEqual([
				...declarations,
				`+${relative(agentDir, next)}`,
			]);
			expect((await packageManager.resolve()).extensions).toContainEqual(
				expect.objectContaining({ path: next, enabled: true }),
			);
		},
	);

	it("keeps a directory skill exclusion when toggling an adjacent standalone skill", async () => {
		setupRemoteAndInstall();
		await packageManager.update();
		createCommit(
			remoteDir,
			"SKILL.md",
			"---\nname: fixture\ndescription: Fixture skill\n---\nDirectory skill.\n",
			"Add directory skill",
		);
		createCommit(
			remoteDir,
			"standalone.md",
			"---\nname: standalone\ndescription: Standalone skill\n---\nStandalone skill.\n",
			"Add standalone skill",
		);
		await packageManager.update();
		const prior = selected();
		const directoryOverride = `-${relative(agentDir, prior)}`;
		settingsManager.setPackages([{ source: gitSource, autoload: false }]);
		settingsManager.setSkillPaths([
			join(prior, "SKILL.md"),
			join(prior, "standalone.md"),
			directoryOverride,
			`-${relative(agentDir, join(prior, "standalone.md"))}`,
		]);
		createCommit(remoteDir, "extension.ts", "// v3", "Advance revision");
		await packageManager.update();
		const resolved = await packageManager.resolve();
		const standalone = resolved.skills.find((entry) => entry.path === join(selected(), "standalone.md"));
		if (!standalone) throw new Error("Expected standalone skill");
		expect(standalone.enabled).toBe(false);
		const noop = () => {};
		const selector = new ConfigSelectorComponent(
			{ global: resolved, project: resolved },
			settingsManager,
			tempDir,
			agentDir,
			noop,
			noop,
			noop,
		);
		const list = selector.getResourceList() as unknown as {
			toggleResource(resource: typeof standalone & { resourceType: "skills" }): boolean;
		};
		expect(list.toggleResource({ ...standalone, resourceType: "skills" })).toBe(true);
		expect(settingsManager.getGlobalSettings().skills).toContain(directoryOverride);
		const refreshed = (await packageManager.resolve()).skills;
		expect(refreshed).toContainEqual(
			expect.objectContaining({ path: join(selected(), "standalone.md"), enabled: true }),
		);
		expect(refreshed).toContainEqual(expect.objectContaining({ path: join(selected(), "SKILL.md"), enabled: false }));
	});

	it.each(["root", "child", "explicit"])(
		"discovers selected skills, prompts and themes through %s aliases",
		async (kind) => {
			setupRemoteAndInstall();
			mkdirSync(join(remoteDir, "skills"));
			createCommit(remoteDir, "skills/README.md", "Existing skills directory", "Add directory");
			git(["pull", "--ff-only"], installedDir);
			const linkType = process.platform === "win32" ? "junction" : "dir";
			const skillRoot = join(agentDir, kind === "explicit" ? "explicit-skills" : "skills");
			if (kind !== "root") mkdirSync(skillRoot);
			symlinkSync(join(installedDir, "skills"), kind === "root" ? skillRoot : join(skillRoot, "alias"), linkType);
			for (const type of ["prompts", "themes"]) {
				mkdirSync(join(remoteDir, type));
				createCommit(remoteDir, `${type}/.keep`, "Existing directory", `Add ${type} directory`);
			}
			git(["pull", "--ff-only"], installedDir);
			if (kind === "explicit") {
				const prompts = join(agentDir, "explicit-prompts");
				const themes = join(agentDir, "explicit-themes");
				mkdirSync(prompts);
				mkdirSync(themes);
				symlinkSync(join(installedDir, "prompts"), join(prompts, "alias"), linkType);
				symlinkSync(join(installedDir, "themes"), join(themes, "alias"), linkType);
				settingsManager.setSkillPaths([skillRoot]);
				settingsManager.setPromptTemplatePaths([prompts]);
				settingsManager.setThemePaths([themes]);
			} else {
				symlinkSync(join(installedDir, "prompts"), join(agentDir, "prompts"), linkType);
				symlinkSync(join(installedDir, "themes"), join(agentDir, "themes"), linkType);
			}
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			mkdirSync(join(remoteDir, "skills", "added"));
			createCommit(
				remoteDir,
				"skills/added/SKILL.md",
				"---\nname: added\ndescription: Fixture skill\n---\nNew skill.\n",
				"Add skill to next revision",
			);
			createCommit(remoteDir, "prompts/added.md", "New prompt", "Add prompt");
			createCommit(remoteDir, "themes/added.json", "{}", "Add theme");
			await packageManager.update();
			const active = selected();
			const resources = await packageManager.resolve();
			expect(resources.skills).toContainEqual(
				expect.objectContaining({ path: join(active, "skills", "added", "SKILL.md"), enabled: true }),
			);
			expect(resources.prompts).toContainEqual(
				expect.objectContaining({ path: join(active, "prompts", "added.md"), enabled: true }),
			);
			expect(resources.themes).toContainEqual(
				expect.objectContaining({ path: join(active, "themes", "added.json"), enabled: true }),
			);
		},
	);

	it.skipIf(process.platform === "win32")("deduplicates an auto-discovered symlink to an old checkout", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
		git(["pull", "--ff-only"], installedDir);
		const original = join(installedDir, "extensions", "worker.ts");
		const link = join(agentDir, "extensions", "worker.ts");
		mkdirSync(dirname(link));
		symlinkSync(original, link);
		createCommit(remoteDir, "extension.ts", "// v2", "Advance revision");
		await packageManager.update();
		const workers = (await packageManager.resolve()).extensions.filter(
			(entry) => basename(entry.path) === "worker.ts",
		);
		expect(workers).toEqual([
			expect.objectContaining({ path: join(selected(), "extensions", "worker.ts"), enabled: true }),
		]);
	});

	it("keeps a pinned fetch result isolated from a competing update", async () => {
		setupRemoteAndInstall();
		const pinnedCommit = createCommit(remoteDir, "extension.ts", "// pinned", "Pinned revision");
		git(["tag", "pinned"], remoteDir);
		createCommit(remoteDir, "extension.ts", "// latest", "Latest revision");
		const pinnedSource = `${gitSource}@pinned`;
		settingsManager.setPackages([pinnedSource]);
		const competingSettings = SettingsManager.inMemory();
		competingSettings.setPackages([gitSource]);
		const competitor = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager: competingSettings });
		const manager = packageManager as unknown as {
			runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
		};
		const run = manager.runCommand.bind(manager);
		let competed = false;
		vi.spyOn(manager, "runCommand").mockImplementation(async (command, args, options) => {
			await run(command, args, options);
			if (command === "git" && args[0] === "fetch" && args.at(-1) === "pinned") {
				competed = true;
				await expect(competitor.update()).rejects.toMatchObject({ code: "ELOCKED" });
			}
		});
		let snapshotContended = false;
		fsFixture.duringCopy = async () => {
			await expect(competitor.update()).rejects.toMatchObject({ code: "ELOCKED" });
			snapshotContended = true;
		};
		await packageManager.update();
		expect(competed).toBe(true);
		expect(snapshotContended).toBe(true);
		expect(getCurrentCommit(selected(pinnedSource))).toBe(pinnedCommit);
	});

	it("preserves an exclusion of a root skill by its previous revision directory", async () => {
		setupRemoteAndInstall();
		createCommit(
			remoteDir,
			"SKILL.md",
			"---\nname: root-skill\ndescription: Fixture skill\n---\nRead this skill.\n",
			"Add root skill",
		);
		settingsManager.setNpmCommand(["npm", "--offline", "--ignore-scripts"]);
		createCommit(
			remoteDir,
			"package.json",
			JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./SKILL.md"] } }),
			"Declare skill",
		);
		await packageManager.update();
		const prior = selected();
		const unrelated = join(dirname(prior), `.pi-revision-${"0".repeat(64)}-Ab1234`);
		settingsManager.setPackages([{ source: gitSource, skills: [`-${unrelated}`] }]);
		expect(
			(await packageManager.resolve()).skills.find((entry) => entry.path === join(prior, "SKILL.md"))?.enabled,
		).toBe(true);
		settingsManager.setPackages([{ source: gitSource, skills: [`-${prior}`] }]);
		createCommit(remoteDir, "extension.ts", "// v3", "Advance revision");
		await packageManager.update();
		const current = selected();
		expect(current).not.toBe(prior);
		expect(
			(await packageManager.resolve()).skills.find((entry) => entry.path === join(current, "SKILL.md"))?.enabled,
		).toBe(false);
	});

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
