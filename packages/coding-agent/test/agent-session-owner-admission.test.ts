import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, markRuntimeStreamFunction } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	vi.restoreAllMocks();
});

async function fixture(stage?: "routing" | "auth" | "headers", extensions: ExtensionFactory[] = [], toolName?: string) {
	const entered = deferred();
	const release = deferred();
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const provider = vi.fn((model) => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		if (toolName && provider.mock.calls.length === 1) {
			message.content = [{ type: "toolCall", id: "outer-call", name: toolName, arguments: {} }];
			message.stopReason = "toolUse";
		}
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		return stream;
	});
	runtime.registerProvider("owner-test", {
		api: "openai-completions",
		apiKey: "offline-fixture",
		baseUrl: "https://example.invalid",
		streamSimple: provider,
		models: [
			{
				id: "physical",
				name: "physical",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1000,
			},
		],
	});
	await runtime.refresh({ allowNetwork: false });
	const physical = runtime.getModel("owner-test", "physical")!;
	let model = physical;
	if (stage === "routing") {
		runtime.registerVirtualModel({
			provider: "owner-test",
			id: "virtual",
			name: "virtual",
			route: async () => {
				entered.resolve();
				await release.promise;
				return { model: physical, thinkingLevel: "off", state: { routed: true } };
			},
		});
		model = runtime.getModel("owner-test", "virtual")!;
	}
	if (stage === "auth") {
		const getAuth = runtime.getAuth.bind(runtime);
		vi.spyOn(runtime, "getAuth").mockImplementation(async (model, options) => {
			entered.resolve();
			await release.promise;
			return typeof model === "string" ? getAuth(model, options) : getAuth(model, options);
		});
	}
	const agent = new Agent({
		initialState: { model, tools: [], systemPrompt: "offline test" },
		streamFn: (model, context, options) =>
			runtime.streamSimple(model, context, {
				...options,
				...(stage === "headers"
					? {
							transformHeaders: async (headers) => {
								entered.resolve();
								await release.promise;
								return headers;
							},
						}
					: {}),
			}),
	});
	markRuntimeStreamFunction(agent.streamFunction, runtime);
	const session = new AgentSession({
		agent,
		modelRuntime: runtime,
		cwd: process.cwd(),
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		resourceLoader: createTestResourceLoader({ extensionsResult: await createTestExtensionsResult(extensions) }),
	});
	session.setActiveToolsByName(toolName ? [toolName, "inner"] : []);
	sessions.push(session);
	return { session, provider, entered, release };
}

describe("guarded session dispatch", () => {
	it("inherits admission through a real nested tool call without deadlock", async () => {
		const entered = deferred();
		const release = deferred();
		let innerCalls = 0;
		const { session, provider } = await fixture(
			undefined,
			[
				(pi) => {
					pi.registerTool({
						name: "inner",
						label: "inner",
						description: "cooperative fixture",
						parameters: Type.Object({}),
						execute: async () => {
							innerCalls++;
							entered.resolve();
							await release.promise;
							return { content: [{ type: "text", text: "inner done" }], details: {} };
						},
					});
					pi.registerTool({
						name: "outer",
						label: "outer",
						description: "nested fixture",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							const nested = await ctx.executeTool("inner", {});
							expect(nested.isError).toBe(false);
							return { content: nested.result.content, details: {} };
						},
					});
				},
			],
			"outer",
		);
		const result = session.submitGuardedPrompt("nested", session.ownerSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await entered.promise;
		expect(session.submitGuardedPrompt("competitor", session.ownerSnapshot, () => true, true)).toEqual({
			status: "rejected",
			reason: "busy",
		});
		release.resolve();
		await result.completion;
		expect(innerCalls).toBe(1);
		expect(provider).toHaveBeenCalledTimes(2);
	});

	it.each(["reload", "replacement"] as const)("fences a pending input hook on %s", async (action) => {
		const entered = deferred();
		const release = deferred();
		const { session, provider } = await fixture(undefined, [
			(pi) => {
				pi.on("input", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		]);
		const oldSnapshot = session.ownerSnapshot;
		const result = session.submitGuardedPrompt("pending", oldSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await entered.promise;
		if (action === "reload") await session.reload();
		else {
			session.dispose();
			const replacement = (await fixture()).session;
			replacement.inheritOwnerActivity(session);
			expect(replacement.submitGuardedPrompt("competitor", replacement.ownerSnapshot, () => true, true)).toEqual({
				status: "rejected",
				reason: "busy",
			});
		}
		release.resolve();
		await expect(result.completion).rejects.toThrow();
		expect(provider).not.toHaveBeenCalled();
		expect(session.ownerSnapshot).not.toEqual(oldSnapshot);
	});

	it("runs a supported request and rejects an unregistered stream backend", async () => {
		const { session, provider } = await fixture();
		const result = session.submitGuardedPrompt("hello", session.ownerSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await result.completion;
		expect(provider).toHaveBeenCalledTimes(1);
		session.agent.streamFunction = () => {
			throw new Error("must not run");
		};
		expect(session.submitGuardedPrompt("hello", session.ownerSnapshot, () => true, true)).toEqual({
			status: "rejected",
			reason: "unsupported",
		});
	});

	it.each(["routing", "auth", "headers"] as const)(
		"fences human intervention during %s without releasing or queueing the reservation",
		async (stage) => {
			const { session, provider, entered, release } = await fixture(stage);
			const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => true, true);
			if (result.status !== "running") throw new Error(JSON.stringify(result));
			await entered.promise;
			expect(session.submitGuardedPrompt("competitor", session.ownerSnapshot, () => true, true)).toEqual({
				status: "rejected",
				reason: "busy",
			});
			session.notifyHumanInput();
			expect(session.submitGuardedPrompt("competitor", session.ownerSnapshot, () => true, true)).toEqual({
				status: "rejected",
				reason: "busy",
			});
			release.resolve();
			await expect(result.completion).rejects.toThrow("stale");
			expect(provider).not.toHaveBeenCalled();
			expect(session.pendingMessageCount).toBe(0);
			if (stage === "routing")
				expect(
					session.sessionManager
						.getEntries()
						.some((entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state"),
				).toBe(false);
		},
	);

	it("rechecks authorization after authentication", async () => {
		const { session, provider, entered, release } = await fixture("auth");
		let authorized = true;
		const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => authorized, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await entered.promise;
		authorized = false;
		release.resolve();
		await expect(result.completion).rejects.toThrow("revoked");
		expect(provider).not.toHaveBeenCalled();
	});
});
