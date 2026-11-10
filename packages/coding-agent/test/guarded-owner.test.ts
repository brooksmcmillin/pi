import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import type { GuardedOwnerCapability, GuardedOwnerSupport } from "../src/core/guarded-owner.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

async function fixture(support?: GuardedOwnerSupport, extensions: ExtensionFactory[] = []) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = createFauxCore({ api: "openai-completions", provider: "guarded-owner-test" });
	faux.setResponses([fauxAssistantMessage("done")]);
	const provider = vi.fn(faux.streamSimple);
	runtime.registerProvider("guarded-owner-test", {
		api: "openai-completions",
		apiKey: "offline-fixture",
		baseUrl: "https://example.invalid",
		streamSimple: provider,
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
	const resourceLoader = createTestResourceLoader({ extensionsResult: await createTestExtensionsResult(extensions) });
	const { session } = await createAgentSession({
		guardedOwner: support,
		modelRuntime: runtime,
		model: runtime.getModel("guarded-owner-test", "fixture"),
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		tools: [],
		settingsManager: SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
			cacheWarming: "off",
		}),
	});
	sessions.push(session);
	return { session, provider, owner: resourceLoader.getExtensions().runtime.ownerActivity, faux };
}

function submit(capability: GuardedOwnerCapability, authorize = () => true) {
	return capability.submit({
		requestId: "fixture-request",
		text: "offline",
		expected: capability.snapshot(),
		authorize,
	});
}

const supported: GuardedOwnerSupport = { isSupported: () => true };

describe("public guarded owner capability", () => {
	it("is absent by default in SDK and extension contexts", async () => {
		const { session } = await fixture();
		expect(session.guardedOwner).toBeUndefined();
		expect(session.extensionRunner.createContext().guardedOwner).toBeUndefined();
	});

	it("exposes the same bound capability to extensions and rejects unsupported hosts", async () => {
		const { session, provider } = await fixture({ isSupported: () => false });
		const capability = session.extensionRunner.createContext().guardedOwner!;
		expect(capability.version).toBe(1);
		expect(capability.boundary).toBe("cooperative-managed-search");
		expect(capability.snapshot()).toEqual({
			...session.ownerSnapshot,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd: process.cwd(),
		});
		expect(submit(capability)).toMatchObject({ status: "rejected", reason: "unsupported" });
		expect(provider).not.toHaveBeenCalled();
	});

	it.each(["cwd", "sessionId", "sessionFile"] as const)("rejects mismatched %s before hooks", async (field) => {
		const input = vi.fn();
		const { session, provider } = await fixture(supported, [
			(pi) => {
				pi.on("input", input);
			},
		]);
		const capability = session.guardedOwner!;
		const expected = { ...capability.snapshot(), [field]: "wrong" };
		expect(capability.submit({ requestId: "wrong", text: "offline", expected, authorize: () => true })).toMatchObject(
			{ status: "rejected", reason: "stale" },
		);
		expect(input).not.toHaveBeenCalled();
		expect(provider).not.toHaveBeenCalled();
	});

	it("rejects stale generations and revoked permission before hooks", async () => {
		const { session, provider } = await fixture(supported);
		const capability = session.guardedOwner!;
		const expected = capability.snapshot();
		session.notifyHumanInput();
		expect(capability.submit({ requestId: "stale", text: "offline", expected, authorize: () => true })).toMatchObject(
			{ status: "rejected", reason: "stale" },
		);
		expect(submit(capability, () => false)).toMatchObject({ status: "rejected", reason: "revoked" });
		expect(provider).not.toHaveBeenCalled();
	});

	it("reserves synchronously and joins input work after cancellation", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, provider } = await fixture(supported, [
			(pi) => {
				pi.on("input", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		]);
		const capability = session.guardedOwner!;
		const result = submit(capability);
		if (result.status !== "running") throw new Error("Expected admission");
		const completion = result.completion.catch((error: unknown) => error);
		await entered.promise;
		expect(submit(capability)).toMatchObject({ status: "rejected", reason: "busy" });
		result.cancel();
		let settled = false;
		void result.settlement.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(submit(capability)).toMatchObject({ status: "rejected", reason: "busy" });
		release.resolve();
		expect(await completion).toBeInstanceOf(Error);
		expect(await result.settlement).toBe("settled");
		expect(provider).not.toHaveBeenCalled();
	});

	it("revalidates host support after async input without relabelling acceptance as rejection", async () => {
		let enabled = true;
		const { session, provider } = await fixture({ isSupported: () => enabled }, [
			(pi) => {
				pi.on("input", async () => {
					enabled = false;
				});
			},
		]);
		const result = submit(session.guardedOwner!);
		if (result.status !== "running") throw new Error("Expected admission");
		await expect(result.completion).rejects.toThrow("revoked");
		expect(await result.settlement).toBe("settled");
		expect(provider).not.toHaveBeenCalled();
	});

	it("reports uncertainty independently and retains ownership after cancellation", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, owner } = await fixture(supported, [
			(pi) => {
				pi.on("input", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		]);
		const result = submit(session.guardedOwner!);
		if (result.status !== "running") throw new Error("Expected admission");
		const completion = result.completion.catch(() => {});
		await entered.promise;
		owner.markUncertain();
		expect(await result.settlement).toBe("uncertain");
		result.cancel();
		release.resolve();
		await completion;
		expect(submit(session.guardedOwner!)).toMatchObject({ status: "rejected", reason: "busy" });
	});

	it("invalidates captured capabilities and cannot reconstruct authority in a fresh SDK session", async () => {
		const { session } = await fixture(supported);
		const capability = session.guardedOwner!;
		const expected = capability.snapshot();
		session.invalidateOwner();
		expect(() => capability.snapshot()).toThrow("stale");
		expect(capability.submit({ requestId: "old", text: "offline", expected, authorize: () => true })).toMatchObject({
			status: "rejected",
			reason: "stale",
		});
		const replacement = await fixture();
		expect(replacement.session.guardedOwner).toBeUndefined();
	});

	it("cancellation preserves queued human input and cannot abort its handoff", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const humanEntered = Promise.withResolvers<void>();
		const humanRelease = Promise.withResolvers<void>();
		const seen: string[] = [];
		const { session } = await fixture(supported, [
			(pi) => {
				pi.on("input", async (event) => {
					seen.push(event.text);
					if (event.text === "offline") {
						entered.resolve();
						await release.promise;
					}
				});
				pi.on("before_agent_start", async (event) => {
					if (event.messageType === "user" && event.prompt === "human") {
						humanEntered.resolve();
						await humanRelease.promise;
					}
				});
			},
		]);
		const result = submit(session.guardedOwner!);
		if (result.status !== "running") throw new Error("Expected admission");
		const completion = result.completion.catch(() => {});
		await entered.promise;
		await session.prompt("human", { streamingBehavior: "steer" });
		result.cancel();
		release.resolve();
		await humanEntered.promise;
		const generation = session.ownerSnapshot.generation;
		result.cancel();
		expect(session.ownerSnapshot.generation).toBe(generation);
		humanRelease.resolve();
		await completion;
		expect(await result.settlement).toBe("settled");
		expect(seen).toEqual(["offline", "human"]);
		expect(session.getLastAssistantText()).toBe("done");
	});

	it("an old cancel handle cannot abort the next human prompt", async () => {
		const { session, faux } = await fixture(supported);
		const result = submit(session.guardedOwner!);
		if (result.status !== "running") throw new Error("Expected admission");
		await result.completion;
		expect(await result.settlement).toBe("settled");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("human");
			},
		]);
		const human = session.prompt("human");
		await entered.promise;
		result.cancel();
		expect(session.agent.signal?.aborted).toBe(false);
		release.resolve();
		await human;
	});
});
