import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { it } from "node:test";
import { Browser, browserTests } from "./browser.ts";

it("waits for the complete debugging-port line and a page target", { skip: !browserTests }, async (t) => {
	const read = t.mock.method<
		{ readFileSync(path: fs.PathOrFileDescriptor, encoding: "utf8"): string },
		"readFileSync"
	>(fs, "readFileSync");
	read.mock.mockImplementationOnce(() => "");
	read.mock.mockImplementationOnce(() => "12", 1);
	const discover = t.mock.method(globalThis, "fetch");
	discover.mock.mockImplementationOnce(async () => new Response("[]"));
	discover.mock.mockImplementationOnce(
		async () =>
			new Response(
				JSON.stringify([{ type: "background_page", webSocketDebuggerUrl: "ws://127.0.0.1:1/not-a-tab" }]),
			),
		1,
	);
	syncBuiltinESMExports();
	try {
		const browser = await Browser.start();
		try {
			assert.ok(read.mock.callCount() >= 3);
			assert.ok(discover.mock.callCount() >= 3);
			assert.equal(await browser.evaluate("1 + 1"), 2);
		} finally {
			await browser.close();
		}
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

it("reaps Chromium and removes its profile when startup fails", { skip: !browserTests }, async (t) => {
	const launches = t.mock.method(childProcess, "spawn");
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("injected discovery failure");
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(Browser.start(), /injected discovery failure/);
		assert.equal(launches.mock.callCount(), 1);
		const launch = launches.mock.calls[0]!;
		const child = launch.result!;
		assert.ok(child.exitCode !== null || child.signalCode !== null);
		const profile = launch.arguments[1]
			.find((arg) => arg.startsWith("--user-data-dir="))!
			.slice("--user-data-dir=".length);
		assert.equal(fs.existsSync(profile), false);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

it(
	"bounds silent DevTools calls and rejects pending calls on disconnect",
	{ skip: !browserTests, timeout: 20_000 },
	async (t) => {
		const browser = await Browser.start();
		t.after(() => browser.close());
		const never = { expression: "new Promise(() => {})", awaitPromise: true };
		t.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const timedOut = assert.rejects(
				browser.call("Runtime.evaluate", never),
				/DevTools Runtime.evaluate timed out after 30000ms/,
			);
			t.mock.timers.tick(30_000);
			await timedOut;
		} finally {
			t.mock.timers.reset();
		}
		assert.equal(await browser.evaluate("1 + 1"), 2, "a timed-out request does not break later commands");
		const disconnected = assert.rejects(
			browser.call("Runtime.evaluate", {
				expression: "globalThis.__harnessPending = true; new Promise(() => {})",
				awaitPromise: true,
			}),
			/DevTools socket closed/,
		);
		await browser.wait("globalThis.__harnessPending === true");
		browser.socket.terminate();
		await disconnected;
		await assert.rejects(browser.call("Page.enable"), /DevTools socket closed/);
	},
);
