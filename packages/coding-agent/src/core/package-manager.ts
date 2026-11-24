import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	globSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { cp, rm } from "node:fs/promises";
import { homedir } from "node:os";

function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import ignore from "ignore";
import { minimatch } from "minimatch";
import lockfile from "proper-lockfile";
import { gt, maxSatisfying, rcompare, satisfies, valid, validRange } from "semver";
import { CONFIG_DIR_NAME } from "../config.ts";
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import {
	canonicalizePath,
	getPathComparisonKey,
	isLocalPath,
	markPathIgnoredByCloudSync,
	normalizePath,
	pathsEqual,
	resolvePath,
} from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { isStdoutTakenOver } from "./output-guard.ts";
import { type PiManifest, readPiManifest } from "./pi-manifest.ts";
import type { PackageSource, SettingsManager } from "./settings-manager.ts";
import { BUILTIN_PATH_PREFIX, getResourcePathKey } from "./source-info.ts";

const NETWORK_TIMEOUT_MS = 10000;
const UPDATE_CHECK_CONCURRENCY = 4;
const GIT_UPDATE_CONCURRENCY = 4;

/** Whether PI_OFFLINE is set; package installs and updates then skip all network access. */
export function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isExactNpmVersion(version: string | undefined): boolean {
	return valid(version ?? "") !== null;
}

function getNpmVersionRange(version: string | undefined): string | undefined {
	return version ? (validRange(version) ?? undefined) : undefined;
}

export interface PathMetadata {
	packageDelta?: boolean;
	packageAliases?: readonly string[];
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
	changelogPath?: string;
	packageRoot?: string;
	gitRevision?: { logical: string; active: string; aliases?: readonly string[]; declarations?: readonly string[] };
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface TemporaryGitSelection {
	checkouts: ReadonlyMap<string, string>;
	gitRevisions: ReadonlyMap<string, string>;
	installFailures: PackageInstallFailure[];
}

export interface ResolvedPaths {
	/** Checkout selection shared with explicit extension sources in the same load. */
	gitRevisions?: ReadonlyMap<string, string>;
	configuredGitCheckouts?: ReadonlyMap<string, string>;
	missingLocalPaths?: string[];
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
	/** Configured packages that were skipped because installing them failed. */
	installFailures?: PackageInstallFailure[];
}

/** A configured package that could not be installed while resolving resources. */
export interface PackageInstallFailure {
	source: string;
	scope: SourceScope;
	message: string;
}

export type MissingSourceAction = "install" | "skip" | "error";

export interface ProgressEvent {
	/**
	 * `start` is followed by exactly one `complete` or `error` for the same source.
	 * `progress` carries an intermediate message or warning.
	 * `result` reports an outcome outside that pairing, e.g. one changed package
	 * after update(): `npm:foo 1.2.0 -> 1.3.0`.
	 */
	type: "start" | "progress" | "complete" | "error" | "result";
	action: "install" | "remove" | "update" | "clone" | "pull";
	source: string;
	message?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface PackageUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: Exclude<SourceScope, "temporary">;
}

export interface ConfiguredPackage {
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	installedPath?: string;
}

export interface PackageManager {
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	install(source: string, options?: { local?: boolean }): Promise<void>;
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	update(source?: string): Promise<void>;
	listConfiguredPackages(): ConfiguredPackage[];
	resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean; gitRevisions?: ReadonlyMap<string, string> },
	): Promise<ResolvedPaths>;
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	setProgressCallback(callback: ProgressCallback | undefined): void;
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

interface PackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	/** Names of built-in extensions, resolved as `builtin:<name>` extension resources. */
	builtinExtensions?: string[];
}

type SourceScope = "user" | "project" | "temporary";

type NpmSource = {
	type: "npm";
	spec: string;
	name: string;
	version?: string;
	range?: string;
	pinned: boolean;
};

type LocalSource = {
	type: "local";
	path: string;
};

type ParsedSource = NpmSource | GitSource | LocalSource;

type InstalledSourceScope = Exclude<SourceScope, "temporary">;

interface ConfiguredUpdateSource {
	source: string;
	scope: InstalledSourceScope;
}

interface NpmUpdateTarget extends ConfiguredUpdateSource {
	parsed: NpmSource;
	/** Version installed before the update, if any. */
	installedVersion?: string;
	/** Newer version reported by the registry, if the lookup succeeded. */
	targetVersion?: string;
}

interface GitUpdateTarget extends ConfiguredUpdateSource {
	parsed: GitSource;
}

/** A configured package whose installed npm version or git commit changed during update(). */
interface UpdatedPackage extends ConfiguredUpdateSource {
	type: "npm" | "git";
	/** npm version or git commit before the update; undefined if it was not installed. */
	from?: string;
	/** npm version or git commit after the update. */
	to?: string;
}

interface ResourceAccumulator {
	gitRevisions: Map<string, string>;
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	// Built-in extensions load after file and package extensions, whichever scope enables them.
	if (m.source === "builtin") return 5;
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

interface PackageFilter {
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

type ResourceType = "extensions" | "skills" | "prompts" | "themes";

const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function getHomeDir(): string {
	return process.env.HOME || homedir();
}

export function getExtensionTempFolder(agentDir: string): string {
	const tempFolder = join(agentDir, "tmp", "extensions");
	mkdirSync(tempFolder, { recursive: true, mode: 0o700 });
	chmodSync(tempFolder, 0o700);
	return tempFolder;
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string, logicalDir = dir): void {
	const relativeDir = relative(rootDir, logicalDir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

/** Glob entries discover visible paths; exact entries can target dot paths or symlinked trees. */
function expandPackageGlob(pattern: string, root: string): string[] {
	return globSync(pattern, { cwd: root })
		.map((match) => resolve(root, match))
		.filter((path) => isVisibleGlobPath(root, path))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isVisibleGlobPath(root: string, path: string): boolean {
	return relative(root, path)
		.split(sep)
		.every((segment) => segment === ".." || !segment.startsWith("."));
}

function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

interface DiscoverySelection {
	selectPath: (path: string) => string;
	rememberAlias: (file: string, alias: string) => void;
	recordDirect?: boolean;
}

function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
	selection?: DiscoverySelection,
	logicalDir = dir,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? logicalDir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root, logicalDir);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(selection?.selectPath(fullPath) ?? fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const logical = join(logicalDir, entry.name);
			const relPath = toPosixPath(relative(root, logical));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				const selected = selection?.selectPath(fullPath) ?? fullPath;
				files.push(...collectFiles(selected, filePattern, skipNodeModules, ig, root, selection, logical));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
				if (selection?.recordDirect || logical !== fullPath) selection?.rememberAlias(fullPath, logical);
			}
		}
	} catch {
		// Ignore errors
	}

	return files;
}

type SkillDiscoveryMode = "pi" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
	selection?: DiscoverySelection,
	logicalDir = dir,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? logicalDir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root, logicalDir);
	const addEntry = (file: string, logical: string) => {
		entries.push(file);
		if (selection?.recordDirect || file !== logical) selection?.rememberAlias(file, logical);
	};

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(selection?.selectPath(fullPath) ?? fullPath).isFile();
				} catch {
					continue;
				}
			}

			const logical = join(logicalDir, entry.name);
			const relPath = toPosixPath(relative(root, logical));
			if (isFile && !ig.ignores(relPath)) {
				addEntry(fullPath, logical);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(selection?.selectPath(fullPath) ?? fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const logical = join(logicalDir, entry.name);
			const relPath = toPosixPath(relative(root, logical));
			const shouldIncludeMarkdownFile =
				isFile &&
				entry.name.endsWith(".md") &&
				!ig.ignores(relPath) &&
				((mode === "pi" && logicalDir === root) || (mode === "agents" && logicalDir !== root));
			if (shouldIncludeMarkdownFile) {
				addEntry(fullPath, logical);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			const selected = selection?.selectPath(fullPath) ?? fullPath;
			entries.push(...collectSkillEntries(selected, mode, ig, root, selection, logical));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

function collectAutoPromptEntries(dir: string, selectPath: (path: string) => string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(selectPath(fullPath)).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".md")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function collectAutoThemeEntries(dir: string, selectPath: (path: string) => string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(selectPath(fullPath)).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".json")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function resolveExtensionEntries(dir: string, selectPath: (path: string) => string): string[] | null {
	const packageJsonPath = selectPath(join(dir, "package.json"));
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(selectPath(resolvedExtPath))) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	for (const name of ["index.ts", "index.js"]) {
		const index = join(dir, name);
		try {
			if (statSync(selectPath(index), { throwIfNoEntry: false })?.isFile()) return [index];
		} catch {
			// An unusable conventional entry should not hide sibling extensions.
		}
	}

	return null;
}

function collectAutoExtensionEntries(
	originalDir: string,
	selectPath = (path: string) => path,
	rememberAlias?: (file: string, alias: string) => void,
	recordDirect = false,
): string[] {
	const dir = selectPath(originalDir);
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	// First check if this directory itself has explicit extension entries (package.json or index)
	const discover = (original: string, selected: string) => {
		const files = resolveExtensionEntries(selected, selectPath);
		if ((recordDirect || original !== selected) && rememberAlias) {
			for (const file of files ?? []) {
				if (recordDirect || isPathInside(selected, file))
					rememberAlias(file, join(original, relative(selected, file)));
			}
		}
		return files;
	};
	const rootEntries = discover(originalDir, dir);
	if (rootEntries) return rootEntries;

	// Otherwise, discover extensions from directory contents
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(selectPath(fullPath));
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(fullPath);
				if (recordDirect || originalDir !== dir) rememberAlias?.(fullPath, join(originalDir, entry.name));
			} else if (isDir) {
				const resolvedEntries = discover(join(originalDir, entry.name), selectPath(fullPath));
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/**
 * Collect resource files from a directory based on resource type.
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "pi");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

// A `pi` object counts as an explicit resource manifest only when it lists resources. Packages whose
// `pi` object holds only metadata (changelogPath, gallery image/video) still use directory auto-discovery.
function hasManifestResourceFields(manifest: PiManifest): boolean {
	return RESOURCE_TYPES.some((resourceType) => manifest[resourceType] !== undefined);
}

function isPathInside(parent: string, child: string): boolean {
	const relativePath = relative(parent, child);
	return (
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

function resolvePackageChangelogPath(
	packageRoot: string,
	manifest: PiManifest | null,
	selectPath: (path: string) => string,
): string | undefined {
	const changelogPath = manifest?.changelogPath ?? "CHANGELOG.md";
	if (!changelogPath) return undefined;

	const resolvedPath = selectPath(resolve(packageRoot, changelogPath));
	if (!existsSync(resolvedPath)) return undefined;

	const canonicalPackageRoot = canonicalizePath(packageRoot);
	const canonicalChangelogPath = canonicalizePath(resolvedPath);
	if (!isPathInside(canonicalPackageRoot, canonicalChangelogPath)) return undefined;

	try {
		return statSync(resolvedPath).isFile() ? resolvedPath : undefined;
	} catch {
		return undefined;
	}
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(normalizePath(pattern));
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalizePath(normalized));
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

function isEnabledByOverrides(
	filePath: string,
	patterns: string[],
	baseDir: string,
	aliases: Iterable<string> = [],
	historicalGlobPath?: string,
): boolean {
	const matches = (rules: string[], matcher: typeof matchesAnyPattern) => {
		if (matcher(filePath, rules, baseDir)) return true;
		for (const alias of aliases) if (matcher(alias, rules, baseDir)) return true;
		return false;
	};
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (
		excludes.length > 0 &&
		(matches(excludes, matchesAnyPattern) ||
			(historicalGlobPath && matchesAnyPattern(historicalGlobPath, excludes, baseDir)))
	) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matches(forceIncludes, matchesAnyExactPattern)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matches(forceExcludes, matchesAnyExactPattern)) {
		enabled = false;
	}
	return enabled;
}

/**
 * Apply patterns to paths and return a Set of enabled paths.
 * Pattern types:
 * - Plain patterns: include matching paths
 * - `!pattern`: exclude matching paths
 * - `+path`: force-include exact path (overrides exclusions)
 * - `-path`: force-exclude exact path (overrides force-includes)
 */
function applyPatterns(
	allPaths: string[],
	patterns: string[],
	baseDir: string,
	logicalRoot = baseDir,
	aliases?: ReadonlyMap<string, Set<string>>,
	matchRule?: (rule: string, matcher: typeof matchesAnyPattern) => boolean,
): Set<string> {
	const matches = (file: string, rules: string[], matcher: typeof matchesAnyPattern) => {
		if (matchRule) return rules.some((rule) => matchRule(rule, matcher));
		if (matchesPackagePath(file, rules, baseDir, logicalRoot, matcher)) return true;
		for (const alias of aliases?.get(file) ?? []) {
			if (matcher(alias, rules, baseDir)) return true;
		}
		return false;
	};
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	// Step 1: Apply includes (or all if no includes)
	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matches(filePath, includes, matchesAnyPattern));
	}

	// Step 2: Apply excludes
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matches(filePath, excludes, matchesAnyPattern));
	}

	// Step 3: Force-include (add back from allPaths, overriding exclusions)
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matches(filePath, forceIncludes, matchesAnyExactPattern)) {
				result.push(filePath);
			}
		}
	}

	// Step 4: Force-exclude (remove even if included or force-included)
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matches(filePath, forceExcludes, matchesAnyExactPattern));
	}

	return new Set(result);
}

export function redirectGitRevisionPath(
	path: string,
	logical: string,
	active: string,
	directOnly = false,
	onBoundary?: (prefixLength: number) => void,
): string | undefined {
	function select(candidate: string, root: string): string | undefined {
		// Windows path.relative folds case even on case-sensitive directories. Only
		// canonical filesystem spellings should make different path spellings match.
		if (candidate === root) return active;
		if (candidate.startsWith(`${root}${sep}`)) return join(active, candidate.slice(root.length + 1));
		const parent = dirname(root);
		const boundary = parent.endsWith(sep) ? parent : `${parent}${sep}`;
		if (!candidate.startsWith(boundary)) return undefined;
		const [name, ...parts] = candidate.slice(boundary.length).split(sep);
		const prefix = basename(active).slice(0, -6);
		if (name?.startsWith(prefix) && /^[a-zA-Z0-9]{6}$/.test(name.slice(prefix.length))) return join(active, ...parts);
		return undefined;
	}

	if (directOnly) return select(path, logical);

	function selectPath(candidate: string): string | undefined {
		const direct = select(candidate, logical);
		if (direct && (direct !== candidate || logical === active)) return direct;
		// A path already in the selected checkout can still be a link into a retained copy.
		const root = canonicalizePath(logical);
		let selected = select(canonicalizePath(candidate), root);
		let boundary = candidate.length;
		for (let ancestor = dirname(candidate); ; ancestor = dirname(ancestor)) {
			const canonical = canonicalizePath(ancestor);
			// An outer checkout alias takes precedence over symlinks inside the old checkout.
			const match = select(join(canonical, candidate.slice(ancestor.length)), root);
			if (match !== undefined && match !== candidate) {
				selected = match;
				boundary = ancestor.length;
			}
			if (dirname(ancestor) === ancestor) break;
		}
		if (selected === candidate) return undefined;
		if (selected && candidate === path) onBoundary?.(boundary);
		return selected;
	}

	const seen = new Set<string>();
	let candidate = path;
	// Bound even cycles that grow the remaining suffix at each hop.
	for (let hops = 0; hops < 40 && !seen.has(candidate); hops++) {
		seen.add(candidate);
		const selected = selectPath(candidate);
		if (selected || existsSync(candidate)) return selected;
		// A dangling link may be an ancestor of the requested file.
		let next: string | undefined;
		for (let component = candidate; dirname(component) !== component; component = dirname(component)) {
			try {
				const link = readlinkSync(component);
				let parent = realpathSync(dirname(component));
				let suffix = link;
				if (process.platform !== "win32" && link.split("/").includes("..")) {
					// Let the filesystem interpret parent segments after resolving any directory links.
					const parts = link.split("/");
					const lastParent = parts.lastIndexOf("..");
					const prefix = parts.slice(0, lastParent + 1).join("/");
					parent = realpathSync.native(isAbsolute(link) ? prefix : `${parent}/${prefix}`);
					suffix = parts.slice(lastParent + 1).join("/");
				}
				const target = resolve(parent, suffix);
				next = join(target, candidate.slice(component.length));
				break;
			} catch {
				// Try an earlier component when the parent or link is unavailable.
			}
		}
		if (!next) return undefined;
		candidate = next;
	}
	return undefined;
}

export function selectGitDeclarationPath(
	path: string,
	{ logical, active }: NonNullable<PathMetadata["gitRevision"]>,
): string {
	const direct = redirectGitRevisionPath(path, logical, active, true);
	if (direct !== undefined) return direct;
	// Resolve checkout-root aliases without following links to individual resources.
	const canonicalRoot = canonicalizePath(logical);
	let selected = path;
	for (let parent = dirname(path); ; parent = dirname(parent)) {
		const canonical = canonicalizePath(parent);
		const root = redirectGitRevisionPath(canonical, canonicalRoot, active, true);
		if (root === active) selected = join(active, relative(parent, path));
		else if (isPathInside(canonical, canonicalRoot)) {
			selected =
				redirectGitRevisionPath(join(canonical, relative(parent, path)), canonicalRoot, active, true) ?? selected;
		}
		if (dirname(parent) === parent) return selected;
	}
}

export function matchesPackageAliasExactRule(aliases: readonly string[], rule: string, baseDir: string): boolean {
	return aliases.some((alias) => matchesAnyExactPattern(alias, [rule], baseDir));
}

export function matchesGitPackageExactRule(
	file: string,
	rule: string,
	revision: { active: string; logical: string },
): boolean {
	return (
		isAbsolute(normalizePath(rule)) &&
		matchesPackagePath(file, [rule], revision.active, revision.logical, matchesAnyExactPattern)
	);
}

function matchesPackagePath(
	file: string,
	rules: string[],
	baseDir: string,
	logicalRoot: string,
	matcher: typeof matchesAnyPattern,
): boolean {
	if (matcher(file, rules, baseDir)) return true;
	if (logicalRoot === baseDir || !isPathInside(baseDir, file)) return false;
	const suffix = relative(baseDir, file);
	if (matcher(join(logicalRoot, suffix), rules, logicalRoot)) return true;

	// A saved absolute filter can name an earlier revision of this same package.
	const revisionPath = /^(.+)\/(\.pi-revision-[a-f0-9]{64}-[a-zA-Z0-9]{6})(?:\/|$)/;
	const [, activeParent, activeRevision] = revisionPath.exec(toPosixPath(baseDir)) ?? [];
	if (!activeParent || !activeRevision) return false;
	const revisionPrefix = activeRevision.slice(0, -6);
	const packageSuffix = relative(join(activeParent, activeRevision), baseDir);
	return rules.some((rule) => {
		const normalized = toPosixPath(normalizePath(rule));
		if (!isAbsolute(normalized)) return false;
		const [, savedParent, revision] = revisionPath.exec(normalized) ?? [];
		if (!savedParent || !revision?.startsWith(revisionPrefix)) return false;
		if (savedParent !== activeParent) {
			try {
				const saved = statSync(savedParent);
				const current = statSync(activeParent);
				if (saved.dev !== current.dev || saved.ino !== current.ino) return false;
			} catch {
				return false;
			}
		}
		const historicalRoot = join(savedParent, revision, packageSuffix);
		return matcher(join(historicalRoot, suffix), [rule], historicalRoot);
	});
}

function matchesPackageDeclaration(
	file: string,
	declaration: string | undefined,
	spellings: ReadonlySet<string> | undefined,
	patterns: string[],
	root: string,
	logicalRoot = root,
): boolean {
	return applyPatterns([file], patterns, root, logicalRoot, undefined, (rule, matcher) => {
		const matches = (path: string) => matchesPackagePath(path, [rule], root, logicalRoot, matcher);
		if (declaration !== undefined && [...(spellings ?? [])].some(matches)) return matches(declaration);
		return matches(file);
	}).has(file);
}

function chooseResourceAlias(spellings: Set<string> | undefined, matches: (alias?: Set<string>) => boolean) {
	if (!spellings?.size) return { enabled: matches() };
	for (const spelling of spellings) {
		const aliases = new Set([spelling]);
		if (matches(aliases)) return { aliases, enabled: true };
	}
	return { aliases: new Set([spellings.values().next().value!]), enabled: false };
}

function applyAutoloadDisabledPatterns(
	allPaths: string[],
	patterns: string[],
	baseDir: string,
	logicalRoot = baseDir,
	aliases?: ReadonlyMap<string, Set<string>>,
	filesBySpelling?: ReadonlyMap<string, string>,
): Map<string, { enabled: boolean; alias?: string }> {
	const states = new Map<string, Map<string | undefined, { enabled: boolean; firstRule: number }>>();
	for (const [ruleIndex, pattern] of patterns.entries()) {
		const target = pattern.slice(
			pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? 1 : 0,
		);
		const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
		const exact = pattern.startsWith("+") || pattern.startsWith("-");
		const matcher = exact ? matchesAnyExactPattern : matchesAnyPattern;
		for (const filePath of allPaths) {
			const spellings = [...(aliases?.get(filePath) ?? [])];
			let matched: (string | undefined)[] = spellings.filter((path) =>
				matchesPackagePath(path, [target], baseDir, logicalRoot, matcher),
			);
			if (!matched.length && matchesPackagePath(filePath, [target], baseDir, logicalRoot, matcher)) {
				matched = spellings.length ? spellings : [undefined];
			}
			if (!matched.length) continue;
			const declarations = states.get(filePath) ?? new Map();
			for (const alias of matched)
				declarations.set(alias, { enabled, firstRule: declarations.get(alias)?.firstRule ?? ruleIndex });
			states.set(filePath, declarations);
		}
	}
	const order = new Map([...(filesBySpelling?.keys() ?? [])].map((spelling, index) => [spelling, index]));
	const rows = [...states].map(([filePath, declarations]) => {
		const candidates = [...declarations].map(([alias, state]) => ({
			filePath,
			alias,
			...state,
			rank: order.get(alias ?? filePath) ?? Number.MAX_SAFE_INTEGER,
		}));
		candidates.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.firstRule - b.firstRule || a.rank - b.rank);
		return candidates[0]!;
	});
	rows.sort((a, b) => a.firstRule - b.firstRule || a.rank - b.rank);
	return new Map(rows.map(({ filePath, alias, enabled }) => [filePath, { alias, enabled }]));
}

class GitRevisionPointerError extends Error {}

export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private builtinExtensions: string[];
	private globalNpmRoot: string | undefined;
	private globalNpmRootCommandKey: string | undefined;
	private progressCallback: ProgressCallback | undefined;

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
		this.builtinExtensions = options.builtinExtensions ?? [];
	}

	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.progressCallback = callback;
	}

	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const normalizedSource = this.normalizePackageSourceForSettings(source, scope);
		const matchIndex = currentPackages.findIndex((existing) => this.packageSourcesMatch(existing, source, scope));
		if (matchIndex !== -1) {
			const existing = currentPackages[matchIndex];
			if (this.getPackageSourceString(existing) === normalizedSource) {
				return false;
			}
			const nextPackages = [...currentPackages];
			nextPackages[matchIndex] =
				typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
			if (scope === "project") {
				this.settingsManager.setProjectPackages(nextPackages);
			} else {
				this.settingsManager.setPackages(nextPackages);
			}
			return true;
		}
		const nextPackages = [...currentPackages, normalizedSource];
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const nextPackages = currentPackages.filter((existing) => !this.packageSourcesMatch(existing, source, scope));
		const changed = nextPackages.length !== currentPackages.length;
		if (!changed) {
			return false;
		}
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			const path = this.getNpmInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "git") {
			try {
				const path = this.getGitInstallPath(parsed, scope);
				return existsSync(path) ? path : undefined;
			} catch (error) {
				if (error instanceof GitRevisionPointerError) return undefined;
				throw error;
			}
		}
		if (parsed.type === "local") {
			const baseDir = this.getBaseDirForScope(scope);
			const path = this.resolvePathFromBase(parsed.path, baseDir);
			return existsSync(path) ? path : undefined;
		}
		return undefined;
	}

	private emitProgress(event: ProgressEvent): void {
		this.progressCallback?.(event);
	}

	private async withProgress(
		action: ProgressEvent["action"],
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void> {
		this.emitProgress({ type: "start", action, source, message });
		try {
			await operation();
			this.emitProgress({ type: "complete", action, source });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.emitProgress({ type: "error", action, source, message: errorMessage });
			throw error;
		}
	}

	async resolve(
		onMissing?: (source: string) => Promise<MissingSourceAction>,
		temporaryGit?: TemporaryGitSelection,
		bootstrapCheckouts?: ReadonlyMap<string, string>,
	): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		accumulator.gitRevisions = new Map(temporaryGit?.gitRevisions);
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();

		// Collect all packages with scope (project first so cwd resources win collisions)
		const allPackages: Array<{ pkg: PackageSource; scope: "user" | "project" }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		// Pin installed checkout paths before resolving local aliases, regardless of declaration order.
		const checkoutSnapshot = new Map<string, string>();
		for (const entry of allPackages) {
			if (entry.scope === "project" && !this.settingsManager.isProjectTrusted()) continue;
			const parsed = this.parseSource(this.getPackageSourceString(entry.pkg));
			if (parsed.type !== "git") continue;
			try {
				const logical = this.getGitStoragePath(parsed, entry.scope);
				const pinned = entry.scope === "user" ? bootstrapCheckouts?.get(logical) : undefined;
				const selected =
					pinned ?? this.readSelectedGitRevision(logical, this.getGitUpdateStatePath(logical, entry.scope));
				if (existsSync(selected)) {
					checkoutSnapshot.set(logical, selected);
					if (logical !== selected) accumulator.gitRevisions.set(logical, selected);
				}
			} catch {
				// Normal package resolution reports failures for packages that are actually loaded.
			}
		}

		// Dedupe: project scope wins over global for same package identity
		const packageSources = this.dedupePackages(allPackages);
		const installFailures = await this.resolvePackageSources(
			packageSources,
			accumulator,
			onMissing,
			checkoutSnapshot,
		);

		const globalBaseDir = this.agentDir;
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

		for (const resourceType of RESOURCE_TYPES) {
			const target = this.getTargetMap(accumulator, resourceType);
			const globalEntries = (globalSettings[resourceType] ?? []) as string[];
			const projectEntries = (projectSettings[resourceType] ?? []) as string[];
			this.resolveLocalEntries(
				projectEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "project",
					origin: "top-level",
				},
				projectBaseDir,
				accumulator.gitRevisions,
			);
			this.resolveLocalEntries(
				globalEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "user",
					origin: "top-level",
				},
				globalBaseDir,
				accumulator.gitRevisions,
			);
		}

		this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

		// Built-in extensions are enabled unless the user `extensions` setting excludes them, for example
		// with `-builtin:mcp`. A matching `+`, `-`, or `!` entry in the project setting overrides that.
		for (const name of this.builtinExtensions) {
			const path = `${BUILTIN_PATH_PREFIX}${name}`;
			const projectEnabled = applyAutoloadDisabledPatterns(
				[path],
				getOverridePatterns(projectSettings.extensions ?? []),
				projectBaseDir,
			).get(path)?.enabled;
			this.addResource(
				accumulator.extensions,
				path,
				{ source: "builtin", scope: projectEnabled === undefined ? "user" : "project", origin: "top-level" },
				projectEnabled ?? isEnabledByOverrides(path, globalSettings.extensions ?? [], globalBaseDir),
			);
		}

		return {
			...this.toResolvedPaths(accumulator),
			installFailures,
			gitRevisions: accumulator.gitRevisions,
			configuredGitCheckouts: checkoutSnapshot,
		};
	}

	async prepareTemporaryGitSources(sources: string[]): Promise<TemporaryGitSelection> {
		const accumulator = this.createAccumulator();
		const checkouts = new Map<string, string>();
		const gitSources = sources.filter((source) => this.parseSource(source).type === "git");
		const installFailures = await this.resolvePackageSources(
			gitSources.map((pkg) => ({ pkg, scope: "temporary" })),
			accumulator,
			undefined,
			undefined,
			undefined,
			{ checkouts, preparing: true },
		);
		return { checkouts, gitRevisions: accumulator.gitRevisions, installFailures };
	}

	async resolveExtensionSources(
		sources: string[],
		options?: {
			local?: boolean;
			temporary?: boolean;
			gitRevisions?: ReadonlyMap<string, string>;
			temporaryGit?: TemporaryGitSelection;
		},
	): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		accumulator.gitRevisions = new Map(options?.gitRevisions);
		const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
		// `-e builtin:<name>` loads a built-in extension; the resource loader reports unknown names.
		for (const source of sources.filter((source) => source.startsWith(BUILTIN_PATH_PREFIX))) {
			this.addResource(accumulator.extensions, source, { source: "builtin", scope, origin: "top-level" }, true);
		}
		const packageSources = sources
			.filter((source) => !source.startsWith(BUILTIN_PATH_PREFIX))
			.map((source) => ({ pkg: source as PackageSource, scope }));
		const missingLocalPaths: string[] = [];
		const installFailures = await this.resolvePackageSources(
			packageSources,
			accumulator,
			undefined,
			undefined,
			missingLocalPaths,
			options?.temporaryGit ? { checkouts: new Map(options.temporaryGit.checkouts), preparing: false } : undefined,
		);
		return {
			...this.toResolvedPaths(accumulator),
			installFailures: [...(options?.temporaryGit?.installFailures ?? []), ...installFailures],
			missingLocalPaths,
		};
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const configuredPackages: ConfiguredPackage[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "user",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "user"),
			});
		}

		for (const pkg of projectSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "project",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "project"),
			});
		}

		return configuredPackages;
	}

	async install(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		this.assertProjectTrustedForScope(scope);
		await this.withProgress("install", source, `Installing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.installNpm(parsed, scope, false);
				return;
			}
			if (parsed.type === "git") {
				await this.installGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				const resolved = this.resolvePath(parsed.path);
				if (!existsSync(resolved)) {
					throw new Error(`Path does not exist: ${resolved}`);
				}
				return;
			}
			throw new Error(`Unsupported install source: ${source}`);
		});
	}

	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, options);
	}

	async remove(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		this.assertProjectTrustedForScope(scope);
		await this.withProgress("remove", source, `Removing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.uninstallNpm(parsed, scope);
				return;
			}
			if (parsed.type === "git") {
				await this.removeGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				return;
			}
			throw new Error(`Unsupported remove source: ${source}`);
		});
	}

	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		await this.remove(source, options);
		return this.removeSourceFromSettings(source, options);
	}

	async update(source?: string): Promise<void> {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const identity = source ? this.getPackageIdentity(source) : undefined;
		let matched = false;
		const updateSources: ConfiguredUpdateSource[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "user") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "user" });
		}
		for (const pkg of projectSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "project") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "project" });
		}

		if (source && !matched) {
			throw new Error(
				this.buildNoMatchingPackageMessage(source, [
					...(globalSettings.packages ?? []),
					...(projectSettings.packages ?? []),
				]),
			);
		}

		await this.updateConfiguredSources(updateSources);
	}

	private async updateConfiguredSources(sources: ConfiguredUpdateSource[]): Promise<void> {
		if (isOfflineModeEnabled() || sources.length === 0) {
			return;
		}

		const npmCandidates: NpmUpdateTarget[] = [];
		const gitCandidates: GitUpdateTarget[] = [];

		for (const entry of sources) {
			const parsed = this.parseSource(entry.source);
			// Pinned npm versions are fixed. Pinned git refs are configured checkout targets,
			// so include them to reconcile an existing clone when the configured ref changes.
			if (parsed.type === "npm") {
				if (!parsed.pinned) {
					npmCandidates.push({ ...entry, parsed });
				}
			} else if (parsed.type === "git") {
				gitCandidates.push({ ...entry, parsed });
			}
		}

		const npmCheckTasks = npmCandidates.map((entry) => async () => {
			const check = await this.shouldUpdateNpmSource(entry.parsed, entry.scope);
			return {
				entry: { ...entry, installedVersion: check.installedVersion, targetVersion: check.targetVersion },
				shouldUpdate: check.shouldUpdate,
			};
		});
		const npmCheckResults = await this.runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
		const userNpmUpdates: NpmUpdateTarget[] = [];
		const projectNpmUpdates: NpmUpdateTarget[] = [];
		const npmUpdates = npmCheckResults.filter((result) => result.shouldUpdate);
		for (const result of npmUpdates) {
			if (result.entry.scope === "user") {
				userNpmUpdates.push(result.entry);
			} else {
				projectNpmUpdates.push(result.entry);
			}
		}

		const tasks: Promise<void>[] = [];
		if (userNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(userNpmUpdates, "user"));
		}
		if (projectNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(projectNpmUpdates, "project"));
		}
		const gitUpdates: UpdatedPackage[] = [];
		if (gitCandidates.length > 0) {
			const gitTasks = gitCandidates.map(
				(entry) => async () =>
					this.withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
						const targetDir = this.getGitInstallPath(entry.parsed, entry.scope);
						const from = await this.getGitHead(targetDir);
						await this.updateGit(entry.parsed, entry.scope);
						const to = await this.getGitHead(this.getGitInstallPath(entry.parsed, entry.scope));
						if (from !== to) {
							gitUpdates.push({ source: entry.source, type: "git", scope: entry.scope, from, to });
						}
					}),
			);
			tasks.push(this.runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
		}

		await Promise.all(tasks);

		const updated: UpdatedPackage[] = [];
		for (const { entry } of npmUpdates) {
			const installedPath = this.getManagedNpmInstallPath(entry.parsed, entry.scope);
			const to = existsSync(installedPath) ? this.getInstalledNpmVersion(installedPath) : undefined;
			if (to !== entry.installedVersion) {
				updated.push({ source: entry.source, type: "npm", scope: entry.scope, from: entry.installedVersion, to });
			}
		}
		// Keep git results in configured order, independent of completion order.
		for (const entry of gitCandidates) {
			const update = gitUpdates.find((u) => u.source === entry.source && u.scope === entry.scope);
			if (update) updated.push(update);
		}

		// Report each changed package, e.g. "npm:foo 1.2.0 -> 1.3.0".
		for (const pkg of updated) {
			const format = (value: string | undefined) =>
				value === undefined ? "(none)" : pkg.type === "git" ? value.slice(0, 7) : value;
			const scope = pkg.scope === "project" ? " (project)" : "";
			this.emitProgress({
				type: "result",
				action: "update",
				source: pkg.source,
				message: `${pkg.source}${scope} ${format(pkg.from)} -> ${format(pkg.to)}`,
			});
		}
	}

	private async getGitHead(targetDir: string): Promise<string | undefined> {
		if (!existsSync(targetDir)) return undefined;
		try {
			const head = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
				cwd: targetDir,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			return head.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private async shouldUpdateNpmSource(
		source: NpmSource,
		scope: InstalledSourceScope,
	): Promise<{ shouldUpdate: boolean; installedVersion?: string; targetVersion?: string }> {
		const installedPath = this.getManagedNpmInstallPath(source, scope);
		const installedVersion = existsSync(installedPath) ? this.getInstalledNpmVersion(installedPath) : undefined;
		if (!installedVersion) {
			return { shouldUpdate: true };
		}

		try {
			const targetVersion = await this.getLatestNpmVersion(source.version ? source.spec : source.name, source.range);
			return { shouldUpdate: gt(targetVersion, installedVersion), installedVersion, targetVersion };
		} catch {
			// Preserve existing update behavior when version lookup fails.
			return { shouldUpdate: true, installedVersion };
		}
	}

	private async updateNpmBatch(sources: NpmUpdateTarget[], scope: InstalledSourceScope): Promise<void> {
		if (sources.length === 0) {
			return;
		}

		const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
		const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
		const specs = sources.map((entry) => (entry.parsed.version ? entry.parsed.spec : `${entry.parsed.name}@latest`));

		await this.withProgress("update", sourceLabel, message, async () => {
			await this.installNpmBatch(specs, scope);
		});

		this.reportUnchangedNpmUpdates(sources, scope);
	}

	/**
	 * npm can resolve stale registry metadata shortly after a publish and install the old
	 * version without an error. Warn when an announced update did not change the installed version.
	 */
	private reportUnchangedNpmUpdates(sources: NpmUpdateTarget[], scope: InstalledSourceScope): void {
		for (const entry of sources) {
			if (!entry.installedVersion || !entry.targetVersion) {
				continue;
			}
			const installedPath = this.getManagedNpmInstallPath(entry.parsed, scope);
			const versionAfter = this.getInstalledNpmVersion(installedPath);
			if (versionAfter !== entry.installedVersion) {
				continue;
			}
			this.emitProgress({
				type: "progress",
				action: "update",
				source: entry.source,
				message: `${entry.source} is still ${versionAfter} (registry reports ${entry.targetVersion}); npm registry metadata may be stale, try again in a few minutes`,
			});
		}
	}

	private async installNpmBatch(specs: string[], scope: InstalledSourceScope): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, false);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs(specs, installRoot));
	}

	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		if (isOfflineModeEnabled()) {
			return [];
		}

		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		const packageSources = this.dedupePackages(allPackages);
		const checks = packageSources
			.filter(
				(entry): entry is { pkg: PackageSource; scope: Exclude<SourceScope, "temporary"> } =>
					entry.scope !== "temporary",
			)
			.map((entry) => async (): Promise<PackageUpdate | undefined> => {
				const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
				const parsed = this.parseSource(source);
				if (parsed.type === "local" || parsed.pinned) {
					return undefined;
				}

				if (parsed.type === "npm") {
					const installedPath = this.getNpmInstallPath(parsed, entry.scope);
					if (!existsSync(installedPath)) {
						return undefined;
					}
					const hasUpdate = await this.npmHasAvailableUpdate(parsed, installedPath);
					if (!hasUpdate) {
						return undefined;
					}
					return {
						source,
						displayName: parsed.name,
						type: "npm",
						scope: entry.scope,
					};
				}

				const installedPath = this.getInstalledPath(source, entry.scope);
				if (!installedPath) return undefined;
				const hasUpdate = await this.gitHasAvailableUpdate(installedPath);
				if (!hasUpdate) {
					return undefined;
				}
				return {
					source,
					displayName: `${parsed.host}/${parsed.path}`,
					type: "git",
					scope: entry.scope,
				};
			});

		const results = await this.runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
		return results.filter((result): result is PackageUpdate => result !== undefined);
	}

	private async resolvePackageSources(
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
		accumulator: ResourceAccumulator,
		onMissing?: (source: string) => Promise<MissingSourceAction>,
		checkoutSnapshot?: Map<string, string>,
		missingLocalPaths?: string[],
		temporarySelection?: { checkouts: Map<string, string>; preparing: boolean },
	): Promise<PackageInstallFailure[]> {
		const installFailures: PackageInstallFailure[] = [];
		const temporaryCollections: Array<() => void> = [];
		const temporaryCheckouts = temporarySelection?.checkouts ?? new Map<string, string>();
		// Finish temporary Git selection before collecting resources, but retain CLI precedence.
		const collect = (scope: SourceScope, resources: () => void) => {
			if (scope === "temporary") {
				if (!temporarySelection?.preparing) temporaryCollections.push(resources);
			} else resources();
		};
		for (const { pkg, scope } of sources) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			const filter = typeof pkg === "object" ? pkg : undefined;
			const deltaBase = this.findAutoloadDeltaBase(pkg, scope, sources);
			const resolvedSource = deltaBase?.source ?? sourceStr;
			const resolvedScope = deltaBase?.scope ?? scope;
			const parsed = this.parseSource(resolvedSource);
			const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

			if (parsed.type === "local") {
				const baseDir = this.getBaseDirForScope(resolvedScope);
				collect(resolvedScope, () =>
					this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir, missingLocalPaths),
				);
				continue;
			}

			const installMissing = async (): Promise<boolean> => {
				if (isOfflineModeEnabled()) return false;
				if (onMissing) {
					const action = await onMissing(resolvedSource);
					if (action === "skip") return false;
					if (action === "error") throw new Error(`Missing source: ${resolvedSource}`);
				}
				// A source that cannot be installed (no network, missing package, failing git prepare step)
				// must not abort startup. Skip its resources, like offline mode does, and report the failure.
				try {
					await this.installParsedSource(parsed, resolvedScope);
					return true;
				} catch (error) {
					installFailures.push({
						source: resolvedSource,
						scope: resolvedScope,
						message: error instanceof Error ? error.message : String(error),
					});
					return false;
				}
			};

			if (parsed.type === "npm") {
				let installedPath = this.getNpmInstallPath(parsed, resolvedScope);
				const needsInstall =
					!existsSync(installedPath) || !(await this.installedNpmMatchesConfiguredVersion(parsed, installedPath));
				if (
					!needsInstall &&
					resolvedScope === "temporary" &&
					!parsed.pinned &&
					(await this.npmHasAvailableUpdate(parsed, installedPath))
				) {
					// Temporary (-e) sources have no `pi update` path, so refresh unpinned ones on load like
					// temporary git sources. Like `pi update`, install `name@latest` for unversioned specs because a bare
					// `npm install name` keeps the range already saved in the temporary package.json.
					const spec = parsed.version ? parsed.spec : `${parsed.name}@latest`;
					try {
						await this.installNpm({ ...parsed, spec }, resolvedScope, true);
					} catch {
						// Keep the cached install if the refresh fails.
					}
				}
				if (needsInstall) {
					const installed = await installMissing();
					if (!installed) continue;
					installedPath = this.getNpmInstallPath(parsed, resolvedScope);
				}
				metadata.baseDir = installedPath;
				metadata.packageRoot = installedPath;
				collect(resolvedScope, () => this.collectPackageResources(installedPath, accumulator, filter, metadata));
				continue;
			}

			if (parsed.type === "git") {
				let installedPath: string;
				let present: boolean;
				try {
					const logical = this.getGitStoragePath(parsed, resolvedScope);
					const pinned = (resolvedScope === "temporary" ? temporaryCheckouts : checkoutSnapshot)?.get(logical);
					if (pinned !== undefined) {
						metadata.baseDir = pinned;
						metadata.packageRoot = pinned;
						collect(resolvedScope, () =>
							this.collectPackageResources(pinned, accumulator, filter, metadata, logical),
						);
						continue;
					}
					if (resolvedScope === "temporary" && temporarySelection?.preparing === false) continue;
					const recovered = await this.recoverGitCheckout(logical, resolvedScope);
					present = recovered !== undefined;
					installedPath = recovered ?? "";
				} catch (error) {
					installFailures.push({ source: resolvedSource, scope: resolvedScope, message: String(error) });
					continue;
				}
				if (!present) {
					const installed = await installMissing();
					if (!installed) continue;
				} else if (resolvedScope === "temporary" && !isOfflineModeEnabled()) {
					await this.refreshTemporaryGitSource(parsed, resolvedSource, installedPath);
				}
				try {
					installedPath = this.getGitInstallPath(parsed, resolvedScope);
				} catch (error) {
					installFailures.push({ source: resolvedSource, scope: resolvedScope, message: String(error) });
					continue;
				}
				metadata.baseDir = installedPath;
				metadata.packageRoot = installedPath;
				const logicalPath = this.getGitStoragePath(parsed, resolvedScope);
				if (logicalPath !== installedPath) accumulator.gitRevisions.set(logicalPath, installedPath);
				if (resolvedScope === "temporary") temporaryCheckouts.set(logicalPath, installedPath);
				else checkoutSnapshot?.set(logicalPath, installedPath);
				collect(resolvedScope, () =>
					this.collectPackageResources(installedPath, accumulator, filter, metadata, logicalPath),
				);
			}
		}
		for (const resources of temporaryCollections) resources();
		return installFailures;
	}

	private findAutoloadDeltaBase(
		pkg: PackageSource,
		scope: SourceScope,
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): { source: string; scope: SourceScope } | undefined {
		if (scope !== "project" || typeof pkg !== "object" || pkg.autoload !== false) return undefined;
		const identity = this.getPackageIdentity(pkg.source, scope);
		const userEntry = sources.find(
			(entry) =>
				entry.scope === "user" &&
				this.getPackageIdentity(this.getPackageSourceString(entry.pkg), "user") === identity,
		);
		return userEntry ? { source: this.getPackageSourceString(userEntry.pkg), scope: "user" } : undefined;
	}

	private resolveLocalExtensionSource(
		source: LocalSource,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
		baseDir: string,
		missingLocalPaths?: string[],
	): void {
		const original = this.resolvePathFromBase(source.path, baseDir);
		const resolved = this.redirectGitResource(original, accumulator.gitRevisions);
		if (!existsSync(resolved)) {
			missingLocalPaths?.push(original);
			return;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isFile()) {
				metadata.baseDir = dirname(resolved);
				this.addResource(accumulator.extensions, resolved, metadata, true);
				return;
			}
			if (stats.isDirectory()) {
				metadata.baseDir = resolved;
				metadata.packageRoot = resolved;
				const resources = this.collectPackageResources(resolved, accumulator, filter, metadata, original);
				if (!resources) {
					this.addResource(accumulator.extensions, resolved, metadata, true);
				}
			}
		} catch {
			return;
		}
	}

	private async installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void> {
		if (parsed.type === "npm") {
			await this.installNpm(parsed, scope, scope === "temporary");
			return;
		}
		if (parsed.type === "git") {
			await this.installGit(parsed, scope);
			return;
		}
	}

	private getPackageSourceString(pkg: PackageSource): string {
		return typeof pkg === "string" ? pkg : pkg.source;
	}

	private getSourceMatchKeyForInput(source: string): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		return `local:${getPathComparisonKey(this.resolvePath(parsed.path))}`;
	}

	private getSourceMatchKeyForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		const baseDir = this.getBaseDirForScope(scope);
		return `local:${getPathComparisonKey(this.resolvePathFromBase(parsed.path, baseDir))}`;
	}

	private buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
		const suggestion = this.findSuggestedConfiguredSource(source, configuredPackages);
		if (!suggestion) {
			return `No matching package found for ${source}`;
		}
		return `No matching package found for ${source}. Did you mean ${suggestion}?`;
	}

	private findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
		const trimmedSource = source.trim();
		const suggestions = new Set<string>();

		for (const pkg of configuredPackages) {
			const sourceStr = this.getPackageSourceString(pkg);
			const parsed = this.parseSource(sourceStr);
			if (parsed.type === "npm") {
				if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
					suggestions.add(sourceStr);
				}
				continue;
			}
			if (parsed.type === "git") {
				const shorthand = `${parsed.host}/${parsed.path}`;
				const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
				if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
					suggestions.add(sourceStr);
				}
			}
		}

		return suggestions.values().next().value;
	}

	private packageSourcesMatch(existing: PackageSource, inputSource: string, scope: SourceScope): boolean {
		const left = this.getSourceMatchKeyForSettings(this.getPackageSourceString(existing), scope);
		const right = this.getSourceMatchKeyForInput(inputSource);
		return left === right;
	}

	private normalizePackageSourceForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type !== "local") {
			return source;
		}
		const baseDir = this.getBaseDirForScope(scope);
		const resolved = this.resolvePath(parsed.path);
		const rel = relative(baseDir, resolved);
		return rel || ".";
	}

	private parseSource(source: string): ParsedSource {
		if (source.startsWith("npm:")) {
			const spec = source.slice("npm:".length).trim();
			const { name, version } = this.parseNpmSpec(spec);
			return {
				type: "npm",
				spec,
				name,
				version,
				range: getNpmVersionRange(version),
				pinned: isExactNpmVersion(version),
			};
		}

		if (isLocalPath(source)) {
			return { type: "local", path: source };
		}

		// Try parsing as git URL
		const gitParsed = parseGitUrl(source);
		if (gitParsed) {
			return gitParsed;
		}

		return { type: "local", path: source };
	}

	private async installedNpmMatchesConfiguredVersion(source: NpmSource, installedPath: string): Promise<boolean> {
		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}
		return source.range ? satisfies(installedVersion, source.range) : true;
	}

	private async npmHasAvailableUpdate(source: NpmSource, installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}

		try {
			const targetVersion = await this.getLatestNpmVersion(source.version ? source.spec : source.name, source.range);
			return gt(targetVersion, installedVersion);
		} catch {
			return false;
		}
	}

	private getInstalledNpmVersion(installedPath: string): string | undefined {
		const packageJsonPath = join(installedPath, "package.json");
		if (!existsSync(packageJsonPath)) return undefined;
		try {
			const content = readFileSync(packageJsonPath, "utf-8");
			const pkg = JSON.parse(stripBom(content)) as { version?: string };
			return pkg.version;
		} catch {
			return undefined;
		}
	}

	private async getLatestNpmVersion(packageSpec: string, range?: string): Promise<string> {
		const npmCommand = this.getNpmCommand();
		const stdout = await this.runCommandCapture(
			npmCommand.command,
			[...npmCommand.args, "view", packageSpec, "version", "--json"],
			{ cwd: this.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
		);
		const raw = stdout.trim();
		if (!raw) throw new Error("Empty response from npm view");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed === "string") {
			return parsed;
		}
		if (Array.isArray(parsed)) {
			const versions = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
			const latest = range ? maxSatisfying(versions, range) : [...versions].sort(rcompare)[0];
			if (latest) return latest;
		}
		throw new Error("Unexpected response from npm view");
	}

	private async gitHasAvailableUpdate(installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		try {
			const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const remoteHead = await this.getRemoteGitHead(installedPath);
			return localHead.trim() !== remoteHead.trim();
		} catch {
			return false;
		}
	}

	private async getRemoteGitHead(installedPath: string): Promise<string> {
		const upstreamRef = await this.getGitUpstreamRef(installedPath);
		if (upstreamRef) {
			const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", upstreamRef]);
			const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
			if (match?.[1]) {
				return match[1];
			}
		}

		const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", "HEAD"]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
		if (!match?.[1]) {
			throw new Error("Failed to determine remote HEAD");
		}
		return match[1];
	}

	private async getLocalGitUpdateTarget(
		installedPath: string,
	): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmedUpstream = upstream.trim();
			if (!trimmedUpstream.startsWith("origin/")) {
				throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
			}
			const branch = trimmedUpstream.slice("origin/".length);
			if (!branch) {
				throw new Error("Missing upstream branch name");
			}
			const head = await this.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			return {
				ref: "@{upstream}",
				head,
				fetchArgs: [
					"fetch",
					"--prune",
					"--no-tags",
					"origin",
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
		} catch {
			await this.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath }).catch(() => {});
			const head = await this.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const originHeadRef = await this.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			}).catch(() => "");
			const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
			if (branch) {
				return {
					ref: "origin/HEAD",
					head,
					fetchArgs: [
						"fetch",
						"--prune",
						"--no-tags",
						"origin",
						`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
					],
				};
			}
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
			};
		}
	}

	private async getGitUpstreamRef(installedPath: string): Promise<string | undefined> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmed = upstream.trim();
			if (!trimmed.startsWith("origin/")) {
				return undefined;
			}
			const branch = trimmed.slice("origin/".length);
			return branch ? `refs/heads/${branch}` : undefined;
		} catch {
			return undefined;
		}
	}

	private runGitRemoteCommand(installedPath: string, args: string[]): Promise<string> {
		return this.runCommandCapture("git", args, {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
			env: {
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	}

	private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
		if (tasks.length === 0) {
			return [];
		}

		const results: T[] = new Array(tasks.length);
		let nextIndex = 0;
		const workerCount = Math.max(1, Math.min(limit, tasks.length));

		const worker = async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= tasks.length) {
					return;
				}
				results[index] = await tasks[index]();
			}
		};

		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	/**
	 * Get a unique identity for a package, ignoring version/ref.
	 * Used to detect when the same package is in both global and project settings.
	 * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
	 * for the same repository are treated as identical.
	 */
	private getPackageIdentity(source: string, scope?: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			// Use host/path for identity to normalize SSH and HTTPS
			return `git:${parsed.host}/${parsed.path}`;
		}
		if (scope) {
			const baseDir = this.getBaseDirForScope(scope);
			return `local:${getPathComparisonKey(this.resolvePathFromBase(parsed.path, baseDir))}`;
		}
		return `local:${getPathComparisonKey(this.resolvePath(parsed.path))}`;
	}

	/**
	 * Dedupe packages: if same package identity appears in both global and project,
	 * keep only the project one (project wins). A project entry with autoload=false
	 * is a delta over the global entry, so both are kept (delta first).
	 */
	private dedupePackages(
		packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): Array<{ pkg: PackageSource; scope: SourceScope }> {
		const result: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		const seen = new Map<string, number>();
		for (const entry of packages) {
			const identity = this.getPackageIdentity(this.getPackageSourceString(entry.pkg), entry.scope);
			const index = seen.get(identity);
			if (index === undefined) {
				seen.set(identity, result.length);
				result.push(entry);
				continue;
			}
			const existing = result[index];
			if (existing?.scope === "project" && entry.scope === "user") {
				if (typeof existing.pkg === "object" && existing.pkg.autoload === false) result.push(entry);
			} else if (entry.scope === "project") {
				result[index] = entry;
			}
		}
		return result;
	}

	private parseNpmSpec(spec: string): { name: string; version?: string } {
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		if (!match) {
			return { name: spec };
		}
		const name = match[1] ?? spec;
		const version = match[2];
		return { name, version };
	}

	private assertProjectTrustedForScope(scope: SourceScope): void {
		if (scope === "project" && !this.settingsManager.isProjectTrusted()) {
			throw new Error("Project is not trusted; refusing to access project package storage");
		}
	}

	private getNpmCommand(): { command: string; args: string[] } {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (!configuredCommand || configuredCommand.length === 0) {
			return { command: "npm", args: [] };
		}
		const [command, ...args] = configuredCommand;
		if (!command) {
			throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		}
		return { command, args };
	}

	private getPackageManagerName(): string {
		const npmCommand = this.getNpmCommand();
		const normalizeCommandName = (command: string): string => basename(command).replace(/\.(cmd|exe)$/i, "");
		const supportedPackageManagers = new Set(["npm", "pnpm", "bun"]);
		const directCommand = normalizeCommandName(npmCommand.command);
		const separatorIndex = npmCommand.args.lastIndexOf("--");
		if (separatorIndex >= 0) {
			const wrappedCommand = npmCommand.args[separatorIndex + 1];
			return wrappedCommand ? normalizeCommandName(wrappedCommand) : directCommand;
		}
		if (supportedPackageManagers.has(directCommand)) return directCommand;

		const wrappedPackageManagers = [
			...new Set(
				npmCommand.args.map(normalizeCommandName).filter((command) => supportedPackageManagers.has(command)),
			),
		];
		if (wrappedPackageManagers.length > 1) {
			throw new Error(`Ambiguous npmCommand package managers: ${wrappedPackageManagers.join(", ")}`);
		}
		return wrappedPackageManagers[0] ?? directCommand;
	}

	private async runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void> {
		const npmCommand = this.getNpmCommand();
		await this.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
	}

	private getGitDependencyInstallArgs(): string[] {
		switch (this.getPackageManagerName()) {
			case "bun":
				return ["install", "--omit=dev", "--omit=peer"];
			case "pnpm":
				return [
					"install",
					"--prod",
					"--config.auto-install-peers=false",
					"--config.strict-peer-dependencies=false",
					"--config.strict-dep-builds=false",
				];
			case "npm":
				return ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"];
			default:
				return ["install"];
		}
	}

	private runNpmCommandSync(args: string[]): string {
		const npmCommand = this.getNpmCommand();
		return this.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
	}

	private getNpmInstallArgs(specs: string[], root: string): string[] {
		// npm writes broken nested package-lock.json paths when --prefix goes through a symlink.
		const installRoot = existsSync(root) ? realpathSync(root) : root;
		const packageManagerName = this.getPackageManagerName();
		// Extension packages run inside pi and resolve pi APIs through loader aliases/virtual modules.
		// Disable peer dependency resolution for managed installs (npm's --legacy-peer-deps, and
		// equivalent bun/pnpm settings) so package managers do not install or solve host-provided
		// @earendil-works/pi-* peers. Stale auto-installed pi peers can otherwise block updates.
		if (packageManagerName === "bun") {
			return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
		}
		if (packageManagerName === "pnpm") {
			return [
				"install",
				...specs,
				"--prefix",
				installRoot,
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		}
		// npm audit fix would run without --legacy-peer-deps and install pi peers, so skip audit advice.
		return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps", "--no-audit", "--no-fund"];
	}

	private async installNpm(source: NpmSource, scope: SourceScope, temporary: boolean): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, temporary);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs([source.spec], installRoot));
	}

	private async uninstallNpm(source: NpmSource, scope: SourceScope): Promise<void> {
		const root = this.getNpmInstallRoot(scope, false);
		if (!existsSync(root)) {
			return;
		}
		// npm writes broken nested package-lock.json paths when --prefix goes through a symlink.
		const installRoot = realpathSync(root);
		const packageManagerName = this.getPackageManagerName();
		if (packageManagerName === "bun") {
			await this.runNpmCommand(["uninstall", source.name, "--cwd", installRoot]);
			return;
		}
		const args = ["uninstall", source.name, "--prefix", installRoot];
		if (packageManagerName !== "pnpm") {
			args.push("--legacy-peer-deps", "--no-audit", "--no-fund");
		}
		await this.runNpmCommand(args);
	}

	private async installGit(source: GitSource, scope: SourceScope): Promise<void> {
		const logicalDir = this.getGitStoragePath(source, scope);
		const recovered = await this.recoverGitCheckout(logicalDir, scope);
		const targetDir = recovered ?? logicalDir;
		if (recovered) {
			if (source.ref) {
				await this.ensureGitRef(logicalDir, targetDir, scope, ["fetch", "origin", source.ref], "FETCH_HEAD");
				return;
			}
			const target = await this.getLocalGitUpdateTarget(targetDir);
			await this.ensureGitRef(logicalDir, targetDir, scope, target.fetchArgs, target.ref);
			return;
		}
		const gitRoot = this.getGitInstallRoot(scope);
		if (gitRoot) {
			this.ensureGitIgnore(gitRoot);
		}
		mkdirSync(dirname(targetDir), { recursive: true });
		const markerPath = this.getGitUpdateMarkerPath(targetDir);
		if (statSync(markerPath, { throwIfNoEntry: false })?.isFile()) rmSync(markerPath, { force: true });

		try {
			await this.runCommand("git", ["clone", source.repo, targetDir]);
			if (source.ref) {
				await this.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
			}
			const packageJsonPath = join(targetDir, "package.json");
			if (existsSync(packageJsonPath)) {
				await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
			}
		} catch (error) {
			rmSync(targetDir, { recursive: true, force: true });
			this.pruneEmptyGitParents(targetDir, gitRoot);
			throw error;
		}
	}

	private async updateGit(source: GitSource, scope: SourceScope): Promise<void> {
		const logicalDir = this.getGitStoragePath(source, scope);
		const targetDir = await this.recoverGitCheckout(logicalDir, scope);
		if (!targetDir) {
			await this.installGit(source, scope);
			return;
		}

		if (source.ref) {
			await this.ensureGitRef(logicalDir, targetDir, scope, ["fetch", "origin", source.ref], "FETCH_HEAD");
			return;
		}

		const target = await this.getLocalGitUpdateTarget(targetDir);
		await this.ensureGitRef(logicalDir, targetDir, scope, target.fetchArgs, target.ref);
	}

	private hasMissingGitDependencies(targetDir: string): boolean {
		const packageJsonPath = join(targetDir, "package.json");
		if (!existsSync(packageJsonPath)) return false;

		try {
			const manifest = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as { dependencies?: unknown };
			if (
				!manifest.dependencies ||
				typeof manifest.dependencies !== "object" ||
				Array.isArray(manifest.dependencies)
			) {
				return false;
			}

			const nodeModulesDir = resolve(targetDir, "node_modules");
			return Object.keys(manifest.dependencies).some((name) => {
				const dependencyPath = resolve(nodeModulesDir, name);
				if (!dependencyPath.startsWith(`${nodeModulesDir}${sep}`)) return false;
				return !existsSync(dependencyPath);
			});
		} catch {
			return false;
		}
	}

	private getGitUpdateMarkerPath(targetDir: string): string {
		return join(dirname(targetDir), `.${basename(targetDir)}.pi-update-incomplete`);
	}

	private getGitUpdateStatePath(targetDir: string, scope: SourceScope): string {
		const packageRoot = this.getGitInstallRoot(scope) ?? getExtensionTempFolder(this.agentDir);
		const stateRoot = join(packageRoot, ".git-update-state");
		let identity = relative(packageRoot, targetDir);
		if (process.platform === "darwin" || process.platform === "win32") {
			// Use the stored spelling only when the volume actually resolves the alias.
			let parent = packageRoot;
			identity = identity
				.split(sep)
				.map((part) => {
					let name = part;
					if (existsSync(join(parent, part))) {
						const entries = readdirSync(parent);
						if (!entries.includes(part)) {
							const requested = statSync(join(parent, part));
							name =
								entries.find((entry) => {
									if (entry.toLowerCase() !== part.toLowerCase()) return false;
									const existing = statSync(join(parent, entry), { throwIfNoEntry: false });
									return existing?.dev === requested.dev && existing.ino === requested.ino;
								}) ?? part;
						}
					}
					parent = join(parent, name);
					return name;
				})
				.join(sep);
		}
		return join(stateRoot, createHash("sha256").update(identity).digest("hex"));
	}

	private lockGitCheckout(state: string): () => void {
		this.ensureGitIgnore(dirname(state));
		return lockfile.lockSync(state, { realpath: false, lockfilePath: `${state}.lock` });
	}

	private assertSameGitCheckout(targetDir: string, installed: { dev: number; ino: number }): void {
		const current = statSync(targetDir, { throwIfNoEntry: false });
		if (current?.dev !== installed.dev || current.ino !== installed.ino) {
			throw new Error(`Git package ${targetDir} changed during update; retry the update.`);
		}
	}

	private async ensureGitRef(
		logicalDir: string,
		targetDir: string,
		scope: SourceScope,
		fetchArgs: string[],
		ref: string,
	): Promise<void> {
		const installed = statSync(targetDir);
		const state = this.getGitUpdateStatePath(logicalDir, scope);
		const releaseFetch = this.lockGitCheckout(state);
		let localHead: string;
		let targetHead: string;
		try {
			this.assertSameGitCheckout(targetDir, installed);
			if (this.readSelectedGitRevision(logicalDir, state) !== targetDir) {
				throw new Error(`Git package ${logicalDir} changed during update; retry the update.`);
			}
			// Pin the fetched commit before another operation can overwrite FETCH_HEAD.
			const options = { cwd: targetDir, timeoutMs: NETWORK_TIMEOUT_MS };
			await this.runCommand("git", fetchArgs, { cwd: targetDir });
			localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], options);
			targetHead = await this.runCommandCapture("git", ["rev-parse", `${ref}^{commit}`], options);
		} finally {
			releaseFetch();
		}
		const markerPath = this.getGitUpdateMarkerPath(targetDir);
		const interruptedLegacyUpdate = statSync(markerPath, { throwIfNoEntry: false })?.isFile();
		const previous = `${state}.previous`;
		if (localHead.trim() === targetHead.trim() && !interruptedLegacyUpdate) {
			if (existsSync(previous) || this.hasMissingGitDependencies(targetDir)) {
				const release = this.lockGitCheckout(state);
				try {
					this.assertSameGitCheckout(targetDir, installed);
					if (this.readSelectedGitRevision(logicalDir, state) !== targetDir) {
						throw new Error(`Git package ${logicalDir} changed during update; retry the update.`);
					}
					await this.removeGitUpdateFiles(previous);
					if (this.hasMissingGitDependencies(targetDir)) {
						await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
					}
				} finally {
					release();
				}
			}
			return;
		}

		const gitDir = join(targetDir, ".git");
		if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory() || existsSync(join(gitDir, "commondir"))) {
			throw new Error(`Cannot stage Git package ${targetDir}: its metadata must be in a standalone .git directory.`);
		}

		this.ensureGitIgnore(dirname(state));
		// Relative file: dependencies must resolve from the same parent as the installed checkout.
		const staged = mkdtempSync(join(dirname(logicalDir), `.pi-revision-${basename(state)}-`));
		let published = false;
		try {
			const releaseSnapshot = this.lockGitCheckout(state);
			try {
				this.assertSameGitCheckout(targetDir, installed);
				if (this.readSelectedGitRevision(logicalDir, state) !== targetDir) {
					throw new Error(`Git package ${logicalDir} changed during update; retry the update.`);
				}
				// Snapshot refs under the fetch lock without blocking its heartbeat.
				await cp(gitDir, join(staged, ".git"), {
					recursive: true,
					filter: (path) => {
						if (lstatSync(path).isSymbolicLink()) {
							throw new Error(
								`Cannot stage Git package ${targetDir}: symbolic link in Git metadata at ${path}.`,
							);
						}
						return !basename(path).endsWith(".lock");
					},
				});
			} finally {
				releaseSnapshot();
			}
			const config = join(staged, ".git", "config");

			const worktreeConfig = join(staged, ".git", "config.worktree");

			if (existsSync(worktreeConfig)) {
				await this.runCommand("git", ["config", "--file", worktreeConfig, "core.worktree", ".."], {
					cwd: staged,
				});
			}
			if (existsSync(config)) {
				await this.runCommand("git", ["--git-dir=.git", "config", "--local", "core.worktree", ".."], {
					cwd: staged,
				});
			}
			await this.runCommand("git", ["--git-dir=.git", "--work-tree=.", "reset", "--hard", targetHead.trim()], {
				cwd: staged,
			});
			if (existsSync(join(staged, "package.json"))) {
				await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: staged });
			}
			const release = this.lockGitCheckout(state);
			try {
				this.assertSameGitCheckout(targetDir, installed);
				if (this.readSelectedGitRevision(logicalDir, state) !== targetDir) {
					throw new Error(`Git package ${logicalDir} changed during update; retry the update.`);
				}
				if (!existsSync(staged)) throw new Error(`Git package ${logicalDir}: prepared revision disappeared.`);
				const pending = `${state}.pending`;
				writeFileSync(pending, basename(staged), "utf8");
				renameSync(pending, `${state}.current`);
				published = true;
				if (interruptedLegacyUpdate) await this.removeGitUpdateFiles(markerPath, { recursive: false });
			} finally {
				release();
			}
		} finally {
			if (!published) await this.removeGitUpdateFiles(staged);
		}
	}

	private async recoverGitCheckout(logicalDir: string, scope: SourceScope): Promise<string | undefined> {
		const state = this.getGitUpdateStatePath(logicalDir, scope);
		const selected = this.readSelectedGitRevision(logicalDir, state);
		if (existsSync(selected)) return selected;
		const previous = `${state}.previous`;
		const lockfilePath = `${state}.lock`;
		if (!existsSync(previous) && !existsSync(lockfilePath) && selected === logicalDir) {
			return existsSync(logicalDir) ? logicalDir : undefined;
		}
		this.ensureGitIgnore(dirname(state));
		// Allow an abandoned lock to reach proper-lockfile's default 10-second stale interval.
		const release = await lockfile
			.lock(state, {
				realpath: false,
				lockfilePath,
				retries: { retries: 105, factor: 1, minTimeout: 100 },
			})
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ELOCKED") throw error;
				throw new Error(`Git package ${logicalDir} is still locked. Retry after the other Pi operation finishes.`, {
					cause: error,
				});
			});
		try {
			const current = this.readSelectedGitRevision(logicalDir, state);
			if (current === logicalDir) this.restoreGitBackup(logicalDir, previous);
			if (existsSync(current)) return current;
			if (current !== logicalDir) throw new GitRevisionPointerError(`Selected Git checkout is missing: ${current}`);
			return undefined;
		} finally {
			await release();
		}
	}

	private restoreGitBackup(targetDir: string, previous: string): void {
		if (existsSync(targetDir) || !existsSync(previous)) return;
		try {
			renameSync(previous, targetDir);
		} catch (error) {
			throw new Error(`Could not restore Git package ${targetDir}; previous checkout is at ${previous}.`, {
				cause: error,
			});
		}
	}

	private async removeGitUpdateFiles(path: string, { recursive } = { recursive: true }): Promise<void> {
		try {
			await rm(path, { recursive, force: true });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.emitProgress({
				type: "progress",
				action: "update",
				source: path,
				message: `Could not remove temporary Git package files at ${path} (${reason}).`,
			});
		}
	}

	private async refreshTemporaryGitSource(source: GitSource, sourceStr: string, installedPath: string): Promise<void> {
		if (isOfflineModeEnabled()) {
			return;
		}
		try {
			// A ref can name a moving branch, so refresh refs too. Skip the network call only when the
			// ref is a commit hash that is already checked out.
			if (source.ref && /^[0-9a-f]{7,64}$/i.test(source.ref)) {
				const head = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
					cwd: installedPath,
					timeoutMs: NETWORK_TIMEOUT_MS,
				});
				if (head.trim().toLowerCase().startsWith(source.ref.toLowerCase())) {
					return;
				}
			}
			await this.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
				await this.updateGit(source, "temporary");
			});
		} catch {
			// Keep cached temporary checkout if refresh fails.
		}
	}

	private async removeGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitStoragePath(source, scope);
		const state = this.getGitUpdateStatePath(targetDir, scope);
		const release = this.lockGitCheckout(state);
		try {
			const pointer = `${state}.current`;
			const pointerInfo = lstatSync(pointer, { throwIfNoEntry: false });
			if (pointerInfo && !pointerInfo.isFile()) {
				throw new GitRevisionPointerError(`Cannot remove Git package: expected a regular file at ${pointer}`);
			}
			let selected = targetDir;
			try {
				selected = this.readSelectedGitRevision(targetDir, state);
			} catch (error) {
				if (!(error instanceof GitRevisionPointerError)) throw error;
				// Only remove the logical checkout and revisions belonging to this package key.
			}
			if (existsSync(dirname(targetDir))) {
				const prefix = `.pi-revision-${basename(state)}-`;
				for (const entry of readdirSync(dirname(targetDir))) {
					const revision = join(dirname(targetDir), entry);
					if (
						revision !== selected &&
						entry.startsWith(prefix) &&
						/^[a-zA-Z0-9]{6}$/.test(entry.slice(prefix.length))
					) {
						await rm(revision, { recursive: true, force: true });
					}
				}
			}
			rmSync(`${state}.pending`, { force: true });
			if (selected !== targetDir) await rm(targetDir, { recursive: true, force: true });
			const markerPath = this.getGitUpdateMarkerPath(targetDir);
			if (statSync(markerPath, { throwIfNoEntry: false })?.isFile()) rmSync(markerPath, { force: true });
			await rm(`${state}.previous`, { recursive: true, force: true });
			await rm(selected, { recursive: true, force: true });
			rmSync(pointer, { force: true });
			this.pruneEmptyGitParents(targetDir, this.getGitInstallRoot(scope));
		} finally {
			release();
		}
	}

	private pruneEmptyGitParents(targetDir: string, installRoot: string | undefined): void {
		if (!installRoot) return;
		const resolvedRoot = resolve(installRoot);
		let current = dirname(targetDir);
		while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
			if (!existsSync(current)) {
				current = dirname(current);
				continue;
			}
			const entries = readdirSync(current);
			if (entries.length > 0) {
				break;
			}
			try {
				rmSync(current, { recursive: true, force: true });
			} catch {
				break;
			}
			current = dirname(current);
		}
	}

	private ensureNpmProject(installRoot: string): void {
		if (!existsSync(installRoot)) {
			mkdirSync(installRoot, { recursive: true });
		}
		markPathIgnoredByCloudSync(installRoot);
		this.ensureGitIgnore(installRoot);
		const packageJsonPath = join(installRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			const pkgJson = { name: "pi-extensions", private: true };
			writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
		}
	}

	private ensureGitIgnore(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const ignorePath = join(dir, ".gitignore");
		if (!existsSync(ignorePath)) {
			writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
		}
	}

	private getNpmInstallRoot(scope: SourceScope, temporary: boolean): string {
		if (temporary) {
			return this.getTemporaryDir("npm");
		}
		if (scope === "project") {
			this.assertProjectTrustedForScope(scope);
			return join(this.cwd, CONFIG_DIR_NAME, "npm");
		}
		return join(this.agentDir, "npm");
	}

	private getGlobalNpmRoot(): string {
		const npmCommand = this.getNpmCommand();
		const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
		if (this.globalNpmRoot && this.globalNpmRootCommandKey === commandKey) {
			return this.globalNpmRoot;
		}
		if (this.getPackageManagerName() === "bun") {
			const binDir = this.runNpmCommandSync(["pm", "bin", "-g"]).trim();
			this.globalNpmRoot = join(dirname(binDir), "install", "global", "node_modules");
		} else {
			this.globalNpmRoot = this.runNpmCommandSync(["root", "-g"]).trim();
		}
		this.globalNpmRootCommandKey = commandKey;
		return this.globalNpmRoot;
	}

	private getPnpmGlobalPackagePath(packageName: string): string | undefined {
		if (this.getPackageManagerName() !== "pnpm") {
			return undefined;
		}

		const output = this.runNpmCommandSync(["list", "-g", "--depth", "0", "--json"]);
		const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, { path?: string }> }>;
		for (const entry of entries) {
			const path = entry.dependencies?.[packageName]?.path;
			if (path) return path;
		}
		return undefined;
	}

	private getManagedNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return join(this.getTemporaryDir("npm"), "node_modules", source.name);
		}
		if (scope === "project") {
			this.assertProjectTrustedForScope(scope);
			return join(this.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
		}
		return join(this.agentDir, "npm", "node_modules", source.name);
	}

	private getLegacyGlobalNpmInstallPath(source: NpmSource): string | undefined {
		try {
			return this.getPnpmGlobalPackagePath(source.name) ?? join(this.getGlobalNpmRoot(), source.name);
		} catch {
			return undefined;
		}
	}

	private getNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		const managedPath = this.getManagedNpmInstallPath(source, scope);
		if (scope !== "user" || existsSync(managedPath)) {
			return managedPath;
		}
		const legacyPath = this.getLegacyGlobalNpmInstallPath(source);
		return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
	}

	private readSelectedGitRevision(logicalDir: string, state: string): string {
		const pointer = `${state}.current`;
		let name: string;
		try {
			if (!lstatSync(pointer).isFile()) throw new GitRevisionPointerError(`Expected a regular file at ${pointer}`);
			name = readFileSync(pointer, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return logicalDir;
			if (error instanceof GitRevisionPointerError) throw error;
			throw new GitRevisionPointerError(`Could not read Git revision pointer at ${pointer}`, { cause: error });
		}
		const prefix = `.pi-revision-${basename(state)}-`;
		if (!name.startsWith(prefix) || !/^[a-zA-Z0-9]{6}$/.test(name.slice(prefix.length))) {
			throw new GitRevisionPointerError(`Invalid Git revision pointer at ${pointer}`);
		}
		return join(dirname(logicalDir), name);
	}

	private getGitInstallPath(source: GitSource, scope: SourceScope): string {
		const logicalDir = this.getGitStoragePath(source, scope);
		return this.readSelectedGitRevision(logicalDir, this.getGitUpdateStatePath(logicalDir, scope));
	}

	private getGitStoragePath(source: GitSource, scope: SourceScope): string {
		if (
			[source.host, ...source.path.split("/")].some((part) => /^\.pi-revision-[a-f0-9]{64}-[a-z0-9]{6}$/i.test(part))
		) {
			throw new GitRevisionPointerError(
				"Git package path overlaps Pi's reserved revision namespace; use a local checkout instead",
			);
		}
		if (scope === "temporary") {
			// Include the ref in the hash so each pinned ref gets its own checkout.
			return this.getTemporaryDir(`git-${source.host}`, source.path, source.ref);
		}
		const installRoot = this.getGitInstallRoot(scope);
		if (!installRoot) {
			throw new Error("Missing git install root");
		}
		const checkout = this.resolveManagedPath(installRoot, source.host, source.path);
		if (relative(installRoot, checkout).split(sep)[0]?.toLowerCase() === ".git-update-state") {
			throw new GitRevisionPointerError(
				"Git package path overlaps Pi's reserved update state directory; use a local checkout instead",
			);
		}
		return checkout;
	}

	private getGitInstallRoot(scope: SourceScope): string | undefined {
		if (scope === "temporary") {
			return undefined;
		}
		if (scope === "project") {
			this.assertProjectTrustedForScope(scope);
			return join(this.cwd, CONFIG_DIR_NAME, "git");
		}
		return join(this.agentDir, "git");
	}

	private getTemporaryDir(prefix: string, suffix?: string, ref?: string): string {
		const root = this.resolveManagedPath(getExtensionTempFolder(this.agentDir), prefix);
		const hash = createHash("sha256")
			.update(`${prefix}-${suffix ?? ""}${ref ? `@${ref}` : ""}`)
			.digest("hex")
			.slice(0, 8);
		return this.resolveManagedPath(root, hash, suffix ?? "");
	}

	private resolveManagedPath(root: string, ...parts: string[]): string {
		const resolvedRoot = resolve(root);
		const resolvedPath = resolve(resolvedRoot, ...parts);
		if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
			throw new Error(`Refusing to use path outside package install root: ${resolvedPath}`);
		}
		return resolvedPath;
	}

	private getBaseDirForScope(scope: SourceScope): string {
		if (scope === "project") {
			this.assertProjectTrustedForScope(scope);
			return join(this.cwd, CONFIG_DIR_NAME);
		}
		if (scope === "user") {
			return this.agentDir;
		}
		return this.cwd;
	}

	private resolvePath(input: string): string {
		return resolvePath(input, this.cwd, { homeDir: getHomeDir(), trim: true });
	}

	private resolvePathFromBase(input: string, baseDir: string): string {
		return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
	}

	private collectPackageResources(
		packageRoot: string,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
		filterRoot = packageRoot,
	): boolean {
		if (filterRoot !== packageRoot) {
			metadata.gitRevision = { active: packageRoot, logical: filterRoot };
		}
		const selectPath = (path: string) => DefaultPackageManager.selectGitResourcePath(path, accumulator.gitRevisions);
		const manifest = readPiManifest(selectPath(join(packageRoot, "package.json")));
		const changelogPath = resolvePackageChangelogPath(packageRoot, manifest, selectPath);
		if (changelogPath) {
			metadata.changelogPath = changelogPath;
		} else {
			delete metadata.changelogPath;
		}

		if (filter) {
			for (const resourceType of RESOURCE_TYPES) {
				const patterns = filter[resourceType];
				const target = this.getTargetMap(accumulator, resourceType);
				if (filter.autoload === false) {
					this.applyPackageDeltaFilter(
						packageRoot,
						patterns ?? [],
						resourceType,
						target,
						metadata,
						filterRoot,
						manifest,
						selectPath,
					);
				} else if (patterns !== undefined) {
					this.applyPackageFilter(
						packageRoot,
						patterns,
						resourceType,
						target,
						metadata,
						filterRoot,
						manifest,
						selectPath,
					);
				} else {
					this.collectDefaultResources(packageRoot, resourceType, target, metadata, manifest, selectPath);
				}
			}
			return true;
		}

		if (manifest && hasManifestResourceFields(manifest)) {
			for (const resourceType of RESOURCE_TYPES) {
				const entries = manifest[resourceType];
				this.addManifestEntries(
					entries,
					packageRoot,
					resourceType,
					this.getTargetMap(accumulator, resourceType),
					metadata,
					selectPath,
				);
			}
			return true;
		}

		let hasAnyDir = false;
		for (const resourceType of RESOURCE_TYPES) {
			const dir = join(packageRoot, resourceType);
			if (existsSync(selectPath(dir))) {
				const { allFiles, aliases } = this.collectSelectedPackagePaths([dir], resourceType, selectPath, true);
				for (const f of allFiles) {
					this.addResource(
						this.getTargetMap(accumulator, resourceType),
						f,
						this.withPackageAliases(metadata, aliases.get(f)),
						true,
					);
				}
				hasAnyDir = true;
			}
		}
		return hasAnyDir;
	}

	private collectDefaultResources(
		packageRoot: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		manifest: PiManifest | null,
		selectPath: (path: string) => string,
	): void {
		const entries = manifest?.[resourceType];
		if (entries) {
			this.addManifestEntries(entries, packageRoot, resourceType, target, metadata, selectPath);
			return;
		}
		const { allFiles, aliases } = this.collectSelectedPackagePaths(
			[join(packageRoot, resourceType)],
			resourceType,
			selectPath,
			true,
		);
		for (const f of allFiles) this.addResource(target, f, this.withPackageAliases(metadata, aliases.get(f)), true);
	}

	private applyPackageFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		filterRoot: string,
		manifest: PiManifest | null,
		selectPath: (path: string) => string,
	): void {
		const { allFiles, aliases, filesBySpelling } = this.collectManifestFiles(
			packageRoot,
			resourceType,
			manifest,
			selectPath,
		);

		if (userPatterns.length === 0) {
			// Empty array explicitly disables all resources of this type
			for (const f of allFiles) {
				this.addResource(target, f, this.withPackageAliases(metadata, aliases?.get(f)), false);
			}
			return;
		}

		// Rank each row by its winning spelling, not an earlier rejected alias.
		const order = new Map([...filesBySpelling.keys()].map((spelling, index) => [spelling, index]));
		const rows = allFiles.map((f) => {
			const spellings = aliases?.get(f);
			const declaration = chooseResourceAlias(spellings, (alias) =>
				matchesPackageDeclaration(
					f,
					alias?.values().next().value,
					spellings,
					userPatterns,
					packageRoot,
					filterRoot,
				),
			);
			const allAliases = new Set([...(declaration.aliases ?? []), ...(aliases?.get(f) ?? [])]);
			const spelling = declaration.aliases?.values().next().value ?? f;
			return { f, allAliases, enabled: declaration.enabled, rank: order.get(spelling) ?? Number.MAX_SAFE_INTEGER };
		});
		rows.sort((a, b) => a.rank - b.rank);
		for (const row of rows)
			this.addResource(target, row.f, this.withPackageAliases(metadata, row.allAliases), row.enabled);
	}

	private applyPackageDeltaFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		filterRoot: string,
		manifest: PiManifest | null,
		selectPath: (path: string) => string,
	): void {
		if (userPatterns.length === 0) {
			return;
		}

		const { allFiles, aliases, filesBySpelling } = this.collectManifestFiles(
			packageRoot,
			resourceType,
			manifest,
			selectPath,
		);
		const enabledByUser = applyAutoloadDisabledPatterns(
			allFiles,
			userPatterns,
			packageRoot,
			filterRoot,
			aliases,
			filesBySpelling,
		);
		for (const [filePath, { enabled, alias }] of enabledByUser) {
			const spellings = aliases?.get(filePath);
			const ordered = alias === undefined ? spellings : new Set([alias, ...(spellings ?? [])]);
			this.addResource(
				target,
				filePath,
				this.withPackageAliases({ ...metadata, packageDelta: true }, ordered),
				enabled,
			);
		}
	}

	/**
	 * Collect all files from a package for a resource type, applying manifest patterns.
	 * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
	 * that pass the manifest's own patterns.
	 */
	private collectManifestFiles(
		packageRoot: string,
		resourceType: ResourceType,
		manifest: PiManifest | null,
		selectPath: (path: string) => string,
	) {
		const entries = manifest?.[resourceType];
		if (entries && entries.length > 0) {
			return this.collectFilesFromManifestEntries(entries, packageRoot, resourceType, selectPath, true);
		}

		return this.collectSelectedPackagePaths([join(packageRoot, resourceType)], resourceType, selectPath, true);
	}

	private addManifestEntries(
		entries: string[] | undefined,
		root: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		selectPath: (path: string) => string,
	): void {
		if (!entries) return;

		const { allFiles, aliases } = this.collectFilesFromManifestEntries(entries, root, resourceType, selectPath);
		for (const f of allFiles) {
			this.addResource(target, f, this.withPackageAliases(metadata, aliases.get(f)), true);
		}
	}

	private withPackageAliases(metadata: PathMetadata, aliases?: Set<string>): PathMetadata {
		return aliases?.size ? { ...metadata, packageAliases: [...aliases] } : metadata;
	}

	private collectFilesFromManifestEntries(
		entries: string[],
		root: string,
		resourceType: ResourceType,
		selectPath: (path: string) => string,
		preserveFilterOrder = false,
	) {
		const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
		const resolved = sourceEntries.flatMap((entry) => {
			if (!hasGlobPattern(entry)) {
				return [resolve(root, entry)];
			}

			// Use a literal cwd for the fixed prefix, leaving only the wildcard suffix to glob.
			const parts = toPosixPath(entry).split("/");
			const wildcard = parts.findIndex(hasGlobPattern);
			const prefix = resolve(root, parts.slice(0, wildcard).join("/") || (isAbsolute(entry) ? sep : "."));
			const selected = selectPath(prefix);
			if (selected === prefix) return expandPackageGlob(entry, root);
			return expandPackageGlob(parts.slice(wildcard).join("/"), selected)
				.map((file) => join(prefix, relative(selected, file)))
				.filter((file) => isVisibleGlobPath(root, file));
		});
		const patterns = entries.filter(isOverridePattern);
		const discovered = this.collectSelectedPackagePaths(resolved, resourceType, selectPath);
		const allFiles: string[] = [];
		const aliases = new Map<string, Set<string>>();
		const declarations = discovered.filesBySpelling;
		const enabled = applyPatterns([...declarations.keys()], patterns, root);
		// Settings filters have historically consumed force-includes at the end.
		const order = preserveFilterOrder ? enabled : declarations.keys();
		const filesBySpelling = new Map<string, string>();
		for (const spelling of order) {
			if (!enabled.has(spelling)) continue;
			const file = declarations.get(spelling)!;
			filesBySpelling.set(spelling, file);
			let spellings = aliases.get(file);
			if (!spellings) {
				allFiles.push(file);
				spellings = new Set<string>();
				aliases.set(file, spellings);
			}
			spellings.add(spelling);
		}
		return { allFiles, aliases, filesBySpelling };
	}

	private collectSelectedPackagePaths(
		resolved: string[],
		resourceType: ResourceType,
		selectPath: (path: string) => string,
		directoriesOnly = false,
	) {
		const aliases = new Map<string, Set<string>>();
		const allFiles = new Set<string>();
		const filesBySpelling = new Map<string, string>();
		const rememberAlias = (file: string, alias: string) => {
			if (!filesBySpelling.has(alias)) filesBySpelling.set(alias, file);
			const spellings = aliases.get(file) ?? new Set<string>();
			spellings.add(alias);
			aliases.set(file, spellings);
		};
		for (const original of resolved) {
			const selected = selectPath(original);
			if (directoriesOnly) {
				try {
					if (!statSync(selected, { throwIfNoEntry: false })?.isDirectory()) continue;
				} catch {
					continue;
				}
			}
			const logicalPath = (path: string) =>
				selected !== original && (path === selected || isPathInside(selected, path))
					? join(original, relative(selected, path))
					: path;
			const rememberDiscoveredAlias = (file: string, alias: string) =>
				rememberAlias(selectPath(file), logicalPath(alias));
			for (const path of this.collectFilesFromPaths(
				[selected],
				resourceType,
				selectPath,
				rememberDiscoveredAlias,
				true,
			)) {
				const active = selectPath(path);
				if (existsSync(active)) allFiles.add(active);
			}
		}
		for (const [file, spellings] of aliases) {
			if (spellings.size === 1 && spellings.has(file)) aliases.delete(file);
		}
		for (const [spelling, file] of filesBySpelling) {
			if (!allFiles.has(file)) filesBySpelling.delete(spelling);
		}
		return { allFiles: [...allFiles], aliases, filesBySpelling };
	}

	private resolveLocalEntries(
		entries: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		baseDir: string,
		gitRevisions: ReadonlyMap<string, string>,
	): void {
		if (entries.length === 0) return;

		// Collect all files from plain entries (non-pattern entries)
		const { plain, patterns } = splitPatterns(entries);
		const { allFiles, aliases, filesBySpelling } = this.collectSelectedPackagePaths(
			plain.map((entry) => this.resolvePathFromBase(entry, baseDir)),
			resourceType,
			(path) => this.redirectGitResource(path, gitRevisions),
		);

		// pi config saves exact paths relative to the settings directory. Resolve them through
		// the same revision mapping as declarations, even if they name a different revision.
		const rules = this.redirectGitExactRules(patterns, baseDir, gitRevisions, aliases);
		const order = new Map([...filesBySpelling.keys()].map((spelling, index) => [spelling, index]));
		const rows = allFiles.map((f) => {
			const spellings = aliases.get(f);
			const revision = this.withGitRevision(metadata, f, gitRevisions).gitRevision;
			const matches = (alias?: Set<string>) => {
				if (!alias || !revision)
					return applyPatterns([f], rules, baseDir, baseDir, alias ? new Map([[f, alias]]) : undefined).has(f);
				const spelling = alias.values().next().value!;
				const candidateRules = this.getDeclarationRules(
					spelling,
					revision,
					patterns,
					baseDir,
					gitRevisions,
					aliases,
					spellings,
				);
				return applyPatterns([spelling], candidateRules, baseDir).has(spelling);
			};
			// Before redirection, canonical deduplication keeps the first declaration,
			// even when disabled. Skip direct duplicates already owned by the package.
			const existing = target.get(f);
			const candidates = new Set<string>();
			const seen = new Set<string>();
			for (const alias of spellings ?? []) {
				if (
					revision &&
					existing?.metadata.origin === "package" &&
					(alias === f || !this.isIndependentGitAlias(alias, revision))
				)
					continue;
				if (existsSync(alias)) {
					const key = getResourcePathKey(alias);
					if (seen.has(key)) continue;
					seen.add(key);
				}
				candidates.add(alias);
			}
			const declaration = chooseResourceAlias(candidates.size ? candidates : undefined, matches);
			return {
				f,
				metadata: this.withGitRevision(metadata, f, gitRevisions, declaration.aliases, spellings),
				enabled: declaration.enabled,
				rank: order.get(declaration.aliases?.values().next().value ?? f) ?? Number.MAX_SAFE_INTEGER,
			};
		});
		rows.sort((a, b) => a.rank - b.rank);
		for (const row of rows) this.addResource(target, row.f, row.metadata, row.enabled);
	}

	private getDeclarationRules(
		spelling: string,
		revision: NonNullable<PathMetadata["gitRevision"]>,
		patterns: string[],
		baseDir: string,
		gitRevisions: ReadonlyMap<string, string>,
		aliases: ReadonlyMap<string, Set<string>>,
		spellings?: ReadonlySet<string>,
	): string[] {
		const normalized = selectGitDeclarationPath(spelling, revision);
		return patterns.flatMap((pattern) => {
			if (!pattern.startsWith("+") && !pattern.startsWith("-")) {
				return this.redirectGitExactRules([pattern], baseDir, gitRevisions, aliases);
			}
			const rule = pattern.slice(1);
			if ([...(spellings ?? [])].some((path) => matchesAnyExactPattern(path, [rule], baseDir))) return [pattern];
			const historical = selectGitDeclarationPath(this.resolvePathFromBase(rule, baseDir), revision);
			return matchesAnyExactPattern(normalized, [historical], baseDir)
				? [pattern, `${pattern[0]}${spelling}`]
				: [pattern];
		});
	}

	private redirectGitExactRules(
		patterns: string[],
		baseDir: string,
		gitRevisions: ReadonlyMap<string, string>,
		declarations?: ReadonlyMap<string, Set<string>>,
	): string[] {
		if (gitRevisions.size === 0) return patterns;
		return patterns.flatMap((pattern) => {
			if (pattern[0] !== "+" && pattern[0] !== "-" && pattern[0] !== "!") return [pattern];
			const original = this.resolvePathFromBase(pattern.slice(1), baseDir);
			const active = this.redirectGitResource(original, gitRevisions);
			if (declarations?.get(active)?.has(original)) return [pattern];
			// Keep relative globs relative so literal settings-directory characters do not become glob syntax.
			const target = pattern[0] === "!" && !isAbsolute(pattern.slice(1)) ? relative(baseDir, active) : active;
			return active === original ? [pattern] : [pattern, `${pattern[0]}${target}`];
		});
	}

	private redirectGitResource(path: string, revisions: ReadonlyMap<string, string>): string {
		return DefaultPackageManager.selectGitResourcePath(path, revisions);
	}

	static selectGitResourcePath(path: string, revisions?: ReadonlyMap<string, string>): string {
		if (!revisions?.size) return path;
		let selected = path;
		const seen = new Set([path]);
		// A selected checkout can itself contain a link into another managed checkout.
		for (let hops = 0; hops < 40; hops++) {
			let next: string | undefined;
			// Select the containing revision before following links in a retained checkout.
			for (const [logical, active] of revisions) {
				const candidate = redirectGitRevisionPath(selected, logical, active, true);
				if (candidate !== undefined && candidate !== selected) {
					next = candidate;
					break;
				}
			}
			if (next === undefined) {
				let bestBoundary = Number.POSITIVE_INFINITY;
				for (const [logical, active] of revisions) {
					let boundary = Number.MAX_SAFE_INTEGER;
					const candidate = redirectGitRevisionPath(selected, logical, active, false, (length) => {
						boundary = length;
					});
					if (candidate !== undefined && candidate !== selected && boundary < bestBoundary) {
						next = candidate;
						bestBoundary = boundary;
					}
				}
			}
			if (next === undefined || seen.has(next)) break;
			seen.add(next);
			selected = next;
		}
		return selected;
	}

	private withGitRevision(
		metadata: PathMetadata,
		path: string,
		revisions: ReadonlyMap<string, string>,
		aliases?: ReadonlySet<string>,
		declarations?: ReadonlySet<string>,
	): PathMetadata {
		for (const [logical, active] of revisions) {
			if (isPathInside(active, path))
				return {
					...metadata,
					gitRevision: {
						logical,
						active,
						aliases: aliases && [...aliases],
						declarations: declarations && [...declarations],
					},
				};
		}
		return metadata;
	}

	private addAutoDiscoveredResources(
		accumulator: ResourceAccumulator,
		globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
		projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
		globalBaseDir: string,
		projectBaseDir: string,
	): void {
		const userMetadata: PathMetadata = {
			source: "auto",
			scope: "user",
			origin: "top-level",
			baseDir: globalBaseDir,
		};
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
		};

		const userOverrides = {
			extensions: (globalSettings.extensions ?? []) as string[],
			skills: (globalSettings.skills ?? []) as string[],
			prompts: (globalSettings.prompts ?? []) as string[],
			themes: (globalSettings.themes ?? []) as string[],
		};
		const projectOverrides = {
			extensions: (projectSettings.extensions ?? []) as string[],
			skills: (projectSettings.skills ?? []) as string[],
			prompts: (projectSettings.prompts ?? []) as string[],
			themes: (projectSettings.themes ?? []) as string[],
		};

		const userDirs = {
			extensions: join(globalBaseDir, "extensions"),
			skills: join(globalBaseDir, "skills"),
			prompts: join(globalBaseDir, "prompts"),
			themes: join(globalBaseDir, "themes"),
		};
		const projectDirs = {
			extensions: join(projectBaseDir, "extensions"),
			skills: join(projectBaseDir, "skills"),
			prompts: join(projectBaseDir, "prompts"),
			themes: join(projectBaseDir, "themes"),
		};
		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		const projectTrusted = this.settingsManager.isProjectTrusted();
		const projectAgentsSkillDirs = projectTrusted
			? collectAncestorAgentsSkillDirs(this.cwd).filter((dir) => !pathsEqual(dir, userAgentsSkillsDir))
			: [];

		const selectPath = (path: string) => this.redirectGitResource(path, accumulator.gitRevisions);
		const aliases = new Map<string, Set<string>>();
		const rememberAlias = (file: string, alias: string) => {
			const spellings = aliases.get(file) ?? new Set<string>();
			spellings.add(alias);
			aliases.set(file, spellings);
		};
		const discoverSkills = (original: string, mode: SkillDiscoveryMode) =>
			collectSkillEntries(selectPath(original), mode, undefined, original, { selectPath, rememberAlias }, original);
		const discoverAtSelectedRoot = (original: string, collect: typeof collectAutoPromptEntries) => {
			const selected = selectPath(original);
			const paths = collect(selected, selectPath);
			if (selected !== original) {
				for (const path of paths) {
					if (isPathInside(selected, path)) rememberAlias(path, join(original, relative(selected, path)));
				}
			}
			return paths;
		};
		const addResources = (
			resourceType: ResourceType,
			paths: string[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
		) => {
			const target = this.getTargetMap(accumulator, resourceType);
			const discovered = new Map<string, Set<string>>();
			for (const path of paths) {
				const active = selectPath(path);
				if (active !== path && !existsSync(active)) continue;
				const spellings = discovered.get(active) ?? new Set<string>();
				if (path !== active) spellings.add(path);
				for (const alias of aliases.get(path) ?? []) spellings.add(alias);
				discovered.set(active, spellings);
			}
			const rules = this.redirectGitExactRules(overrides, baseDir, accumulator.gitRevisions, discovered);
			for (const [active, spellings] of discovered) {
				const revision = this.withGitRevision(metadata, active, accumulator.gitRevisions).gitRevision;
				const declaration = chooseResourceAlias(spellings, (alias) => {
					if (!alias || !revision) return isEnabledByOverrides(active, rules, baseDir, alias);
					const spelling = alias.values().next().value!;
					return isEnabledByOverrides(
						spelling,
						this.getDeclarationRules(
							spelling,
							revision,
							overrides,
							baseDir,
							accumulator.gitRevisions,
							discovered,
							spellings,
						),
						baseDir,
						[],
						selectGitDeclarationPath(spelling, revision),
					);
				});
				this.addResource(
					target,
					active,
					this.withGitRevision(metadata, active, accumulator.gitRevisions, declaration.aliases, spellings),
					declaration.enabled,
				);
			}
			aliases.clear();
		};

		if (projectTrusted) {
			// Project extensions from .pi/
			addResources(
				"extensions",
				collectAutoExtensionEntries(projectDirs.extensions, selectPath, rememberAlias),
				projectMetadata,
				projectOverrides.extensions,
				projectBaseDir,
			);

			// Project skills from .pi/
			addResources(
				"skills",
				discoverSkills(projectDirs.skills, "pi"),
				projectMetadata,
				projectOverrides.skills,
				projectBaseDir,
			);
		}

		// Project skills from .agents/ (each with its own baseDir)
		for (const agentsSkillsDir of projectAgentsSkillDirs) {
			const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
			const agentsMetadata: PathMetadata = {
				...projectMetadata,
				baseDir: agentsBaseDir,
			};
			addResources(
				"skills",
				discoverSkills(agentsSkillsDir, "agents"),
				agentsMetadata,
				projectOverrides.skills,
				agentsBaseDir,
			);
		}

		if (projectTrusted) {
			addResources(
				"prompts",
				discoverAtSelectedRoot(projectDirs.prompts, collectAutoPromptEntries),
				projectMetadata,
				projectOverrides.prompts,
				projectBaseDir,
			);
			addResources(
				"themes",
				discoverAtSelectedRoot(projectDirs.themes, collectAutoThemeEntries),
				projectMetadata,
				projectOverrides.themes,
				projectBaseDir,
			);
		}

		// User extensions from ~/.pi/agent/
		addResources(
			"extensions",
			collectAutoExtensionEntries(userDirs.extensions, selectPath, rememberAlias),
			userMetadata,
			userOverrides.extensions,
			globalBaseDir,
		);

		// User skills from ~/.pi/agent/
		addResources("skills", discoverSkills(userDirs.skills, "pi"), userMetadata, userOverrides.skills, globalBaseDir);

		// User skills from ~/.agents/ (with its own baseDir)
		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		const userAgentsMetadata: PathMetadata = {
			...userMetadata,
			baseDir: userAgentsBaseDir,
		};
		addResources(
			"skills",
			discoverSkills(userAgentsSkillsDir, "agents"),
			userAgentsMetadata,
			userOverrides.skills,
			userAgentsBaseDir,
		);

		addResources(
			"prompts",
			discoverAtSelectedRoot(userDirs.prompts, collectAutoPromptEntries),
			userMetadata,
			userOverrides.prompts,
			globalBaseDir,
		);
		addResources(
			"themes",
			discoverAtSelectedRoot(userDirs.themes, collectAutoThemeEntries),
			userMetadata,
			userOverrides.themes,
			globalBaseDir,
		);
	}

	private collectFilesFromPaths(
		paths: string[],
		resourceType: ResourceType,
		selectPath?: (path: string) => string,
		rememberAlias?: (file: string, alias: string) => void,
		recordDirect = false,
	): string[] {
		const files: string[] = [];
		for (const p of paths) {
			if (!existsSync(p)) continue;

			try {
				const stats = statSync(p);
				if (stats.isFile()) {
					files.push(p);
					if (recordDirect) rememberAlias?.(p, p);
				} else if (stats.isDirectory()) {
					if (!selectPath || !rememberAlias) {
						files.push(...collectResourceFiles(p, resourceType));
					} else if (resourceType === "extensions") {
						files.push(...collectAutoExtensionEntries(p, selectPath, rememberAlias, recordDirect));
					} else if (resourceType === "skills") {
						files.push(
							...collectSkillEntries(p, "pi", undefined, undefined, { selectPath, rememberAlias, recordDirect }),
						);
					} else {
						files.push(
							...collectFiles(p, FILE_PATTERNS[resourceType], true, undefined, undefined, {
								selectPath,
								rememberAlias,
								recordDirect,
							}),
						);
					}
				}
			} catch {
				// Ignore errors
			}
		}
		return files;
	}

	private getTargetMap(
		accumulator: ResourceAccumulator,
		resourceType: ResourceType,
	): Map<string, { metadata: PathMetadata; enabled: boolean }> {
		switch (resourceType) {
			case "extensions":
				return accumulator.extensions;
			case "skills":
				return accumulator.skills;
			case "prompts":
				return accumulator.prompts;
			case "themes":
				return accumulator.themes;
			default:
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	private isIndependentGitAlias(path: string, revision: NonNullable<PathMetadata["gitRevision"]>): boolean {
		for (let component = path; dirname(component) !== component; component = dirname(component)) {
			try {
				if (!lstatSync(component, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
				if (component === path) return true;
				// A link to the checkout or a directory inside it adds another declaration.
				// An alias of its storage parent just re-spells the same checkout path.
				if (
					redirectGitRevisionPath(
						canonicalizePath(component),
						canonicalizePath(revision.logical),
						revision.active,
						true,
					)
				)
					return true;
			} catch {
				// An inaccessible component does not prove a separate alias.
			}
		}
		return false;
	}

	private addResource(
		map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		path: string,
		metadata: PathMetadata,
		enabled: boolean,
	): void {
		if (!path) return;
		const existing = map.get(path);
		const revision = metadata.gitRevision;
		// Selection can collapse distinct spellings before canonical precedence runs.
		// An independent auto-discovered alias keeps its own enablement. A plain
		// configured declaration still does not undo an explicit package exclusion.
		if (
			!existing ||
			(metadata.origin === "top-level" &&
				revision?.aliases?.some((alias) => alias !== path && this.isIndependentGitAlias(alias, revision)) &&
				resourcePrecedenceRank(metadata) < resourcePrecedenceRank(existing.metadata))
		) {
			// A replacement takes its position from the winning declaration, not the displaced row.
			if (existing) map.delete(path);
			map.set(path, { metadata, enabled });
		}
	}

	private createAccumulator(): ResourceAccumulator {
		return {
			gitRevisions: new Map(),
			extensions: new Map(),
			skills: new Map(),
			prompts: new Map(),
			themes: new Map(),
		};
	}

	private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
		const mapToResolved = (
			entries: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		): ResolvedResource[] => {
			const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
				path,
				enabled,
				metadata,
			}));
			resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

			const seen = new Set<string>();
			return resolved.filter((entry) => {
				const pathKey = getResourcePathKey(entry.path);
				if (seen.has(pathKey)) return false;
				seen.add(pathKey);
				return true;
			});
		};

		return {
			extensions: mapToResolved(accumulator.extensions),
			skills: mapToResolved(accumulator.skills),
			prompts: mapToResolved(accumulator.prompts),
			themes: mapToResolved(accumulator.themes),
		};
	}

	private spawnCommand(command: string, args: string[], options?: { cwd?: string }): ChildProcess {
		const env = getEnv();
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			env,
		});
	}

	private spawnCaptureCommand(
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): ChildProcessByStdio<null, Readable, Readable> {
		const baseEnv = getEnv();
		const env = options?.env ? { ...baseEnv, ...options.env } : baseEnv;
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
	}

	private runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCaptureCommand(command, args, options);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timeout =
				typeof options?.timeoutMs === "number"
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeoutMs)
					: undefined;

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			child.once("error", (error) => {
				if (timeout) clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (timeout) clearTimeout(timeout);
				if (timedOut) {
					reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
					return;
				}
				if (code === 0) {
					resolvePromise(stdout.trim());
					return;
				}
				const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
			});
		});
	}

	private runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCommand(command, args, options);
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
				}
			});
		});
	}

	private runCommandSync(command: string, args: string[]): string {
		const env = getEnv();
		const result = spawnProcessSync(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
			env,
		});
		if (result.error || result.status !== 0) {
			throw new Error(
				`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
			);
		}
		return (result.stdout || result.stderr || "").trim();
	}
}
