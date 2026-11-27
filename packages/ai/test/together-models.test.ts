import { afterEach, describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/build.ts";
import together from "../catalog/providers/together.ts";
import type { ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

function buildTogetherModels() {
	const models = ["moonshotai/Kimi-K3", "openai/gpt-oss-120b", "deepseek-ai/DeepSeek-V4-Pro-0813"].map(
		(id): ModelsDevV2Model => ({
			id,
			name: id,
			type: "chat",
			api: {},
			modalities: { input: ["text", "image"], output: ["text"] },
			capabilities: {
				tools: { supported: true },
				reasoning: {
					supported: true,
					...(id === "openai/gpt-oss-120b" ? { effort: ["low", "medium", "high"] } : {}),
				},
			},
			limit: { context: 1048576, output: 131072 },
			cost: { text: { input: { price: 3, cache: { read: 0.3 } }, output: { price: 15 } } },
		}),
	);
	const catalog = buildCatalog(
		[together],
		{
			modelsDev: { togetherai: { models: Object.fromEntries(models.map((model) => [model.id, model])) } },
			modelsDevDecisions: {},
			openRouter: { chat: [], images: [], classifiers: [] },
			aiGateway: { chat: [], classifiers: [] },
			nvidiaModelIds: new Map(),
			radius: [],
		},
		true,
	);
	return Object.fromEntries(catalog.together.chat.map((model) => [model.id, model]));
}

describe("Together models", () => {
	it("registers Kimi K3 via OpenAI-compatible Chat Completions API", () => {
		const model = buildTogetherModels()["moonshotai/Kimi-K3"];

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("together");
		expect(model.baseUrl).toBe("https://api.together.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null });
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1048576);
		expect(model.maxTokens).toBe(131072);
		expect(model.cost).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "together",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	it("models Together reasoning controls from the Together API surface", () => {
		const models = buildTogetherModels();
		const gptOss = models["openai/gpt-oss-120b"];
		expect(gptOss.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			max: null,
			xhigh: null,
		});
		expect(gptOss.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});

		const deepSeekV4 = models["deepseek-ai/DeepSeek-V4-Pro-0813"];
		expect(deepSeekV4.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
		});
		expect(deepSeekV4.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "together",
		});
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
