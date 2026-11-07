import { Agent } from "@earendil-works/pi-agent-core";
import {
	contentText,
	createFauxCore,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, markRuntimeStreamFunction } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
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

async function fixture(
	stage?: "routing" | "auth" | "headers" | "response",
	extensions: ExtensionFactory[] = [],
	toolName?: string,
	toolCallAt = 1,
) {
	const entered = deferred();
	const release = deferred();
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = createFauxCore({ api: "openai-completions", provider: "owner-test" });
	const response: FauxResponseFactory = async () => {
		const callCount = faux.state.callCount;
		faux.appendResponses([response]);
		if (stage === "response" && callCount === 1) {
			entered.resolve();
			await release.promise;
		}
		return toolName && callCount === toolCallAt
			? fauxAssistantMessage(fauxToolCall(toolName, {}, { id: "outer-call" }), { stopReason: "toolUse" })
			: fauxAssistantMessage("done");
	};
	faux.setResponses([response]);
	const provider = vi.fn(faux.streamSimple);
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
	return { session, provider, entered, release, faux };
}

const interactive = InteractiveMode.prototype as unknown as {
	setupKeyHandlers(this: unknown): void;
	cycleModel(this: unknown, direction: "forward" | "backward"): Promise<void>;
	cycleThinkingLevel(this: unknown): void;
	showModelSelector(this: unknown): void;
};

function shortcuts(session: AgentSession) {
	const handlers = new Map<string, () => void | Promise<void>>();
	const context = {
		session,
		defaultEditor: { onAction: (name: string, handler: () => void | Promise<void>) => handlers.set(name, handler) },
		ui: {},
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
		cycleModel: (direction: "forward" | "backward") => interactive.cycleModel.call(context, direction),
		cycleThinkingLevel: () => interactive.cycleThinkingLevel.call(context),
	};
	interactive.setupKeyHandlers.call(context);
	return { handlers, context };
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

	it.each([
		["auth", "steer"],
		["auth", "followUp"],
		["headers", "steer"],
		["headers", "followUp"],
	] as const)("delivers accepted human %s/%s input after fencing", async (stage, streamingBehavior) => {
		const { session, provider, entered, release } = await fixture(stage);
		const delivered: string[] = [];
		session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				delivered.push(contentText(event.message.content, ""));
			}
		});
		const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await entered.promise;
		await session.prompt("human", { streamingBehavior });
		expect(session.pendingMessageCount).toBe(1);
		release.resolve();
		await expect(result.completion).rejects.toThrow("stale");
		expect(provider).toHaveBeenCalledTimes(1);
		expect(delivered.filter((text) => text === "human")).toEqual(["human"]);
		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		const next = session.submitGuardedPrompt("next", session.ownerSnapshot, () => true, true);
		expect(next.status).toBe("running");
		if (next.status === "running") await next.completion;
	});

	it.each([
		["auth", "steer", "one-at-a-time"],
		["auth", "steer", "all"],
		["auth", "followUp", "one-at-a-time"],
		["auth", "followUp", "all"],
		["response", "steer", "one-at-a-time"],
		["response", "steer", "all"],
		["response", "followUp", "one-at-a-time"],
		["response", "followUp", "all"],
	] as const)("preserves handoff batching for %s/%s/%s", async (stage, behavior, mode) => {
		const { session, provider, entered, release } = await fixture(stage);
		session.agent.steeringMode = mode;
		session.agent.followUpMode = mode;
		const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		const completion = result.completion.catch((error: Error) => error);
		await entered.promise;
		await session[behavior]("human one");
		await session[behavior]("human two");
		release.resolve();
		await completion;
		const requests = provider.mock.calls.slice(stage === "response" ? 1 : 0).map(([, context]) =>
			context.messages
				.filter((message) => message.role === "user")
				.map((message) => contentText(message.content, ""))
				.filter((text) => text.startsWith("human")),
		);
		expect(requests).toEqual(
			mode === "all" ? [["human one", "human two"]] : [["human one"], ["human one", "human two"]],
		);
		expect(session.pendingMessageCount).toBe(0);
	});

	it.each(["steer", "followUp"] as const)(
		"gives human %s a normal tool scope after dispatch",
		async (streamingBehavior) => {
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "mock shell" }], details: {} }));
			const { session, provider, entered, release } = await fixture(
				"response",
				[
					(pi) =>
						pi.registerTool({
							name: "bash",
							label: "bash",
							description: "in-process mock, never spawns",
							parameters: Type.Object({}),
							execute,
						}),
				],
				"bash",
				2,
			);
			const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => true, true);
			if (result.status !== "running") throw new Error(JSON.stringify(result));
			await entered.promise;
			await session.prompt("human", { streamingBehavior });
			release.resolve();
			await result.completion;
			expect(execute).toHaveBeenCalledTimes(1);
			expect(provider).toHaveBeenCalledTimes(3);
			expect(session.pendingMessageCount).toBe(0);
		},
	);

	it.each(["response", "boundary"] as const)("prioritizes human steering over continuation at %s", async (stage) => {
		const boundaryEntered = deferred();
		const boundaryRelease = deferred();
		let continued = false;
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "human tool" }], details: {} }));
		const { session, provider, entered, release } = await fixture(
			"response",
			[
				(pi) => {
					pi.registerTool({
						name: "bash",
						label: "bash",
						description: "in-process mock",
						parameters: Type.Object({}),
						execute,
					});
					pi.on("agent_before_settle", async () => {
						if (continued) return;
						continued = true;
						boundaryEntered.resolve();
						if (stage === "boundary") await boundaryRelease.promise;
						return {
							entries: [
								{ type: "custom_message", customType: "continuation", content: "continue now", display: false },
							],
							continue: true,
						};
					});
				},
			],
			"bash",
			2,
		);
		const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await entered.promise;
		if (stage === "response") await session.steer("human priority");
		release.resolve();
		if (stage === "boundary") {
			await boundaryEntered.promise;
			await session.steer("human priority");
			boundaryRelease.resolve();
		}
		await result.completion;
		expect(
			provider.mock.calls[1][1].messages.some(
				(message) => message.role === "user" && contentText(message.content, "") === "human priority",
			),
		).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(session.pendingMessageCount).toBe(0);
	});

	it("preserves selected extension steering when human input hands off during compaction", async () => {
		const entered = deferred();
		const release = deferred();
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "human tool" }], details: {} }));
		const { session, provider, faux } = await fixture(undefined, [
			(pi) => {
				pi.registerTool({
					name: "large_result",
					label: "large result",
					description: "cross compaction threshold",
					parameters: Type.Object({}),
					execute: async () => {
						pi.sendMessage(
							{ customType: "selected-extension", content: "retained extension input", display: false },
							{ deliverAs: "steer" },
						);
						return {
							content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
							details: {},
						};
					},
				});
				pi.registerTool({
					name: "bash",
					label: "bash",
					description: "in-process mock",
					parameters: Type.Object({}),
					execute,
				});
				pi.on("session_before_compact", async (event) => {
					entered.resolve();
					await release.promise;
					return {
						compaction: {
							summary: "compacted history",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		]);
		session.agent.convertToLlm = convertToLlm;
		await session.setModel({ ...session.model!, contextWindow: 2600, maxTokens: 100 });
		session.settingsManager.applyOverrides({
			compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 },
		});
		session.setActiveToolsByName(["large_result", "bash"]);
		faux.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("delayed human"),
		]);
		await session.prompt("seed old history");
		await session.prompt("seed recent history");
		const result = session.submitGuardedPrompt("run the large tool", session.ownerSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await entered.promise;
		await session.steer("human during compaction");
		release.resolve();
		await result.completion;
		expect(JSON.stringify(provider.mock.calls[3][1].messages)).toContain("human during compaction");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(provider).toHaveBeenCalledTimes(5);
		expect(JSON.stringify(provider.mock.calls[3][1].messages)).not.toContain("retained extension input");
		expect(JSON.stringify(provider.mock.calls[4][1].messages)).toContain("retained extension input");
		expect(
			session.messages.filter((message) => message.role === "custom" && message.customType === "selected-extension"),
		).toHaveLength(1);
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "selected-extension"),
		).toHaveLength(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.pendingMessageCount).toBe(0);
	});

	it("hands off before_agent_start input without running input hooks twice", async () => {
		const entered = deferred();
		const release = deferred();
		let humanInputs = 0;
		let starts = 0;
		const { session, provider } = await fixture(undefined, [
			(pi) => {
				pi.on("input", (event) => {
					if (event.source !== "extension") {
						humanInputs++;
						return { action: "transform", text: `${event.text} transformed` };
					}
				});
				pi.on("before_agent_start", async () => {
					if (++starts === 1) {
						entered.resolve();
						await release.promise;
					}
				});
			},
		]);
		const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await entered.promise;
		await session.followUp("human");
		release.resolve();
		await expect(result.completion).rejects.toThrow("stale");
		expect(provider).toHaveBeenCalledTimes(1);
		expect(humanInputs).toBe(1);
		expect(session.getUserMessagesForForking().map((entry) => entry.text)).toEqual(["human transformed"]);
		expect(session.pendingMessageCount).toBe(0);
	});

	it.each(["steer", "followUp"] as const)(
		"keeps original subprocess calls restricted with pending human %s",
		async (streamingBehavior) => {
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "mock" }], details: {} }));
			const { session, entered, release } = await fixture(
				"response",
				[
					(pi) => {
						pi.registerTool({
							name: "bash",
							label: "bash",
							description: "in-process mock",
							parameters: Type.Object({}),
							execute,
						});
					},
				],
				"bash",
			);
			const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => true, true);
			if (result.status !== "running") throw new Error(JSON.stringify(result));
			await entered.promise;
			await session.prompt("human", { streamingBehavior });
			release.resolve();
			await result.completion;
			expect(execute).not.toHaveBeenCalled();
			expect(session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
			expect(session.pendingMessageCount).toBe(0);
		},
	);

	it("retains outgoing children and their restrictions across human handoff", async () => {
		const childRelease = deferred();
		const humanSettled = deferred();
		const { session, entered, release } = await fixture("response");
		let started = false;
		let settlements = 0;
		let childGuarded = false;
		session.subscribe((event) => {
			if (event.type === "agent_start" && !started) {
				started = true;
				void session.trackOwnerActivity(async () => {
					await childRelease.promise;
					childGuarded = session.resourceLoader.getExtensions().runtime.ownerActivity.guarded;
				});
			}
			if (event.type === "agent_settled" && ++settlements === 2) humanSettled.resolve();
		});
		const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await entered.promise;
		await session.followUp("human");
		release.resolve();
		await humanSettled.promise;
		expect(session.submitGuardedPrompt("competitor", session.ownerSnapshot, () => true, true)).toEqual({
			status: "rejected",
			reason: "busy",
		});
		childRelease.resolve();
		await result.completion;
		expect(childGuarded).toBe(true);
	});

	it.each(["clear", "abort", "dispose"] as const)("does not replay human input after %s", async (action) => {
		const { session, provider, entered, release } = await fixture("auth");
		const result = session.submitGuardedPrompt("autonomous", session.ownerSnapshot, () => true, true);
		if (result.status !== "running") throw new Error(JSON.stringify(result));
		await entered.promise;
		await session.followUp("human");
		let aborted: Promise<void> | undefined;
		if (action === "clear") expect(session.clearQueue().followUp).toEqual(["human"]);
		else if (action === "abort") aborted = session.abort();
		else session.dispose();
		release.resolve();
		await Promise.allSettled([result.completion, aborted]);
		expect(provider).not.toHaveBeenCalled();
		if (action === "abort") expect(session.clearQueue().followUp).toEqual(["human"]);
	});

	it.each(["app.model.cycleForward", "app.model.cycleBackward", "app.thinking.cycle"])(
		"fences pending auth through the actual %s shortcut",
		async (action) => {
			const { session, provider, entered, release } = await fixture("auth");
			const { handlers } = shortcuts(session);
			const snapshot = session.ownerSnapshot;
			const result = session.submitGuardedPrompt("autonomous", snapshot, () => true, true);
			if (result.status !== "running") throw new Error(JSON.stringify(result));
			await entered.promise;
			await handlers.get(action)!();
			release.resolve();
			const outcome = await result.completion.then(
				() => "dispatched",
				(error: Error) => error.message,
			);
			expect(outcome).toContain("stale");
			expect(provider).not.toHaveBeenCalled();
			expect(session.ownerSnapshot.generation).toBeGreaterThan(snapshot.generation);
		},
	);

	it.each(["app.model.cycleForward", "app.model.cycleBackward"])(
		"accounts for blocked model_select through %s",
		async (action) => {
			const entered = deferred();
			const release = deferred();
			const { session, provider } = await fixture(undefined, [
				(pi) => {
					pi.on("model_select", async () => {
						entered.resolve();
						await release.promise;
					});
				},
			]);
			session.modelRuntime.registerProvider("shortcut-other", {
				api: "openai-completions",
				apiKey: "offline",
				baseUrl: "https://example.invalid",
				streamSimple: provider,
				models: [{ ...session.model!, id: "alternate" }],
			});
			await session.modelRuntime.refresh({ allowNetwork: false });
			session.setScopedModels([
				{ model: session.model! },
				{ model: session.modelRuntime.getModel("shortcut-other", "alternate")! },
			]);
			const { handlers } = shortcuts(session);
			const switched = handlers.get(action)!();
			await entered.promise;
			const admission = session.submitGuardedPrompt("competitor", session.ownerSnapshot, () => true, true);
			release.resolve();
			await switched;
			if (admission.status === "running") await admission.completion;
			expect(admission).toEqual({ status: "rejected", reason: "busy" });
		},
	);

	it("accounts for an asynchronous thinking selection hook", async () => {
		const entered = deferred();
		const release = deferred();
		const { session } = await fixture(undefined, [
			(pi) => {
				pi.on("thinking_level_select", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		]);
		session.agent.state.model = { ...session.model!, reasoning: true };
		const { handlers } = shortcuts(session);
		await handlers.get("app.thinking.cycle")!();
		await entered.promise;
		const admission = session.submitGuardedPrompt("competitor", session.ownerSnapshot, () => true, true);
		release.resolve();
		if (admission.status === "running") await admission.completion;
		expect(admission).toEqual({ status: "rejected", reason: "busy" });
	});

	it("tracks model-selector confirmation rather than only opening the selector", async () => {
		initTheme("dark");
		const { session } = await fixture();
		const entered = deferred();
		const release = deferred();
		const done = deferred();
		const checkAuth = session.modelRuntime.checkAuth.bind(session.modelRuntime);
		vi.spyOn(session.modelRuntime, "checkAuth").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return checkAuth(...args);
		});
		vi.spyOn(
			ModelSelectorComponent.prototype as unknown as { refreshModels(): Promise<void> },
			"refreshModels",
		).mockResolvedValue();
		let selector: ModelSelectorComponent | undefined;
		const { context } = shortcuts(session);
		const selectionContext = {
			...context,
			settingsManager: session.settingsManager,
			ui: { requestRender: vi.fn() },
			updateAvailableProviderCount: vi.fn(),
			showSelector: (create: (done: () => void) => { component: ModelSelectorComponent }) => {
				selector = create(done.resolve).component;
			},
		};
		const snapshot = session.ownerSnapshot;
		interactive.showModelSelector.call(selectionContext);
		expect(session.ownerSnapshot).toEqual(snapshot);
		selector!.handleInput("\r");
		await entered.promise;
		const admission = session.submitGuardedPrompt("competitor", session.ownerSnapshot, () => true, true);
		release.resolve();
		await done.promise;
		if (admission.status === "running") await admission.completion;
		expect(admission).toEqual({ status: "rejected", reason: "busy" });
		expect(session.ownerSnapshot.generation).toBeGreaterThan(snapshot.generation);
	});

	it("releases shortcut activity when model cycling fails", async () => {
		const { session } = await fixture();
		vi.spyOn(session, "cycleModel").mockRejectedValueOnce(new Error("fixture model error"));
		const { handlers, context } = shortcuts(session);
		await handlers.get("app.model.cycleForward")!();
		expect(context.showError).toHaveBeenCalledWith("fixture model error");
		expect(session.resourceLoader.getExtensions().runtime.ownerActivity.busy).toBe(false);
	});

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
