import { AsyncResource } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api, promptTokens = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createDoneStream(api: Api, promptTokens = 0) {
		const stream = createAssistantMessageEventStream();
		stream.end(createDoneMessage(api, promptTokens));
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionFactory?: ExtensionFactory,
		providerEvent?: unknown,
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: extensionFactory ? [extensionFactory] : [],
		});
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (requestModel, _context, providerOptions) => {
				capturedOptions = providerOptions;
				if (providerEvent === undefined) return createDoneStream(api);

				const stream = createAssistantMessageEventStream();
				void (async () => {
					await providerOptions?.onProviderStreamEvent?.(providerEvent, requestModel);
					stream.end(createDoneMessage(api));
				})();
				return stream;
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		try {
			if (providerEvent === undefined) {
				const stream = await session.agent.streamFunction(
					model,
					normalizeContext({ messages: [] }),
					requestOptions,
				);
				await stream.result();
			} else {
				await session.prompt("test");
			}
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	async function createCacheWarmingSession(
		populate?: (manager: SessionManager, model: Model<Api>) => void,
		options: {
			extensionFactory?: ExtensionFactory;
			stream?: (call: number) => ReturnType<typeof createDoneStream>;
		} = {},
	) {
		const model: Model<Api> = {
			...createModel("anthropic-messages"),
			cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
			promptCache: { short: 300 },
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let providerCalls = 0;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => {
				providerCalls++;
				return options.stream?.(providerCalls) ?? createDoneStream(model.api, 100_000);
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		populate?.(sessionManager, model);
		const settingsManager = SettingsManager.inMemory({ cacheWarming: "idle" });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: options.extensionFactory ? [options.extensionFactory] : [],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			resourceLoader,
			sessionManager,
		});
		return {
			session,
			providerCalls: () => providerCalls,
			dispose: () => {
				session.dispose();
				modelRegistry.unregisterProvider(model.provider);
			},
		};
	}

	it("schedules cache warming after a completed session request", async () => {
		const fixture = await createCacheWarmingSession();
		try {
			await fixture.session.prompt("test");
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());

			// Equivalent shallow copies remain current, but removing the request prefix does not.
			fixture.session.agent.state.messages = [...fixture.session.agent.state.messages];
			fixture.session.agent.state.model = { ...fixture.session.agent.state.model };
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());
			fixture.session.agent.state.messages = fixture.session.agent.state.messages.slice(1);
			expect(fixture.session.cacheWarmingStatus?.reason).toBe("conversation context changed");
		} finally {
			fixture.dispose();
		}
	});

	it.each(["normal", "guarded"] as const)("refreshes idle cache after a completed %s prompt", async (kind) => {
		const fixture = await createCacheWarmingSession();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const schedule = setTimeout;
		// Fake clocks otherwise run callbacks in the clock driver's context, unlike Node timers.
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
			schedule(AsyncResource.bind(callback), delay, ...args),
		);
		try {
			if (kind === "guarded") {
				const result = fixture.session.submitGuardedPrompt("test", fixture.session.ownerSnapshot, () => true, true);
				if (result.status !== "running") throw new Error(JSON.stringify(result));
				await result.completion;
			} else {
				await fixture.session.prompt("test");
			}
			expect(fixture.providerCalls()).toBe(1);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(fixture.providerCalls()).toBe(2);
			expect(
				fixture.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "usage" && entry.kind === "cache_warm"),
			).toHaveLength(1);
		} finally {
			fixture.dispose();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it("warms the human request after a fenced autonomous auth handoff", async () => {
		const fixture = await createCacheWarmingSession();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const schedule = setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
			schedule(AsyncResource.bind(callback), delay, ...args),
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtime = fixture.session.modelRuntime;
		const getAuth = runtime.getAuth.bind(runtime);
		vi.spyOn(runtime, "getAuth").mockImplementationOnce(async (model, options) => {
			entered.resolve();
			await release.promise;
			return typeof model === "string" ? getAuth(model, options) : getAuth(model, options);
		});
		try {
			const result = fixture.session.submitGuardedPrompt(
				"autonomous",
				fixture.session.ownerSnapshot,
				() => true,
				true,
			);
			if (result.status !== "running") throw new Error(JSON.stringify(result));
			const completion = result.completion.catch((error: Error) => error);
			await entered.promise;
			await fixture.session.steer("human input");
			release.resolve();
			await completion;
			expect(fixture.providerCalls()).toBe(1);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(fixture.providerCalls()).toBe(2);
			expect(
				fixture.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "usage" && entry.kind === "cache_warm"),
			).toHaveLength(1);
		} finally {
			release.resolve();
			fixture.dispose();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it.each(["finish", "cancel", "replace"] as const)("accounts for refresh auth through %s", async (action) => {
		const fixture = await createCacheWarmingSession();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const schedule = setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
			schedule(AsyncResource.bind(callback), delay, ...args),
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			const result = fixture.session.submitGuardedPrompt("test", fixture.session.ownerSnapshot, () => true, true);
			if (result.status !== "running") throw new Error(JSON.stringify(result));
			await result.completion;
			const runtime = fixture.session.modelRuntime;
			const getAuth = runtime.getAuth.bind(runtime);
			vi.spyOn(runtime, "getAuth").mockImplementation(async (model, options) => {
				entered.resolve();
				await release.promise;
				return typeof model === "string" ? getAuth(model, options) : getAuth(model, options);
			});
			const clock = vi.advanceTimersByTimeAsync(270_000);
			await entered.promise;
			expect(
				fixture.session.submitGuardedPrompt("competitor", fixture.session.ownerSnapshot, () => true, true),
			).toEqual({ status: "rejected", reason: "busy" });
			if (action === "cancel") fixture.session.setCacheWarmingMode("off");
			if (action === "replace") fixture.session.invalidateOwner();
			release.resolve();
			await clock;
			expect(fixture.providerCalls()).toBe(action === "finish" ? 2 : 1);
			expect(
				fixture.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "usage" && entry.kind === "cache_warm"),
			).toHaveLength(action === "finish" ? 1 : 0);
		} finally {
			release.resolve();
			fixture.dispose();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it.each([
		{ deliverAs: "steer" as const, triggerTurn: true },
		{ deliverAs: "followUp" as const, triggerTurn: true },
		{ deliverAs: "followUp" as const, triggerTurn: undefined },
		{ deliverAs: "followUp" as const, triggerTurn: false },
		{ userQueue: "steer" as const, triggerTurn: true },
		{ userQueue: "followUp" as const, triggerTurn: true },
	])("fences maintenance custom-message turns while streaming: %j", async (messageOptions) => {
		const entered = Promise.withResolvers<void>();
		const response = createAssistantMessageEventStream();
		let decisions = 0;
		const errors: string[] = [];
		const fixture = await createCacheWarmingSession(undefined, {
			stream: (call) => {
				if (call !== 1) return createDoneStream("anthropic-messages", 100_000);
				entered.resolve();
				return response;
			},
			extensionFactory: (pi) => {
				pi.on("cache_warming_decision", async () => {
					decisions++;
					const userQueue = "userQueue" in messageOptions ? messageOptions.userQueue : undefined;
					if (userQueue) {
						await fixture.session[userQueue]("maintenance input", undefined, {
							source: "extension",
						}).catch((error: Error) => errors.push(error.message));
					} else {
						pi.sendMessage(
							{ customType: "maintenance", content: "context only", display: false },
							messageOptions,
						);
					}
					return { action: "stop" };
				});
			},
		});
		await fixture.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const schedule = setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
			schedule(AsyncResource.bind(callback), delay, ...args),
		);
		const prompt = fixture.session.prompt("test");
		try {
			await entered.promise;
			await vi.advanceTimersByTimeAsync(270_000);
			expect(decisions).toBe(1);
			response.end(createDoneMessage("anthropic-messages", 100_000));
			await prompt;
			expect(errors).toEqual(
				messageOptions.triggerTurn === false ? [] : ["Cache maintenance cannot start agent turns"],
			);
			expect(fixture.providerCalls()).toBe(1);
			expect(fixture.session.agent.state.messages.some((message) => message.role === "custom")).toBe(
				messageOptions.triggerTurn === false,
			);
		} finally {
			response.end(createDoneMessage("anthropic-messages", 100_000));
			await prompt;
			fixture.dispose();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it("records billed refresh usage after intervention without rescheduling stale work", async () => {
		const entered = Promise.withResolvers<void>();
		const response = createAssistantMessageEventStream();
		const fixture = await createCacheWarmingSession(undefined, {
			stream: (call) => {
				if (call !== 2) return createDoneStream("anthropic-messages", 100_000);
				entered.resolve();
				return response;
			},
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const schedule = setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
			schedule(AsyncResource.bind(callback), delay, ...args),
		);
		try {
			await fixture.session.prompt("test");
			const clock = vi.advanceTimersByTimeAsync(270_000);
			await entered.promise;
			fixture.session.notifyHumanInput();
			response.end(createDoneMessage("anthropic-messages", 100_000));
			await clock;
			expect(
				fixture.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "usage" && entry.kind === "cache_warm"),
			).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(fixture.providerCalls()).toBe(2);
			expect(fixture.session.cacheWarmingStatus?.state).toBe("inactive");
		} finally {
			response.end(createDoneMessage("anthropic-messages", 100_000));
			fixture.dispose();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it("waits for the next request instead of restoring cache warming", async () => {
		const fixture = await createCacheWarmingSession((manager, model) => {
			manager.appendModelChange(model.provider, model.id);
			manager.appendThinkingLevelChange("off");
			manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() - 60_000 });
			const assistant = { ...createDoneMessage(model.api, 100_000), timestamp: Date.now() - 59_000 };
			manager.appendMessage(assistant);
			manager.appendUsage("cache_warm", model.provider, model.id, assistant.usage);
		});
		try {
			expect(fixture.providerCalls()).toBe(0);
			expect(fixture.session.cacheWarmingStatus).toEqual({
				state: "inactive",
				reason: "waiting for first request",
			});
		} finally {
			fixture.dispose();
		}
	});

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	// Regression test for #9784.
	it("forwards provider stream events to extensions", async () => {
		const providerEvent = { openrouter_metadata: { strategy: "direct" } };
		const extensionEvents: unknown[] = [];

		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{},
			(pi) => {
				pi.on("provider_stream_event", (event) => {
					extensionEvents.push(event);
				});
			},
			providerEvent,
		);

		expect(options?.onProviderStreamEvent).toEqual(expect.any(Function));
		expect(extensionEvents).toEqual([
			{
				data: providerEvent,
				type: "provider_stream_event",
				provider: "capture-provider",
				api: "openai-completions",
				model: "capture-model",
			},
		]);
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			(pi) => {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			},
		);

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});
});
