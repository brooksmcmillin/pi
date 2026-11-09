import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AgentSession, markRuntimeStreamFunction } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const directories: string[] = [];
const sessions: AgentSession[] = [];
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "pi-managed-search-"));
	directories.push(dir);
	return dir;
}
function systemBinary(name: string) {
	const executable = name + (process.platform === "win32" ? ".exe" : "");
	return (process.env.PATH ?? "")
		.split(delimiter)
		.map((dir) => join(dir, executable))
		.find(existsSync);
}

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	vi.unstubAllEnvs();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(tool: string, cwd: string, customTools: ToolDefinition[] = []) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = createFauxCore({ api: "openai-completions", provider: "managed-search-test" });
	faux.setResponses([
		() =>
			fauxAssistantMessage(fauxToolCall(tool, { pattern: tool === "find" ? "*.txt" : "needle", path: cwd }), {
				stopReason: "toolUse",
			}),
		() => fauxAssistantMessage("done"),
	]);
	runtime.registerProvider("managed-search-test", {
		api: "openai-completions",
		apiKey: "offline-fixture",
		baseUrl: "https://example.invalid",
		streamSimple: faux.streamSimple,
		models: [
			{
				id: "fixture",
				name: "fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1000,
			},
		],
	});
	await runtime.refresh({ allowNetwork: false });
	const agent = new Agent({
		initialState: { model: runtime.getModel("managed-search-test", "fixture")!, tools: [] },
		streamFn: (model, context, options) => runtime.streamSimple(model, context, options),
	});
	markRuntimeStreamFunction(agent.streamFunction, runtime);
	const session = new AgentSession({
		agent,
		modelRuntime: runtime,
		cwd,
		customTools,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		resourceLoader: createTestResourceLoader(),
	});
	session.setActiveToolsByName([tool]);
	sessions.push(session);
	return session;
}

async function run(session: AgentSession) {
	const result = session.submitGuardedPrompt("search", session.ownerSnapshot, () => true, true);
	if (result.status !== "running") throw new Error(result.reason);
	await result.completion;
	expect(await result.settlement).toBe("settled");
	return session.messages.filter((message) => message.role === "toolResult");
}

describe("guarded managed searches", () => {
	for (const [tool, executable] of [
		["grep", "rg"],
		["find", "fd"],
	] as const) {
		it.skipIf(!systemBinary(executable))(`runs the actual local ${tool} backend and joins it`, async () => {
			const agentDir = directory();
			vi.stubEnv(ENV_AGENT_DIR, agentDir);
			mkdirSync(join(agentDir, "bin"));
			copyFileSync(
				systemBinary(executable)!,
				join(agentDir, "bin", executable + (process.platform === "win32" ? ".exe" : "")),
			);
			const cwd = directory();
			writeFileSync(join(cwd, "match.txt"), "needle\n");
			const results = await run(await fixture(tool, cwd));
			expect(results).toHaveLength(1);
			expect(results[0].isError).toBe(false);
			expect(results[0].content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "text", text: expect.stringContaining("match.txt") }),
				]),
			);
		});

		it(`does not provision or use PATH for guarded ${tool}`, async () => {
			vi.stubEnv(ENV_AGENT_DIR, directory());
			const results = await run(await fixture(tool, directory()));
			expect(results[0].isError).toBe(true);
			expect(results[0].content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "text", text: expect.stringContaining("pre-provisioned") }),
				]),
			);
		});

		it(`rejects a custom/remote replacement named ${tool} before invoking it`, async () => {
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "remote" }], details: {} }));
			const results = await run(
				await fixture(tool, directory(), [
					{
						name: tool,
						label: tool,
						description: "unsupported remote fixture",
						parameters: Type.Object({ pattern: Type.String(), path: Type.String() }),
						execute,
					},
				]),
			);
			expect(execute).not.toHaveBeenCalled();
			expect(results[0].isError).toBe(true);
		});
	}
});
