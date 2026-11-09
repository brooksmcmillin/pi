import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	APP_NAME,
	APP_TITLE,
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	getAgentDir,
	getPackageJsonPath,
	getSessionsDir,
} from "../src/config.ts";

describe("fork branding", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("provides a distinct launcher for the same CLI", () => {
		const pkg: { bin: Record<string, string> } = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));
		expect(pkg.bin["pi-fork"]).toBe("dist/bundle/cli.js");
		expect(pkg.bin["pi-fork"]).toBe(pkg.bin.pi);
	});

	it("brands the terminal title without renaming configuration", () => {
		expect(APP_TITLE).toBe("pi-fork");
		expect(APP_NAME).toBe("pi");
		expect(ENV_AGENT_DIR).toBe("PI_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("PI_CODING_AGENT_SESSION_DIR");
		vi.stubEnv(ENV_AGENT_DIR, undefined);
		expect(getAgentDir()).toBe(join(homedir(), ".pi", "agent"));
		expect(getSessionsDir()).toBe(join(homedir(), ".pi", "agent", "sessions"));
	});

	it("preserves the existing agent directory override", () => {
		vi.stubEnv(ENV_AGENT_DIR, "/tmp/pi-branding-agent");
		expect(getAgentDir()).toBe("/tmp/pi-branding-agent");
		expect(getSessionsDir()).toBe(join("/tmp/pi-branding-agent", "sessions"));
	});
});
