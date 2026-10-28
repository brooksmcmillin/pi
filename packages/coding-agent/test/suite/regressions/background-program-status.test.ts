import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import backgroundWork from "../../../examples/extensions/background-work.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { ProgramStatusReporter } from "../../../src/modes/interactive/program-status-reporter.ts";
import { createHarness, createTestUiContext } from "../harness.ts";

// Exercise the actual interactive UI adapter without starting a terminal.
const interactivePrototype = InteractiveMode.prototype as unknown as {
	createExtensionUIContext(this: { programStatus: ProgramStatusReporter }): ExtensionUIContext;
	resetExtensionUI(this: Record<string, unknown>): void;
};

describe("extension background program status", () => {
	it("keeps the terminal working through real parent settlements and rejects stale UI registrations", async () => {
		const reports: ProgramStatus[] = [];
		const terminal = { setProgramStatus: (status: ProgramStatus) => reports.push(status) } as unknown as Terminal;
		const reporter = new ProgramStatusReporter(
			() => terminal,
			() => "Review",
		);
		const ui = interactivePrototype.createExtensionUIContext.call({ programStatus: reporter });
		let extensionUI: ExtensionUIContext | undefined;
		let finish: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						extensionUI = ctx.ui;
					});
					pi.on("agent_start", (_event, ctx) => {
						finish ??= ctx.ui.beginBackgroundWork();
					});
				},
			],
		});
		try {
			harness.session.subscribe((event) => reporter.handleEvent(event));
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createTestUiContext({ beginBackgroundWork: ui.beginBackgroundWork }),
			});
			harness.setResponses([fauxAssistantMessage("Waiting for reviewers"), fauxAssistantMessage("Still waiting")]);
			await harness.session.prompt("Start review");
			await harness.session.prompt("Check progress");
			expect(reports.map(({ state }) => state)).toEqual(["working"]);
			finish!();
			expect(reports.map(({ state }) => state)).toEqual(["working", "done"]);

			const oldUI = extensionUI!;
			const oldFinish = oldUI.beginBackgroundWork();
			await harness.session.reload({
				beforeSessionStart: () =>
					interactivePrototype.resetExtensionUI.call({
						programStatus: reporter,
						extensionDialogs: [],
						ui: { hideOverlay() {} },
						clearExtensionTerminalInputListeners() {},
						setExtensionFooter() {},
						setExtensionHeader() {},
						clearExtensionWidgets() {},
						footerDataProvider: { clearExtensionStatuses() {} },
						footer: { invalidate() {} },
						setCustomEditorComponent() {},
						setupAutocompleteProvider() {},
						defaultEditor: {},
						updateTerminalTitle() {},
						setWorkingIndicator() {},
						setHiddenThinkingLabel() {},
					}),
			});
			expect(reports.at(-1)?.state).toBe("idle");
			expect(() => oldUI.beginBackgroundWork()).toThrow(/stale/);
			const newFinish = extensionUI!.beginBackgroundWork();
			oldFinish();
			expect(reports.at(-1)?.state).toBe("working");
			newFinish();
			expect(reports.at(-1)?.state).toBe("idle");
		} finally {
			harness.cleanup();
		}
	});

	it("runs the model-free example with overlapping jobs and shutdown cleanup", async () => {
		const releases: Array<ReturnType<typeof vi.fn>> = [];
		const notify = vi.fn();
		const harness = await createHarness({ extensionFactories: [backgroundWork] });
		try {
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createTestUiContext({
					beginBackgroundWork: () => {
						const release = vi.fn();
						releases.push(release);
						return release;
					},
					notify,
				}),
			});
			vi.useFakeTimers();
			await harness.session.prompt("/background-work");
			await harness.session.prompt("/background-work");
			expect(releases).toHaveLength(2);
			expect(releases.every((release) => release.mock.calls.length === 0)).toBe(true);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(notify).toHaveBeenCalledTimes(2);
			expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
			await harness.session.prompt("/background-work");
			await harness.session.reload();
			expect(releases[2]).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(notify).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
			harness.cleanup();
		}
	});

	it("provides a harmless release callback in headless mode", async () => {
		let finish: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						finish = ctx.ui.beginBackgroundWork();
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({ mode: "print" });
			expect(finish).toBeTypeOf("function");
			finish!();
			finish!();
		} finally {
			harness.cleanup();
		}
	});
});
