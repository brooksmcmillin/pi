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
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { allowNetwork } from "./test-network-env.ts";

const fsFixture = vi.hoisted(() => ({
	aliasFrom: "",
	aliasTo: "",
	blockedRename: "",
	duringCopy: undefined as (() => Promise<void>) | undefined,
	duringRemove: undefined as ((path: string, removed: boolean) => Promise<void>) | undefined,
}));
function mapAlias<T>(path: T): T | string {
	return path === fsFixture.aliasFrom ? fsFixture.aliasTo : path;
}

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		cp: (async (from, to, options) => {
			await fsFixture.duringCopy?.();
			await fs.cp(from, to, options);
		}) as typeof fs.cp,
		rm: (async (path, options) => {
			await fsFixture.duringRemove?.(String(path), false);
			await fs.rm(mapAlias(path), options);
			await fsFixture.duringRemove?.(String(path), true);
		}) as typeof fs.rm,
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		existsSync: (path: Parameters<typeof fs.existsSync>[0]) => fs.existsSync(mapAlias(path)),
		statSync: ((path, options) => fs.statSync(mapAlias(path)!, options)) as typeof fs.statSync,
		rmSync: ((path, options) => fs.rmSync(mapAlias(path), options)) as typeof fs.rmSync,
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

	it.skipIf(process.platform === "win32")(
		"preserves a project extension exclusion when checkout selection collapses the alias",
		async () => {
			setupRemoteAndInstall();
			createCommit(
				remoteDir,
				"extension.ts",
				"export default function(pi) { pi.registerCommand('git-alias-fixture', { handler: async () => {} }); }",
				"Add extension",
			);
			createCommit(
				remoteDir,
				"package.json",
				JSON.stringify({ pi: { extensions: ["extension.ts"] } }),
				"Declare extension",
			);
			await packageManager.update();
			const active = join(selected(), "extension.ts");
			expect((await packageManager.resolve()).extensions).toContainEqual(
				expect.objectContaining({ path: active, enabled: true }),
			);
			const alias = join(tempDir, "extension-alias.ts");
			symlinkSync(join(installedDir, "extension.ts"), alias);
			settingsManager.setProjectExtensionPaths([alias, `-${alias}`]);
			const { extensions } = await packageManager.resolve();
			expect(extensions.filter((entry) => entry.path === active)).toEqual([
				expect.objectContaining({
					enabled: false,
					metadata: expect.objectContaining({ scope: "project", origin: "top-level" }),
				}),
			]);
			const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			await loader.reload();
			expect(loader.getExtensions().extensions.some((extension) => extension.path === active)).toBe(false);
		},
	);

	it("pins a configured user Git extension across the trust prompt", async () => {
		setupRemoteAndInstall();
		const marker = join(tempDir, "initializations.txt");
		const extension = (value: string) => `import { appendFileSync } from 'node:fs';
			export default function() { appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(value)}); }`;
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", extension("old\n"), "Add worker");
		git(["pull", "--ff-only"], installedDir);
		const oldPath = join(installedDir, "extensions", "worker.ts");
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				expect(extensionsResult.extensions.map(({ path }) => path)).toContain(oldPath);
				createCommit(remoteDir, "extensions/worker.ts", extension("new\n"), "Publish during trust");
				await packageManager.update();
				return true;
			},
		});
		const newPath = join(selected(), "extensions", "worker.ts");
		expect(newPath).not.toBe(oldPath);
		expect(loader.getExtensions().extensions.map(({ path }) => path)).toContain(oldPath);
		expect(readFileSync(marker, "utf8")).toBe("old\n");
		await loader.reload();
		expect(loader.getExtensions().extensions.map(({ path }) => path)).toContain(newPath);
		expect(readFileSync(marker, "utf8")).toBe("old\nnew\n");
	});

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
			if (kind === "active exact" || kind === "active delta") {
				const item = extensions.find((entry) => entry.path === join(active, "extensions", "excluded.ts"));
				if (!item) throw new Error("Expected excluded extension");
				const noop = () => {};
				const resolved = await packageManager.resolve();
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
				};
				expect(list.toggleResource({ ...item, resourceType: "extensions" })).toBe(true);
				const pkg = settingsManager.getGlobalSettings().packages?.[0];
				if (typeof pkg !== "object" || !pkg.extensions) throw new Error("Expected package filters");
				expect(pkg.extensions).not.toContainEqual(expect.stringMatching(/^-.*excluded\.ts$/));
				expect((await packageManager.resolve()).extensions).toContainEqual(
					expect.objectContaining({ path: item.path, enabled: true }),
				);
			}
		},
	);

	it.each([false, true])("deduplicates managed local package aliases (local first: %s)", async (localFirst) => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
		git(["pull", "--ff-only"], installedDir);
		const original = join(installedDir, "extensions", "worker.ts");
		settingsManager.setPackages(localFirst ? [original, gitSource] : [gitSource, original]);
		createCommit(remoteDir, "extensions/worker.ts", "export default function() { return 2; }", "Update worker");
		await packageManager.update();
		const workers = (await packageManager.resolve()).extensions.filter(({ path }) => basename(path) === "worker.ts");
		expect(workers).toEqual([
			expect.objectContaining({ path: join(selected(), "extensions", "worker.ts"), enabled: true }),
		]);
	});

	it("resolves an explicit CLI file from the configured checkout selection", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
		git(["pull", "--ff-only"], installedDir);
		const original = join(installedDir, "extensions", "worker.ts");
		createCommit(remoteDir, "extensions/worker.ts", "export default function() { return 2; }", "Update worker");
		await packageManager.update();
		const configured = await packageManager.resolve();
		const cli = await packageManager.resolveExtensionSources([original], {
			temporary: true,
			gitRevisions: configured.gitRevisions,
		});
		const paths = [...configured.extensions, ...cli.extensions].filter(({ path }) => basename(path) === "worker.ts");
		expect(paths.map(({ path }) => path)).toEqual(Array(2).fill(join(selected(), "extensions", "worker.ts")));
	});

	it("reports CLI extension presence from the selected revision", async () => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "removed.ts", "export default function() {}", "Add original extension");
		git(["pull", "--ff-only"], installedDir);
		git(["rm", "removed.ts"], remoteDir);
		createCommit(remoteDir, "added.ts", "export default function() {}", "Replace original extension");
		await packageManager.update();
		const removed = join(installedDir, "removed.ts");
		await settingsManager.flush();
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [join(installedDir, "added.ts"), removed],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([
			{ path: removed, error: `Extension path does not exist: ${removed}` },
		]);
		expect(loader.getExtensions().extensions.map(({ path }) => path)).toContain(join(selected(), "added.ts"));
	});

	it.each(["direct", "nested", "configured", "directory", "directory-denied"])(
		"defers a project checkout alias until project trust resolves (%s)",
		async (kind) => {
			const nested = kind === "nested";
			const directoryEntry = kind === "directory" || kind === "directory-denied";
			const trusted = kind !== "directory-denied";
			setupRemoteAndInstall();
			const marker = join(tempDir, "initialized");
			const extension = (value: string) =>
				`import { appendFileSync } from "node:fs"; export default function() { appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(value)}); }`;
			createCommit(remoteDir, "worker.ts", extension("old\n"), "Add project extension");
			const checkout = join(tempDir, ".pi", "git", "github.com", "test", "extension");
			mkdirSync(dirname(checkout), { recursive: true });
			git(["clone", remoteDir, checkout], tempDir);
			settingsManager.setPackages([]);
			settingsManager.setProjectPackages([{ source: gitSource, autoload: false }]);
			createCommit(remoteDir, "worker.ts", extension("selected\n"), "Update project extension");
			await packageManager.update();
			const active = packageManager.getInstalledPath(gitSource, "project");
			if (!active || active === checkout) throw new Error("Expected a staged project revision");
			const alias = join(tempDir, "checkout-alias");
			symlinkSync(checkout, alias, process.platform === "win32" ? "junction" : "dir");
			const ordinary = nested ? join(tempDir, "cli-package", "ordinary.ts") : join(tempDir, "ordinary.ts");
			const cliPackage = dirname(ordinary);
			if (nested) {
				mkdirSync(cliPackage);
				symlinkSync(checkout, join(cliPackage, "managed"), process.platform === "win32" ? "junction" : "dir");
				writeFileSync(
					join(cliPackage, "package.json"),
					JSON.stringify({ pi: { extensions: ["managed/worker.ts", "ordinary.ts"] } }),
				);
			}
			writeFileSync(ordinary, extension("ordinary\n"));
			const barePackage = join(tempDir, "bare-project-alias");
			if (directoryEntry) {
				mkdirSync(barePackage);
				writeFileSync(join(barePackage, "package.json"), JSON.stringify({ main: "entry.ts" }));
				symlinkSync(join(checkout, "worker.ts"), join(barePackage, "entry.ts"), "file");
				settingsManager.setPackages([barePackage]);
				settingsManager.setExtensionPaths([ordinary]);
			} else if (kind === "configured") {
				settingsManager.setExtensionPaths([join(alias, "worker.ts"), ordinary]);
			}
			await settingsManager.flush();
			const loader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir,
				settingsManager,
				additionalExtensionPaths:
					kind === "configured" || directoryEntry
						? []
						: nested
							? [cliPackage]
							: [join(alias, "worker.ts"), ordinary],
			});
			await loader.reload({
				resolveProjectTrust: async ({ extensionsResult }) => {
					expect(settingsManager.isProjectTrusted()).toBe(false);
					expect(settingsManager.getProjectSettings().packages).toBeUndefined();
					expect(extensionsResult.extensions.map(({ path }) => path)).toEqual([ordinary]);
					expect(readFileSync(marker, "utf8")).toBe("ordinary\n");
					return trusted;
				},
			});
			expect(loader.getExtensions().errors).toEqual([]);
			const paths = loader.getExtensions().extensions.map(({ path }) => path);
			if (directoryEntry && trusted) {
				expect(paths).toHaveLength(2);
				expect(paths).toEqual(expect.arrayContaining([barePackage, ordinary]));
			} else {
				expect(paths).toEqual(trusted ? [join(active, "worker.ts"), ordinary] : [ordinary]);
			}
			expect(readFileSync(marker, "utf8")).toBe(trusted ? "ordinary\nselected\n" : "ordinary\n");
		},
	);

	it("pins a checkout selection when publication occurs between local and Git collection", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
		await packageManager.update();
		const previous = selected();
		createCommit(remoteDir, "extensions/worker.ts", "export default function() { return 2; }", "Update worker");
		await packageManager.update();
		const next = selected();
		expect(next).not.toBe(previous);
		const key = createHash("sha256")
			.update(relative(join(agentDir, "git"), installedDir))
			.digest("hex");
		const pointer = join(agentDir, "git", ".git-update-state", `${key}.current`);
		writeFileSync(pointer, basename(previous));
		settingsManager.setPackages([join(installedDir, "extensions", "worker.ts"), gitSource]);
		const manager = packageManager as unknown as { resolveLocalExtensionSource: (...args: unknown[]) => void };
		const resolveLocal = manager.resolveLocalExtensionSource.bind(manager);
		const publish = vi.spyOn(manager, "resolveLocalExtensionSource").mockImplementationOnce((...args) => {
			resolveLocal(...args);
			const pending = `${pointer}.fixture`;
			writeFileSync(pending, basename(next));
			renameSync(pending, pointer);
		});
		const workers = async () =>
			(await packageManager.resolve()).extensions.filter(({ path }) => basename(path) === "worker.ts");
		expect(await workers()).toEqual([expect.objectContaining({ path: join(previous, "extensions", "worker.ts") })]);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(await workers()).toEqual([expect.objectContaining({ path: join(next, "extensions", "worker.ts") })]);
	});

	it.each(["plain", "default", "filtered"])("ignores a regular file at a %s convention root", async (kind) => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "extensions", "not an extension", "Add incidental file");
		await packageManager.update();
		settingsManager.setPackages([
			kind === "plain"
				? gitSource
				: kind === "default"
					? { source: gitSource, skills: [] }
					: { source: gitSource, extensions: ["*"] },
		]);
		expect((await packageManager.resolve()).extensions).toEqual([]);
	});

	it("preserves a historical exclusion for a nested local package", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "nested", "extensions"), { recursive: true });
		createCommit(remoteDir, "nested/extensions/worker.ts", "export default function() {}", "Add worker");
		await packageManager.update();
		const prior = selected();
		settingsManager.setPackages([
			{ source: join(installedDir, "nested"), extensions: [`-${join(prior, "nested", "extensions", "worker.ts")}`] },
			{ source: gitSource, autoload: false },
		]);
		createCommit(remoteDir, "extension.ts", "// v3", "Advance revision");
		await packageManager.update();
		expect(selected()).not.toBe(prior);
		expect((await packageManager.resolve()).extensions).toContainEqual(
			expect.objectContaining({ path: join(selected(), "nested", "extensions", "worker.ts"), enabled: false }),
		);
	});

	it("preserves an absolute filter on a local package alias of a managed checkout", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
		git(["pull", "--ff-only"], installedDir);
		settingsManager.setPackages([
			{ source: installedDir, extensions: [`-${join(installedDir, "extensions", "worker.ts")}`] },
			{ source: gitSource, autoload: false },
		]);
		createCommit(remoteDir, "extension.ts", "// v2", "Advance revision");
		await packageManager.update();
		expect((await packageManager.resolve()).extensions).toContainEqual(
			expect.objectContaining({ path: join(selected(), "extensions", "worker.ts"), enabled: false }),
		);
	});

	it("redirects explicit user paths when a trusted project shadows the package", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
		createCommit(remoteDir, "extensions/implicit.ts", "export default function() {}", "Add implicit extension");
		await packageManager.update();
		const active = selected();
		const projectCheckout = join(tempDir, ".pi", "git", "github.com", "test", "extension");
		mkdirSync(dirname(projectCheckout), { recursive: true });
		git(["clone", remoteDir, projectCheckout], tempDir);
		settingsManager.setProjectPackages([gitSource]);
		settingsManager.setExtensionPaths([join(installedDir, "extensions", "worker.ts")]);
		const { extensions } = await packageManager.resolve();
		expect(extensions).toContainEqual(
			expect.objectContaining({ path: join(active, "extensions", "worker.ts"), enabled: true }),
		);
		expect(extensions).toContainEqual(
			expect.objectContaining({ path: join(projectCheckout, "extensions", "implicit.ts"), enabled: true }),
		);
		expect(extensions.map((entry) => entry.path)).not.toContain(join(active, "extensions", "implicit.ts"));

		const alias = join(installedDir, "extension.ts");
		expect(existsSync(alias)).toBe(true);
		settingsManager.setPackages([alias, gitSource]);
		const manager = packageManager as unknown as { getGitUpdateStatePath(path: string, scope: string): string };
		writeFileSync(`${manager.getGitUpdateStatePath(installedDir, "user")}.current`, "invalid");
		const afterCorruption = await packageManager.resolve();
		expect(afterCorruption.installFailures).toEqual([
			expect.objectContaining({
				scope: "user",
				source: gitSource,
				message: expect.stringContaining("Invalid Git revision pointer"),
			}),
		]);
		expect(afterCorruption.extensions.map(({ path }) => path)).not.toContain(alias);
		expect(afterCorruption.extensions.map(({ path }) => path)).toContain(
			join(projectCheckout, "extensions", "implicit.ts"),
		);
	});

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

	it.each([
		"root",
		"child",
		"explicit child",
		"explicit file",
		"explicit internal symlink",
		"explicit nested file",
		"explicit directory symlink",
		"retained alias exclusion",
		"historical glob",
	])("uses the selected manifest through a %s alias", async (kind) => {
		if (kind === "historical glob") {
			const checkout = relative(agentDir, installedDir);
			agentDir = join(tempDir, "agent[1]");
			installedDir = join(agentDir, checkout);
			packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
		}
		setupRemoteAndInstall();
		settingsManager.setNpmCommand(["npm", "--offline", "--ignore-scripts"]);
		createCommit(remoteDir, "old.ts", "export default function() {}", "Add old entry");
		const manifest = (entry: string) =>
			JSON.stringify({ name: "fixture", version: "1.0.0", pi: { extensions: [entry] } });
		createCommit(remoteDir, "package.json", manifest("./old.ts"), "Declare old entry");
		const nested = kind === "explicit nested file";
		if (kind === "explicit file" && process.platform !== "win32") {
			writeFileSync(join(tempDir, "external.ts"), "export default function() {}");
			symlinkSync(join(tempDir, "external.ts"), join(installedDir, "new.ts"));
		}
		const directoryAlias = kind === "explicit directory symlink";
		const replacement = nested || directoryAlias ? "assets/new.ts" : "new.ts";
		if (directoryAlias) {
			mkdirSync(join(installedDir, "impl"));
			symlinkSync(
				join(installedDir, "impl"),
				join(installedDir, "assets"),
				process.platform === "win32" ? "junction" : "dir",
			);
			mkdirSync(join(remoteDir, "assets"));
		}
		if (nested) createCommit(remoteDir, "assets", "old file", "Add old assets file");
		git(["pull", "--ff-only"], installedDir);
		if (kind === "explicit internal symlink" && process.platform !== "win32") {
			symlinkSync("old.ts", join(installedDir, "new.ts"));
		}
		const root = join(agentDir, kind.startsWith("explicit") ? "custom-extensions" : "extensions");
		const alias = kind === "root" ? root : join(root, "alias");
		mkdirSync(dirname(alias), { recursive: true });
		symlinkSync(installedDir, alias, process.platform === "win32" ? "junction" : "dir");
		settingsManager.setPackages([{ source: gitSource, autoload: false }]);
		const declarations =
			kind === "explicit child" ? [root] : kind.startsWith("explicit") ? [join(alias, replacement)] : [];
		settingsManager.setExtensionPaths([...declarations, `-${relative(agentDir, join(alias, replacement))}`]);
		if (nested) {
			git(["rm", "assets"], remoteDir);
			mkdirSync(join(remoteDir, "assets"));
		}
		createCommit(remoteDir, replacement, "export default function() {}", "Add replacement");
		createCommit(remoteDir, "package.json", manifest(`./${replacement}`), "Select replacement");
		await packageManager.update();
		const entries = (await packageManager.resolve()).extensions.filter((entry) =>
			["old.ts", "new.ts"].includes(basename(entry.path)),
		);
		const first = join(selected(), replacement);
		expect(existsSync(join(alias, replacement))).toBe(
			(kind === "explicit file" || kind === "explicit internal symlink") && process.platform !== "win32",
		);
		expect(entries).toEqual([expect.objectContaining({ path: first, enabled: false })]);
		if (kind !== "retained alias exclusion") {
			const rule =
				kind === "historical glob"
					? `!${relative(agentDir, dirname(first))}/*.ts`
					: `-${relative(agentDir, first)}`;
			settingsManager.setExtensionPaths([...declarations, rule]);
		}
		createCommit(remoteDir, "extension.ts", "// v3", "Advance revision again");
		await packageManager.update();
		const next = join(selected(), replacement);
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
		};
		settingsManager.setProjectExtensionPaths([first, `-${first}`]);
		const project = await packageManager.resolve();
		const projectItem = project.extensions.find((entry) => entry.path === next);
		if (!projectItem) throw new Error("Expected project extension");
		const projectSelector = new ConfigSelectorComponent(
			{ global: resolved, project },
			settingsManager,
			tempDir,
			agentDir,
			noop,
			noop,
			noop,
			undefined,
			"project",
		);
		const projectList = projectSelector.getResourceList() as unknown as typeof list;
		expect(projectList.toggleResource({ ...projectItem, resourceType: "extensions" })).toBe(false);
		expect(settingsManager.getProjectSettings().extensions).toEqual([]);
		expect((await packageManager.resolve()).extensions).toContainEqual(
			expect.objectContaining({ path: next, enabled: false }),
		);
		expect(list.toggleResource({ ...item, resourceType: "extensions" })).toBe(true);
		expect(settingsManager.getGlobalSettings().extensions).toEqual([
			...declarations,
			...(kind === "historical glob" ? [`!${relative(agentDir, dirname(first))}/*.ts`] : []),
			`+${relative(agentDir, next)}`,
		]);
		expect((await packageManager.resolve()).extensions).toContainEqual(
			expect.objectContaining({ path: next, enabled: true }),
		);
	});

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

	it.skipIf(process.platform === "win32")(
		"classifies skill, prompt and theme aliases after file-to-directory updates",
		async () => {
			setupRemoteAndInstall();
			const fixtures = [
				["skills", "tool.md", "SKILL.md"],
				["prompts", "tool.md", "nested.md"],
				["themes", "tool.json", "nested.json"],
			] as const;
			for (const [kind, file] of fixtures) createCommit(remoteDir, `${kind}-${file}`, "old", `Add ${kind} file`);
			git(["pull", "--ff-only"], installedDir);
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			for (const [kind, file, child] of fixtures) {
				const path = `${kind}-${file}`;
				mkdirSync(join(agentDir, kind));
				symlinkSync(join(installedDir, path), join(agentDir, kind, file));
				git(["rm", path], remoteDir);
				mkdirSync(join(remoteDir, path));
				createCommit(remoteDir, `${path}/${child}`, "new", `Replace ${kind} file with directory`);
			}
			settingsManager.setSkillPaths([`-${join("skills", "tool.md", "SKILL.md")}`]);
			await packageManager.update();
			const active = selected();
			const resources = await packageManager.resolve();
			expect(resources.skills).toContainEqual(
				expect.objectContaining({ path: join(active, "skills-tool.md", "SKILL.md"), enabled: false }),
			);
			expect(resources.prompts.map(({ path }) => path)).not.toContain(join(active, "prompts-tool.md"));
			expect(resources.themes.map(({ path }) => path)).not.toContain(join(active, "themes-tool.json"));
			settingsManager.setPromptTemplatePaths(["prompts"]);
			settingsManager.setThemePaths(["themes"]);
			const recursive = await packageManager.resolve();
			expect(recursive.prompts).toContainEqual(
				expect.objectContaining({ path: join(active, "prompts-tool.md", "nested.md") }),
			);
			expect(recursive.themes).toContainEqual(
				expect.objectContaining({ path: join(active, "themes-tool.json", "nested.json") }),
			);
		},
	);

	it.skipIf(process.platform === "win32")(
		"reads an aliased extension manifest from the selected revision",
		async () => {
			setupRemoteAndInstall();
			const manifest = (entry: string) => JSON.stringify({ pi: { extensions: [entry] } });
			createCommit(remoteDir, "package.json", manifest("src/old.ts"), "Declare old extension");
			git(["pull", "--ff-only"], installedDir);
			const root = join(agentDir, "extensions");
			mkdirSync(join(root, "src"), { recursive: true });
			for (const name of ["old.ts", "new.ts"])
				writeFileSync(join(root, "src", name), "export default function() {}");
			symlinkSync(join(installedDir, "package.json"), join(root, "package.json"));
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			settingsManager.setNpmCommand(["npm", "--offline", "--ignore-scripts"]);
			createCommit(remoteDir, "package.json", manifest("src/new.ts"), "Select new extension");
			await packageManager.update();
			const paths = (await packageManager.resolve()).extensions.map(({ path }) => path);
			expect(paths).toContain(join(root, "src", "new.ts"));
			expect(paths).not.toContain(join(root, "src", "old.ts"));
			const local = join(agentDir, "local-package");
			renameSync(root, local);
			settingsManager.setPackages([local, { source: gitSource, autoload: false }]);
			const configured = (await packageManager.resolve()).extensions.map(({ path }) => path);
			expect(configured).toContain(join(local, "src", "new.ts"));
			expect(configured).not.toContain(join(local, "src", "old.ts"));
		},
	);

	it.skipIf(process.platform === "win32")(
		"resolves nested manifest entry aliases for configured and CLI packages",
		async () => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "worker.ts", "export default function() {}", "Add worker");
			git(["pull", "--ff-only"], installedDir);
			const local = join(agentDir, "local-package");
			mkdirSync(join(local, "src"), { recursive: true });
			writeFileSync(
				join(local, "package.json"),
				JSON.stringify({ pi: { extensions: ["src/worker.ts", "src/new.ts"] } }),
			);
			for (const name of ["worker.ts", "new.ts"]) symlinkSync(join(installedDir, name), join(local, "src", name));
			settingsManager.setPackages([
				{ source: gitSource, autoload: false },
				{ source: local, extensions: ["-src/worker.ts"] },
			]);
			createCommit(remoteDir, "new.ts", "export default function() {}", "Add dangling alias target");
			await packageManager.update();
			const active = selected();
			settingsManager.setPackages([
				{ source: gitSource, autoload: false },
				{ source: local, extensions: ["-src/worker.ts", `-${join(active, "worker.ts")}`] },
			]);
			const configured = await packageManager.resolve();
			expect(configured.extensions).toContainEqual(
				expect.objectContaining({ path: join(active, "worker.ts"), enabled: false }),
			);
			expect(configured.extensions).toContainEqual(
				expect.objectContaining({ path: join(active, "new.ts"), enabled: true }),
			);
			const cli = await packageManager.resolveExtensionSources([local], {
				temporary: true,
				gitRevisions: configured.gitRevisions,
			});
			expect(cli.extensions.map(({ path }) => path).sort()).toEqual([
				join(active, "new.ts"),
				join(active, "worker.ts"),
			]);
			const worker = configured.extensions.find(({ path }) => path === join(active, "worker.ts"));
			if (!worker) throw new Error("Expected selected worker");
			const noop = () => {};
			const selector = new ConfigSelectorComponent(
				{ global: configured, project: configured },
				settingsManager,
				tempDir,
				agentDir,
				noop,
				noop,
				noop,
			);
			const list = selector.getResourceList() as unknown as {
				toggleResource(item: typeof worker & { resourceType: "extensions" }): boolean;
			};
			expect(list.toggleResource({ ...worker, resourceType: "extensions" })).toBe(true);
			expect(settingsManager.getGlobalSettings().packages).toContainEqual({
				source: local,
				extensions: [`+${join("src", "worker.ts")}`],
			});
			expect((await packageManager.resolve()).extensions).toContainEqual(
				expect.objectContaining({ path: worker.path, enabled: true }),
			);
		},
	);

	it.skipIf(process.platform === "win32").each([false, true])(
		"discovers selected child aliases in a package directory (manifest: %s)",
		async (manifest) => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "removed.ts", "export default function() {}", "Add old resource");
			git(["pull", "--ff-only"], installedDir);
			const local = join(agentDir, "local-package");
			const dir = join(local, "extensions");
			mkdirSync(dir, { recursive: true });
			if (manifest)
				writeFileSync(join(local, "package.json"), JSON.stringify({ pi: { extensions: ["extensions"] } }));
			for (const name of ["added.ts", "removed.ts"]) symlinkSync(join(installedDir, name), join(dir, name));
			settingsManager.setPackages([{ source: gitSource, autoload: false }, local]);
			git(["rm", "removed.ts"], remoteDir);
			createCommit(remoteDir, "added.ts", "export default function() {}", "Add selected resource");
			await packageManager.update();
			const configured = await packageManager.resolve();
			const cli = await packageManager.resolveExtensionSources([local], {
				temporary: true,
				gitRevisions: configured.gitRevisions,
			});
			for (const result of [configured, cli]) {
				expect(result.extensions.map(({ path }) => path)).toEqual([join(selected(), "added.ts")]);
			}
		},
	);

	it.skipIf(process.platform === "win32")("discovers a newly available nested extension manifest alias", async () => {
		setupRemoteAndInstall();
		const root = join(agentDir, "extensions");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["src/tool.ts"] } }));
		symlinkSync(join(installedDir, "tool.ts"), join(root, "src", "tool.ts"));
		settingsManager.setPackages([{ source: gitSource, autoload: false }]);
		createCommit(remoteDir, "tool.ts", "export default function() {}", "Add extension target");
		await packageManager.update();
		expect((await packageManager.resolve()).extensions).toContainEqual(
			expect.objectContaining({ path: join(selected(), "tool.ts"), enabled: true }),
		);
	});

	it
		.skipIf(process.platform === "win32")
		.each([
			"auto",
			"package",
			"manifest",
			"configured",
			"auto-first",
			"configured-first",
			"configured-direct",
			"configured-directory",
			"package-include",
			"package-delta-include",
			"package-delta-mixed",
			"package-project-delta-mixed",
			"package-direct",
			"manifest-directory",
			"package-toggle",
			"package-project-toggle",
		])("loads the surviving prompt alias (%s)", async (kind) => {
		const asPackage = kind.startsWith("package") || kind.startsWith("manifest");
		const mixedDelta = kind.endsWith("delta-mixed");
		const firstExcluded = kind.endsWith("-first");
		const excluded = firstExcluded ? "keep.md" : "z-hide.md";
		setupRemoteAndInstall();
		createCommit(remoteDir, "review.md", "Selected review", "Add prompt");
		if (mixedDelta) git(["pull", "--ff-only"], installedDir);
		const dir = join(agentDir, kind.startsWith("auto") ? "prompts" : "local-prompts");
		mkdirSync(dir);
		for (const name of ["keep.md", "z-hide.md"]) symlinkSync(join(installedDir, "review.md"), join(dir, name));
		settingsManager.setPackages([{ source: gitSource, autoload: false }]);
		if (asPackage) {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({
					pi: {
						prompts:
							kind === "manifest-directory"
								? [".", "-keep.md"]
								: ["keep.md", "z-hide.md", ...(kind === "manifest" ? ["-z-hide.md"] : [])],
					},
				}),
			);
			const declaration =
				kind.startsWith("manifest") || kind.endsWith("toggle")
					? dir
					: kind === "package-delta-include"
						? { source: dir, autoload: false, prompts: ["+z-hide.md"] }
						: mixedDelta
							? { source: dir, autoload: false, prompts: ["+keep.md", "-z-hide.md"] }
							: { source: dir, prompts: [kind === "package-include" ? "z-hide.md" : `-${excluded}`] };
			if (kind === "package-project-delta-mixed") {
				settingsManager.setPackages([{ source: gitSource, autoload: false }, dir]);
				settingsManager.setProjectPackages([declaration]);
			} else if (kind === "package-project-toggle") settingsManager.setProjectPackages([declaration]);
			else settingsManager.setPackages([{ source: gitSource, autoload: false }, declaration]);
		} else {
			settingsManager.setPromptTemplatePaths(
				kind.startsWith("configured")
					? [join(dir, "keep.md"), join(dir, "z-hide.md"), `-${join(dir, excluded)}`]
					: [`-prompts/${excluded}`],
			);
		}
		if (mixedDelta) {
			const before = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			await before.reload();
			expect(before.getPrompts().prompts.map(({ name }) => name)).toEqual(["keep"]);
			createCommit(remoteDir, "extension.ts", "// Advance revision", "Advance revision");
		}
		await packageManager.update();
		if (kind === "package-direct") {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ pi: { prompts: ["keep.md", join(selected(), "review.md")] } }),
			);
			settingsManager.setPackages([
				{ source: gitSource, autoload: false },
				{ source: dir, prompts: ["-keep.md"] },
			]);
		}
		if (kind === "configured-direct" || kind === "configured-directory") {
			const alias = join(dir, "keep.md");
			settingsManager.setPromptTemplatePaths([
				alias,
				kind === "configured-directory" ? selected() : join(selected(), "review.md"),
				`-${alias}`,
			]);
		}
		await settingsManager.flush();
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getPrompts().prompts).toEqual([
			expect.objectContaining({
				name:
					kind === "configured-direct" || kind === "configured-directory" || kind === "package-direct"
						? "review"
						: firstExcluded ||
								kind === "package-include" ||
								kind === "package-delta-include" ||
								kind === "manifest-directory"
							? "z-hide"
							: "keep",
				filePath: join(selected(), "review.md"),
				content: "Selected review",
			}),
		]);
		if (kind === "package-project-delta-mixed") {
			const globalManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager: SettingsManager.inMemory(settingsManager.getGlobalSettings()),
			});
			const project = await packageManager.resolve();
			const item = { ...project.prompts[0]!, resourceType: "prompts" as const };
			const noop = () => {};
			const selector = new ConfigSelectorComponent(
				{ global: await globalManager.resolve(), project },
				settingsManager,
				tempDir,
				agentDir,
				noop,
				noop,
				noop,
				undefined,
				"project",
			);
			const list = selector.getResourceList() as unknown as {
				getProjectOverrideState(resource: typeof item): string;
				toggleResource(resource: typeof item): boolean;
			};
			expect(list.getProjectOverrideState(item)).toBe("load");
			expect(list.toggleResource(item)).toBe(true);
			expect(settingsManager.getProjectSettings().packages).toEqual([]);
		}
		if (kind.endsWith("toggle")) {
			const project = kind === "package-project-toggle";
			const toggle = async () => {
				const resolved = await packageManager.resolve();
				const [item] = resolved.prompts;
				if (!item) throw new Error("Missing prompt row");
				const noop = () => {};
				const selector = new ConfigSelectorComponent(
					{
						global: project ? { extensions: [], skills: [], prompts: [], themes: [] } : resolved,
						project: resolved,
					},
					settingsManager,
					tempDir,
					agentDir,
					noop,
					noop,
					noop,
					undefined,
					project ? "project" : "global",
				);
				const list = selector.getResourceList() as unknown as {
					toggleResource(resource: typeof item & { resourceType: "prompts" }): boolean;
				};
				return list.toggleResource({ ...item, resourceType: "prompts" });
			};
			expect(await toggle()).toBe(false);
			expect((await packageManager.resolve()).prompts).toEqual([expect.objectContaining({ enabled: false })]);
			createCommit(remoteDir, "review.md", "Updated review", "Advance selection");
			await packageManager.update();
			expect((await packageManager.resolve()).prompts).toEqual([
				expect.objectContaining({ path: join(selected(), "review.md"), enabled: false }),
			]);
			expect(await toggle()).toBe(true);
			expect((await packageManager.resolve()).prompts).toEqual([expect.objectContaining({ enabled: true })]);
		}
	});

	it.skipIf(process.platform === "win32")(
		"keeps hidden manifest glob prefixes hidden after revision selection",
		async () => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "added.md", "Selected prompt", "Add prompt");
			const local = join(agentDir, "local-package");
			mkdirSync(local);
			symlinkSync(installedDir, join(local, ".resources"), "dir");
			const manifest = (entry: string) =>
				writeFileSync(join(local, "package.json"), JSON.stringify({ pi: { prompts: [entry] } }));
			settingsManager.setPackages([{ source: gitSource, autoload: false }, local]);
			await packageManager.update();
			manifest(".resources/*.md");
			expect((await packageManager.resolve()).prompts).toEqual([]);
			manifest(".resources/added.md");
			expect((await packageManager.resolve()).prompts).toEqual([
				expect.objectContaining({ path: join(selected(), "added.md") }),
			]);
		},
	);

	it.skipIf(process.platform === "win32")("expands manifest globs through two selected checkouts", async () => {
		setupRemoteAndInstall();
		const secondSource = "git:github.com/test/other";
		const secondRemote = join(tempDir, "second-remote");
		const secondCheckout = join(dirname(installedDir), "other");
		mkdirSync(secondRemote);
		initGitRepo(secondRemote);
		createCommit(secondRemote, "removed.md", "Old prompt", "Add old prompt");
		git(["clone", secondRemote, secondCheckout], tempDir);
		git(["rm", "removed.md"], secondRemote);
		createCommit(secondRemote, "added.md", "Selected prompt", "Add new prompt");
		createCommit(secondRemote, "excluded.md", "Excluded prompt", "Add excluded prompt");
		mkdirSync(join(remoteDir, "assets"));
		createCommit(remoteDir, "assets/old.md", "Old assets", "Add original assets");
		git(["pull", "--ff-only"], installedDir);
		git(["rm", "-r", "assets"], remoteDir);
		symlinkSync(secondCheckout, join(remoteDir, "assets"), "dir");
		git(["add", "assets"], remoteDir);
		git(["commit", "-m", "Point assets to another checkout"], remoteDir);
		const local = join(agentDir, "local-package");
		mkdirSync(local);
		const prefix = relative(local, join(installedDir, "assets"));
		writeFileSync(
			join(local, "package.json"),
			JSON.stringify({ pi: { prompts: [`${prefix}/*.md`, `-${prefix}/excluded.md`] } }),
		);
		settingsManager.setPackages([
			{ source: gitSource, autoload: false },
			{ source: secondSource, autoload: false },
			local,
		]);
		await packageManager.update();
		expect((await packageManager.resolve()).prompts).toEqual([
			expect.objectContaining({ path: join(selected(secondSource), "added.md") }),
		]);

		for (const pattern of [
			`${prefix.slice(0, -1)}*/*.md`,
			`${prefix.slice(0, -1)}[sx]/*.md`,
			`${join(installedDir, "asset")}*/*.md`,
			`${dirname(prefix)}/**/*.md`,
			`${prefix}/{added.md,other*.md}`,
		]) {
			writeFileSync(
				join(local, "package.json"),
				JSON.stringify({ pi: { prompts: [pattern, `-${prefix}/excluded.md`] } }),
			);
			expect((await packageManager.resolve()).prompts).toEqual([
				expect.objectContaining({ path: join(selected(secondSource), "added.md") }),
			]);
		}

		const explicitLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noPromptTemplates: true,
			additionalPromptTemplatePaths: [join(installedDir, "assets")],
		});
		await explicitLoader.reload();
		expect(
			explicitLoader
				.getPrompts()
				.prompts.map((prompt) => prompt.name)
				.sort(),
		).toEqual(["added", "excluded"]);

		symlinkSync(installedDir, join(local, "resources"), "dir");
		writeFileSync(
			join(local, "package.json"),
			JSON.stringify({ pi: { prompts: ["resources", "-resources/assets/excluded.md"] } }),
		);
		expect((await packageManager.resolve()).prompts).toEqual([
			expect.objectContaining({ path: join(selected(secondSource), "added.md") }),
		]);

		// This is not a physical symlink cycle: selecting the retained checkout makes it one.
		const active = selected(secondSource);
		symlinkSync(secondCheckout, join(active, "loop"), "dir");
		mkdirSync(join(active, "example"));
		writeFileSync(join(active, "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\n");
		writeFileSync(
			join(local, "package.json"),
			JSON.stringify({
				pi: {
					prompts: ["resources", "-resources/assets/excluded.md", "-resources/assets/example/SKILL.md"],
					skills: ["resources"],
				},
			}),
		);
		const bounded = await packageManager.resolve();
		expect(bounded.prompts.map(({ path }) => path)).toEqual([join(active, "added.md")]);
		const skills = bounded.skills.filter(({ path }) => path.startsWith(active));
		expect(skills.map(({ path }) => path)).toEqual([join(active, "example", "SKILL.md")]);
		for (const resource of [...bounded.prompts, ...skills]) {
			expect(resource.metadata.packageAliases?.some((path) => path.includes(join("assets", "loop")))).toBe(false);
		}
		const skillLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noSkills: true,
			additionalSkillPaths: [join(installedDir, "assets")],
		});
		await skillLoader.reload();
		expect(skillLoader.getSkills().skills.map(({ name }) => name)).toEqual(["example"]);
		rmSync(join(active, "loop"));
		rmSync(join(active, "example"), { recursive: true });

		const checkConfigured = async (sources: string[], expectedPaths: string[]) => {
			settingsManager.setPackages(sources.map((source) => ({ source, autoload: false })));
			settingsManager.setPromptTemplatePaths([join(local, "resources", "assets")]);
			const { prompts } = await packageManager.resolve();
			expect(
				prompts
					.filter((prompt) => prompt.enabled)
					.map((prompt) => prompt.path)
					.sort(),
			).toEqual(expectedPaths.sort());
			settingsManager.setPromptTemplatePaths([]);
		};
		const sourceOrders = [
			[gitSource, secondSource],
			[secondSource, gitSource],
		];
		for (const sources of sourceOrders) {
			await checkConfigured(sources, [
				join(selected(secondSource), "added.md"),
				join(selected(secondSource), "excluded.md"),
			]);
		}

		// The next revision replaces A's link with a real directory. A retained
		// checkout must not redirect this declaration into B in either order.
		git(["pull", "--ff-only"], installedDir);
		writeFileSync(join(local, "package.json"), JSON.stringify({ pi: { prompts: ["resources/assets/*.md"] } }));
		git(["rm", "assets"], remoteDir);
		mkdirSync(join(remoteDir, "assets"));
		createCommit(remoteDir, "assets/replacement.md", "New assets", "Replace assets link");
		await packageManager.update();
		for (const sources of sourceOrders) {
			const replacement = join(selected(), "assets", "replacement.md");
			await checkConfigured(sources, [replacement]);
			settingsManager.setPackages([...sources.map((source) => ({ source, autoload: false })), local]);
			expect((await packageManager.resolve()).prompts).toEqual([expect.objectContaining({ path: replacement })]);
		}
		for (const roots of [
			[join(installedDir, "assets"), secondCheckout],
			[secondCheckout, join(installedDir, "assets")],
		]) {
			const loader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir,
				settingsManager,
				noPromptTemplates: true,
				additionalPromptTemplatePaths: roots,
			});
			await loader.reload();
			expect(
				loader
					.getPrompts()
					.prompts.map((prompt) => prompt.name)
					.sort(),
			).toEqual(["added", "excluded", "replacement"]);
		}
	});

	it("expands manifest globs from the selected checkout and retains original filter paths", async () => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "removed.md", "Old prompt", "Add old prompt");
		git(["pull", "--ff-only"], installedDir);
		git(["rm", "removed.md"], remoteDir);
		createCommit(remoteDir, "added.md", "Selected prompt", "Replace old prompt");
		createCommit(remoteDir, "excluded.md", "Excluded prompt", "Add excluded prompt");
		const local = join(agentDir, "local-package");
		mkdirSync(local);
		const prefix = relative(local, installedDir).replaceAll("\\", "/");
		writeFileSync(
			join(local, "package.json"),
			JSON.stringify({ pi: { prompts: [`${prefix}/*.md`, `-${prefix}/excluded.md`] } }),
		);
		settingsManager.setPackages([{ source: gitSource, autoload: false }, local]);
		await packageManager.update();
		expect((await packageManager.resolve()).prompts).toEqual([
			expect.objectContaining({ path: join(selected(), "added.md"), enabled: true }),
		]);
	});

	it("persists a load override for an external manifest path across Git updates", async () => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "review.md", "Review prompt", "Add prompt");
		const local = join(agentDir, "local-package");
		mkdirSync(local);
		const declaration = relative(local, join(installedDir, "review.md")).replaceAll("\\", "/");
		writeFileSync(join(local, "package.json"), JSON.stringify({ pi: { prompts: [declaration] } }));
		settingsManager.setPackages([
			{ source: gitSource, autoload: false },
			{ source: local, autoload: false, prompts: [`-${declaration}`] },
		]);
		await packageManager.update();
		const resolved = await packageManager.resolve();
		expect(resolved.prompts).toEqual([expect.objectContaining({ enabled: false })]);
		const item = resolved.prompts[0]!;
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
			toggleResource(resource: typeof item & { resourceType: "prompts" }): boolean;
		};
		expect(list.toggleResource({ ...item, resourceType: "prompts" })).toBe(true);
		createCommit(remoteDir, "review.md", "Updated review", "Advance selection");
		await packageManager.update();
		expect(selected()).not.toBe(dirname(item.path));
		expect((await packageManager.resolve()).prompts).toEqual([
			expect.objectContaining({ path: join(selected(), "review.md"), enabled: true }),
		]);
	});

	it.skipIf(process.platform === "win32")("loads discovered aliases to extensionless selected resources", async () => {
		setupRemoteAndInstall();
		const theme = JSON.parse(
			readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf8"),
		);
		const fixtures = [
			["prompts", "quick.md", "review", "---\nname: guide\ndescription: Selected guide\n---\nSelected review"],
			["themes", "style.json", "style", JSON.stringify({ ...theme, name: "selected-style" })],
		] as const;
		for (const [kind, alias, target, content] of fixtures) {
			createCommit(remoteDir, target, content, `Add ${kind} resource`);
			mkdirSync(join(agentDir, kind));
			symlinkSync(join(installedDir, target), join(agentDir, kind, alias));
		}
		const projectSkills = join(tempDir, ".pi", "skills");
		mkdirSync(projectSkills, { recursive: true });
		symlinkSync(join(installedDir, "review"), join(projectSkills, "guide.md"));
		settingsManager.setPackages([{ source: gitSource, autoload: false }]);
		await packageManager.update();
		await settingsManager.flush();
		const active = selected();
		const review = join(active, "review");
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			additionalSkillPaths: [review],
			additionalPromptTemplatePaths: [review],
		});
		await loader.reload();
		expect(loader.getPrompts().prompts).toEqual([
			expect.objectContaining({
				name: "quick",
				filePath: review,
				content: "Selected review",
				sourceInfo: expect.objectContaining({ scope: "user" }),
			}),
		]);
		expect(loader.getSkills().skills).toContainEqual(
			expect.objectContaining({
				name: "guide",
				filePath: review,
				sourceInfo: expect.objectContaining({ scope: "project" }),
			}),
		);
		expect(loader.getThemes().themes).toContainEqual(
			expect.objectContaining({ name: "selected-style", sourcePath: join(active, "style") }),
		);
	});

	it.skipIf(process.platform === "win32").each([
		{ excluded: false, configured: false },
		{ excluded: true, configured: false },
		{ excluded: true, configured: true },
		{ excluded: true, configured: "parent" },
		{ excluded: true, configured: "parent", linkedAgentDir: true },
		{ excluded: true, configured: "parent", directFirst: true },
		{ excluded: true, configured: "parent", directFirst: true, excludeAlias: true },
		{ excluded: true, configured: "parent", directFirst: true, toggle: true },
		{ excluded: true, configured: "parent", directFirst: true, toggle: "project" },
	])(
		"keeps the prompt alias name while loading selected content ($excluded/$configured/$linkedAgentDir/$directFirst/$excludeAlias/$toggle)",
		async ({ excluded, configured, linkedAgentDir, directFirst, excludeAlias, toggle }) => {
			if (linkedAgentDir) {
				const realAgentDir = join(tempDir, "real-agent");
				mkdirSync(realAgentDir);
				rmSync(agentDir, { recursive: true });
				symlinkSync(realAgentDir, agentDir, "dir");
			}
			setupRemoteAndInstall();
			mkdirSync(join(remoteDir, "prompts"));
			createCommit(remoteDir, "prompts/review.md", "Old review", "Add review prompt");
			git(["pull", "--ff-only"], installedDir);
			const name = configured === "parent" ? "review" : "quick";
			const alias =
				configured === "parent"
					? join(tempDir, "linked-prompts", "review.md")
					: join(configured ? tempDir : join(agentDir, "prompts"), "quick.md");
			if (configured === "parent") {
				symlinkSync(join(installedDir, "prompts"), dirname(alias), "dir");
			} else {
				mkdirSync(dirname(alias), { recursive: true });
				symlinkSync(join(installedDir, "prompts", "review.md"), alias);
			}
			if (configured) {
				const declarations = directFirst ? [join(installedDir, "prompts", "review.md"), alias] : [alias];
				if (excludeAlias) declarations.push(`-${alias}`);
				settingsManager.setPromptTemplatePaths(declarations);
			}
			if (excluded) settingsManager.setPackages([{ source: gitSource, prompts: [] }]);
			const before = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			await before.reload();
			expect(before.getPrompts().prompts).toEqual(
				excludeAlias ? [] : [expect.objectContaining({ name, content: "Old review" })],
			);
			createCommit(remoteDir, "prompts/review.md", "Selected review", "Update review prompt");
			await packageManager.update();
			await settingsManager.flush();
			const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			await loader.reload();
			expect(loader.getPrompts().prompts).toEqual(
				excludeAlias
					? []
					: [
							expect.objectContaining({
								name,
								content: "Selected review",
								filePath: join(selected(), "prompts", "review.md"),
							}),
						],
			);
			if (toggle) {
				const declarations = [join(selected(), "prompts", "review.md"), alias];
				const project = toggle === "project";
				if (project) {
					settingsManager.setPackages([{ source: gitSource, autoload: false }]);
					settingsManager.setPromptTemplatePaths([]);
					settingsManager.setProjectPromptTemplatePaths(declarations);
				} else settingsManager.setPromptTemplatePaths(declarations);
				const globalManager = new DefaultPackageManager({
					cwd: tempDir,
					agentDir,
					settingsManager: SettingsManager.inMemory(settingsManager.getGlobalSettings()),
				});
				const resolved = await packageManager.resolve();
				const item = resolved.prompts[0]!;
				if (project) expect(item.metadata).toMatchObject({ scope: "project", origin: "top-level" });
				const noop = () => {};
				const toggleRow = async (current: typeof resolved) => {
					const selector = new ConfigSelectorComponent(
						{ global: project ? await globalManager.resolve() : current, project: current },
						settingsManager,
						tempDir,
						agentDir,
						noop,
						noop,
						noop,
						undefined,
						project ? "project" : "global",
					);
					return selector.getResourceList() as unknown as {
						toggleResource(resource: typeof item & { resourceType: "prompts" }): boolean;
						setProjectTopLevelOverride(
							resource: typeof item & { resourceType: "prompts" },
							state: "unload" | "inherit",
						): boolean;
					};
				};
				const list = await toggleRow(resolved);
				const row = { ...item, resourceType: "prompts" as const };
				if (project) expect(list.setProjectTopLevelOverride(row, "unload")).toBe(true);
				else expect(list.toggleResource(row)).toBe(false);
				await loader.reload();
				expect(loader.getPrompts().prompts).toEqual([]);
				createCommit(remoteDir, "prompts/review.md", "Next review", "Advance selected revision");
				await packageManager.update();
				await loader.reload();
				expect(loader.getPrompts().prompts).toEqual([]);
				if (project) {
					const current = await packageManager.resolve();
					expect(
						(await toggleRow(current)).setProjectTopLevelOverride(
							{ ...current.prompts[0]!, resourceType: "prompts" },
							"inherit",
						),
					).toBe(true);
					expect(settingsManager.getProjectSettings().prompts?.filter((entry) => entry.startsWith("-"))).toEqual(
						[],
					);
				}
			}
		},
	);

	it
		.skipIf(process.platform === "win32")
		.each(["direct", "symlinked parent", "chained", "dangling directory", "parent after link"])(
		"discovers a dangling prompt alias when its target appears (%s)",
		async (kind) => {
			const linkedParent = kind === "symlinked parent";
			setupRemoteAndInstall();
			const alias = join(agentDir, "prompts", "tool.md");
			const containingDir = linkedParent ? join(dirname(installedDir), "prompt-aliases") : dirname(alias);
			mkdirSync(containingDir);
			if (linkedParent) symlinkSync(containingDir, dirname(alias));
			const targetPath = kind === "dangling directory" ? "new-dir/tool.md" : "tool.md";
			const target = join(installedDir, targetPath);
			if (kind === "dangling directory") {
				const bridge = join(tempDir, "bridge");
				symlinkSync(dirname(target), bridge, "dir");
				symlinkSync(relative(containingDir, join(bridge, "tool.md")), alias);
				mkdirSync(join(remoteDir, "new-dir"));
			} else if (kind === "parent after link") {
				const directory = join(installedDir, "bridge-target");
				mkdirSync(directory);
				symlinkSync(directory, join(containingDir, "bridge"), "dir");
				symlinkSync("bridge/../tool.md", alias);
			} else if (kind === "chained") {
				const intermediate = join(tempDir, "intermediate.md");
				symlinkSync(relative(tempDir, target), intermediate);
				symlinkSync(relative(containingDir, intermediate), alias);
				symlinkSync("cycle-b.md", join(containingDir, "cycle-a.md"));
				symlinkSync("cycle-a.md", join(containingDir, "cycle-b.md"));
			} else {
				symlinkSync(relative(containingDir, target), alias);
			}
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			expect((await packageManager.resolve()).prompts).toEqual([]);
			createCommit(remoteDir, targetPath, "Selected prompt", "Add prompt target");
			await packageManager.update();
			expect(existsSync(alias)).toBe(false);
			expect((await packageManager.resolve()).prompts).toEqual([
				expect.objectContaining({ path: join(selected(), targetPath), enabled: true }),
			]);
		},
	);

	it.skipIf(process.platform === "win32").each(["worker.ts", "index.ts"])(
		"discovers a selected directory index through an old %s file symlink",
		async (name) => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "worker.ts", "export default function() {}", "Add worker file");
			git(["pull", "--ff-only"], installedDir);
			const alias = join(agentDir, "extensions", name);
			mkdirSync(dirname(alias));
			const sibling = join(dirname(alias), "sibling.ts");
			writeFileSync(sibling, "export default function() {}");
			symlinkSync(join(installedDir, "worker.ts"), alias);
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			settingsManager.setExtensionPaths([`-${relative(agentDir, join(alias, "index.ts"))}`]);
			git(["rm", "worker.ts"], remoteDir);
			mkdirSync(join(remoteDir, "worker.ts"));
			createCommit(remoteDir, "worker.ts/index.ts", "export default function() {}", "Replace worker with directory");
			await packageManager.update();
			const directory = join(selected(), "worker.ts");
			const resources = (await packageManager.resolve()).extensions;
			expect(resources).toContainEqual(expect.objectContaining({ path: sibling, enabled: true }));
			expect(resources.filter(({ path }) => path === directory || dirname(path) === directory)).toEqual([
				expect.objectContaining({ path: join(directory, "index.ts"), enabled: false }),
			]);
		},
	);

	it("keeps package precedence for a non-Git exact-path collision", async () => {
		const local = join(tempDir, "local-package");
		mkdirSync(local);
		const worker = join(local, "worker.ts");
		writeFileSync(worker, "export default function() {}");
		writeFileSync(join(local, "package.json"), JSON.stringify({ pi: { extensions: ["worker.ts"] } }));
		settingsManager.setPackages([local]);
		settingsManager.setExtensionPaths([worker, `-${worker}`]);
		const { extensions } = await packageManager.resolve();
		expect(extensions.filter((entry) => entry.path === worker)).toEqual([
			expect.objectContaining({ enabled: true, metadata: expect.objectContaining({ origin: "package" }) }),
		]);
	});

	it("keeps Git package ownership when top-level settings exclude an exact duplicate", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
		git(["pull", "--ff-only"], installedDir);
		const original = join(installedDir, "extensions/worker.ts");
		settingsManager.setExtensionPaths([original, `-${original}`]);
		const assertWorker = async (checkout: string) => {
			const { extensions } = await packageManager.resolve();
			expect(extensions.filter(({ path }) => basename(path) === "worker.ts")).toEqual([
				expect.objectContaining({
					path: join(checkout, "extensions/worker.ts"),
					enabled: true,
					metadata: expect.objectContaining({ origin: "package" }),
				}),
			]);
		};
		await assertWorker(installedDir);
		createCommit(remoteDir, "update.txt", "advance", "Advance revision");
		await packageManager.update();
		await assertWorker(selected());
	});

	it.skipIf(process.platform === "win32").each([false, true])(
		"deduplicates an auto-discovered symlink to an old checkout (excluded: %s)",
		async (excluded) => {
			setupRemoteAndInstall();
			mkdirSync(join(remoteDir, "extensions"));
			createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
			git(["pull", "--ff-only"], installedDir);
			const original = join(installedDir, "extensions", "worker.ts");
			const link = join(agentDir, "extensions", "worker.ts");
			mkdirSync(dirname(link));
			symlinkSync(original, link);
			if (excluded) settingsManager.setExtensionPaths(["-extensions/worker.ts"]);
			const assertWorker = async () => {
				const workers = (await packageManager.resolve()).extensions.filter(
					(entry) => basename(entry.path) === "worker.ts",
				);
				expect(workers).toHaveLength(1);
				expect(workers[0]?.enabled).toBe(!excluded);
				const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
				await loader.reload();
				expect(loader.getExtensions().extensions.some((entry) => basename(entry.path) === "worker.ts")).toBe(
					!excluded,
				);
				return workers[0];
			};
			await assertWorker();
			createCommit(remoteDir, "extension.ts", "// v2", "Advance revision");
			await packageManager.update();
			expect((await assertWorker())?.path).toBe(join(selected(), "extensions", "worker.ts"));
		},
	);

	it
		.skipIf(process.platform === "win32")
		.each([
			"default",
			"delta",
			"absolute-delta",
			"manifest",
			"manifest-only",
			"manifest-undeclared-target",
			"manifest-direct-first",
		])("loads a selected checkout's prompt symlink from its selected target (%s)", async (mode) => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "prompts"));
		const target = mode === "default" ? "review.md" : "prompts/review.md";
		createCommit(remoteDir, target, "Retained review", "Add review target");
		symlinkSync(join(installedDir, target), join(remoteDir, "prompts", "quick.md"));
		if (mode === "delta" || mode === "absolute-delta" || mode === "manifest") {
			const exclusion = mode === "absolute-delta" ? join(installedDir, target) : target;
			settingsManager.setPackages([
				{ source: gitSource, autoload: mode === "manifest", prompts: ["+prompts/quick.md", `-${exclusion}`] },
			]);
		}
		if (mode.startsWith("manifest")) {
			createCommit(
				remoteDir,
				"package.json",
				JSON.stringify({
					pi: {
						prompts:
							mode === "manifest-direct-first"
								? [target, "prompts/quick.md"]
								: [
										"prompts/quick.md",
										...(mode === "manifest-undeclared-target" ? [] : [target]),
										...(mode === "manifest" ? [] : [`-${target}`]),
									],
					},
				}),
				"Declare prompts",
			);
		}
		git(["add", "prompts/quick.md"], remoteDir);
		git(["commit", "-m", "Declare prompt alias"], remoteDir);
		git(["pull", "--ff-only"], installedDir);
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getPrompts().prompts).toEqual([
			expect.objectContaining({
				name: mode === "manifest-direct-first" ? "review" : "quick",
				content: "Retained review",
			}),
		]);
		createCommit(remoteDir, target, "Selected review", "Update review target");
		await packageManager.update();
		await loader.reload();
		expect(loader.getPrompts().prompts).toEqual([
			expect.objectContaining({
				name: mode === "manifest-direct-first" ? "review" : "quick",
				content: "Selected review",
				filePath: join(selected(), target),
			}),
		]);
		if (mode === "manifest-direct-first") {
			const active = selected();
			expect((await packageManager.resolve()).prompts[0]?.metadata.packageAliases).toEqual([
				join(active, target),
				join(active, "prompts", "quick.md"),
			]);
		}
		expect(readFileSync(join(installedDir, target), "utf8")).toBe("Retained review");
	});

	it
		.skipIf(process.platform === "win32")
		.each([
			"manifest",
			"settings",
			"settings-exact",
			"external-exact",
			"external-directory",
			"auto-exact",
			"auto-glob",
			"multi-load",
			"project-multi-load",
			"project-mixed",
			"project-exclusion-only",
		])(
		"does not discover a hidden prompt target independently of its excluded directory alias (%s)",
		async (source) => {
			setupRemoteAndInstall();
			mkdirSync(join(remoteDir, "prompts", ".hidden"), { recursive: true });
			createCommit(remoteDir, "prompts/.hidden/note.md", "Original note", "Add hidden note");
			symlinkSync(join(installedDir, "prompts", ".hidden"), join(remoteDir, "prompts", "shortcut"), "dir");
			git(["add", "prompts/shortcut"], remoteDir);
			git(["commit", "-m", "Add shortcut"], remoteDir);
			createCommit(
				remoteDir,
				"package.json",
				JSON.stringify({ pi: { prompts: ["prompts", "-prompts/shortcut/note.md"] } }),
				"Exclude shortcut note",
			);
			git(["pull", "--ff-only"], installedDir);
			const declaredRoot = join(installedDir, "prompts");
			const hiddenTarget = join(declaredRoot, ".hidden", "note.md");
			const auto = source === "auto-exact" || source === "auto-glob";
			const external = source === "external-exact" || auto;
			const mixed = source === "project-mixed";
			const partial = mixed || source === "project-exclusion-only";
			const projectMode = source === "project-multi-load" || partial;
			const multi = source === "multi-load" || projectMode;
			const directory = source === "external-directory" || multi;
			const exact = external || directory || source === "settings-exact";
			const declared = directory
				? join(tempDir, "shortcut")
				: external
					? join(auto ? join(agentDir, "prompts") : tempDir, "shortcut.md")
					: declaredRoot;
			if (external) {
				mkdirSync(dirname(declared), { recursive: true });
				symlinkSync(hiddenTarget, declared);
			}
			if (multi) {
				mkdirSync(declared);
				for (const name of ["first.md", "second.md"]) symlinkSync(hiddenTarget, join(declared, name));
			} else if (directory) symlinkSync(dirname(hiddenTarget), declared, "dir");
			const glob = directory
				? `!${declared}/*.md`
				: external
					? `!${declared}`
					: `!${relative(agentDir, declaredRoot)}/**/note.md`;
			if (source !== "manifest") {
				settingsManager.setPackages([{ source: gitSource, autoload: false }]);
				if (projectMode) settingsManager.setProjectPromptTemplatePaths([declared, glob]);
				else
					settingsManager.setPromptTemplatePaths(
						auto
							? [source === "auto-glob" ? `!${dirname(hiddenTarget)}/*.md` : `-${hiddenTarget}`]
							: [declared, glob, ...(exact ? [`+${hiddenTarget}`] : [])],
					);
			}
			const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			await loader.reload();
			expect(loader.getPrompts().prompts.map(({ content }) => content)).toEqual(auto ? ["Original note"] : []);
			createCommit(remoteDir, "prompts/.hidden/note.md", "Selected note", "Update note");
			await packageManager.update();
			await loader.reload();
			expect(loader.getPrompts().prompts.map(({ content }) => content)).toEqual(auto ? ["Selected note"] : []);
			if (auto) {
				if (source === "auto-glob") {
					settingsManager.setPromptTemplatePaths(["!prompts/*.md"]);
					await loader.reload();
					expect(loader.getPrompts().prompts).toEqual([]);
				}
				return;
			}
			if (multi) {
				if (partial) {
					settingsManager.setProjectPromptTemplatePaths([
						declared,
						...(mixed ? [`+${join(declared, "first.md")}`] : []),
						`-${join(declared, "second.md")}`,
					]);
					await loader.reload();
					expect(loader.getPrompts().prompts.map(({ name }) => name)).toEqual(["first"]);
				}
				const resolved = await packageManager.resolve();
				expect(resolved.prompts).toHaveLength(1);
				const row = { ...resolved.prompts[0]!, resourceType: "prompts" as const };
				expect(row.enabled).toBe(partial);
				expect(row.metadata.gitRevision?.declarations).toHaveLength(2);
				const noop = () => {};
				const selector = new ConfigSelectorComponent(
					{
						global: projectMode
							? await new DefaultPackageManager({
									cwd: tempDir,
									agentDir,
									settingsManager: SettingsManager.inMemory(settingsManager.getGlobalSettings()),
								}).resolve()
							: resolved,
						project: resolved,
					},
					settingsManager,
					tempDir,
					agentDir,
					noop,
					noop,
					noop,
					undefined,
					projectMode ? "project" : "global",
				);
				const list = selector.getResourceList() as unknown as {
					getProjectOverrideState(item: typeof row): string;
					toggleResource(item: typeof row): boolean;
				};
				if (partial) expect(list.getProjectOverrideState(row)).toBe("load");
				expect(list.toggleResource(row)).toBe(!partial);
				await loader.reload();
				if (partial) {
					expect(loader.getPrompts().prompts).toEqual([]);
					return;
				}
				expect(loader.getPrompts().prompts).toEqual([
					expect.objectContaining({ name: "first", content: "Selected note" }),
				]);
				if (projectMode) expect(settingsManager.getProjectSettings().prompts).toContain(glob);
				return;
			}
			if (source !== "manifest") {
				settingsManager.setPromptTemplatePaths([declared, ...(exact ? [`-${hiddenTarget}`] : [])]);
				await loader.reload();
				expect(loader.getPrompts().prompts.map(({ content }) => content)).toEqual(["Selected note"]);
				const [prompt] = (await packageManager.resolve()).prompts;
				expect(prompt?.metadata.gitRevision?.declarations).toEqual([
					directory ? join(declared, "note.md") : external ? declared : join(declaredRoot, "shortcut", "note.md"),
				]);
				if (source === "settings") {
					const toggle = async () => {
						const resolved = await packageManager.resolve();
						const row = { ...resolved.prompts[0]!, resourceType: "prompts" as const };
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
						return (
							selector.getResourceList() as unknown as { toggleResource(item: typeof row): boolean }
						).toggleResource(row);
					};
					expect(await toggle()).toBe(false);
					await loader.reload();
					expect(loader.getPrompts().prompts).toEqual([]);
					createCommit(remoteDir, "prompts/.hidden/note.md", "Next note", "Advance selected note");
					await packageManager.update();
					await loader.reload();
					expect(loader.getPrompts().prompts).toEqual([]);
					expect(await toggle()).toBe(true);
					await loader.reload();
					expect(loader.getPrompts().prompts.map(({ content }) => content)).toEqual(["Next note"]);
				}
				return;
			}
			createCommit(
				remoteDir,
				"package.json",
				JSON.stringify({ pi: { prompts: ["prompts"] } }),
				"Allow shortcut note",
			);
			await packageManager.update();
			const active = selected();
			expect((await packageManager.resolve()).prompts).toEqual([
				expect.objectContaining({
					path: join(active, "prompts", ".hidden", "note.md"),
					metadata: expect.objectContaining({ packageAliases: [join(active, "prompts", "shortcut", "note.md")] }),
				}),
			]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"toggles a collapsed user Agent Skills row relative to its discovery base",
		async () => {
			setupRemoteAndInstall();
			vi.stubEnv("HOME", join(tempDir, "home"));
			const skills = join(tempDir, "home", ".agents", "skills");
			const target = "assets/tool/SKILL.md";
			mkdirSync(join(remoteDir, dirname(target)), { recursive: true });
			createCommit(remoteDir, target, "---\nname: tool\ndescription: Tool fixture\n---\nOld tool", "Add skill");
			git(["pull", "--ff-only"], installedDir);
			mkdirSync(skills, { recursive: true });
			for (const name of ["first", "second"])
				symlinkSync(join(installedDir, dirname(target)), join(skills, name), "dir");
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			settingsManager.setSkillPaths(["!skills/**/SKILL.md"]);
			createCommit(remoteDir, target, "---\nname: tool\ndescription: Tool fixture\n---\nNew tool", "Update skill");
			await packageManager.update();
			const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			const toggle = async () => {
				const resolved = await packageManager.resolve();
				const row = { ...resolved.skills[0]!, resourceType: "skills" as const };
				expect(row.metadata.gitRevision?.declarations).toHaveLength(2);
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
				return (
					selector.getResourceList() as unknown as { toggleResource(item: typeof row): boolean }
				).toggleResource(row);
			};
			await loader.reload();
			expect(loader.getSkills().skills).toEqual([]);
			expect(await toggle()).toBe(true);
			await loader.reload();
			expect(loader.getSkills().skills).toEqual([
				expect.objectContaining({ name: "tool", filePath: join(selected(), target) }),
			]);
			expect(await toggle()).toBe(false);
			await loader.reload();
			expect(loader.getSkills().skills).toEqual([]);
		},
	);

	it.skipIf(process.platform === "win32").each(["file", "directory", "settings"])(
		"preserves an unnamed skill alias across publication (%s)",
		async (mode) => {
			setupRemoteAndInstall();
			vi.stubEnv("HOME", join(tempDir, "home"));
			const target = "templates/raw";
			mkdirSync(join(remoteDir, "templates"));
			createCommit(remoteDir, target, "---\ndescription: Review fixture\n---\nOld review", "Add review skill");
			git(["pull", "--ff-only"], installedDir);
			const directory = join(tempDir, "review");
			mkdirSync(directory);
			const alias = join(directory, "SKILL.md");
			symlinkSync(join(installedDir, target), alias);
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			if (mode === "settings") settingsManager.setSkillPaths([directory]);
			const loader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir,
				settingsManager,
				additionalSkillPaths: mode === "settings" ? [] : [mode === "file" ? alias : directory],
			});
			await loader.reload();
			expect(loader.getSkills().skills).toEqual([expect.objectContaining({ name: "review" })]);
			createCommit(remoteDir, target, "---\ndescription: Review fixture\n---\nNew review", "Advance review skill");
			await packageManager.update();
			await loader.reload();
			const filePath = join(selected(), target);
			expect(loader.getSkills().skills).toEqual([
				expect.objectContaining({ name: "review", filePath, baseDir: dirname(filePath) }),
			]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"preserves an inherited prompt alias through project overrides and publication",
		async () => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "review", "Old review", "Add review");
			git(["pull", "--ff-only"], installedDir);
			const alias = join(agentDir, "prompts", "quick.md");
			mkdirSync(dirname(alias));
			symlinkSync(join(installedDir, "review"), alias);
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			createCommit(remoteDir, "review", "Selected review", "Update review");
			await packageManager.update();
			const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
			const globalManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager: SettingsManager.inMemory(settingsManager.getGlobalSettings()),
			});
			const toggle = async () => {
				const project = await packageManager.resolve();
				const row = { ...project.prompts[0]!, resourceType: "prompts" as const };
				const noop = () => {};
				const selector = new ConfigSelectorComponent(
					{ global: await globalManager.resolve(), project },
					settingsManager,
					tempDir,
					agentDir,
					noop,
					noop,
					noop,
					undefined,
					"project",
				);
				return (
					selector.getResourceList() as unknown as { toggleResource(item: typeof row): boolean }
				).toggleResource(row);
			};
			const prompts = async () => {
				await loader.reload();
				return loader.getPrompts().prompts.map(({ name, content }) => [name, content]);
			};
			expect(await prompts()).toEqual([["quick", "Selected review"]]);
			expect(await toggle()).toBe(false);
			expect(await prompts()).toEqual([]);
			expect(await toggle()).toBe(true);
			expect(await prompts()).toEqual([["quick", "Selected review"]]);
			createCommit(remoteDir, "review", "Next review", "Advance review");
			await packageManager.update();
			expect(await prompts()).toEqual([["quick", "Next review"]]);
			expect(await toggle()).toBe(true);
			expect(settingsManager.getProjectSettings().prompts).toEqual([]);
			expect(await prompts()).toEqual([["quick", "Next review"]]);
		},
	);

	it.skipIf(process.platform === "win32").each([false, true])(
		"resolves a checkout-local changelog after publication (external: %s)",
		async (external) => {
			setupRemoteAndInstall();
			mkdirSync(join(remoteDir, "extensions"));
			createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add extension");
			createCommit(remoteDir, "notes.md", "Old notes", "Add notes");
			const outside = join(tempDir, "outside.md");
			writeFileSync(outside, "External notes");
			symlinkSync(external ? outside : join(installedDir, "notes.md"), join(remoteDir, "CHANGELOG.md"));
			git(["add", "CHANGELOG.md"], remoteDir);
			git(["commit", "-m", "Add changelog link"], remoteDir);
			git(["pull", "--ff-only"], installedDir);
			const changelog = async () =>
				(await packageManager.resolve()).extensions.find(({ path }) => basename(path) === "worker.ts")?.metadata
					.changelogPath;
			const before = await changelog();
			if (external) expect(before).toBeUndefined();
			else expect(readFileSync(before!, "utf8")).toBe("Old notes");
			createCommit(remoteDir, "notes.md", "New notes", "Update notes");
			await packageManager.update();
			const after = await changelog();
			if (external) expect(after).toBeUndefined();
			else {
				expect(after).toBe(join(selected(), "notes.md"));
				expect(readFileSync(after!, "utf8")).toBe("New notes");
			}
		},
	);

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

	it("locks detached checkout fallback ref discovery before touching origin/HEAD", async () => {
		setupRemoteAndInstall();
		git(["checkout", "--detach"], installedDir);
		const expected = createCommit(remoteDir, "extension.ts", "// v2", "Update default branch");
		const competitor = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
		const manager = packageManager as unknown as {
			runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
		};
		const run = manager.runCommand.bind(manager);
		let competingUpdate: Promise<void> | undefined;
		vi.spyOn(manager, "runCommand").mockImplementation(async (command, args, options) => {
			if (command === "git" && args[0] === "remote" && args[1] === "set-head") {
				competingUpdate = expect(competitor.update()).rejects.toMatchObject({ code: "ELOCKED" });
				await competingUpdate;
			}
			await run(command, args, options);
		});
		await packageManager.update();
		expect(competingUpdate).toBeDefined();
		await competingUpdate;
		expect(getCurrentCommit(selected())).toBe(expected);
	});

	it("keeps the surviving prompt ahead of a force-included prompt in a filtered manifest", async () => {
		const local = join(tempDir, "local-package");
		for (const [dir, text] of [
			["a", "Restored prompt"],
			["b", "Surviving prompt"],
		] as const) {
			mkdirSync(join(local, dir), { recursive: true });
			writeFileSync(join(local, dir, "review.md"), text);
		}
		writeFileSync(
			join(local, "package.json"),
			JSON.stringify({ pi: { prompts: ["a/review.md", "b/review.md", "!a/review.md", "+a/review.md"] } }),
		);
		settingsManager.setPackages([{ source: local, prompts: ["**/*.md"] }]);
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getPrompts().prompts).toEqual([
			expect.objectContaining({
				name: "review",
				content: "Surviving prompt",
				filePath: join(local, "b", "review.md"),
			}),
		]);
	});

	it
		.skipIf(process.platform === "win32")
		.each([
			"force-include",
			"manifest-exclusion",
			"settings-exclusion",
			"delta-exclusion",
			"top-level-exclusion",
			"delta-rule-order",
			"top-level-replacement",
			"top-level-exclusion-only-aliases",
			"delta-exclusion-only-aliases",
			"settings-exclusion-only-aliases",
			"auto-exclusion-only-aliases",
		])("keeps the same prompt winner with interleaved Git aliases (%s)", async (mode) => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "shared.md", "Aliased prompt", "Add shared prompt");
		for (const dir of ["a", "b", "c"]) mkdirSync(join(remoteDir, dir));
		createCommit(remoteDir, "b/review.md", "Independent prompt", "Add independent prompt");
		for (const path of ["a/first.md", "c/review.md"])
			symlinkSync(join(installedDir, "shared.md"), join(remoteDir, path));
		git(["add", "a/first.md", "c/review.md"], remoteDir);
		git(["commit", "-m", "Add interleaved aliases"], remoteDir);
		createCommit(
			remoteDir,
			"package.json",
			JSON.stringify({
				pi: {
					prompts:
						mode === "top-level-replacement"
							? ["shared.md"]
							: [
									"a/first.md",
									"b/review.md",
									"c/review.md",
									...(mode === "manifest-exclusion" || mode === "force-include" ? ["!a/first.md"] : []),
									...(mode === "force-include" ? ["+a/first.md"] : []),
								],
				},
			}),
			"Declare filtered prompts",
		);
		git(["pull", "--ff-only"], installedDir);
		if (mode === "auto-exclusion-only-aliases") {
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			const dir = join(agentDir, "prompts");
			mkdirSync(dir, { recursive: true });
			for (const name of ["first.md", "review.md"]) symlinkSync(join(installedDir, "shared.md"), join(dir, name));
			settingsManager.setPromptTemplatePaths(["-prompts/first.md"]);
		} else if (mode === "delta-rule-order") {
			settingsManager.setPackages([
				{ source: gitSource, autoload: false, prompts: ["c/review.md", "b/review.md", "a/first.md"] },
			]);
		} else if (mode === "top-level-replacement") {
			settingsManager.setPackages([{ source: gitSource, prompts: [] }]);
			settingsManager.setPromptTemplatePaths([join(installedDir, "b/review.md"), join(installedDir, "c/review.md")]);
		} else if (mode === "top-level-exclusion" || mode === "top-level-exclusion-only-aliases") {
			settingsManager.setPackages([{ source: gitSource, autoload: false }]);
			settingsManager.setPromptTemplatePaths([
				...["a/first.md", ...(mode === "top-level-exclusion" ? ["b/review.md"] : []), "c/review.md"].map((path) =>
					join(installedDir, path),
				),
				`-${join(installedDir, "a/first.md")}`,
			]);
		} else if (mode !== "manifest-exclusion") {
			settingsManager.setPackages([
				{
					source: gitSource,
					autoload: !mode.startsWith("delta-exclusion"),
					prompts: [
						"**/*.md",
						...(mode.startsWith("settings-exclusion") || mode.startsWith("delta-exclusion")
							? ["-a/first.md"]
							: []),
						...(mode.endsWith("exclusion-only-aliases") ? ["-b/review.md"] : []),
					],
				},
			]);
		}
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		const verifyWinner = async (checkout: string) => {
			await loader.reload();
			if (mode.endsWith("exclusion-only-aliases")) {
				expect(loader.getPrompts().prompts).toEqual([]);
				return;
			}
			expect(loader.getPrompts().prompts.find(({ name }) => name === "review")).toMatchObject({
				content: mode === "delta-rule-order" ? "Aliased prompt" : "Independent prompt",
				filePath: join(
					checkout,
					mode === "delta-rule-order" ? (checkout === installedDir ? "c/review.md" : "shared.md") : "b/review.md",
				),
			});
		};
		await verifyWinner(installedDir);
		createCommit(remoteDir, "extension.ts", "// advance revision", "Advance revision");
		await packageManager.update();
		await verifyWinner(selected());
	});

	it("keeps a nested extension entry outside its discovery directory when filtering a manifest", async () => {
		const local = join(tempDir, "local-package");
		const nested = join(local, "extensions", "plugin");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(local, "package.json"), JSON.stringify({ pi: { extensions: ["extensions"] } }));
		writeFileSync(join(nested, "package.json"), JSON.stringify({ pi: { extensions: ["../../worker.ts"] } }));
		const worker = join(local, "worker.ts");
		writeFileSync(worker, "export default function() {}");
		settingsManager.setPackages([{ source: local, extensions: ["**/*.ts"] }]);
		expect((await packageManager.resolve()).extensions).toContainEqual(
			expect.objectContaining({ path: worker, enabled: true }),
		);
	});

	it("preserves the fallback name of a manifest-declared root skill across publication", async () => {
		setupRemoteAndInstall();
		vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", tempDir);
		createCommit(remoteDir, "SKILL.md", "---\ndescription: Root skill fixture\n---\nRoot skill", "Add root skill");
		createCommit(remoteDir, "package.json", JSON.stringify({ pi: { skills: ["SKILL.md"] } }), "Declare root skill");
		git(["pull", "--ff-only"], installedDir);
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		const name = basename(installedDir);
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([
			expect.objectContaining({ name, filePath: join(installedDir, "SKILL.md") }),
		]);
		createCommit(remoteDir, "extension.ts", "// advance revision", "Advance revision");
		await packageManager.update();
		const active = selected();
		expect(active).not.toBe(installedDir);
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([
			expect.objectContaining({ name, filePath: join(active, "SKILL.md"), baseDir: active }),
		]);
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

	it("updates healthy Git packages even when a configured checkout path is reserved", async () => {
		setupRemoteAndInstall();
		const expected = createCommit(remoteDir, "extension.ts", "// v2", "Update healthy package");
		settingsManager.setPackages([`git:github.com/test/.pi-revision-${"a".repeat(64)}-Ab1234`, gitSource]);

		await expect(packageManager.update()).rejects.toThrow("reserved revision namespace");
		expect(getCurrentCommit(selected())).toBe(expected);
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
		const retainedAlias = join(installedDir, "extension.ts");
		expect(existsSync(retainedAlias)).toBe(true);
		settingsManager.setPackages([retainedAlias, gitSource, "git:github.com/test/other"]);

		const resources = await packageManager.resolve();
		expect(resources.extensions.some((entry) => entry.path === retainedAlias)).toBe(false);
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

	it("skips explicit CLI resources from an invalid configured checkout across trust", async () => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "extension.ts", "// v2", "Update");
		await packageManager.update();
		const manager = packageManager as unknown as { getGitUpdateStatePath(path: string, scope: string): string };
		writeFileSync(`${manager.getGitUpdateStatePath(installedDir, "user")}.current`, "invalid");
		const alias = join(installedDir, "extension.ts");
		const healthy = join(tempDir, "healthy.ts");
		writeFileSync(healthy, "export default function() {}");
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [alias, healthy],
		});
		let trustChecked = false;
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				trustChecked = true;
				expect(extensionsResult.extensions.map(({ path }) => path)).toEqual([healthy]);
				return true;
			},
		});
		expect(trustChecked).toBe(true);
		expect(loader.getExtensions().extensions.map(({ path }) => path)).toEqual([healthy]);
		expect(
			loader.getExtensions().warnings?.filter(({ warning }) => warning.includes("Invalid Git revision pointer")),
		).toHaveLength(1);
	});

	it("warns once when a directory entry reaches a shadowed invalid checkout", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add project extension");
		const projectCheckout = join(tempDir, ".pi", "git", "github.com", "test", "extension");
		mkdirSync(dirname(projectCheckout), { recursive: true });
		git(["clone", remoteDir, projectCheckout], tempDir);
		const directory = join(tempDir, "bare-extension");
		mkdirSync(directory);
		writeFileSync(join(directory, "package.json"), JSON.stringify({ main: "entry.ts" }));
		symlinkSync(join(installedDir, "extension.ts"), join(directory, "entry.ts"), "file");
		const manager = packageManager as unknown as { getGitUpdateStatePath(path: string, scope: string): string };
		const pointer = `${manager.getGitUpdateStatePath(installedDir, "user")}.current`;
		mkdirSync(dirname(pointer), { recursive: true });
		writeFileSync(pointer, "invalid");
		settingsManager.setPackages([directory, gitSource]);
		settingsManager.setProjectPackages([gitSource]);
		expect((await packageManager.resolve()).installFailures).toEqual([]);
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.extensions.map(({ path }) => path)).toEqual([join(projectCheckout, "extensions", "worker.ts")]);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([
			{ path: gitSource, warning: expect.stringContaining("Invalid Git revision pointer") },
		]);
	});

	it.each([false, true])("checks the resolved directory extension entry (invalid pointer: %s)", async (invalid) => {
		setupRemoteAndInstall();
		const loaded = join(tempDir, "directory-entry-loaded");
		createCommit(
			remoteDir,
			"extension.ts",
			`import { writeFileSync } from 'node:fs'; export default function() { writeFileSync(${JSON.stringify(loaded)}, 'selected'); }`,
			"Update",
		);
		await packageManager.update();
		const directory = join(tempDir, "bare-extension");
		mkdirSync(directory);
		writeFileSync(join(directory, "package.json"), JSON.stringify({ main: "entry.ts" }));
		symlinkSync(join(installedDir, "extension.ts"), join(directory, "entry.ts"), "file");
		if (invalid) {
			const manager = packageManager as unknown as { getGitUpdateStatePath(path: string, scope: string): string };
			writeFileSync(`${manager.getGitUpdateStatePath(installedDir, "user")}.current`, "invalid");
		}
		settingsManager.setPackages([directory, { source: gitSource, extensions: [] }]);
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		const expected = invalid ? [] : [directory];
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				expect(extensionsResult.extensions.map(({ path }) => path)).toEqual(expected);
				return true;
			},
		});
		const result = loader.getExtensions();
		expect(result.extensions.map(({ path }) => path)).toEqual(expected);
		expect(result.errors).toEqual([]);
		expect(result.warnings?.filter(({ warning }) => warning.includes("Invalid Git revision pointer"))).toHaveLength(
			invalid ? 1 : 0,
		);
		if (invalid) expect(existsSync(loaded)).toBe(false);
		else expect(readFileSync(loaded, "utf8")).toBe("selected");
	});

	it("rejects a regular file at the selected checkout path", async () => {
		setupRemoteAndInstall();
		createCommit(remoteDir, "extension.ts", "// v2", "Update");
		await packageManager.update();
		const active = selected();
		expect(active).not.toBe(installedDir);
		rmSync(active, { recursive: true });
		writeFileSync(active, "not a checkout");
		settingsManager.setPackages([installedDir, gitSource]);

		const result = await packageManager.resolve();
		expect(result.extensions.some(({ metadata }) => [installedDir, gitSource].includes(metadata.source))).toBe(false);
		expect(result.installFailures).toEqual([
			expect.objectContaining({
				source: gitSource,
				message: expect.stringContaining(`Expected a directory at ${active}`),
			}),
		]);
	});

	it.each(["file", "directory"])(
		"skips an unavailable checkout reached through a configured %s alias",
		async (kind) => {
			setupRemoteAndInstall();
			const otherSource = "git:github.com/test/other";
			const other = join(dirname(installedDir), "other");
			git(["clone", remoteDir, other], tempDir);
			createCommit(remoteDir, "extension.ts", "// v2", "Update");
			await packageManager.update();
			const active = selected();
			const alias = join(installedDir, "extension.ts");
			const selectedAlias = join(active, "extension.ts");
			rmSync(selectedAlias);
			symlinkSync(join(other, "extension.ts"), selectedAlias, "file");
			const manager = packageManager as unknown as { getGitUpdateStatePath(path: string, scope: string): string };
			writeFileSync(`${manager.getGitUpdateStatePath(other, "user")}.current`, "invalid");
			const packageAlias = kind === "file" ? alias : installedDir;
			const retained = join(other, "extension.ts");
			const healthy = join(active, "extensions", "healthy.ts");
			mkdirSync(dirname(healthy), { recursive: true });
			writeFileSync(healthy, "export default function() {}");
			symlinkSync(retained, join(dirname(healthy), "retained.ts"), "file");
			// A link inside the retained checkout must not shadow a healthy selected resource.
			const selectedExplicit = join(active, "explicit.ts");
			writeFileSync(selectedExplicit, "export default function() {}");
			symlinkSync(retained, join(installedDir, "explicit.ts"), "file");
			const externalAlias = join(agentDir, "checkout-alias");
			symlinkSync(installedDir, externalAlias, "dir");
			const fileAlias = join(agentDir, "explicit-alias.ts");
			const intermediate = join(agentDir, "intermediate.ts");
			symlinkSync(join(installedDir, "explicit.ts"), intermediate, "file");
			symlinkSync(intermediate, fileAlias, "file");
			const autoDir = join(agentDir, "extensions");
			mkdirSync(autoDir, { recursive: true });
			const rediscoverable = join(autoDir, "retained.ts");
			symlinkSync(retained, rediscoverable, "file");
			const standalone = join(autoDir, "standalone.ts");
			writeFileSync(standalone, "export default function() {}");
			settingsManager.setPackages([packageAlias, { source: gitSource, extensions: [] }, otherSource]);
			settingsManager.setExtensionPaths([
				retained,
				rediscoverable,
				kind === "file" ? fileAlias : join(externalAlias, "explicit.ts"),
			]);
			const result = await packageManager.resolve();
			expect(
				result.extensions
					.filter(({ metadata, enabled }) => metadata.source === packageAlias && enabled)
					.map(({ path }) => path),
			).toEqual(kind === "directory" ? [healthy] : []);
			expect(
				result.extensions
					.filter(({ metadata, enabled }) => metadata.origin === "top-level" && enabled)
					.map(({ path }) => path),
			).toContain(standalone);
			expect(result.extensions.map(({ path }) => path)).toContain(selectedExplicit);
			expect(result.extensions.map(({ path }) => path)).not.toContain(retained);
			expect(result.extensions.map(({ path }) => path)).not.toContain(rediscoverable);
			if (kind === "file") {
				rmSync(retained);
				const dangling = await packageManager.resolve();
				expect(dangling.extensions.map(({ path }) => path)).toContain(selectedExplicit);
				rmSync(intermediate);
				symlinkSync(join(externalAlias, "explicit.ts"), intermediate, "file");
				const mixed = await packageManager.resolve();
				expect(mixed.extensions.map(({ path }) => path)).toContain(selectedExplicit);
			}
			expect(result.extensions.map(({ path }) => path)).not.toContain(join(dirname(healthy), "retained.ts"));
			expect(result.installFailures).toEqual([
				expect.objectContaining({
					source: otherSource,
					message: expect.stringContaining("Invalid Git revision pointer"),
				}),
			]);
		},
	);

	it("skips a configured alias when the final checkout lookup sees an invalid pointer", async () => {
		setupRemoteAndInstall();
		const alias = join(installedDir, "extension.ts");
		const backup = `${installedDir}-backup`;
		renameSync(installedDir, backup);
		settingsManager.setPackages([alias, gitSource]);
		const manager = packageManager as unknown as {
			recoverGitCheckout(path: string, scope: string): Promise<string | undefined>;
			getGitUpdateStatePath(path: string, scope: string): string;
		};
		const recover = manager.recoverGitCheckout.bind(manager);
		vi.spyOn(manager, "recoverGitCheckout").mockImplementationOnce(async (path, scope) => {
			renameSync(backup, installedDir);
			const recovered = await recover(path, scope);
			expect(recovered).toBe(installedDir);
			const state = manager.getGitUpdateStatePath(path, scope);
			mkdirSync(dirname(state), { recursive: true });
			writeFileSync(`${state}.current`, "invalid");
			return recovered;
		});
		const result = await packageManager.resolve();
		expect(result.extensions.map(({ path }) => path)).not.toContain(alias);
		expect(result.installFailures).toEqual([
			expect.objectContaining({
				source: gitSource,
				message: expect.stringContaining("Invalid Git revision pointer"),
			}),
		]);
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

	it("does not resolve the superseded checkout during Git package removal", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "// v1", "Add worker");
		git(["pull", "--ff-only"], installedDir);
		createCommit(remoteDir, "extensions/worker.ts", "// v2", "Update");
		await packageManager.update();
		const active = selected();
		settingsManager.setPackages([join(installedDir, "extensions", "worker.ts"), gitSource]);
		let resolution: ReturnType<typeof packageManager.resolve> | undefined;
		fsFixture.duringRemove = async (path, removed) => {
			if (path !== installedDir || removed) return;
			expect(existsSync(installedDir)).toBe(true);
			resolution = packageManager.resolve(async () => "skip");
		};
		try {
			await packageManager.remove(gitSource);
		} finally {
			fsFixture.duringRemove = undefined;
		}
		expect(resolution).toBeDefined();
		const resolved = await resolution;
		expect(resolved?.extensions.map(({ path }) => path)).not.toContain(join(installedDir, "extensions", "worker.ts"));
		expect(existsSync(active)).toBe(false);
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
			mkdirSync(aliasPath);
			expect(selected(aliasSource)).toBe(aliasPath);
			expect(selected()).toBe(active);
			await packageManager.remove(aliasSource);
			expect(getFileContent(active, "extension.ts")).toBe("// v2");

			// Simulate a case-insensitive directory without changing the host platform.
			fsFixture.aliasFrom = aliasPath;
			fsFixture.aliasTo = installedDir;
			try {
				expect(selected(aliasSource)).toBe(active);
				const checkedLock: string[] = [];
				fsFixture.duringRemove = async (path, removed) => {
					if (path === active && !removed) {
						expect(existsSync(installedDir)).toBe(true);
						checkedLock.push("selected cleanup");
					} else if (path === installedDir && removed) {
						expect(existsSync(installedDir)).toBe(false);
						checkedLock.push("after logical deletion");
					} else {
						return;
					}
					await expect(packageManager.remove(aliasSource)).rejects.toMatchObject({ code: "ELOCKED" });
				};
				await packageManager.remove(gitSource);
				expect(checkedLock).toEqual(["selected cleanup", "after logical deletion"]);
				expect(existsSync(active)).toBe(false);
				expect(existsSync(installedDir)).toBe(false);
			} finally {
				fsFixture.duringRemove = undefined;
				fsFixture.aliasFrom = "";
				fsFixture.aliasTo = "";
			}
		}
	});

	it.each(["selected cleanup", "logical deletion", "reinstall"])(
		"retries Git removal interrupted at %s via a case alias",
		async (phase) => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "extension.ts", "// v2", "Update");
			await packageManager.update();
			const active = selected();
			const key = createHash("sha256")
				.update(relative(join(agentDir, "git"), installedDir))
				.digest("hex");
			const pointer = join(agentDir, "git", ".git-update-state", `${key}.current`);
			const aliasPath = join(dirname(installedDir), "EXTENSION");
			if (!existsSync(aliasPath)) {
				fsFixture.aliasFrom = aliasPath;
				fsFixture.aliasTo = installedDir;
			}
			try {
				fsFixture.duringRemove = async (path, removed) => {
					if (phase === "selected cleanup" ? path === active && !removed : path === installedDir && removed) {
						throw new Error("injected removal failure");
					}
				};
				await expect(packageManager.remove(gitSource)).rejects.toThrow("injected removal failure");
				expect(existsSync(pointer)).toBe(true);
				fsFixture.duringRemove = undefined;
				const distinct = join(dirname(installedDir), "Extension");
				if (phase === "logical deletion" && fsFixture.aliasFrom) mkdirSync(distinct);
				const alias = "git:github.com/test/EXTENSION";
				if (phase === "reinstall") {
					const manager = packageManager as unknown as {
						runCommand(command: string, args: string[]): Promise<void>;
					};
					vi.spyOn(manager, "runCommand").mockImplementation(async (_command, args) => {
						expect(args[0]).toBe("clone");
						expect(existsSync(pointer)).toBe(false);
						git(["clone", remoteDir, aliasPath], tempDir);
					});
					await packageManager.install(alias);
					fsFixture.aliasFrom = "";
					fsFixture.aliasTo = "";
					expect(existsSync(aliasPath)).toBe(true);
				}
				await packageManager.remove(alias);
				expect(existsSync(aliasPath)).toBe(false);
				if (phase === "logical deletion" && fsFixture.aliasFrom) expect(existsSync(distinct)).toBe(true);
				expect(existsSync(active)).toBe(false);
				expect(existsSync(pointer)).toBe(false);
				expect(existsSync(installedDir)).toBe(false);
				git(["clone", remoteDir, installedDir], tempDir);
				expect(selected()).toBe(installedDir);
			} finally {
				fsFixture.duringRemove = undefined;
				fsFixture.aliasFrom = "";
				fsFixture.aliasTo = "";
			}
		},
	);

	it("updates distinct case-sensitive checkouts in one batch", async ({ skip }) => {
		setupRemoteAndInstall();
		const otherSource = "git:github.com/test/EXTENSION";
		const otherDir = join(dirname(installedDir), "EXTENSION");
		if (existsSync(otherDir)) return skip();
		const otherRemote = join(tempDir, "other-remote");
		mkdirSync(otherRemote);
		initGitRepo(otherRemote);
		createCommit(otherRemote, "extension.ts", "// other v1", "Initial commit");
		git(["clone", otherRemote, otherDir], tempDir);
		const head = createCommit(remoteDir, "extension.ts", "// v2", "Update");
		const otherHead = createCommit(otherRemote, "extension.ts", "// other v2", "Update");
		const unrelated = "git:github.com/test/unrelated";
		git(["clone", remoteDir, join(dirname(installedDir), "unrelated")], tempDir);
		settingsManager.setPackages([gitSource, otherSource, unrelated]);
		const events: string[] = [];
		packageManager.setProgressCallback(({ type, source }) => {
			if (type === "start" || type === "complete") events.push(`${type}:${source}`);
		});

		await packageManager.update();

		expect(getCurrentCommit(selected())).toBe(head);
		expect(getCurrentCommit(selected(otherSource))).toBe(otherHead);
		expect(events.slice(0, 2)).toEqual([`start:${gitSource}`, `start:${unrelated}`]);
		expect(events.indexOf(`start:${otherSource}`)).toBeGreaterThan(events.indexOf(`complete:${gitSource}`));

		const key = createHash("sha256")
			.update(relative(join(agentDir, "git"), installedDir))
			.digest("hex");
		writeFileSync(join(agentDir, "git", ".git-update-state", `${key}.current`), "invalid\n");
		const nextOther = createCommit(otherRemote, "extension.ts", "// other v3", "Update again");
		settingsManager.setPackages([gitSource, otherSource]);
		await expect(packageManager.update()).rejects.toThrow(/revision pointer/i);
		expect(getCurrentCommit(selected(otherSource))).toBe(nextOther);
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
		const key = createHash("sha256").update(identity).digest("hex");
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

	it("resolves configured resources and aliases after recovery selects the logical checkout", async () => {
		setupRemoteAndInstall();
		mkdirSync(join(remoteDir, "extensions"));
		createCommit(remoteDir, "extensions/worker.ts", "export default function() {}", "Add worker");
		createCommit(remoteDir, "alias-only.ts", "export default function() {}", "Add explicit local extension");
		git(["pull", "--ff-only"], installedDir);
		createCommit(remoteDir, "extensions/worker.ts", "export default function() { /* updated */ }", "Update");
		await packageManager.update();
		const aliasPath = join(installedDir, "alias-only.ts");
		settingsManager.setPackages([aliasPath, { source: gitSource, extensions: ["extensions/worker.ts"] }]);
		const active = selected();
		expect(active).not.toBe(installedDir);
		rmSync(active, { recursive: true });
		const manager = packageManager as unknown as {
			recoverGitCheckout(path: string, scope: string): Promise<string | undefined>;
			getGitUpdateStatePath(path: string, scope: string): string;
		};
		const recover = manager.recoverGitCheckout.bind(manager);
		const recovery = vi.spyOn(manager, "recoverGitCheckout");
		recovery.mockRejectedValueOnce(new Error("Recovery interrupted"));
		const failed = await packageManager.resolve();
		expect(failed.extensions.map(({ path }) => path)).not.toContain(aliasPath);
		expect(failed.gitRevisions?.get(installedDir)).toBe(active);

		recovery.mockImplementationOnce((path, scope) => {
			rmSync(`${manager.getGitUpdateStatePath(path, scope)}.current`);
			return recover(path, scope);
		});
		const resolved = await packageManager.resolve();
		expect(resolved.extensions.find(({ path }) => path === aliasPath)?.metadata.source).toBe(aliasPath);
		const worker = join(installedDir, "extensions", "worker.ts");
		expect(
			resolved.extensions.map(({ path }) => path).filter((path) => path === aliasPath || path === worker),
		).toEqual([aliasPath, worker]);
		expect(resolved.gitRevisions?.has(installedDir)).not.toBe(true);
		const alias = await packageManager.resolveExtensionSources([worker], { gitRevisions: resolved.gitRevisions });
		expect(alias.extensions.map(({ path }) => path)).toContain(worker);
	});

	describe("temporary git sources", () => {
		it("clears a missing revision redirect when temporary recovery selects the logical checkout", async () => {
			const logical = selected(gitSource, "temporary");
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			createCommit(remoteDir, "worker.ts", "export default function() {}", "Initial");
			mkdirSync(dirname(logical), { recursive: true });
			git(["clone", remoteDir, logical], tempDir);
			createCommit(remoteDir, "worker.ts", "export default function() { /* updated */ }", "Update");
			await packageManager.prepareTemporaryGitSources([gitSource]);
			const active = selected(gitSource, "temporary");
			expect(active).not.toBe(logical);
			rmSync(active, { recursive: true });
			const manager = packageManager as unknown as {
				recoverGitCheckout(path: string, scope: string): Promise<string | undefined>;
				getGitUpdateStatePath(path: string, scope: string): string;
			};
			const recover = manager.recoverGitCheckout.bind(manager);
			vi.spyOn(manager, "recoverGitCheckout").mockImplementationOnce((path, scope) => {
				rmSync(`${manager.getGitUpdateStatePath(path, scope)}.current`);
				return recover(path, scope);
			});
			vi.stubEnv("PI_OFFLINE", "1");
			const prepared = await packageManager.prepareTemporaryGitSources([gitSource]);
			expect(prepared.checkouts.get(logical)).toBe(logical);
			expect(prepared.gitRevisions.has(logical)).toBe(false);
			const alias = join(logical, "worker.ts");
			const resolved = await packageManager.resolveExtensionSources([alias, gitSource], {
				temporary: true,
				temporaryGit: prepared,
				gitRevisions: prepared.gitRevisions,
			});
			expect(resolved.extensions.map(({ path }) => path)).toContain(alias);
		});

		it.each([
			["local first", false],
			["configured", false],
			["local first", true],
			["configured", true],
		] as const)(
			"suppresses aliases to an unavailable temporary selection (%s; malformed: %s)",
			async (kind, malformed) => {
				const cachedDir = selected(gitSource, "temporary");
				mkdirSync(remoteDir, { recursive: true });
				initGitRepo(remoteDir);
				const marker = join(tempDir, "stale-loaded");
				createCommit(
					remoteDir,
					"worker.ts",
					`import { writeFileSync } from 'node:fs'; export default function() { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }`,
					"Initial",
				);
				mkdirSync(dirname(cachedDir), { recursive: true });
				git(["clone", remoteDir, cachedDir], tempDir);
				createCommit(remoteDir, "worker.ts", "export default function() {}", "Update");
				const prepared = await packageManager.prepareTemporaryGitSources([gitSource]);
				const active = prepared.checkouts.get(cachedDir);
				if (!active || active === cachedDir) throw new Error("Expected a selected revision");
				rmSync(active, { recursive: true });
				if (malformed) {
					const manager = packageManager as unknown as {
						getGitUpdateStatePath(path: string, scope: string): string;
					};
					writeFileSync(`${manager.getGitUpdateStatePath(cachedDir, "temporary")}.current`, "invalid");
				}
				const alias = join(cachedDir, "worker.ts");
				if (kind === "configured") settingsManager.setExtensionPaths([alias]);
				const retainedPrompt = join(cachedDir, "retained.md");
				const healthyPrompt = join(tempDir, "healthy.md");
				writeFileSync(retainedPrompt, "retained");
				writeFileSync(healthyPrompt, "healthy");
				const loader = new DefaultResourceLoader({
					cwd: tempDir,
					agentDir,
					settingsManager,
					additionalExtensionPaths: kind === "configured" ? [gitSource] : [alias, gitSource],
					additionalPromptTemplatePaths: [retainedPrompt, healthyPrompt],
				});
				let trustChecked = false;
				await loader.reload({
					resolveProjectTrust: async ({ extensionsResult }) => {
						trustChecked = true;
						expect(extensionsResult.extensions).toEqual([]);
						expect(existsSync(marker)).toBe(false);
						return false;
					},
				});
				expect(trustChecked).toBe(true);
				expect(loader.getExtensions().extensions).toEqual([]);
				expect(loader.getPrompts().prompts.map(({ name }) => name)).toEqual(["healthy"]);
				expect(existsSync(marker)).toBe(false);
			},
		);

		it.each(["git first", "local first", "configured"])(
			"pins refreshed temporary Git aliases across trust (%s)",
			async (kind) => {
				const managerWithPaths = packageManager as unknown as PackageManagerPathInternals;
				const cachedDir = managerWithPaths.getGitInstallPath(managerWithPaths.parseSource(gitSource), "temporary");

				mkdirSync(join(remoteDir, "pi-extensions"), { recursive: true });
				initGitRepo(remoteDir);
				writeFileSync(
					join(remoteDir, "package.json"),
					JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
				);
				git(["add", "package.json"], remoteDir);
				const marker = join(tempDir, "temporary-initializations");
				const extension = (value: string) =>
					`import { appendFileSync } from "node:fs"; export default function() { appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(value)}); }`;
				createCommit(remoteDir, "pi-extensions/session-breakdown.ts", extension("stale\n"), "Initial package");
				mkdirSync(dirname(cachedDir), { recursive: true });
				git(["clone", remoteDir, cachedDir], tempDir);
				const newCommit = createCommit(
					remoteDir,
					"pi-extensions/session-breakdown.ts",
					extension("fresh\n"),
					"Update package",
				);
				settingsManager.setNpmCommand(["npm", "--offline", "--ignore-scripts"]);

				const relativeFile = "pi-extensions/session-breakdown.ts";
				const cachedFile = join(cachedDir, relativeFile);
				if (kind === "configured") settingsManager.setExtensionPaths([cachedFile]);
				await settingsManager.flush();
				const loader = new DefaultResourceLoader({
					cwd: tempDir,
					agentDir,
					settingsManager,
					additionalExtensionPaths:
						kind === "configured"
							? [gitSource]
							: kind === "local first"
								? [cachedFile, gitSource]
								: [gitSource, cachedFile],
				});
				await loader.reload({
					resolveProjectTrust: async ({ extensionsResult }) => {
						const active = selected(gitSource, "temporary");
						expect(extensionsResult.errors).toEqual([]);
						expect(extensionsResult.extensions.map(({ path }) => path)).toEqual([
							join(active, "pi-extensions", "session-breakdown.ts"),
						]);
						expect(readFileSync(marker, "utf8")).toBe("fresh\n");
						createCommit(remoteDir, relativeFile, extension("newer\n"), "Advance during trust prompt");
						return false;
					},
				});
				const active = selected(gitSource, "temporary");
				expect(getCurrentCommit(active)).toBe(newCommit);
				expect(loader.getExtensions().errors).toEqual([]);
				expect(loader.getExtensions().extensions.map(({ path }) => path)).toEqual([
					join(active, "pi-extensions", "session-breakdown.ts"),
				]);
				expect(readFileSync(marker, "utf8")).toBe("fresh\n");
				await loader.reload();
				const next = selected(gitSource, "temporary");
				expect(next).not.toBe(active);
				expect(loader.getExtensions().errors).toEqual([]);
				expect(loader.getExtensions().extensions.map(({ path }) => path)).toEqual([join(next, relativeFile)]);
				expect(readFileSync(marker, "utf8")).toBe("fresh\nnewer\n");
			},
		);
	});
});
