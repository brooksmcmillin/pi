import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type RebindContext = {
	session: { subscribe: () => () => void };
	unsubscribe?: () => void;
	applyRuntimeSettings: () => void;
	programStatus: { reset(): void };
	renderCurrentSessionState: () => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

type InteractiveModePrototype = {
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("overlapping startup and replacement session rebinds", () => {
	it("retires the stale startup subscription without duplicating the replacement subscription", async () => {
		const unsubscribeStartup = vi.fn();
		const startupSession = { subscribe: vi.fn(() => unsubscribeStartup) };
		const replacementSession = { subscribe: vi.fn(() => () => {}) };
		let resolveStartupBind!: () => void;
		let resolveReplacementBind!: () => void;

		const startupBind = new Promise<void>((resolve) => {
			resolveStartupBind = resolve;
		});
		const replacementBind = new Promise<void>((resolve) => {
			resolveReplacementBind = resolve;
		});

		const updateTerminalTitle = vi.fn();
		let bindCount = 0;

		const context: RebindContext = {
			session: startupSession,
			applyRuntimeSettings: () => {},
			programStatus: { reset: () => {} },
			renderCurrentSessionState: () => {},
			bindCurrentSessionExtensions: () => {
				bindCount += 1;
				return bindCount === 1 ? startupBind : replacementBind;
			},
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor: () => {},
			updateTerminalTitle,
		};

		const startupRebind = interactiveModePrototype.rebindCurrentSession.call(context);
		expect(bindCount).toBe(1);

		context.session = replacementSession;
		const replacementRebind = interactiveModePrototype.rebindCurrentSession.call(context, {
			renderBeforeBind: true,
		});

		expect(bindCount).toBe(2);
		expect(unsubscribeStartup).toHaveBeenCalledTimes(1);
		expect(replacementSession.subscribe).toHaveBeenCalledTimes(1);

		resolveStartupBind();
		await startupRebind;

		expect(startupSession.subscribe).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).not.toHaveBeenCalled();

		resolveReplacementBind();
		await replacementRebind;

		expect(replacementSession.subscribe).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).toHaveBeenCalledTimes(1);
	});
});
